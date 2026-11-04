import type { LoggerService } from '@nestjs/common';
import { z } from 'zod';
import type {
  RespuestaConversacion,
  VistaBorrador,
} from '../facturacion/conversacion.service.js';
import { duracionOggOpusSegundos } from '../voz/duracion-ogg.js';

/** Máximo de caracteres de un texto (docs/planes/fase-4.3-cola.md §5). */
export const LIMITE_TEXTO = 1000;

/**
 * Tamaño máximo de una nota de voz. Medido el 2026-10-30: ~4 KB/s (Opus de Telegram), así que una
 * nota de 120 s pesa ~0,5 MB; 1 MB deja ~2 veces de margen (§18.1).
 */
export const TAMANO_MAXIMO_VOZ_BYTES = 1_048_576;

/** Transcribir ocupa la CPU: una nota más larga bloquearía el equipo. */
export const DURACION_MAXIMA_VOZ_SEGUNDOS = 120;

/** Pausa antes del único reintento interno. */
export const ESPERA_REINTENTO_MS = 2000;

/** Si un texto o una nota tarda más que esto, se avisa que sigue en proceso (4.4 §14.2, opción B). */
export const AVISO_DEMORA_MS = 30_000;

export const AVISO_DEMORA = '⏳ Sigo procesando…';

/**
 * Datos de un trabajo de la cola. Vienen de Redis, así que se validan antes de usarlos.
 * La voz solo lleva el file_id de Telegram: el audio nunca se guarda en Redis.
 */
export const trabajoMensajeSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('texto'),
    chatId: z.number().int(),
    texto: z.string().min(1).max(LIMITE_TEXTO),
  }),
  /** Botón "✅ Aprobar" pulsado: el borrador y la versión del mensaje que el usuario tenía. */
  z.object({
    tipo: z.literal('aprobar'),
    chatId: z.number().int(),
    borradorId: z.uuid(),
    version: z.number().int().positive(),
    /** Mensaje del botón pulsado: se le quita el botón para que no se pulse otra vez. */
    messageId: z.number().int().positive(),
    /** Id de Telegram de quien pulsó el botón (dato personal: nunca va a los logs). */
    usuarioId: z.number().int().positive(),
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
  vozLarga: `La nota de voz es muy larga. Envía una de máximo ${DURACION_MAXIMA_VOZ_SEGUNDOS / 60} minutos.`,
  transcripcionLarga: `Entendí una nota de más de ${LIMITE_TEXTO.toLocaleString('es-CO')} caracteres. Divídela en notas más cortas o escríbela.`,
  texto: 'No pude procesar el mensaje. Tu borrador anterior sigue igual.',
  aprobar:
    'No pude aprobar la factura en este momento. Tu borrador sigue igual: intenta de nuevo en un rato.',
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

/**
 * La duración real de la nota (leída del Ogg, no la que declara el cliente) supera el máximo, o el
 * archivo no es un Ogg Opus que se pueda medir. No se reintenta ni se transcribe.
 */
export class VozNoAdmitidaError extends Error {
  override readonly name = 'VozNoAdmitidaError';
  constructor(readonly motivo: 'larga' | 'ilegible') {
    super(
      motivo === 'larga'
        ? `La nota de voz supera ${DURACION_MAXIMA_VOZ_SEGUNDOS} s`
        : 'La nota de voz no es un Ogg Opus legible',
    );
  }
}

/** Lo que el procesador necesita del exterior. TelegramService lo arma al arrancar. */
export interface DependenciasProcesador {
  /** @param porVoz el texto es la transcripción de una nota de voz. */
  responder(
    chatId: number,
    texto: string,
    porVoz?: boolean,
  ): Promise<RespuestaConversacion>;
  aprobar(
    chatId: number,
    vista: VistaBorrador,
    usuarioId: number,
  ): Promise<RespuestaConversacion>;
  marcarMostrada(borradorId: string, version: number): Promise<void>;
  /** Estado real del borrador del chat tras un trabajo cortado; null si no hay nada que mostrar. */
  estadoTrasFallo(
    chatId: number,
    desde: Date,
  ): Promise<RespuestaConversacion | null>;
  descargarVoz(fileId: string): Promise<Uint8Array<ArrayBuffer>>;
  transcribir(audio: Uint8Array<ArrayBuffer>): Promise<string>;
  /**
   * Termina sin error solo cuando el canal confirmó el mensaje. Con `boton`, el mensaje lleva
   * "✅ Aprobar" para ese borrador y esa versión.
   */
  enviar(
    chatId: number,
    texto: string,
    boton: VistaBorrador | null,
  ): Promise<void>;
  /** Quita los botones de un mensaje ya enviado. */
  quitarBoton(chatId: number, messageId: number): Promise<void>;
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

  // Un solo aviso por trabajo. Se guarda la promesa para que la respuesta no llegue antes que él.
  let avisoDemora: Promise<void> | undefined;
  const temporizador =
    trabajo.tipo === 'aprobar'
      ? undefined
      : setTimeout(() => {
          avisoDemora = deps
            .enviar(trabajo.chatId, AVISO_DEMORA, null)
            .catch((err: unknown) =>
              deps.logger.warn(
                `Trabajo ${jobId} (${trabajo.tipo}) falló en avisar la demora: ${describirError(err)}`,
              ),
            );
        }, AVISO_DEMORA_MS);

  let respuesta: RespuestaConversacion;
  try {
    respuesta = await procesar(trabajo, ctx);
  } catch (err) {
    deps.logger.error(
      `Trabajo ${jobId} (${trabajo.tipo}) falló en ${ctx.etapa}: ${describirError(err)}`,
    );
    respuesta = { texto: mensajeDeFalla(err, trabajo.tipo, ctx.etapa) };
  } finally {
    clearTimeout(temporizador);
  }
  await avisoDemora;

  if (trabajo.tipo === 'aprobar') {
    // El botón pulsado ya no vale: o se aprobó, o se reenvía el resumen vigente con uno nuevo.
    try {
      await deps.quitarBoton(trabajo.chatId, trabajo.messageId);
    } catch (err) {
      // Si queda visible, pulsarlo otra vez no aprueba nada: la condición de versión lo impide.
      deps.logger.warn(
        `Trabajo ${jobId} (aprobar) falló en quitar el botón: ${describirError(err)}`,
      );
    }
  }

  const { mostrar } = respuesta;
  const boton =
    mostrar?.aprobable === true
      ? { borradorId: mostrar.borradorId, version: mostrar.version }
      : null;
  try {
    await deps.enviar(trabajo.chatId, respuesta.texto, boton);
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

/** Lo que hace cada tipo de trabajo. Con ECONNREFUSED nada se aplicó: se reintenta una vez. */
function procesar(
  trabajo: TrabajoMensaje,
  ctx: { jobId: string; deps: DependenciasProcesador; etapa: Etapa },
): Promise<RespuestaConversacion> {
  const { deps } = ctx;
  switch (trabajo.tipo) {
    case 'voz':
      return procesarVoz(trabajo.chatId, trabajo.fileId, ctx);
    case 'texto':
      return conReintento(
        () => deps.responder(trabajo.chatId, trabajo.texto),
        esConexionRechazada,
        ctx,
      );
    case 'aprobar':
      return conReintento(
        () =>
          deps.aprobar(
            trabajo.chatId,
            { borradorId: trabajo.borradorId, version: trabajo.version },
            trabajo.usuarioId,
          ),
        esConexionRechazada,
        ctx,
      );
  }
}

/** Qué decirle al usuario según el error y la etapa en que ocurrió. */
function mensajeDeFalla(
  err: unknown,
  tipo: TrabajoMensaje['tipo'],
  etapa: Etapa,
): string {
  if (err instanceof VozDemasiadoPesadaError) return MENSAJES_FALLA.vozPesada;
  if (err instanceof VozNoAdmitidaError) {
    return err.motivo === 'larga'
      ? MENSAJES_FALLA.vozLarga
      : MENSAJES_FALLA.voz;
  }
  // Una nota ya transcrita que falla en la conversación es un fallo de Ollama, no de la voz.
  if (tipo === 'voz' && etapa !== 'conversar') return MENSAJES_FALLA.voz;
  if (tipo === 'aprobar') return MENSAJES_FALLA.aprobar;
  return MENSAJES_FALLA.texto;
}

async function procesarVoz(
  chatId: number,
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
  // Duración real, leída del Ogg: la que declara el cliente de Telegram puede mentir (4.4 §4).
  const segundos = duracionOggOpusSegundos(audio);
  if (segundos === null) throw new VozNoAdmitidaError('ilegible');
  if (segundos > DURACION_MAXIMA_VOZ_SEGUNDOS) {
    throw new VozNoAdmitidaError('larga');
  }

  ctx.etapa = 'transcribir';
  const inicio = Date.now();
  const texto = await conReintento(
    () => deps.transcribir(audio),
    esConexionRechazada,
    ctx,
  );
  deps.logger.log(
    `Trabajo ${ctx.jobId} (voz): ${Math.round(segundos)} s de audio, transcribir tardó ${Date.now() - inicio} ms`,
  );
  if (!texto) return { texto: '🎤 No escuché nada en la nota.' };
  // El mismo límite que un texto escrito (plan de la 4.3, §5).
  if (texto.length > LIMITE_TEXTO) {
    return { texto: MENSAJES_FALLA.transcripcionLarga };
  }

  // La transcripción sigue el mismo camino que un texto: crea o corrige el borrador. Un "sí"
  // dictado no aprueba (decisión 1 de la 4.4): reenvía el resumen vigente con su botón.
  ctx.etapa = 'conversar';
  const respuesta = await conReintento(
    () => deps.responder(chatId, texto, true),
    esConexionRechazada,
    ctx,
  );
  // Un solo mensaje: el usuario compara lo que dijo con lo que se entendió.
  return {
    texto: `🎤 Entendí: "${texto}"\n\n${respuesta.texto}`,
    mostrar: respuesta.mostrar,
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
 *
 * "Reenvíalo" podía ser falso: la corrección o la aprobación pudieron guardarse antes del corte.
 * Por eso se responde con el estado real del borrador, y solo si no hay nada, con el aviso
 * genérico (4.4 §6).
 * @param encoladoEn cuándo se encoló el trabajo (job.timestamp, en ms).
 */
export async function avisarTrabajoFallido(
  datos: unknown,
  jobId: string,
  encoladoEn: number,
  err: Error,
  deps: Pick<
    DependenciasProcesador,
    'enviar' | 'logger' | 'estadoTrasFallo' | 'marcarMostrada'
  >,
): Promise<void> {
  const interrumpido = err.message === 'job stalled more than allowable limit';
  deps.logger.error(
    `Trabajo ${jobId} fallido${interrumpido ? ' por un reinicio' : ''}: ${describirError(err)}`,
  );
  const destino = z.object({ chatId: z.number().int() }).safeParse(datos);
  if (!destino.success) return;
  const { chatId } = destino.data;

  let estado: RespuestaConversacion | null = null;
  try {
    estado = await deps.estadoTrasFallo(chatId, new Date(encoladoEn));
  } catch (errEstado) {
    deps.logger.warn(
      `Trabajo ${jobId}: no se pudo leer el estado del borrador: ${describirError(errEstado)}`,
    );
  }
  const mostrar = estado?.mostrar;
  try {
    await deps.enviar(
      chatId,
      estado?.texto ?? MENSAJES_FALLA.reinicio,
      mostrar?.aprobable
        ? { borradorId: mostrar.borradorId, version: mostrar.version }
        : null,
    );
  } catch (errEnvio) {
    deps.logger.error(
      `Trabajo ${jobId}: no se pudo avisar la falla: ${describirError(errEnvio)}`,
    );
    return;
  }
  if (mostrar) {
    try {
      await deps.marcarMostrada(mostrar.borradorId, mostrar.version);
    } catch (errMarcar) {
      deps.logger.warn(
        `Trabajo ${jobId}: falló en marcar: ${describirError(errMarcar)}`,
      );
    }
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
