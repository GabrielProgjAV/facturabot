import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.schema.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Cliente de base de datos compartido por toda la app.
 * Se conecta al arrancar y se desconecta al apagar, para no dejar conexiones abiertas.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Última fase del apagado: Nest la ejecuta después de que el worker terminó su trabajo
   * (beforeApplicationShutdown), que todavía puede escribir en la base.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
