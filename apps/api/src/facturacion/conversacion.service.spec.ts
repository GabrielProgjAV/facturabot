// Todos los NIT y cédulas de este archivo son ficticios.
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ConversacionService, esComando } from './conversacion.service.js';
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
  actualizadoEn: Date;
  aprobadoEn: Date | null;
}

function fila(cambios: Partial<Fila> = {}): Fila {
  return {
    id: 'b1',
    chatId: 42n,
    estado: 'PENDIENTE',
    datos: borrador,
    version: 1,
    versionMostrada: 1,
    actualizadoEn: new Date('2026-11-02T20:05:00Z'),
    aprobadoEn: null,
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

/** Lo que lleva el botón "✅ Aprobar" pulsado: por defecto, del borrador b1. */
const boton = (version: number, borradorId = 'b1') => ({ borradorId, version });

const APROBACION = expect.objectContaining({
  data: expect.objectContaining({ estado: 'APROBADO' }) as unknown,
});
/** Quien pulsa el botón (usuario ficticio). */
const USUARIO = 4242;

const sinNit = {
  ...borrador,
  cliente: { nombre: 'Ana', identificacion: null },
};

describe('ConversacionService', () => {
  describe('crear y corregir', () => {
    it('sin borrador pendiente, crea uno nuevo y pide mostrar la versión 1 con el botón', async () => {
      const { servicio, prisma, interprete } = crear(null);

      const respuesta = await servicio.responder(42, 'factura a Ana');

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'factura a Ana',
        undefined,
      );
      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: { chatId: 42n, datos: borrador },
      });
      expect(respuesta.texto).toContain('Ana');
      expect(respuesta.texto).toContain('Toca ✅ Aprobar');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'nuevo',
        version: 1,
        aprobable: true,
      });
    });

    it('con borrador pendiente, lo corrige y sube la versión', async () => {
      const { servicio, prisma, interprete } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.responder(42, 'el nit es 123');

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'el nit es 123',
        sinNit,
      );
      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { datos: borrador, version: { increment: 1 } },
      });
      expect(prisma.borrador.create).not.toHaveBeenCalled();
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 2,
        aprobable: true,
      });
    });

    it('un borrador al que le falta un dato no es aprobable: no lleva botón y dice qué falta', async () => {
      const { servicio, interprete } = crear(null);
      interprete.interpretar.mockResolvedValueOnce(sinNit);

      const respuesta = await servicio.responder(42, 'factura a Ana');

      expect(respuesta.mostrar?.aprobable).toBe(false);
      expect(respuesta.texto).toContain('Escribe los datos que faltan');
      expect(respuesta.texto).not.toContain('Aprobar');
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

      await servicio.responder(42, 'agrega una brocha');

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

      await expect(servicio.responder(42, 'factura a Ana')).rejects.toThrow(
        'sin conexión',
      );
      expect(prisma.borrador.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelar', () => {
    it('"cancelar" descarta el borrador pendiente sin llamar a la IA', async () => {
      const { servicio, prisma, interprete } = crear(fila());

      const respuesta = await servicio.responder(42, ' Cancelar ');

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

      await servicio.responder(42, 'cancelar');

      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { estado: 'CANCELADO' },
      });
    });

    it.each(['Cancelar.', 'cancelar!', ' CANCELAR '])(
      '"%s" (como lo transcribe Whisper) también cancela',
      async (texto) => {
        const { servicio, prisma, interprete } = crear(fila());

        await servicio.responder(42, texto);

        expect(prisma.borrador.update).toHaveBeenCalledWith({
          where: { id: 'b1' },
          data: { estado: 'CANCELADO' },
        });
        expect(interprete.interpretar).not.toHaveBeenCalled();
      },
    );

    it('"cancelar" sin borrador pendiente solo avisa', async () => {
      const { servicio, prisma } = crear(null);

      const respuesta = await servicio.responder(42, 'cancelar');

      expect(respuesta.texto).toContain('No hay');
      expect(prisma.borrador.update).not.toHaveBeenCalled();
    });
  });

  describe('"sí" escrito o dictado: ya no aprueba (decisión 1 de la 4.4)', () => {
    it.each(['sí', 'Si', 'ok', 'dale!', 'apruebo', 'Sí.'])(
      '"%s" reenvía el resumen vigente con el botón, sin aprobar ni llamar a la IA',
      async (texto) => {
        const { servicio, prisma, interprete } = crear(
          fila({ version: 2, versionMostrada: 2 }),
        );

        const respuesta = await servicio.responder(42, texto);

        expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
        expect(interprete.interpretar).not.toHaveBeenCalled();
        expect(respuesta.texto).toContain('Para aprobar, toca ✅ Aprobar');
        expect(respuesta.mostrar).toEqual({
          borradorId: 'b1',
          version: 2,
          aprobable: true,
        });
      },
    );

    it('"sí" con un borrador incompleto: dice qué falta, sin botón', async () => {
      const { servicio, prisma } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.texto).toContain('NIT o cédula');
      expect(respuesta.mostrar?.aprobable).toBe(false);
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });

    it('"sí" sin borrador pendiente solo avisa', async () => {
      const { servicio, interprete } = crear(null);

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.texto).toContain('No hay');
      expect(interprete.interpretar).not.toHaveBeenCalled();
    });

    it('"sí, pero…" es una corrección', async () => {
      const { servicio, prisma, interprete } = crear(fila());

      await servicio.responder(42, 'sí, pero el nit es 999');

      expect(interprete.interpretar).toHaveBeenCalled();
      expect(prisma.borrador.updateMany).not.toHaveBeenCalledWith(APROBACION);
    });
  });

  describe('aprobar con el botón', () => {
    it('aprueba si version == versionMostrada == la del botón, en una escritura atómica', async () => {
      const { servicio, prisma, interprete } = crear(
        fila({ version: 2, versionMostrada: 2 }),
      );

      const respuesta = await servicio.aprobar(42, boton(2), USUARIO);

      expect(prisma.borrador.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'b1',
          estado: 'PENDIENTE',
          version: 2,
          versionMostrada: 2,
        },
        data: {
          estado: 'APROBADO',
          aprobadoPor: 4242n,
          aprobadoEn: expect.any(Date) as Date,
        },
      });
      expect(interprete.interpretar).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('aprobada');
      expect(respuesta.mostrar).toBeUndefined();
    });

    it('guardado sin envío (version 2, versionMostrada 1, botón de la 1): no aprueba y reenvía', async () => {
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 1 }),
      );

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('ya no está vigente');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 2,
        aprobable: true,
      });
    });

    it('solo versionMostrada difiere (version 2, versionMostrada 1, botón de la 2): no aprueba', async () => {
      // Aísla la condición versionMostrada === version: el botón coincide con version.
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 1 }),
      );

      const respuesta = await servicio.aprobar(42, boton(2), USUARIO);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('ya no está vigente');
    });

    it('botón de un resumen viejo (botón de la 1, ya se mostró la 2): no aprueba', async () => {
      const { servicio, prisma } = crear(
        fila({ version: 2, versionMostrada: 2 }),
      );

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('ya no está vigente');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 2,
        aprobable: true,
      });
    });

    it('misma versión pero otro borrador (botón de b1, pendiente b2): no aprueba', async () => {
      const { servicio, prisma } = crear(
        fila({ id: 'b2', version: 1, versionMostrada: 1 }),
      );

      const respuesta = await servicio.aprobar(42, boton(1, 'b1'), USUARIO);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.mostrar?.borradorId).toBe('b2');
    });

    it('sin borrador pendiente (cancelado o ya aprobado): avisa que no está vigente', async () => {
      const { servicio, prisma } = crear(null);

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(respuesta.texto).toContain('ya no está vigente');
      expect(respuesta.mostrar).toBeUndefined();
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });

    it('carrera al aprobar (updateMany con count 0): no aprueba y reenvía el resumen vigente', async () => {
      const { servicio, prisma } = crear(fila());
      prisma.borrador.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.borrador.findFirst
        .mockResolvedValueOnce(fila())
        .mockResolvedValueOnce(fila({ version: 2, versionMostrada: 1 }));

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(respuesta.texto).not.toContain('aprobada');
      expect(respuesta.texto).toContain('ya no está vigente');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 2,
        aprobable: true,
      });
    });

    it('no aprueba si falta un dato y dice qué falta', async () => {
      const { servicio, prisma } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(respuesta.texto).toContain('NIT o cédula');
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('estadoTrasFallo (trabajo cortado por un reinicio)', () => {
    const desde = new Date('2026-11-02T20:00:00Z');

    it('con un PENDIENTE: devuelve su resumen vigente con el botón', async () => {
      const { servicio } = crear(fila({ version: 3, versionMostrada: 2 }));

      const estado = await servicio.estadoTrasFallo(42, desde);

      expect(estado?.texto).toContain('No alcancé a terminar');
      expect(estado?.texto).toContain('si era una corrección');
      expect(estado?.mostrar).toEqual({
        borradorId: 'b1',
        version: 3,
        aprobable: true,
      });
    });

    it('sin PENDIENTE y el último quedó aprobado después de encolar: "quedó aprobada"', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fila({ estado: 'APROBADO' }));

      const estado = await servicio.estadoTrasFallo(42, desde);

      expect(estado?.texto).toContain('✅ Tu factura quedó aprobada');
      expect(estado?.mostrar).toBeUndefined();
      expect(prisma.borrador.findFirst).toHaveBeenLastCalledWith({
        where: { chatId: 42n },
        orderBy: { actualizadoEn: 'desc' },
      });
    });

    it('sin PENDIENTE y el último quedó cancelado después de encolar: "quedó cancelado"', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fila({ estado: 'CANCELADO' }));

      const estado = await servicio.estadoTrasFallo(42, desde);

      expect(estado?.texto).toContain('quedó cancelado');
    });

    it('usa la hora de la aprobación, no la de la última escritura', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          fila({
            estado: 'APROBADO',
            // Aprobado antes de encolar el trabajo, aunque luego se haya escrito algo más.
            aprobadoEn: new Date('2026-11-02T19:30:00Z'),
            actualizadoEn: new Date('2026-11-02T20:10:00Z'),
          }),
        );

      expect(await servicio.estadoTrasFallo(42, desde)).toBeNull();
    });

    it('el último cambio es anterior al trabajo cortado: null (aviso genérico)', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          fila({
            estado: 'APROBADO',
            actualizadoEn: new Date('2026-11-02T19:00:00Z'),
          }),
        );

      expect(await servicio.estadoTrasFallo(42, desde)).toBeNull();
    });

    it('sin ningún borrador en el chat: null', async () => {
      const { servicio } = crear(null);

      expect(await servicio.estadoTrasFallo(42, desde)).toBeNull();
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

describe('esComando', () => {
  it.each([
    ['sí', true],
    ['cancelar', true],
    ['Cancelar.', true],
    ['sí, pero el nit es 999', false],
    ['factura a Ana', false],
  ])('"%s" → %s', (texto, comando) => {
    expect(esComando(texto)).toBe(comando);
  });
});
