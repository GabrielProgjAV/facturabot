// Todos los NIT y cédulas de este archivo son ficticios.
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ORG_FICTICIA } from '../emision/alegra/token-ficticio.spec-util.js';
import { configEmisionFalsa } from '../emision/config-emision.spec-util.js';
import {
  ConversacionService,
  esComando,
  fechaCorta,
  QUIETO_MS,
  type VistaBorrador,
} from './conversacion.service.js';
import {
  type BorradorFactura,
  DatosBorradorInvalidosError,
} from './factura.js';
import type { InterpreteTextoService } from './interprete-texto.service.js';

const borrador: BorradorFactura = {
  cliente: { nombre: 'Ana', identificacion: '12345678' }, // cédula ficticia
  items: [{ descripcion: 'vinilo', valor: 50000 }],
  totalEscrito: null,
};

/** Primer mensaje con todos los datos del borrador: nada queda vacío al crear. */
const MENSAJE_NUEVO = 'factura a Ana cc 12345678, vinilo 50 mil'; // cédula ficticia

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
    // Recién escrito: un borrador de hace más de 2 horas se trata distinto (QUIETO_MS).
    actualizadoEn: new Date(),
    aprobadoEn: null,
    ...cambios,
  };
}

/**
 * Dobles de prueba: sin base de datos ni IA reales. Por defecto el token de Alegra es válido (el
 * cliente Ana, con cédula, va igual a SIN_FACTURA).
 */
function crear(pendiente: Fila | null, emision = configEmisionFalsa()) {
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
    emision: { create: vi.fn().mockResolvedValue({}) },
    // La transacción recibe el mismo doble: se comprueba qué escribe, no el aislamiento.
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const interprete = { interpretar: vi.fn().mockResolvedValue(borrador) };
  const servicio = new ConversacionService(
    prisma as unknown as PrismaService,
    interprete as unknown as InterpreteTextoService,
    emision,
  );
  return { servicio, prisma, interprete };
}

/** Lo que lleva el botón pulsado: por defecto, del borrador b1 (Ana, con cédula: sin factura). */
const boton = (
  version: number,
  borradorId = 'b1',
  destino: VistaBorrador['destino'] = 'SIN_FACTURA',
): VistaBorrador => ({ borradorId, version, destino });

const APROBACION = expect.objectContaining({
  data: expect.objectContaining({ estado: 'APROBADO' }) as unknown,
});
/** Quien pulsa el botón (usuario ficticio). */
const USUARIO = 4242;

const sinNit = {
  ...borrador,
  cliente: { nombre: 'Ana', identificacion: null },
};

describe('ConversacionService: datos de la BD validados', () => {
  // Ítem con valor en texto: forma que nunca guarda el código actual.
  const daniado = fila({
    datos: { ...borrador, items: [{ descripcion: 'vinilo', valor: '50' }] },
  });

  it('una corrección sobre un borrador con datos inválidos lanza sin llamar a la IA ni escribir', async () => {
    const { servicio, prisma, interprete } = crear(daniado);

    await expect(
      servicio.responder(42, 'el total es 50 mil'),
    ).rejects.toBeInstanceOf(DatosBorradorInvalidosError);
    expect(interprete.interpretar).not.toHaveBeenCalled();
    expect(prisma.borrador.update).not.toHaveBeenCalled();
  });

  it('el botón sobre un borrador con datos inválidos no aprueba', async () => {
    const { servicio, prisma } = crear(daniado);

    await expect(
      servicio.aprobar(42, boton(1), USUARIO),
    ).rejects.toBeInstanceOf(DatosBorradorInvalidosError);
    expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
  });

  it('"cancelar" sí funciona: es la salida que se le ofrece al usuario', async () => {
    const { servicio, prisma } = crear(daniado);

    const respuesta = await servicio.responder(42, 'cancelar');

    expect(prisma.borrador.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { estado: 'CANCELADO' },
    });
    expect(respuesta.texto).toContain('Borrador cancelado');
  });
});

describe('ConversacionService', () => {
  describe('crear y corregir', () => {
    it('sin borrador pendiente, crea uno nuevo y pide mostrar la versión 1 con el botón', async () => {
      const { servicio, prisma, interprete } = crear(null);

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

      expect(interprete.interpretar).toHaveBeenCalledWith(
        MENSAJE_NUEVO,
        undefined,
      );
      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: { chatId: 42n, datos: borrador },
      });
      expect(respuesta.texto).toContain('Ana');
      expect(respuesta.texto).toContain('Toca 📝 Registrar sin factura');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'nuevo',
        version: 1,
        aprobable: true,
        destino: 'SIN_FACTURA',
      });
    });

    it('con borrador pendiente, lo corrige y sube la versión', async () => {
      const { servicio, prisma, interprete } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.responder(42, 'el nit es 12345678');

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'el nit es 12345678',
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
        destino: 'SIN_FACTURA',
      });
    });

    it('un borrador al que le falta un dato no es aprobable: no lleva botón y dice qué falta', async () => {
      const { servicio, interprete } = crear(null);
      interprete.interpretar.mockResolvedValueOnce(sinNit);

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

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
      // Al corregir el ganador, la IA conserva su total (si lo perdiera, se preguntaría).
      const corregido = { ...borrador, totalEscrito: 80000 };
      interprete.interpretar
        .mockResolvedValueOnce(borrador)
        .mockResolvedValueOnce(corregido);
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
        data: { datos: corregido, version: { increment: 1 } },
      });
      expect(prisma.borrador.create).toHaveBeenCalledTimes(1);
    });

    it('una corrección que hace desaparecer un ítem sin pedirlo no se guarda y se pregunta', async () => {
      const dos: BorradorFactura = {
        ...borrador,
        items: [...borrador.items, { descripcion: 'brocha', valor: 12000 }],
      };
      const { servicio, prisma, interprete } = crear(fila({ datos: dos }));
      interprete.interpretar.mockResolvedValueOnce(borrador); // la IA "olvidó" la brocha

      const respuesta = await servicio.responder(42, 'el nit es 12345678');

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección desaparecían 1 producto\(s\), y tu mensaje no pide quitarlos por su nombre: brocha\./,
      );
      expect(respuesta.texto).toContain('No cambié el borrador');
      // El resumen es el mismo que ya tenía: misma versión, con su botón.
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 1,
        aprobable: true,
        destino: 'SIN_FACTURA',
      });
    });

    it('si el mensaje pide quitar el ítem, la corrección se guarda', async () => {
      const dos: BorradorFactura = {
        ...borrador,
        items: [...borrador.items, { descripcion: 'brocha', valor: 12000 }],
      };
      const { servicio, prisma, interprete } = crear(fila({ datos: dos }));
      interprete.interpretar.mockResolvedValueOnce(borrador);

      await servicio.responder(42, 'quita la brocha');

      expect(prisma.borrador.update).toHaveBeenCalled();
    });

    it('"quita" sin nombrar el ítem que se va: no se guarda y se pregunta (hallazgo 4)', async () => {
      const dos: BorradorFactura = {
        ...borrador,
        items: [...borrador.items, { descripcion: 'brocha', valor: 12000 }],
      };
      const { servicio, prisma, interprete } = crear(fila({ datos: dos }));
      interprete.interpretar.mockResolvedValueOnce(borrador);

      const respuesta = await servicio.responder(42, 'quita el rodillo');

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain('no pide quitarlos por su nombre');
    });

    it('una corrección que cambia un valor que el mensaje no dice: no se guarda y se pregunta (hallazgo 5)', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        cliente: { nombre: 'Ana', identificacion: '12345679' }, // cédula ficticia
        items: [{ descripcion: 'vinilo', valor: 55000 }], // la IA cambió el vinilo
      });

      const respuesta = await servicio.responder(42, 'el nit es 12345679');

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección, vinilo pasaba de \$\s50\.000 a \$\s55\.000, y tu mensaje no dice ese valor para ese producto\./,
      );
      expect(respuesta.texto).toContain('No cambié el borrador');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 1,
        aprobable: true,
        destino: 'SIN_FACTURA',
      });
    });

    it('un ítem nuevo con un valor que el mensaje no dice: no se guarda y avisa que aparecía', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        items: [...borrador.items, { descripcion: 'brocha', valor: 12000 }],
      });

      const respuesta = await servicio.responder(42, 'agrega una brocha');

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección aparecía brocha con \$\s12\.000, y ese valor no está en tu mensaje\./,
      );
    });

    it('si el mensaje dice el valor nuevo, la corrección se guarda', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        items: [{ descripcion: 'vinilo', valor: 55000 }],
      });

      await servicio.responder(42, 'el vinilo a 55 mil');

      expect(prisma.borrador.update).toHaveBeenCalled();
    });

    it('los logs de una corrección descartada no llevan descripciones ni valores', async () => {
      const { servicio, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        items: [{ descripcion: 'vinilo', valor: 55000 }],
      });
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await servicio.responder(42, 'x');

      expect(warn).toHaveBeenCalledWith(
        'Corrección descartada: 0 ítems desaparecían, 0 se reemplazaban, 1 valores cambiaban y cambiaban [], sin que el mensaje lo pidiera',
      );
      warn.mockRestore();
    });

    it('caso f: la IA reemplaza un ítem que el mensaje no nombra: no se guarda y se pregunta', async () => {
      const conEstuco: BorradorFactura = {
        cliente: { nombre: 'Marta', identificacion: null },
        items: [{ descripcion: 'estuco', valor: 40000 }],
        totalEscrito: null,
      };
      const { servicio, prisma, interprete } = crear(
        fila({ datos: conEstuco }),
      );
      interprete.interpretar.mockResolvedValueOnce({
        ...conEstuco,
        items: [{ descripcion: '3 galones de vinilo', valor: 40000 }],
      });

      const respuesta = await servicio.responder(
        42,
        'el vinilo son 3 galones y quita la brocha',
      );

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección se cambiaba por otro producto: estuco, y tu mensaje no lo nombra\./,
      );
    });

    it('un reemplazo pedido por su nombre sí se guarda', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        items: [{ descripcion: 'esmalte', valor: 50000 }],
      });

      await servicio.responder(42, 'cambia el vinilo por esmalte');

      expect(prisma.borrador.update).toHaveBeenCalled();
    });

    it('una identificación que la IA cambia sin que el mensaje la diga: no se guarda, se pregunta y el log no la lleva', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        cliente: { nombre: 'Ana', identificacion: '87654321' }, // cédula ficticia inventada
      });
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const respuesta = await servicio.responder(42, 'el cliente es Ana');

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección, el NIT o la cédula pasaba de 12345678 a 87654321, y tu mensaje no dice ese número\./,
      );
      expect(warn).toHaveBeenCalledWith(
        'Corrección descartada: 0 ítems desaparecían, 0 se reemplazaban, 0 valores cambiaban y cambiaban [identificacion], sin que el mensaje lo pidiera',
      );
      warn.mockRestore();
    });

    it('un total que la IA cambia sin que el mensaje lo diga: no se guarda y se pregunta', async () => {
      const { servicio, prisma, interprete } = crear(fila());
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        totalEscrito: 60000,
      });

      const respuesta = await servicio.responder(
        42,
        'el total es lo que te dije',
      );

      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^⚠️ Con tu corrección, el total pasaba de \(ninguno\) a \$\s60\.000, y tu mensaje no dice ese valor después de "total"\./,
      );
    });

    it('al crear, lo que la IA inventó queda vacío, se avisa y el log no lleva valores', async () => {
      const { servicio, prisma } = crear(null);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      // La IA devuelve cédula y valor, pero el mensaje no los trae.
      const respuesta = await servicio.responder(
        42,
        'factura a Ana por vinilo',
      );

      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: {
          chatId: 42n,
          datos: {
            // Marcado: un cliente vaciado no es consumidor final.
            cliente: { nombre: 'Ana', identificacion: null, vaciado: true },
            items: [{ descripcion: 'vinilo', valor: null }],
            totalEscrito: null,
          },
        },
      });
      expect(respuesta.texto).toMatch(
        /^⚠️ Entendí datos que no están escritos en tu mensaje y los dejé vacíos \(❓\): NIT o cédula: 12345678; vinilo: \$\s50\.000\. Si son correctos, escríbelos\./,
      );
      expect(respuesta.mostrar?.aprobable).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        'Borrador nuevo: 2 datos que no estaban en el mensaje quedaron vacíos [identificacion, item]',
      );
      warn.mockRestore();
    });

    it('una nota de voz con la identificación la guarda marcada y el resumen advierte', async () => {
      const { servicio, prisma, interprete } = crear(null);
      interprete.interpretar.mockResolvedValueOnce({
        ...borrador,
        cliente: { nombre: 'Rosa', identificacion: '52111222' }, // cédula ficticia
      });

      const respuesta = await servicio.responder(
        42,
        'factura a Rosa cc 52111222, vinilo 50 mil',
        true,
      );

      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: {
          chatId: 42n,
          datos: expect.objectContaining({
            cliente: {
              nombre: 'Rosa',
              identificacion: '52111222',
              identificacionPorVoz: true,
            },
          }) as unknown,
        },
      });
      expect(respuesta.texto).toContain(
        'La identificación vino de una nota de voz',
      );
      // Solo advierte: el botón sigue.
      expect(respuesta.mostrar?.aprobable).toBe(true);
    });

    it('el mismo mensaje escrito no lleva la marca ni la advertencia', async () => {
      const { servicio, prisma } = crear(null);

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: { chatId: 42n, datos: borrador },
      });
      expect(respuesta.texto).not.toContain('nota de voz');
    });

    it('otro error al crear se propaga sin reintentar', async () => {
      const { servicio, prisma } = crear(null);
      prisma.borrador.create.mockRejectedValueOnce(new Error('sin conexión'));

      await expect(servicio.responder(42, MENSAJE_NUEVO)).rejects.toThrow(
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
        expect(respuesta.texto).toContain(
          'Para seguir, toca 📝 Registrar sin factura',
        );
        expect(respuesta.mostrar).toEqual({
          borradorId: 'b1',
          version: 2,
          aprobable: true,
          destino: 'SIN_FACTURA',
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

  describe('destino de la venta (decisiones de Gabriel del 2026-11-12)', () => {
    const consumidorFinal: BorradorFactura = {
      cliente: { nombre: null, identificacion: null },
      items: [{ descripcion: 'vinilo', valor: 50000 }],
      totalEscrito: null,
    };

    it('consumidor final con token válido: ✅ Aprobar, sin avisos', async () => {
      const { servicio } = crear(fila({ datos: consumidorFinal }));

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.texto).toContain('Cliente: consumidor final');
      expect(respuesta.texto).toContain('toca ✅ Aprobar');
      expect(respuesta.texto).not.toContain('⚠️');
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 1,
        aprobable: true,
        destino: 'PROVEEDOR',
      });
    });

    it('consumidor final con token válido: aprueba y nace la emisión PENDIENTE en la misma transacción', async () => {
      const { servicio, prisma } = crear(
        fila({ datos: consumidorFinal }),
        configEmisionFalsa({ modo: 'SOLO_BORRADOR' }),
      );

      const respuesta = await servicio.aprobar(
        42,
        boton(1, 'b1', 'PROVEEDOR'),
        USUARIO,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.borrador.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destinoFactura: 'PROVEEDOR',
          }) as unknown,
        }),
      );
      expect(prisma.emision.create).toHaveBeenCalledWith({
        data: {
          borradorId: 'b1',
          proveedor: 'ALEGRA',
          cuentaProveedor: ORG_FICTICIA,
          modo: 'SOLO_BORRADOR',
          fechaFactura: expect.any(Date) as Date,
        },
      });
      expect(respuesta.texto).toMatch(
        /^✅ Factura aprobada\nCliente: consumidor final/,
      );
      expect(respuesta.texto).toContain('Modo de prueba');
    });

    it('sin token válido: aviso de facturar a mano antes del botón, y al aprobar no hay emisión', async () => {
      const sinToken = configEmisionFalsa({ tokenValido: false });
      const { servicio, prisma } = crear(
        fila({ datos: consumidorFinal }),
        sinToken,
      );

      const resumen = await servicio.responder(42, 'sí');
      expect(resumen.mostrar?.destino).toBe('MANUAL');
      const aviso = resumen.texto.indexOf(
        '⚠️ Ahora no se pudo conectar con Alegra. Si el cliente necesita la factura ya, regístrala para hacerla a mano. Si puede esperar, escribe "cancelar" y vuelve a intentarlo más tarde.',
      );
      expect(aviso).toBeGreaterThan(-1);
      expect(aviso).toBeLessThan(
        resumen.texto.indexOf('📝 Registrar para facturar a mano'),
      );
      // Lo lee el comerciante: sin términos técnicos.
      expect(resumen.texto).not.toMatch(/token/i);

      const respuesta = await servicio.aprobar(
        42,
        boton(1, 'b1', 'MANUAL'),
        USUARIO,
      );
      expect(prisma.borrador.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destinoFactura: 'MANUAL',
          }) as unknown,
        }),
      );
      expect(prisma.emision.create).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^📝 Venta registrada para facturar a mano/,
      );
      expect(respuesta.texto).not.toMatch(/token/i);
    });

    it('el nombre del proveedor sale del adaptador, no está fijo en los textos', async () => {
      const siigo = configEmisionFalsa({ tokenValido: false });
      (siigo.proveedor as { nombre: string }).nombre = 'SIIGO';
      const { servicio } = crear(fila({ datos: consumidorFinal }), siigo);

      const resumen = await servicio.responder(42, 'sí');

      expect(resumen.texto).toContain('conectar con Siigo');
      expect(resumen.texto).not.toContain('Alegra');
    });

    it('con NIT o cédula: aviso de "no se facturará" antes del botón 📝 Registrar sin factura', async () => {
      const { servicio } = crear(fila());

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.mostrar?.destino).toBe('SIN_FACTURA');
      expect(respuesta.texto).toContain('no se facturará desde aquí');
      expect(respuesta.texto).not.toContain('✅ Aprobar');
    });

    it('a medias (nombre sin identificación): no hay botón y se pide el dato o "consumidor final"', async () => {
      const { servicio } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.mostrar?.aprobable).toBe(false);
      expect(respuesta.texto).toContain(
        'Falta: NIT o cédula del cliente. Si la venta es a consumidor final, escribe "consumidor final".',
      );
    });

    it('un cliente vaciado al crear no es consumidor final', async () => {
      const { servicio } = crear(
        fila({
          datos: {
            ...consumidorFinal,
            cliente: { nombre: null, identificacion: null, vaciado: true },
          },
        }),
      );

      const respuesta = await servicio.responder(42, 'sí');

      expect(respuesta.mostrar?.aprobable).toBe(false);
      expect(respuesta.texto).not.toContain('Cliente: consumidor final');
      expect(respuesta.texto).toContain('escribe "consumidor final"');
    });

    it('"consumidor final" sin pasar por la IA: quita nombre, identificación y la marca', async () => {
      const { servicio, prisma, interprete } = crear(
        fila({
          datos: {
            ...borrador,
            cliente: { nombre: 'Ana', identificacion: null, vaciado: true },
          },
        }),
      );

      const respuesta = await servicio.responder(42, 'Consumidor final.');

      expect(interprete.interpretar).not.toHaveBeenCalled();
      // El nombre a medias se borra y el resumen lo muestra: consumidor final no lleva nombre.
      expect(respuesta.texto).toContain('Cliente: consumidor final');
      expect(respuesta.texto).not.toContain('Ana');
      expect(respuesta.mostrar).toMatchObject({
        aprobable: true,
        destino: 'PROVEEDOR',
      });
      expect(prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: {
          datos: {
            ...borrador,
            cliente: { nombre: null, identificacion: null },
          },
          version: { increment: 1 },
        },
      });
      expect(esComando('es consumidor final')).toBe(true);
    });

    it('si el token cambió entre el resumen y el botón, no aprueba y reenvía el resumen', async () => {
      const { servicio, prisma } = crear(
        fila({ datos: consumidorFinal }),
        configEmisionFalsa({ tokenValido: false }),
      );

      // El usuario vio ✅ Aprobar (token válido); ahora el token venció.
      const respuesta = await servicio.aprobar(
        42,
        boton(1, 'b1', 'PROVEEDOR'),
        USUARIO,
      );

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(prisma.emision.create).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        /^La conexión con Alegra cambió desde ese resumen, así que no lo aprobé/,
      );
      expect(respuesta.mostrar?.destino).toBe('MANUAL');
    });

    it('si el borrador cambió al aprobar (count 0), tampoco nace la emisión', async () => {
      const { servicio, prisma } = crear(fila({ datos: consumidorFinal }));
      prisma.borrador.updateMany.mockResolvedValueOnce({ count: 0 });

      await servicio.aprobar(42, boton(1, 'b1', 'PROVEEDOR'), USUARIO);

      expect(prisma.emision.create).not.toHaveBeenCalled();
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
          destinoFactura: 'SIN_FACTURA',
        },
      });
      expect(interprete.interpretar).not.toHaveBeenCalled();
      // El título cambia: ya no es un borrador (4.4 §8). Con cédula no hay emisión.
      expect(respuesta.texto).toMatch(
        /^📝 Venta registrada sin factura\nCliente: Ana/,
      );
      expect(respuesta.texto).not.toContain('Borrador de factura');
      expect(respuesta.mostrar).toBeUndefined();
      expect(prisma.emision.create).not.toHaveBeenCalled();
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
        destino: 'SIN_FACTURA',
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
        destino: 'SIN_FACTURA',
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
        destino: 'SIN_FACTURA',
      });
    });

    it('no aprueba si falta un dato y dice qué falta', async () => {
      const { servicio, prisma } = crear(fila({ datos: sinNit }));

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(respuesta.texto).toContain('NIT o cédula');
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('borrador quieto (más de 2 horas sin escrituras, 4.4 §14.1)', () => {
    const haceMs = (ms: number) => new Date(Date.now() - ms);
    const QUIETO = haceMs(QUIETO_MS + 60_000);

    it('a la 1 h 59 min todavía corrige', async () => {
      const { servicio, prisma, interprete } = crear(
        fila({ actualizadoEn: haceMs(QUIETO_MS - 60_000) }),
      );

      await servicio.responder(42, 'agrega una brocha');

      expect(interprete.interpretar).toHaveBeenCalledWith(
        'agrega una brocha',
        borrador,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a las 2 h 01 min cancela el viejo y crea uno nuevo con el mensaje, avisando', async () => {
      const { servicio, prisma, interprete } = crear(
        fila({ actualizadoEn: QUIETO }),
      );

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

      expect(interprete.interpretar).toHaveBeenCalledWith(
        MENSAJE_NUEVO,
        undefined,
      );
      expect(prisma.borrador.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', estado: 'PENDIENTE', version: 1 },
        data: { estado: 'CANCELADO' },
      });
      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: { chatId: 42n, datos: borrador },
      });
      expect(prisma.borrador.update).not.toHaveBeenCalled();
      expect(respuesta.texto).toMatch(
        new RegExp(
          `^📝 Tenías un borrador sin aprobar del ${fechaCorta(QUIETO)} \\(Ana\\)\\. Lo dejé cancelado`,
        ),
      );
      expect(respuesta.mostrar).toEqual({
        borradorId: 'nuevo',
        version: 1,
        aprobable: true,
        destino: 'SIN_FACTURA',
      });
    });

    it('al reemplazar un quieto, el borrador nuevo también vacía lo que no está en el mensaje', async () => {
      const { servicio, prisma } = crear(fila({ actualizadoEn: QUIETO }));

      const respuesta = await servicio.responder(
        42,
        'factura a Ana por vinilo',
      );

      expect(prisma.borrador.create).toHaveBeenCalledWith({
        data: {
          chatId: 42n,
          datos: expect.objectContaining({
            cliente: { nombre: 'Ana', identificacion: null, vaciado: true },
          }) as unknown,
        },
      });
      expect(respuesta.texto).toContain(
        'Lo dejé cancelado y empecé uno nuevo con tu mensaje.\n\n⚠️ Entendí datos que no están escritos',
      );
    });

    it('quieto con datos inválidos: se cancela y se reemplaza igual, con el aviso verdadero y sin nombre', async () => {
      const { servicio, prisma } = crear(
        fila({
          actualizadoEn: QUIETO,
          datos: {
            ...borrador,
            items: [{ descripcion: 'vinilo', valor: '50' }],
          },
        }),
      );

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

      expect(prisma.borrador.updateMany).toHaveBeenCalledWith({
        where: { id: 'b1', estado: 'PENDIENTE', version: 1 },
        data: { estado: 'CANCELADO' },
      });
      expect(respuesta.texto).toMatch(
        new RegExp(
          `^📝 Tenías un borrador sin aprobar del ${fechaCorta(QUIETO)}\\. Lo dejé cancelado`,
        ),
      );
    });

    it('sin nombre de cliente, el aviso no lleva paréntesis', async () => {
      const { servicio } = crear(
        fila({
          actualizadoEn: QUIETO,
          datos: {
            ...borrador,
            cliente: { nombre: null, identificacion: null },
          },
        }),
      );

      const respuesta = await servicio.responder(42, MENSAJE_NUEVO);

      expect(respuesta.texto).toContain(`del ${fechaCorta(QUIETO)}. Lo dejé`);
    });

    it('si la IA falla, el viejo no se cancela', async () => {
      const { servicio, prisma, interprete } = crear(
        fila({ actualizadoEn: QUIETO }),
      );
      interprete.interpretar.mockRejectedValueOnce(new Error('timeout'));

      await expect(servicio.responder(42, MENSAJE_NUEVO)).rejects.toThrow(
        'timeout',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
    });

    it('si el viejo cambió antes de cancelarlo (count 0), falla sin crear el nuevo', async () => {
      const { servicio, prisma } = crear(fila({ actualizadoEn: QUIETO }));
      prisma.borrador.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(servicio.responder(42, MENSAJE_NUEVO)).rejects.toThrow(
        'cambió antes de cancelarlo',
      );
      expect(prisma.borrador.create).not.toHaveBeenCalled();
    });

    it('"cancelar" y "sí" sobre un borrador quieto funcionan como siempre', async () => {
      const cancelar = crear(fila({ actualizadoEn: QUIETO }));
      await cancelar.servicio.responder(42, 'cancelar');
      expect(cancelar.prisma.borrador.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { estado: 'CANCELADO' },
      });
      expect(cancelar.prisma.borrador.create).not.toHaveBeenCalled();

      const si = crear(fila({ actualizadoEn: QUIETO }));
      const respuesta = await si.servicio.responder(42, 'sí');
      expect(respuesta.texto).toContain(
        'Para seguir, toca 📝 Registrar sin factura',
      );
      expect(si.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('el botón Aprobar de un borrador quieto no aprueba: reenvía el resumen para revisarlo', async () => {
      const { servicio, prisma } = crear(fila({ actualizadoEn: QUIETO }));

      const respuesta = await servicio.aprobar(42, boton(1), USUARIO);

      expect(prisma.borrador.updateMany).not.toHaveBeenCalled();
      expect(respuesta.texto).toContain(
        `Este borrador es del ${fechaCorta(QUIETO)}; revísalo y aprueba de nuevo.`,
      );
      expect(respuesta.mostrar).toEqual({
        borradorId: 'b1',
        version: 1,
        aprobable: true,
        destino: 'SIN_FACTURA',
      });
    });

    it('fechaCorta usa la hora de Colombia', () => {
      // 14:15 UTC = 9:15 a. m. en Bogotá (UTC−5, sin horario de verano).
      expect(fechaCorta(new Date('2026-10-30T14:15:00Z'))).toBe(
        '30 de oct, 9:15 a. m.',
      );
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
        destino: 'SIN_FACTURA',
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
