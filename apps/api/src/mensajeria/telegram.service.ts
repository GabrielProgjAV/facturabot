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
import { type MensajeEntrante, responderEco } from './mensaje.js';

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

  constructor(config: ConfigService<Env, true>) {
    this.bot = new Bot(config.get('TELEGRAM_BOT_TOKEN', { infer: true }));
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
