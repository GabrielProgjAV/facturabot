// Todos los NIT y cédulas de este archivo son ficticios.
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ConversacionService,
  esAprobacion,
  esComando,
} from './conversacion.service.js';
import type { BorradorFactura } from './factura.js';
import type { InterpreteTextoService } from './interprete-texto.service.js';

const borrador: BorradorFactura = {
  cliente: { nombre: 'Ana', identificacion: '123' }, // cédula ficticia
  items: [{ descripcion: 'vinilo', valor: 50000 }],
  totalEscrito: null,
};

interface Fila {
  id: string;
  chatId: bigint;
  estado: 'PENDIENTE' | 'APROBADO' | 'CANCELADO';
  datos: unknown;
  version: number;
  versionMostrada: number | null;
}

function fila(cambios: Partial<Fila> = {}): Fila {
  return {
    id: 'b1',
    chatId: 42n,
    estado: 'PENDIENTE',
    datos: borrador,
    version: 1,
    versionMostrada: 1,
    ...cambios,
  };
}

/** Dobles de prueba: sin base de datos ni IA reales. */
function crear(pendiente: Fila | null) {
  const prisma = {
    borrador: {
      findFirst: vi.fn().mockResolvedValue(pendiente),
      // create y update devuelven la fila escrita, como Prisma.
      create: vi.fn(({ data }: { data: { datos: unknown } }) =>
        Promise.resolve(
          fila({ id: 'nuevo', datos: data.datos, versionMostrada: null }),
        ),
      ),
      update: vi.fn(({ data }: { data: { datos?: unknown } }) =>
        Promise.resolve(
          fila({
            datos: data.datos ?? pendiente?.datos,
            version: (pendiente?.version ?? 1) + 1,
            versionMostrada: pendiente?.versionMostrada ?? null,
          }),
        ),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const interprete = { interpretar: vi.fn().mockResolvedValue(borrador) };
  const servicio = new ConversacionService(
    prisma as unknown as PrismaService,
    interprete as unknown as InterpreteTextoService,
  );
  return { servicio, prisma, interprete };
}

const APROBACION = expect.objectContaining({
  data: { estado: 'APROBADO' },
});

describe('ConversacionService', () => {
  describe('crear y corregir', () => {
    it('sin borrador pendiente, crea uno nuevo y pide mostrar la versión 1', async () => {
      const { servicio, prisma, interprete } = crear(null);

      const respuesta = await servicio.responder(42, 'factura a Ana', null);

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'factura a Ana',
        undefined,
      );
      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: { chatId: 42n, datos: borrador },
      });
      expect(respuesta.texto).toContain('Ana');
      expect(respuesta.mostrar).toEqual({ borradorId: 'nuevo', version: 1 });
    });

    it('con borrador pendiente, lo corrige y sube la versión', async () => {
      const anterior = {
        ...borrador,
        cliente: { nombre: 'Ana', identificacion: null },
      };
      const { servicio, prisma, interprete } = crear(fila({ datos: anterior }));

      const respuesta = await servicio.responder(42, 'el nit es 123', null);

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'el nit es 123',
        anterior,
      );
      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { datos: borrador, version: { increment: 1 } },
      });
      expect(prisma.borrador.create).not.toHaveBeenCalled();
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 2 });
    });

    it('P2002 al crear: reinterpreta el mensaje como corrección del PENDIENTE existente', async () => {
      const ganador = fila({
        id: 'ganador',
        datos: { ...borrador, totalEscrito: 80000 },
      });
      const { servicio, prisma, interprete } = crear(null);
      prisma.borrador.findFirst
        .mockResolvedValueOnce(null) // la lectura inicial no lo vio
        .mockResolvedValueOnce(ganador); // tras el P2002, sí
      prisma.borrador.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );

      await servicio.responder(42, 'agrega una brocha', null);

      expect(interprete.interpretar).toHaveBeenNthCalledWith(
        2,
        'agrega una brocha',
        ganador.datos,
      );
      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'ganador' },
        data: { datos: borrador, version: { increment: 1 } },
      });
      expect(prisma.borrador.create).toHaveBeenCalledTimes(1);
    });

    it('otro error al crear se propaga sin reintentar', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.create.mockRejectedValueOnce(new Error('sin conexión'));

      await expect(
        servicio.responder(42, 'factura a Ana', null),
      ).rejects.toThrow('sin conexión');
      expect(prisma.borrador.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelar', () => {
    it('"cancelar" descarta el borrador pendiente sin llamar a la IA', async () => {
      const { servicio, prisma, interprete } = crear(fila());

      const respuesta = await servicio.responder(42, ' Cancelar ', null);

      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { estado: 'CANCELADO' },
      });
      expect(interprete.interpretar).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('cancelado');
    });

    it('"cancelar" no exige versión: cancela aunque no se haya mostrado', async () => {
      const { servicio, prisma } = crear(
        fila({ version: 3, versionMostrada: null }),
      );

      await servicio.responder(42, 'cancelar', null);

      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { estado: 'CANCELADO' },
      });
    });

    it('"cancelar" sin borrador pendiente solo avisa', async () => {
      const { servicio, prisma } = crear(null);

      const respuesta = await servicio.responder(42, 'cancelar', null);

      expect(respuesta.texto).toContain('No hay');
      expect(prisma.borrador.update).not.toHaveBeenCalled();
    });
  });

  describe('aprobar', () => {
    it.each(['sí', 'Si', 'ok', 'dale!', 'apruebo'])(
      '"%s" aprueba si version == versionMostrada == versionVista, en una escritura atómica',
      async (texto) => {
        const { servicio, prisma, interprete } = crear(
          fila({ version: 2, versionMostrada: 2 }),
        );

        const respuesta = await servicio.responder(42, texto, 2);

        expect(prisma.borrador.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'b1',
            estado: 'PENDIENTE',
            version: 2,
            versionMostrada: 2,
          },
          data: { estado: 'APROBADO' },
        });
        expect(interprete.interpretar).not.toHaveBeenCalled();
        expect(respuesta.texto).toContain('aprobada');
        expect(respuesta.mostrar).toBeUndefined();
      },
    );

    it('guardado sin envío (version 2, versionMostrada 1): no aprueba y reenvía el resumen', async () => {
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 1 }),
      );

      const respuesta = await servicio.responder(42, 'sí', 1);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('otra vez');
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 2 });
    });

    it('solo versionMostrada difiere (version 2, versionMostrada 1, versionVista 2): no aprueba', async () => {
      // Aísla la condición versionMostrada === version: versionVista coincide con version.
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 1 }),
      );

      const respuesta = await servicio.responder(42, 'sí', 2);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('otra vez');
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 2 });
    });

    it('"sí" escrito antes de ver la corrección (versionVista 1, version 2 mostrada): no aprueba', async () => {
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 2 }),
      );

      const respuesta = await servicio.responder(42, 'sí', 1);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('otra vez');
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 2 });
    });

    it('versionVista sale de versionMostrada: corrección guardada sin enviar → "sí" → envío → no aprueba', async () => {
      // 1. Llega el "sí": hay una corrección guardada (v2) que aún no se envió (mostrada v1).
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 1 }),
      );
      const versionVista = await servicio.versionMostrada(42);
      expect(versionVista).toBe(1); // nunca `version`

      // 2. Telegram confirma el envío de la corrección antes de procesar el "sí".
      prisma.borrador.findFirst.mockResolvedValue(
        fila({ version: 2, versionMostrada: 2 }),
      );

      // 3. Se procesa el "sí": version 2 == versionMostrada 2, pero el usuario veía la 1.
      const respuesta = await servicio.responder(42, 'sí', versionVista);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalledWith(APROBACION);
      expect(respuesta.texto).toContain('otra vez');
    });

    it('borrador que nunca se mostró (versionMostrada null): el primer "sí" reenvía el resumen', async () => {
      const { servicio, prisma } = crear(fila({ versionMostrada: null }));

      const versionVista = await servicio.versionMostrada(42);
      const respuesta = await servicio.responder(42, 'sí', versionVista);

      expect(versionVista).toBeNull();
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 1 });
    });

    it('"sí" sin borrador pendiente (versionVista null) solo avisa', async () => {
      const { servicio, prisma, interprete } = crear(null);

      expect(await servicio.versionMostrada(42)).toBeNull();
      const respuesta = await servicio.responder(42, 'sí', null);

      expect(respuesta.texto).toContain('No hay');
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(interprete.interpretar).not.toHaveBeenCalled();
    });

    it('carrera al aprobar (updateMany con count 0): no aprueba y reenvía el resumen vigente', async () => {
      const { servicio, prisma } = crear(fila());
      prisma.borrador.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.borrador.findFirst
        .mockResolvedValueOnce(fila())
        .mockResolvedValueOnce(fila({ version: 2, versionMostrada: 1 }));

      const respuesta = await servicio.responder(42, 'sí', 1);

      expect(respuesta.texto).not.toContain('aprobada');
      expect(respuesta.texto).toContain('otra vez');
      expect(respuesta.mostrar).toEqual({ borradorId: 'b1', version: 2 });
    });

    it('no aprueba si falta un dato y dice qué falta', async () => {
      const sinNit = {
        ...borrador,
        cliente: { nombre: 'Ana', identificacion: null },
      };
      const { servicio, prisma } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.responder(42, 'sí', 1);

      expect(respuesta.texto).toContain('NIT o cédula');
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });

    it('"sí, pero…" no aprueba: es una corrección', async () => {
      const { servicio, prisma, interprete } = crear(fila());

      await servicio.responder(42, 'sí, pero el nit es 999', 1);

      expect(interprete.interpretar).toHaveBeenCalled();
      expect(prisma.borrador.updateMany).not.toHaveBeenCalledWith(APROBACION);
    });
  });

  describe('marcarMostrada', () => {
    it('marca solo si el borrador sigue en esa versión', async () => {
      const { servicio, prisma } = crear(null);

      await servicio.marcarMostrada('b1', 3);

      expect(prisma.borrador.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', version: 3 },
        data: { versionMostrada: 3 },
      });
    });
  });
});

describe('esComando y esAprobacion', () => {
  it.each([
    ['sí', true, true],
    ['cancelar', true, false],
    ['sí, pero el nit es 999', false, false],
    ['factura a Ana', false, false],
  ])('"%s": comando %s, aprobación %s', (texto, comando, aprobacion) => {
    expect(esComando(texto)).toBe(comando);
    expect(esAprobacion(texto)).toBe(aprobacion);
  });
});
