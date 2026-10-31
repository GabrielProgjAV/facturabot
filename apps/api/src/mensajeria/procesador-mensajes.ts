import type { LoggerService } from '@nestjs/common';
import { z } from 'zod';
import type {
  RespuestaConversacion,
  VistaBorrador,
} from '../facturacion/conversacion.service.js';

/** Máximo de caracteres de un texto (docs/planes/fase-4.3-cola.md §5). */
export const LIMITE_TEXTO = 1000;

/**
 * Tamaño máximo de una nota de voz. Medido el 2026-10-30: ~4 KB/s (Opus de Telegram), así que una
 * nota de 120 s pesa ~0,5 MB; 1 MB deja ~2 veces de margen (§18.1).
 */
export const TAMANO_MAXIMO_VOZ_BYTES = 1_048_576;

/** Pausa antes del único reintento interno. */
export const ESPERA_REINTENTO_MS = 2000;

/**
 * Datos de un trabajo de la cola. Vienen de Redis, así que se validan antes de usarlos.
 * La voz solo lleva el file_id de Telegram: el audio nunca se guarda en Redis.
 */
export const trabajoMensajeSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('texto'),
    chatId: z.number().int(),
    texto: z.string().min(1).max(LIMITE_TEXTO),
    /** Borrador y versión mostrados al recibir un "sí"; null en los demás mensajes. */
    vista: z
      .object({
        borradorId: z.uuid(),
        version: z.number().int().positive(),
      })
      .nullable(),
  }),
  z.object({
    tipo: z.literal('voz'),
    chatId: z.number().int(),
    fileId: z.string().min(1).max(200),
  }),
]);

export type TrabajoMensaje = z.infer<typeof trabajoMensajeSchema>;

export const MENSAJES_FALLA = {
  voz: 'No pude escuchar la nota de voz. Intenta en un rato o escríbela.',
  vozPesada: 'La nota de voz es muy pesada. Envíala más corta o escríbela.',
  texto: 'No pude procesar el mensaje. Tu borrador anterior sigue igual.',
  reinicio: 'No alcancé a procesar tu último mensaje. Reenvíalo, por favor.',
  encoladoSinConfirmar:
    'No pude confirmar si recibí tu mensaje. Espera un momento: si en un minuto no te llega el resumen, reenvíalo.',
} as const;

/** La nota de voz supera TAMANO_MAXIMO_VOZ_BYTES. No se reintenta: volvería a pesar lo mismo. */
export class VozDemasiadoPesadaError extends Error {
  override readonly name = 'VozDemasiadoPesadaError';
  constructor() {
    super(`La nota de voz supera ${TAMANO_MAXIMO_VOZ_BYTES} bytes`);
  }
}

/** Lo que el procesador necesita del exterior. TelegramService lo arma al arrancar. */
export interface DependenciasProcesador {
  responder(
    chatId: number,
    texto: string,
    vista: VistaBorrador | null,
  ): Promise<RespuestaConversacion>;
  marcarMostrada(borradorId: string, version: number): Promise<void>;
  descargarVoz(fileId: string): Promise<Uint8Array<ArrayBuffer>>;
  transcribir(audio: Uint8Array<ArrayBuffer>): Promise<string>;
  /** Termina sin error solo cuando el canal confirmó el mensaje. */
  enviar(chatId: number, texto: string): Promise<void>;
  /** Pausa antes del reintento; los tests la reemplazan para no esperar. */
  esperar(ms: number): Promise<void>;
  logger: Pick<LoggerService, 'log' | 'warn' | 'error'>;
}

type Etapa = 'descargar' | 'transcribir' | 'conversar';

/**
 * Procesa un mensaje de la cola y envía la respuesta.
 * Nunca lanza: cada falla se convierte en un mensaje para el usuario y una línea de log.
 * Los logs llevan jobId, tipo, etapa, duración y el nombre/código del error; nunca el texto,
 * la transcripción, el chatId ni datos del borrador (Ley 1581 de 2012).
 */
export async function procesarMensaje(
  datos: unknown,
  jobId: string,
  deps: DependenciasProcesador,
): Promise<void> {
  const inicio = Date.now();
  const validacion = trabajoMensajeSchema.safeParse(datos);
  if (!validacion.success) {
    deps.logger.error(`Trabajo ${jobId}: datos inválidos, no se procesa`);
    return;
  }
  const trabajo = validacion.data;
  const ctx = { jobId, deps, etapa: 'conversar' as Etapa };

  let respuesta: RespuestaConversacion;
  try {
    respuesta =
      trabajo.tipo === 'voz'
        ? await procesarVoz(trabajo.fileId, ctx)
        : // Con ECONNREFUSED nada se aplicó: ni la IA respondió ni se escribió en la base.
          await conReintento(
            () => deps.responder(trabajo.chatId, trabajo.texto, trabajo.vista),
            esConexionRechazada,
            ctx,
          );
  } catch (err) {
    deps.logger.error(
      `Trabajo ${jobId} (${trabajo.tipo}) falló en ${ctx.etapa}: ${describirError(err)}`,
    );
    respuesta = {
      texto:
        err instanceof VozDemasiadoPesadaError
          ? MENSAJES_FALLA.vozPesada
          : MENSAJES_FALLA[trabajo.tipo],
    };
  }

  try {
    await deps.enviar(trabajo.chatId, respuesta.texto);
  } catch (err) {
    // Sin envío confirmado no se marca como mostrado: ese borrador no se puede aprobar (§3).
    deps.logger.error(
      `Trabajo ${jobId} (${trabajo.tipo}) falló en enviar: ${describirError(err)}`,
    );
    return;
  }

  if (respuesta.mostrar) {
    try {
      await deps.marcarMostrada(
        respuesta.mostrar.borradorId,
        respuesta.mostrar.version,
      );
    } catch (err) {
      // El siguiente "sí" reenviará el resumen: no se aprueba nada que no esté marcado.
      deps.logger.warn(
        `Trabajo ${jobId} (${trabajo.tipo}) falló en marcar: ${describirError(err)}`,
      );
    }
  }
  deps.logger.log(
    `Trabajo ${jobId} (${trabajo.tipo}) terminado en ${Date.now() - inicio} ms`,
  );
}

async function procesarVoz(
  fileId: string,
  ctx: { jobId: string; deps: DependenciasProcesador; etapa: Etapa },
): Promise<RespuestaConversacion> {
  const { deps } = ctx;
  ctx.etapa = 'descargar';
  // Descargar es una lectura: se puede repetir sin efectos. El timeout y el exceso de tamaño
  // no se reintentan.
  const audio = await conReintento(
    () => deps.descargarVoz(fileId),
    (err) => !esTimeout(err) && !(err instanceof VozDemasiadoPesadaError),
    ctx,
  );
  ctx.etapa = 'transcribir';
  const inicio = Date.now();
  const texto = await conReintento(
    () => deps.transcribir(audio),
    esConexionRechazada,
    ctx,
  );
  deps.logger.log(
    `Trabajo ${ctx.jobId} (voz): transcribir tardó ${Date.now() - inicio} ms`,
  );
  // La 4.4 pasará la transcripción a la conversación.
  return {
    texto: texto ? `🎤 Entendí: "${texto}"` : '🎤 No escuché nada en la nota.',
  };
}

/**
 * Un solo reintento, a los 2 s, solo cuando es seguro que la operación no se aplicó.
 * BullMQ no reintenta (attempts: 1): un reintento suyo rompería el orden de los mensajes.
 */
async function conReintento<T>(
  operacion: () => Promise<T>,
  reintentable: (err: unknown) => boolean,
  ctx: { jobId: string; deps: DependenciasProcesador; etapa: Etapa },
): Promise<T> {
  try {
    return await operacion();
  } catch (err) {
    if (!reintentable(err)) throw err;
    ctx.deps.logger.warn(
      `Trabajo ${ctx.jobId}: reintento de ${ctx.etapa} en ${ESPERA_REINTENTO_MS} ms (${describirError(err)})`,
    );
    await ctx.deps.esperar(ESPERA_REINTENTO_MS);
    return operacion();
  }
}

/**
 * Responde al usuario cuando BullMQ marca un trabajo como fallido sin que el procesador lo
 * manejara. En la práctica es un reinicio a mitad del trabajo: con maxStalledCount 0, BullMQ
 * lo falla ("job stalled more than allowable limit") en lugar de repetirlo.
 */
export async function avisarTrabajoFallido(
  datos: unknown,
  jobId: string,
  err: Error,
  deps: Pick<DependenciasProcesador, 'enviar' | 'logger'>,
): Promise<void> {
  const interrumpido = err.message === 'job stalled more than allowable limit';
  deps.logger.error(
    `Trabajo ${jobId} fallido${interrumpido ? ' por un reinicio' : ''}: ${describirError(err)}`,
  );
  const destino = z.object({ chatId: z.number().int() }).safeParse(datos);
  if (!destino.success) return;
  try {
    await deps.enviar(destino.data.chatId, MENSAJES_FALLA.reinicio);
  } catch (errEnvio) {
    deps.logger.error(
      `Trabajo ${jobId}: no se pudo avisar la falla: ${describirError(errEnvio)}`,
    );
  }
}

/** Nombre y código del error, sin su mensaje: los mensajes de terceros pueden traer datos. */
export function describirError(err: unknown): string {
  const nombre = err instanceof Error ? err.name : typeof err;
  const codigo = codigoDe(err);
  return codigo ? `${nombre} (${codigo})` : nombre;
}

/** Código de sistema del error (ECONNREFUSED…), también si fetch lo envuelve en `cause`. */
function codigoDe(err: unknown): string | undefined {
  for (let actual = err, i = 0; actual && i < 4; i++) {
    const { code, cause, errors } = actual as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown[];
    };
    if (typeof code === 'string') return code;
    actual = cause ?? errors?.[0];
  }
  return undefined;
}

function esConexionRechazada(err: unknown): boolean {
  return codigoDe(err) === 'ECONNREFUSED';
}

function esTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}
