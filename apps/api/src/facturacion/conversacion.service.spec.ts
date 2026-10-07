import type { PrismaService } from '../prisma/prisma.service.js';
import { ConversacionService } from './conversacion.service.js';
import type { BorradorFactura } from './factura.js';
import type { InterpreteTextoService } from './interprete-texto.service.js';

const borrador: BorradorFactura = {
  cliente: { nombre: 'Ana', identificacion: '123' },
  items: [{ descripcion: 'vinilo', valor: 50000 }],
  totalEscrito: null,
};

/** Dobles de prueba: sin base de datos ni IA reales. */
function crear(pendiente: { id: string; datos: unknown } | null) {
  const prisma = {
    borrador: {
      findFirst: vi.fn().mockResolvedValue(pendiente),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const interprete = { interpretar: vi.fn().mockResolvedValue(borrador) };
  const servicio = new ConversacionService(
    prisma as unknown as PrismaService,
    interprete as unknown as InterpreteTextoService,
  );
  return { servicio, prisma, interprete };
}

describe('ConversacionService', () => {
  it('sin borrador pendiente, crea uno nuevo', async () => {
    const { servicio, prisma, interprete } = crear(null);

    const respuesta = await servicio.responder(42, 'factura a Ana');

    expect(interprete.interpretar).toHaveBeenCalledWith(
      'factura a Ana',
      undefined,
    );
    expect(prisma.borrador.create).toHaveBeenCalledWith({
      data: { chatId: 42n, datos: borrador },
    });
    expect(respuesta).toContain('Ana');
  });

  it('con borrador pendiente, lo corrige en lugar de crear otro', async () => {
    const anterior = {
      ...borrador,
      cliente: { nombre: 'Ana', identificacion: null },
    };
    const { servicio, prisma, interprete } = crear({
      id: 'b1',
      datos: anterior,
    });

    await servicio.responder(42, 'el nit es 123');

    expect(interprete.interpretar).toHaveBeenCalledWith(
      'el nit es 123',
      anterior,
    );
    expect(prisma.borrador.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { datos: borrador },
    });
    expect(prisma.borrador.create).not.toHaveBeenCalled();
  });

  it('"cancelar" descarta el borrador pendiente sin llamar a la IA', async () => {
    const { servicio, prisma, interprete } = crear({
      id: 'b1',
      datos: borrador,
    });

    const respuesta = await servicio.responder(42, ' Cancelar ');

    expect(prisma.borrador.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { estado: 'CANCELADO' },
    });
    expect(interprete.interpretar).not.toHaveBeenCalled();
    expect(respuesta).toContain('cancelado');
  });

  it('"cancelar" sin borrador pendiente solo avisa', async () => {
    const { servicio, prisma } = crear(null);

    expect(await servicio.responder(42, 'cancelar')).toContain('No hay');
    expect(prisma.borrador.update).not.toHaveBeenCalled();
  });

  it.each(['sí', 'Si', 'ok', 'dale!', 'apruebo'])(
    '"%s" aprueba un borrador completo sin llamar a la IA',
    async (texto) => {
      const { servicio, prisma, interprete } = crear({
        id: 'b1',
        datos: borrador,
      });

      const respuesta = await servicio.responder(42, texto);

      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { estado: 'APROBADO' },
      });
      expect(interprete.interpretar).not.toHaveBeenCalled();
      expect(respuesta).toContain('aprobada');
    },
  );

  it('no aprueba si falta un dato y dice qué falta', async () => {
    const sinNit = {
      ...borrador,
      cliente: { nombre: 'Ana', identificacion: null },
    };
    const { servicio, prisma } = crear({ id: 'b1', datos: sinNit });

    const respuesta = await servicio.responder(42, 'sí');

    expect(respuesta).toContain('NIT o cédula');
    expect(prisma.borrador.update).not.toHaveBeenCalled();
  });

  it('"sí, pero…" no aprueba: es una corrección', async () => {
    const { servicio, prisma, interprete } = crear({
      id: 'b1',
      datos: borrador,
    });

    await servicio.responder(42, 'sí, pero el nit es 999');

    expect(interprete.interpretar).toHaveBeenCalled();
    expect(prisma.borrador.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { estado: 'APROBADO' } }),
    );
  });

  it('"sí" sin borrador pendiente solo avisa', async () => {
    const { servicio, interprete } = crear(null);

    expect(await servicio.responder(42, 'sí')).toContain('No hay');
    expect(interprete.interpretar).not.toHaveBeenCalled();
  });
});
