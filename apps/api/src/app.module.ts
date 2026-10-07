import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from './config/env.schema.js';
import { ConversacionService } from './facturacion/conversacion.service.js';
import { InterpreteTextoService } from './facturacion/interprete-texto.service.js';
import { TelegramService } from './mensajeria/telegram.service.js';
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
    InterpreteTextoService,
    ConversacionService,
    TelegramService,
  ],
})
export class AppModule {}
