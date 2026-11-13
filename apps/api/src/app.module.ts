import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from './config/env.schema.js';
import {
  CONFIG_EMISION,
  configEmisionDesdeEnv,
} from './emision/config-emision.js';
import { AvisoTokenService } from './emision/alegra/aviso-token.service.js';
import { ConversacionService } from './facturacion/conversacion.service.js';
import { InterpreteTextoService } from './facturacion/interprete-texto.service.js';
import { ColaMensajesService } from './mensajeria/cola-mensajes.service.js';
import { TelegramService } from './mensajeria/telegram.service.js';
import { TranscriptorService } from './voz/transcriptor.service.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: CONFIG_EMISION,
      useFactory: configEmisionDesdeEnv,
      inject: [ConfigService],
    },
    InterpreteTextoService,
    ConversacionService,
    TranscriptorService,
    ColaMensajesService,
    AvisoTokenService,
    TelegramService,
  ],
})
export class AppModule {}
