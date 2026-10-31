import { setTimeout as esperar } from 'node:timers/promises';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type { Env } from '../config/env.schema.js';
import {
  ConversacionService,
  esAprobacion,
  esComando,
  type VistaBorrador,
} from '../facturacion/conversacion.service.js';
import { TranscriptorService } from '../voz/transcriptor.service.js';
import {
  ColaMensajesService,
  EncoladoSinConfirmarError,
} from './cola-mensajes.service.js';
import { type MensajeEntrante, responderEco } from './mensaje.js';
import {
  avisarTrabajoFallido,
  type DependenciasProcesador,
  describirError,
  LIMITE_TEXTO,
  MENSAJES_FALLA,
  procesarMensaje,
  TAMANO_MAXIMO_VOZ_BYTES,
  type TrabajoMensaje,
  VozDemasiadoPesadaError,
} from './procesador-mensajes.js';

/** Transcribir ocupa la CPU: una nota más larga bloquearía el equipo. */
const DURACION_MAXIMA_VOZ_SEGUNDOS = 120;
/** Tiempo máximo para pedirle el archivo a Telegram y descargarlo. */
const LIMITE_DESCARGA_MS = 30_000;

export const MENSAJES_RECEPCION = {
  procesando: '✍️ Procesando…',
  escuchando: '🎤 Escuchando…',
  redisCaido:
    '⚠️ No pude recibir tu mensaje ahora. Intenta de nuevo en unos minutos.',
  textoLargo: `El mensaje es muy largo (máx. ${LIMITE_TEXTO.toLocaleString('es-CO')} caracteres). Divídelo o resúmelo.`,
  vozLarga: `La nota de voz es muy larga. Envía una de máximo ${DURACION_MAXIMA_VOZ_SEGUNDOS / 60} minutos.`,
} as const;

type SenalGrammy = Parameters<Bot['api']['getFile']>[1];

/** Envía un texto al chat del mensaje recibido (en grammY, `ctx.reply`). */
type Responder = (texto: string) => Promise<unknown>;

/**
 * Adaptador de Telegram: recibe los mensajes, los encola y responde en menos de un segundo.
 * El worker de la cola los procesa en segundo plano, uno a la vez, y envía la respuesta.
 * Usa long polling (el bot pregunta a Telegram por mensajes nuevos), así que no necesita
 * exponer el equipo a internet.
 */
@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot: Bot;
  private readonly token: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly conversacion: ConversacionService,
    private readonly transcriptor: TranscriptorService,
    private readonly cola: ColaMensajesService,
  ) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.bot = new Bot(this.token);

    // Solo los chats autorizados pasan; al resto se le dice su ID para que lo puedan autorizar.
    const permitidos = new Set(
      config.get('TELEGRAM_CHATS_PERMITIDOS', { infer: true }),
    );
    this.bot.use(async (ctx, next) => {
      if (ctx.chat && permitidos.has(ctx.chat.id)) return next();
      // El chatId es un dato personal: no va al log.
      this.logger.warn('Mensaje rechazado de un chat no autorizado');
      if (ctx.chat)
        await ctx.reply(
          `No estás autorizado para usar este bot. Tu ID de chat es ${ctx.chat.id}.`,
        );
    });

    this.bot.on('message:text', (ctx) =>
      this.recibirTexto(
        ctx.chat.id,
        ctx.update.update_id,
        ctx.message.text,
        (texto) => ctx.reply(texto),
      ),
    );
    this.bot.on('message:voice', (ctx) =>
      this.recibirVoz(
        ctx.chat.id,
        ctx.update.update_id,
        ctx.message.voice,
        (texto) => ctx.reply(texto),
      ),
    );
    // Las fotos llegan en la fase 9; mientras tanto, se confirma la recepción.
    this.bot.on('message', (ctx) =>
      ctx.reply(responderEco(aMensajeEntrante(ctx.message))),
    );
    this.bot.catch((err) =>
      this.logger.error(`Error del bot: ${describirError(err.error)}`),
    );
  }

  /** Valida un texto, captura lo que el usuario veía si es un "sí" y lo encola. */
  async recibirTexto(
    chatId: number,
    updateId: number,
    texto: string,
    responder: Responder,
  ): Promise<void> {
    if (texto.length > LIMITE_TEXTO) {
      await this.avisar(responder, MENSAJES_RECEPCION.textoLargo);
      return;
    }
    const vista = esAprobacion(texto)
      ? await this.leerVista(chatId, updateId)
      : null;
    // "sí" y "cancelar" no pasan por la IA: su respuesta llega enseguida, sin aviso previo.
    if (!esComando(texto))
      await this.avisar(responder, MENSAJES_RECEPCION.procesando);
    await this.encolar(
      { tipo: 'texto', chatId, texto, vista },
      updateId,
      responder,
    );
  }

  /** Valida la duración y el tamaño de una nota de voz y la encola (solo el file_id, nunca el audio). */
  async recibirVoz(
    chatId: number,
    updateId: number,
    voz: { duration: number; file_id: string; file_size?: number },
    responder: Responder,
  ): Promise<void> {
    // Duración y tamaño no son datos personales: sirven para fijar el límite de tamaño (§18.1).
    this.logger.log(
      `tg-${updateId} voz: ${voz.duration} s, ${voz.file_size ?? 'sin'} bytes`,
    );
    if (voz.duration > DURACION_MAXIMA_VOZ_SEGUNDOS) {
      await this.avisar(responder, MENSAJES_RECEPCION.vozLarga);
      return;
    }
    // La duración la declara el cliente; el tamaño acota lo que se descarga y transcribe.
    // Si Telegram no envía file_size, se comprueba al descargar (descargarVoz).
    if (
      voz.file_size !== undefined &&
      voz.file_size > TAMANO_MAXIMO_VOZ_BYTES
    ) {
      await this.avisar(responder, MENSAJES_FALLA.vozPesada);
      return;
    }
    await this.avisar(responder, MENSAJES_RECEPCION.escuchando);
    await this.encolar(
      { tipo: 'voz', chatId, fileId: voz.file_id },
      updateId,
      responder,
    );
  }

  /** Envía un mensaje y termina sin error solo si Telegram lo confirmó. */
  async enviar(chatId: number, texto: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, texto);
  }

  /** Descarga una nota de voz a memoria. El audio nunca se guarda en disco. */
  async descargarVoz(fileId: string): Promise<Uint8Array<ArrayBuffer>> {
    const senal = AbortSignal.timeout(LIMITE_DESCARGA_MS);
    try {
      // grammY tipa la señal con el polyfill abort-controller; en ejecución acepta la nativa.
      const archivo = await this.bot.api.getFile(
        fileId,
        senal as unknown as SenalGrammy,
      );
      if (
        archivo.file_size !== undefined &&
        archivo.file_size > TAMANO_MAXIMO_VOZ_BYTES
      ) {
        throw new VozDemasiadoPesadaError();
      }
      // La URL lleva el token: nunca se registra en los logs.
      const descarga = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${archivo.file_path}`,
        { signal: senal },
      );
      if (!descarga.ok) {
        throw new Error(`Telegram respondió ${descarga.status}`);
      }
      const audio = new Uint8Array(await descarga.arrayBuffer());
      // Por si Telegram no informó el tamaño: nunca se transcribe una nota más pesada.
      if (audio.byteLength > TAMANO_MAXIMO_VOZ_BYTES) {
        throw new VozDemasiadoPesadaError();
      }
      return audio;
    } catch (err) {
      // grammY envuelve la cancelación en su propio error: se normaliza para no reintentarla.
      if (senal.aborted) {
        throw new DOMException(
          `Descarga sin respuesta en ${LIMITE_DESCARGA_MS} ms`,
          'TimeoutError',
        );
      }
      throw err;
    }
  }

  onApplicationBootstrap(): void {
    const deps = this.dependenciasProcesador();
    this.cola.iniciar(
      (datos, jobId) => procesarMensaje(datos, jobId, deps),
      (datos, jobId, err) => avisarTrabajoFallido(datos, jobId, err, deps),
    );
    // start() no termina mientras el bot esté escuchando, por eso no se espera con await.
    this.bot
      .start({
        onStart: (info) =>
          this.logger.log(`Bot @${info.username} escuchando (long polling)`),
      })
      .catch((err: Error) =>
        this.logger.error(`No se pudo iniciar el bot: ${describirError(err)}`),
      );
  }

  /**
   * Primera fase del apagado: deja de recibir mensajes. El worker sigue terminando el trabajo
   * en curso (bot.api funciona sin el long polling) y se cierra en beforeApplicationShutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.bot.stop();
  }

  private dependenciasProcesador(): DependenciasProcesador {
    return {
      responder: (chatId, texto, vista) =>
        this.conversacion.responder(chatId, texto, vista),
      marcarMostrada: (borradorId, version) =>
        this.conversacion.marcarMostrada(borradorId, version),
      descargarVoz: (fileId) => this.descargarVoz(fileId),
      transcribir: (audio) => this.transcriptor.transcribir(audio, 'nota.ogg'),
      enviar: (chatId, texto) => this.enviar(chatId, texto),
      esperar: (ms) => esperar(ms),
      logger: this.logger,
    };
  }

  /**
   * Borrador PENDIENTE y versionMostrada al recibir el "sí": lo que el usuario tenía en pantalla.
   * Nunca `version`, que puede ir por delante (§3 del plan), y siempre con el id del borrador
   * (§18): la misma versión de otro borrador no vale.
   */
  private async leerVista(
    chatId: number,
    updateId: number,
  ): Promise<VistaBorrador | null> {
    try {
      return await this.conversacion.vistaActual(chatId);
    } catch (err) {
      // Sin versión, el "sí" no aprueba: reenvía el resumen y pide confirmar otra vez.
      this.logger.warn(
        `tg-${updateId}: no se pudo leer la versión vista (${describirError(err)})`,
      );
      return null;
    }
  }

  /** Encola con el update_id como jobId: BullMQ ignora una entrega repetida del mismo mensaje. */
  private async encolar(
    trabajo: TrabajoMensaje,
    updateId: number,
    responder: Responder,
  ): Promise<void> {
    // El update_id es un contador del bot, no un dato personal. BullMQ no acepta enteros
    // como jobId, de ahí el prefijo.
    const jobId = `tg-${updateId}`;
    try {
      await this.cola.encolar(trabajo, jobId);
    } catch (err) {
      this.logger.error(
        `${jobId}: no se pudo encolar (${describirError(err)})`,
      );
      await this.avisar(
        responder,
        err instanceof EncoladoSinConfirmarError
          ? MENSAJES_FALLA.encoladoSinConfirmar
          : MENSAJES_RECEPCION.redisCaido,
      );
    }
  }

  /**
   * Respuesta inmediata del handler (aviso de recepción o rechazo). Si Telegram no la acepta,
   * solo se registra: el handler nunca lanza, y un mensaje ya encolado se procesa igual.
   */
  private async avisar(responder: Responder, texto: string): Promise<void> {
    try {
      await responder(texto);
    } catch (err) {
      this.logger.warn(`No se pudo enviar el aviso (${describirError(err)})`);
    }
  }
}

function aMensajeEntrante(mensaje: Message): MensajeEntrante {
  if (mensaje.text) return { tipo: 'texto', texto: mensaje.text };
  if (mensaje.photo) return { tipo: 'imagen' };
  if (mensaje.voice || mensaje.audio) return { tipo: 'audio' };
  return { tipo: 'otro' };
}
