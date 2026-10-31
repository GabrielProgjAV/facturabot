import { Test } from '@nestjs/testing';
import { ColaMensajesService } from './mensajeria/cola-mensajes.service.js';
import { TelegramService } from './mensajeria/telegram.service.js';
import { PrismaService } from './prisma/prisma.service.js';

/**
 * Orden de apagado (docs/planes/fase-4.3-cola.md §18.1): Nest ejecuta todos los onModuleDestroy,
 * luego todos los beforeApplicationShutdown y al final todos los onApplicationShutdown. Se usa el
 * ciclo de vida real de Nest con instancias sin constructor (no se conecta nada) y los hooks
 * espiados en el prototipo.
 */
describe('orden de apagado', () => {
  afterEach(() => vi.restoreAllMocks());

  it('primero deja de recibir mensajes, luego cierra el worker y al final la base', async () => {
    const orden: string[] = [];
    vi.spyOn(TelegramService.prototype, 'onModuleDestroy').mockImplementation(
      () => {
        orden.push('bot.stop');
        return Promise.resolve();
      },
    );
    vi.spyOn(
      ColaMensajesService.prototype,
      'beforeApplicationShutdown',
    ).mockImplementation(async () => {
      // El worker tarda en terminar su trabajo: Prisma debe esperar.
      await new Promise((resolve) => setTimeout(resolve, 20));
      orden.push('worker.close');
    });
    vi.spyOn(
      PrismaService.prototype,
      'onApplicationShutdown',
    ).mockImplementation(() => {
      orden.push('prisma.$disconnect');
      return Promise.resolve();
    });
    const sinConstructor = <T>(clase: abstract new (...args: never[]) => T) =>
      Object.create(clase.prototype) as T;

    const modulo = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: sinConstructor(PrismaService) },
        {
          provide: ColaMensajesService,
          useValue: sinConstructor(ColaMensajesService),
        },
        { provide: TelegramService, useValue: sinConstructor(TelegramService) },
      ],
    }).compile();
    const app = modulo.createNestApplication();
    await app.close();

    expect(orden).toEqual(['bot.stop', 'worker.close', 'prisma.$disconnect']);
  });
});
