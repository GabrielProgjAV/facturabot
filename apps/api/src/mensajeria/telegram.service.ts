import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import type { Message } from 'grammy/types';
import type { Env } from '../config/env.schema.js';
import {
  ConversacionService,
  esAprobacion,
} from '../facturacion/conversacion.service.js';
import { TranscriptorService } from '../voz/transcriptor.service.js';
import { type MensajeEntrante, responderEco } from './mensaje.js';

/** Transcribir ocupa la CPU: una nota más larga bloquearía el equipo. */
const DURACION_MAXIMA_VOZ_SEGUNDOS = 120;

/**
 * Adaptador de Telegram: traduce mensajes de Telegram a MensajeEntrante y envía la respuesta.
 * Usa long polling (el bot pregunta a Telegram por mensajes nuevos), así que no necesita
 * exponer el equipo a internet.
 */
@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot: Bot;
  private readonly token: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly conversacion: ConversacionService,
    private readonly transcriptor: TranscriptorService,
  ) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.bot = new Bot(this.token);

    // Solo los chats autorizados pasan; al resto se le dice su ID para que lo puedan autorizar.
    const permitidos = new Set(
      config.get('TELEGRAM_CHATS_PERMITIDOS', { infer: true }),
    );
    this.bot.use(async (ctx, next) => {
      if (ctx.chat && permitidos.has(ctx.chat.id)) return next();
      this.logger.warn(`Mensaje rechazado del chat ${ctx.chat?.id}`);
      if (ctx.chat)
        await ctx.reply(
          `No estás autorizado para usar este bot. Tu ID de chat es ${ctx.chat.id}.`,
        );
    });

    this.bot.on('message:text', async (ctx) => {
      await ctx.replyWithChatAction('typing');
      try {
        // Provisional hasta que la cola procese los mensajes (paso 6 del plan de la 4.3).
        const texto = ctx.message.text;
        const versionVista = esAprobacion(texto)
          ? await this.conversacion.versionMostrada(ctx.chat.id)
          : null;
        const respuesta = await this.conversacion.responder(
          ctx.chat.id,
          texto,
          versionVista,
        );
        await ctx.reply(respuesta.texto);
        // Solo después de que Telegram confirmó el envío.
        if (respuesta.mostrar) {
          await this.conversacion.marcarMostrada(
            respuesta.mostrar.borradorId,
            respuesta.mostrar.version,
          );
        }
      } catch (err) {
        this.logger.error(
          `Error interpretando texto: ${(err as Error).message}`,
        );
        await ctx.reply(
          'No pude procesar el mensaje en este momento. Intenta de nuevo en un rato.',
        );
      }
    });
    this.bot.on('message:voice', async (ctx) => {
      if (ctx.message.voice.duration > DURACION_MAXIMA_VOZ_SEGUNDOS) {
        await ctx.reply(
          `La nota de voz es muy larga. Envía una de máximo ${DURACION_MAXIMA_VOZ_SEGUNDOS / 60} minutos.`,
        );
        return;
      }
      await ctx.replyWithChatAction('typing');
      try {
        const archivo = await ctx.getFile();
        // La URL lleva el token: nunca se registra en los logs. El audio no se guarda en disco.
        const descarga = await fetch(
          `https://api.telegram.org/file/bot${this.token}/${archivo.file_path}`,
        );
        if (!descarga.ok) {
          throw new Error(`Telegram respondió ${descarga.status}`);
        }
        const audio = new Uint8Array(await descarga.arrayBuffer());
        const texto = await this.transcriptor.transcribir(audio, 'nota.ogg');
        await ctx.reply(
          texto ? `🎤 Entendí: "${texto}"` : '🎤 No escuché nada en la nota.',
        );
      } catch (err) {
        this.logger.error(
          `Error transcribiendo voz: ${(err as Error).message}`,
        );
        await ctx.reply(
          'No pude procesar la nota de voz en este momento. Intenta de nuevo en un rato.',
        );
      }
    });
    // Las fotos llegan en la fase 9; mientras tanto, se confirma la recepción.
    this.bot.on('message', (ctx) =>
      ctx.reply(responderEco(aMensajeEntrante(ctx.message))),
    );
    this.bot.catch((err) => this.logger.error(err.message));
  }

  onApplicationBootstrap(): void {
    // start() no termina mientras el bot esté escuchando, por eso no se espera con await.
    this.bot
      .start({
        onStart: (info) =>
          this.logger.log(`Bot @${info.username} escuchando (long polling)`),
      })
      .catch((err: Error) =>
        this.logger.error(`No se pudo iniciar el bot: ${err.message}`),
      );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bot.stop();
  }
}

function aMensajeEntrante(mensaje: Message): MensajeEntrante {
  if (mensaje.text) return { tipo: 'texto', texto: mensaje.text };
  if (mensaje.photo) return { tipo: 'imagen' };
  if (mensaje.voice || mensaje.audio) return { tipo: 'audio' };
  return { tipo: 'otro' };
}
