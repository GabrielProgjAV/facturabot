import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  ColaMensajesService,
  EncoladoSinConfirmarError,
  LIMITE_ENCOLAR_MS,
} from './cola-mensajes.service.js';
import type { TrabajoMensaje } from './procesador-mensajes.js';

// Dobles de bullmq e ioredis: los tests unitarios nunca se conectan a Redis ni crean un Worker real.
const h = vi.hoisted(() => {
  type Manejador = (...args: unknown[]) => unknown;
  class Eventos {
    readonly manejadores = new Map<string, Manejador>();
    on(evento: string, manejador: Manejador) {
      this.manejadores.set(evento, manejador);
      return this;
    }
  }
  const registro = {
    orden: [] as string[],
    conexiones: [] as { url: string; opciones: Record<string, unknown> }[],
    colas: [] as {
      nombre: string;
      opciones: Record<string, unknown>;
      trabajos: Map<string, unknown>;
      add: ReturnType<typeof vi.fn>;
    }[],
    workers: [] as {
      nombre: string;
      procesar: (job: unknown) => Promise<void>;
      opciones: Record<string, unknown>;
      manejadores: Map<string, Manejador>;
    }[],
  };
  class Redis extends Eventos {
    disconnect = vi.fn(() => registro.orden.push('disconnect'));
    constructor(
      public url: string,
      public opciones: Record<string, unknown>,
    ) {
      super();
      registro.conexiones.push(this);
    }
  }
  class Queue {
    /** Trabajos en la cola, por id. */
    readonly trabajos = new Map<string, unknown>();
    private siguienteId = 1;
    // Imita la regla documentada de BullMQ (JobsOptions.jobId): "If you attempt to add a job
    // with an id that already exists, it will not be added". La deduplicación real la hace
    // BullMQ en Redis; este doble solo permite comprobar que le pasamos el jobId.
    add = vi.fn(
      (_nombre: string, datos: unknown, opciones?: { jobId?: string }) => {
        const id = opciones?.jobId ?? String(this.siguienteId++);
        if (!this.trabajos.has(id)) this.trabajos.set(id, datos);
        return Promise.resolve({ id });
      },
    );
    close = vi.fn(() => {
      registro.orden.push('cola.close');
      return Promise.resolve();
    });
    constructor(
      public nombre: string,
      public opciones: Record<string, unknown>,
    ) {
      registro.colas.push(this);
    }
  }
  class Worker extends Eventos {
    close = vi.fn(() => {
      registro.orden.push('worker.close');
      return Promise.resolve();
    });
    constructor(
      public nombre: string,
      public procesar: (job: unknown) => Promise<void>,
      public opciones: Record<string, unknown>,
    ) {
      super();
      registro.workers.push(this);
    }
  }
  return { registro, Redis, Queue, Worker };
});

vi.mock('ioredis', () => ({ Redis: h.Redis }));
vi.mock('bullmq', () => ({ Queue: h.Queue, Worker: h.Worker }));

const REDIS_URL = 'redis://localhost:6379';
const trabajo: TrabajoMensaje = {
  tipo: 'texto',
  chatId: 4242, // chat ficticio
  texto: 'factura a Ana',
  versionVista: null,
};

function crear() {
  const config = { get: () => REDIS_URL } as unknown as ConfigService<
    Env,
    true
  >;
  return new ColaMensajesService(config);
}

beforeEach(() => {
  h.registro.orden.length = 0;
  h.registro.conexiones.length = 0;
  h.registro.colas.length = 0;
  h.registro.workers.length = 0;
});

describe('ColaMensajesService', () => {
  it('crea la cola "mensajes" sin reintentos, con retención acotada y fallando rápido sin Redis', () => {
    crear();

    const [cola] = h.registro.colas;
    expect(cola.nombre).toBe('mensajes');
    expect(cola.opciones.defaultJobOptions).toEqual({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
    expect(h.registro.conexiones[0]).toMatchObject({
      url: REDIS_URL,
      opciones: { enableOfflineQueue: false },
    });
  });

  it('no crea el worker al construirse', () => {
    crear();

    expect(h.registro.workers).toHaveLength(0);
  });

  it('encolar sin jobId deja que BullMQ asigne uno', async () => {
    const servicio = crear();

    await servicio.encolar(trabajo);

    expect(h.registro.colas[0].add).toHaveBeenCalledWith(
      'mensaje',
      trabajo,
      {},
    );
  });

  it('encolar pasa el jobId a BullMQ', async () => {
    const servicio = crear();

    await servicio.encolar(trabajo, 'tg-1001');

    expect(h.registro.colas[0].add).toHaveBeenCalledWith('mensaje', trabajo, {
      jobId: 'tg-1001',
    });
  });

  it('dos encolados con el mismo jobId (entrega repetida) producen un solo trabajo', async () => {
    const servicio = crear();

    await servicio.encolar(trabajo, 'tg-1001');
    await servicio.encolar(trabajo, 'tg-1001');
    await servicio.encolar(trabajo, 'tg-1002');

    // La deduplicación real la hace BullMQ en Redis, mientras el primer trabajo siga en la cola.
    expect(h.registro.colas[0].trabajos.size).toBe(2);
  });

  it.each(['1001', 'tg:1001', '', 'tg 1001'])(
    'rechaza el jobId "%s" sin llamar a BullMQ (no acepta enteros ni ":")',
    async (jobId) => {
      const servicio = crear();

      await expect(servicio.encolar(trabajo, jobId)).rejects.toThrow(
        'jobId inválido',
      );
      expect(h.registro.colas[0].add).not.toHaveBeenCalled();
    },
  );

  it('si Redis no confirma a tiempo, pide esperar y reenviar si no llega el resumen', async () => {
    vi.useFakeTimers();
    try {
      const servicio = crear();
      h.registro.colas[0].add.mockReturnValueOnce(new Promise(() => {}));

      const resultado = servicio.encolar(trabajo);
      const verificacion = expect(resultado).rejects.toThrow(
        new EncoladoSinConfirmarError(),
      );
      await vi.advanceTimersByTimeAsync(LIMITE_ENCOLAR_MS);
      await verificacion;
      await expect(resultado).rejects.toBeInstanceOf(EncoladoSinConfirmarError);
      expect(new EncoladoSinConfirmarError().message).toBe(
        'No pude confirmar si recibí tu mensaje. Espera un momento: si en un minuto no te llega el resumen, reenvíalo.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('encolar propaga el error de Redis caído', async () => {
    const servicio = crear();
    h.registro.colas[0].add.mockRejectedValueOnce(
      new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      ),
    );

    await expect(servicio.encolar(trabajo)).rejects.toThrow(
      'enableOfflineQueue',
    );
  });

  it('iniciar crea un worker con concurrencia 1, sin trabajos repetidos tras un reinicio', () => {
    const servicio = crear();

    servicio.iniciar(vi.fn(), vi.fn());

    const [worker] = h.registro.workers;
    expect(worker.nombre).toBe('mensajes');
    expect(worker.opciones).toMatchObject({
      concurrency: 1,
      maxStalledCount: 0,
    });
    expect(h.registro.conexiones[1]).toMatchObject({
      url: REDIS_URL,
      opciones: { maxRetriesPerRequest: null },
    });
  });

  it('el worker pasa los datos y el id del trabajo al procesador', async () => {
    const servicio = crear();
    const procesar = vi.fn().mockResolvedValue(undefined);
    servicio.iniciar(procesar, vi.fn());

    await h.registro.workers[0].procesar({ id: '7', data: trabajo });

    expect(procesar).toHaveBeenCalledWith(trabajo, '7');
  });

  it('un trabajo fallido (p. ej. por reinicio) se le avisa al usuario', () => {
    const servicio = crear();
    const avisar = vi.fn().mockResolvedValue(undefined);
    servicio.iniciar(vi.fn(), avisar);
    const err = new Error('job stalled more than allowable limit');

    h.registro.workers[0].manejadores.get('failed')?.(
      { id: '8', data: trabajo },
      err,
    );

    expect(avisar).toHaveBeenCalledWith(trabajo, '8', err);
  });

  it('iniciar dos veces lanza un error', () => {
    const servicio = crear();
    servicio.iniciar(vi.fn(), vi.fn());

    expect(() => servicio.iniciar(vi.fn(), vi.fn())).toThrow(
      'ya está iniciado',
    );
  });

  it('al apagar cierra primero el worker, luego la cola y al final las conexiones', async () => {
    const servicio = crear();
    servicio.iniciar(vi.fn(), vi.fn());

    await servicio.onApplicationShutdown();

    expect(h.registro.orden).toEqual([
      'worker.close',
      'cola.close',
      'disconnect',
      'disconnect',
    ]);
  });

  it('apagar sin haber iniciado el worker cierra la cola', async () => {
    const servicio = crear();

    await servicio.onApplicationShutdown();

    expect(h.registro.orden).toEqual(['cola.close', 'disconnect']);
  });
});
