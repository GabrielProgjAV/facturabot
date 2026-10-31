import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import {
  describirError,
  MENSAJES_FALLA,
  type TrabajoMensaje,
} from './procesador-mensajes.js';

const NOMBRE_COLA = 'mensajes';
/** Si Redis no acepta el trabajo en este tiempo, se le avisa al usuario en vez de esperar. */
export const LIMITE_ENCOLAR_MS = 5000;
/**
 * Opciones de cada trabajo. Sin reintentos de BullMQ: romperían el orden y duplicarían
 * correcciones (§2). Ni los completados ni los fallidos se quedan en Redis: el texto del cliente
 * se borra al terminar. Con `removeOnFail: { age }` el borrado era perezoso (BullMQ solo limpia
 * por antigüedad cuando otro trabajo termina en ese conjunto) y un fallido podía quedarse días.
 * El aviso al usuario no necesita el trabajo guardado: el evento 'failed' trae el job en memoria.
 */
export const OPCIONES_TRABAJO = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export type ProcesarTrabajo = (datos: unknown, jobId: string) => Promise<void>;
export type AvisarFallo = (
  datos: unknown,
  jobId: string,
  err: Error,
) => Promise<void>;

/**
 * Cola "mensajes" en Redis (BullMQ). Solo crea la Queue y el Worker: la lógica vive en
 * procesador-mensajes.ts y la entrega TelegramService al arrancar, sin dependencia circular.
 *
 * Un solo worker con concurrencia 1: el orden es global y, por lo tanto, también por chat.
 * Límite conocido: un chat espera al otro (hasta ~2 min con una nota larga). Se revisa en la
 * fase 12 (multiempresa).
 */
@Injectable()
export class ColaMensajesService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ColaMensajesService.name);
  private readonly redisUrl: string;
  private readonly conexionCola: Redis;
  private readonly cola: Queue<TrabajoMensaje>;
  private conexionWorker?: Redis;
  private worker?: Worker<TrabajoMensaje>;

  constructor(config: ConfigService<Env, true>) {
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    // enableOfflineQueue: false → con Redis caído, add() falla en el acto en vez de guardar el
    // comando en memoria hasta que vuelva.
    this.conexionCola = new Redis(this.redisUrl, { enableOfflineQueue: false });
    this.conexionCola.on('error', (err) =>
      this.logger.error(`Redis (cola): ${describirError(err)}`),
    );
    this.cola = new Queue(NOMBRE_COLA, {
      connection: this.conexionCola,
      defaultJobOptions: OPCIONES_TRABAJO,
    });
  }

  /**
   * Agrega el trabajo a la cola. Lanza el error de Redis si no pudo recibirlo, o
   * `EncoladoSinConfirmarError` si Redis no confirmó a tiempo (el trabajo pudo quedar o no).
   *
   * @param jobId identificador de la entrega (en Telegram, `tg-<update_id>`). BullMQ no agrega
   *   un trabajo cuyo jobId ya existe en la cola: así se ignora una entrega repetida del mismo
   *   mensaje mientras su trabajo siga ahí (removeOnComplete lo borra al terminar). Aparece en
   *   los logs, así que nunca debe llevar el chatId ni datos del mensaje.
   */
  async encolar(trabajo: TrabajoMensaje, jobId?: string): Promise<void> {
    if (jobId !== undefined) validarJobId(jobId);
    // Si Redis estaba caído al arrancar, BullMQ espera la primera conexión sin límite:
    // el tiempo límite garantiza que el usuario reciba una respuesta.
    await conTiempoLimite(
      this.cola.add('mensaje', trabajo, jobId ? { jobId } : {}),
      LIMITE_ENCOLAR_MS,
    );
  }

  /** Arranca el worker. Se llama una sola vez, desde TelegramService. */
  iniciar(procesar: ProcesarTrabajo, avisarFallo: AvisarFallo): void {
    if (this.worker) throw new Error('El worker de la cola ya está iniciado');
    // BullMQ exige maxRetriesPerRequest: null en el worker: sus comandos bloqueantes esperan.
    this.conexionWorker = new Redis(this.redisUrl, {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<TrabajoMensaje>(
      NOMBRE_COLA,
      (job) => procesar(job.data, job.id ?? 'sin-id'),
      {
        connection: this.conexionWorker,
        concurrency: 1,
        // Un trabajo cortado por un reinicio falla en vez de repetirse (no reaplica correcciones).
        maxStalledCount: 0,
      },
    );
    this.worker.on('failed', (job, err) => {
      if (job) void avisarFallo(job.data, job.id ?? 'sin-id', err);
    });
    this.worker.on('error', (err) =>
      this.logger.error(`Worker de la cola: ${describirError(err)}`),
    );
  }

  /**
   * Cierre ordenado: el worker termina el trabajo en curso antes de cerrar la cola.
   * Fase intermedia del apagado: después de bot.stop() (onModuleDestroy) y antes del
   * $disconnect de Prisma (onApplicationShutdown), porque el trabajo en curso usa la base.
   */
  async beforeApplicationShutdown(): Promise<void> {
    // Si cerrar el worker o la cola falla, las conexiones se cierran igual.
    try {
      try {
        await this.worker?.close();
      } finally {
        await this.cola.close();
      }
    } finally {
      // BullMQ no cierra las conexiones que recibe ya creadas.
      this.conexionWorker?.disconnect();
      this.conexionCola.disconnect();
    }
  }
}

/** Redis no confirmó el encolado a tiempo: el trabajo pudo quedar en la cola o no. */
export class EncoladoSinConfirmarError extends Error {
  override readonly name = 'EncoladoSinConfirmarError';
  constructor() {
    super(MENSAJES_FALLA.encoladoSinConfirmar);
  }
}

/**
 * BullMQ rechaza un jobId que sea un entero ("Custom Id cannot be integers") o que lleve ":".
 * Se exige que empiece por una letra, para fallar aquí con un mensaje claro.
 */
function validarJobId(jobId: string): void {
  if (!/^[A-Za-z][\w-]{0,99}$/.test(jobId)) {
    throw new Error(
      'jobId inválido: debe empezar por una letra y llevar solo letras, números, "_" o "-"',
    );
  }
}

function conTiempoLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new EncoladoSinConfirmarError()),
      ms,
    );
  });
  return Promise.race([promesa, limite]).finally(() =>
    clearTimeout(temporizador),
  );
}
