// Prueba de integración con BullMQ y Redis reales (docs/planes/fase-4.3-cola.md §18): con
// removeOnFail: true, el evento 'failed' del Worker sigue entregando job.data (con el chatId para
// avisar al usuario) y el trabajo no se queda en Redis. Cubre los dos caminos: una falla normal y
// un trabajo stalled por reinicio. Usa una cola propia con nombre único: no toca "mensajes".
// Correr con `pnpm test:int` (necesita REDIS_URL).
import 'dotenv/config';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { OPCIONES_TRABAJO } from './cola-mensajes.service.js';
import type { TrabajoMensaje } from './procesador-mensajes.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const trabajo: TrabajoMensaje = {
  tipo: 'texto',
  chatId: 999000005, // chat ficticio
  texto: 'factura a Ferretería Ejemplo',
  vista: null,
};

const conexiones: Redis[] = [];
const conexion = () => {
  const c = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  conexiones.push(c);
  return c;
};
const workers: Worker[] = [];
let cola: Queue<TrabajoMensaje>;

beforeEach(() => {
  cola = new Queue(`prueba-fallidos-${Date.now()}`, {
    connection: conexion(),
    defaultJobOptions: OPCIONES_TRABAJO,
  });
});

afterEach(async () => {
  await Promise.all(workers.map((w) => w.close(true)));
  workers.length = 0;
  await cola.obliterate({ force: true });
  await cola.close();
  for (const c of conexiones) c.disconnect();
  conexiones.length = 0;
});

/** Espera el primer 'failed' del worker y devuelve lo que entregó el evento. */
function primerFallo(worker: Worker<TrabajoMensaje>) {
  return new Promise<{
    datos: unknown;
    id: string | undefined;
    motivo: string;
  }>((resolver) => {
    worker.on('failed', (job: Job<TrabajoMensaje> | undefined, err: Error) =>
      resolver({ datos: job?.data, id: job?.id, motivo: err.message }),
    );
  });
}

describe('removeOnFail: true con BullMQ y Redis reales', () => {
  it('falla normal: el evento trae job.data y el trabajo no queda en Redis', async () => {
    const worker = new Worker<TrabajoMensaje>(
      cola.name,
      () => Promise.reject(new Error('falla simulada')),
      { connection: conexion(), concurrency: 1, maxStalledCount: 0 },
    );
    workers.push(worker);
    const fallo = primerFallo(worker);

    const job = await cola.add('mensaje', trabajo);
    const recibido = await fallo;

    expect(recibido).toEqual({
      datos: trabajo,
      id: job.id,
      motivo: 'falla simulada',
    });
    expect(await cola.getJob(job.id!)).toBeUndefined();
    expect(await cola.getFailedCount()).toBe(0);
  });

  it('trabajo stalled por reinicio: el evento trae job.data y el trabajo no queda en Redis', async () => {
    // Worker A toma el trabajo y "se cae": no renueva su lock (como un proceso que murió).
    const workerA = new Worker<TrabajoMensaje>(
      cola.name,
      () => new Promise((resolver) => setTimeout(resolver, 8000)),
      {
        connection: conexion(),
        concurrency: 1,
        lockDuration: 1000,
        skipLockRenewal: true,
        skipStalledCheck: true,
      },
    );
    workers.push(workerA);
    const activo = new Promise<void>((resolver) => {
      workerA.on('active', () => resolver());
    });
    const job = await cola.add('mensaje', trabajo);
    await activo;

    // Worker B arranca después, como la app tras el reinicio, con la configuración de producción
    // (maxStalledCount 0) y una revisión de stalled frecuente para que la prueba sea corta.
    const procesadoPorB = vi.fn();
    const workerB = new Worker<TrabajoMensaje>(cola.name, procesadoPorB, {
      connection: conexion(),
      concurrency: 1,
      maxStalledCount: 0,
      stalledInterval: 500,
    });
    workers.push(workerB);
    const recibido = await primerFallo(workerB);

    expect(recibido).toEqual({
      datos: trabajo,
      id: job.id,
      motivo: 'job stalled more than allowable limit',
    });
    // BullMQ lo falla sin volver a ejecutarlo: no se reaplica una corrección.
    expect(procesadoPorB).not.toHaveBeenCalled();
    expect(await cola.getJob(job.id!)).toBeUndefined();
    expect(await cola.getFailedCount()).toBe(0);
  }, 20_000);
});
