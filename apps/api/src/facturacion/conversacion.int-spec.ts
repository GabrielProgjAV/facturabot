// Prueba de integración de la aprobación por versión (docs/planes/fase-4.3-cola.md §3 y §18.1)
// contra PostgreSQL real: el updateMany condicionado solo se puede probar con una base de verdad.
// El intérprete se simula: no se llama a Ollama. Correr con `pnpm test:int`.
import 'dotenv/config';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversacionService } from './conversacion.service.js';
import type { BorradorFactura } from './factura.js';
import type { InterpreteTextoService } from './interprete-texto.service.js';

const CHAT_A = 999000003; // chat ficticio
const CHAT_B = 999000004; // chat ficticio
const USUARIO = 999000006; // usuario ficticio que pulsa el botón

const borrador: BorradorFactura = {
  cliente: { nombre: 'Ferretería Ejemplo', identificacion: '900000001-2' }, // NIT ficticio (DV 2)
  items: [{ descripcion: 'vinilo', valor: 50000 }],
  totalEscrito: null,
};

/** Primer mensaje con todos los datos del borrador: nada queda vacío al crear. */
const MENSAJE_NUEVO =
  'factura a Ferretería Ejemplo NIT 900000001-2, vinilo 50 mil'; // NIT ficticio

const config = {
  get: () => process.env.DATABASE_URL,
} as unknown as ConfigService<Env, true>;
const db = new PrismaService(config);
const interprete = {
  interpretar: vi.fn().mockResolvedValue(borrador),
} as unknown as InterpreteTextoService;
const servicio = new ConversacionService(db, interprete);
/** Solo se borran las filas que creó esta prueba. */
const creadas: string[] = [];

async function crearPendiente(
  chatId: number,
  version: number,
  versionMostrada: number | null,
) {
  const fila = await db.borrador.create({
    data: {
      chatId: BigInt(chatId),
      datos: borrador as object,
      version,
      versionMostrada,
    },
  });
  creadas.push(fila.id);
  return fila;
}

/** Deja el borrador como si nadie lo hubiera tocado en 3 horas (más que QUIETO_MS). */
async function envejecer(id: string) {
  await db.$executeRaw`UPDATE borradores SET actualizado_en = now() - interval '3 hours' WHERE id = ${id}::uuid`;
}

async function estadoDe(id: string) {
  return db.borrador.findUniqueOrThrow({
    where: { id },
    select: { estado: true, version: true, versionMostrada: true },
  });
}

beforeAll(async () => {
  await db.$connect();
  const pendientes = await db.borrador.count({
    where: {
      chatId: { in: [BigInt(CHAT_A), BigInt(CHAT_B)] },
      estado: 'PENDIENTE',
    },
  });
  if (pendientes > 0) {
    throw new Error(
      'Los chats ficticios de la prueba ya tienen un PENDIENTE: revisar la base antes de seguir',
    );
  }
});

afterEach(async () => {
  await db.borrador.deleteMany({ where: { id: { in: creadas } } });
  creadas.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('aprobación por versión contra PostgreSQL', () => {
  it('flujo completo: crear, marcar como mostrada, "sí" no aprueba, el botón sí', async () => {
    const creada = await servicio.responder(CHAT_A, MENSAJE_NUEVO);
    const id = creada.mostrar!.borradorId;
    creadas.push(id);
    expect(await estadoDe(id)).toEqual({
      estado: 'PENDIENTE',
      version: 1,
      versionMostrada: null,
    });

    await servicio.marcarMostrada(id, 1);
    const si = await servicio.responder(CHAT_A, 'sí');
    expect(si.texto).toContain('toca ✅ Aprobar');
    expect((await estadoDe(id)).estado).toBe('PENDIENTE');

    const respuesta = await servicio.aprobar(
      CHAT_A,
      {
        borradorId: id,
        version: 1,
      },
      USUARIO,
    );

    expect(respuesta.texto).toContain('aprobada');
    expect((await estadoDe(id)).estado).toBe('APROBADO');
    const guardado = await db.borrador.findUniqueOrThrow({
      where: { id },
      select: { aprobadoPor: true, aprobadoEn: true },
    });
    expect(guardado.aprobadoPor).toBe(BigInt(USUARIO));
    expect(guardado.aprobadoEn).toBeInstanceOf(Date);
  });

  it('version 2, versionMostrada 1, botón de la 2: no aprueba y la fila sigue PENDIENTE', async () => {
    const fila = await crearPendiente(CHAT_A, 2, 1);

    const respuesta = await servicio.aprobar(
      CHAT_A,
      {
        borradorId: fila.id,
        version: 2,
      },
      USUARIO,
    );

    expect(respuesta.texto).toContain('ya no está vigente');
    expect(await estadoDe(fila.id)).toEqual({
      estado: 'PENDIENTE',
      version: 2,
      versionMostrada: 1,
    });
  });

  it('"cancelar" → factura nueva → botón de la vieja en cola: no aprueba el borrador nuevo', async () => {
    // El usuario pulsó el botón del resumen de A v1; al procesarlo, A está cancelado y B (v1) ya
    // se mostró.
    const a = await crearPendiente(CHAT_A, 1, 1);
    await servicio.responder(CHAT_A, 'cancelar');
    const nueva = await servicio.responder(CHAT_A, MENSAJE_NUEVO);
    const b = nueva.mostrar!.borradorId;
    creadas.push(b);
    await servicio.marcarMostrada(b, 1);

    const respuesta = await servicio.aprobar(
      CHAT_A,
      {
        borradorId: a.id,
        version: 1,
      },
      USUARIO,
    );

    expect(respuesta.texto).toContain('ya no está vigente');
    expect((await estadoDe(a.id)).estado).toBe('CANCELADO');
    expect(await estadoDe(b)).toEqual({
      estado: 'PENDIENTE',
      version: 1,
      versionMostrada: 1,
    });
  });

  it('estadoTrasFallo: con la aprobación guardada antes del corte dice que quedó aprobada', async () => {
    const desde = new Date(Date.now() - 1000);
    const fila = await crearPendiente(CHAT_A, 1, 1);
    await servicio.aprobar(
      CHAT_A,
      { borradorId: fila.id, version: 1 },
      USUARIO,
    );

    const estado = await servicio.estadoTrasFallo(CHAT_A, desde);

    expect(estado?.texto).toContain('✅ Tu factura quedó aprobada');
    // Si el trabajo cortado es posterior a la aprobación, no hay nada que decir.
    expect(
      await servicio.estadoTrasFallo(CHAT_A, new Date(Date.now() + 60_000)),
    ).toBeNull();
  });

  it('estadoTrasFallo: con un PENDIENTE devuelve su versión actual', async () => {
    const fila = await crearPendiente(CHAT_A, 2, 1);

    const estado = await servicio.estadoTrasFallo(CHAT_A, new Date());

    expect(estado?.mostrar).toEqual({
      borradorId: fila.id,
      version: 2,
      aprobable: true,
    });
  });

  it('marcarMostrada con una versión vieja no cambia nada', async () => {
    const fila = await crearPendiente(CHAT_A, 2, null);

    await servicio.marcarMostrada(fila.id, 1);

    expect((await estadoDe(fila.id)).versionMostrada).toBeNull();
  });

  it('una corrección sube la versión en la base', async () => {
    const fila = await crearPendiente(CHAT_A, 1, 1);

    const respuesta = await servicio.responder(CHAT_A, 'el vinilo vale 55.000');

    expect(respuesta.mostrar).toEqual({
      borradorId: fila.id,
      version: 2,
      aprobable: true,
    });
    expect(await estadoDe(fila.id)).toMatchObject({
      version: 2,
      versionMostrada: 1,
    });
  });

  it('borrador quieto: marcarMostrada refresca actualizado_en (base de QUIETO_MS)', async () => {
    const fila = await crearPendiente(CHAT_A, 1, 1);
    await envejecer(fila.id);
    const antes = await db.borrador.findUniqueOrThrow({
      where: { id: fila.id },
    });

    // Misma versión ya mostrada: igual cuenta como "el usuario lo acaba de ver".
    await servicio.marcarMostrada(fila.id, 1);

    const despues = await db.borrador.findUniqueOrThrow({
      where: { id: fila.id },
    });
    expect(despues.actualizadoEn.getTime()).toBeGreaterThan(
      antes.actualizadoEn.getTime() + 2 * 60 * 60 * 1000,
    );
  });

  it('borrador quieto: un mensaje lo cancela y crea uno nuevo en la misma transacción', async () => {
    const viejo = await crearPendiente(CHAT_A, 1, 1);
    await envejecer(viejo.id);

    const respuesta = await servicio.responder(CHAT_A, MENSAJE_NUEVO);
    const nuevo = respuesta.mostrar!.borradorId;
    creadas.push(nuevo);

    expect(respuesta.texto).toContain('Lo dejé cancelado');
    expect(nuevo).not.toBe(viejo.id);
    expect((await estadoDe(viejo.id)).estado).toBe('CANCELADO');
    expect(await estadoDe(nuevo)).toEqual({
      estado: 'PENDIENTE',
      version: 1,
      versionMostrada: null,
    });
  });

  it('borrador quieto: el botón viejo reenvía el resumen y el botón nuevo sí aprueba', async () => {
    const fila = await crearPendiente(CHAT_A, 1, 1);
    await envejecer(fila.id);
    const vista = { borradorId: fila.id, version: 1 };

    const reenvio = await servicio.aprobar(CHAT_A, vista, USUARIO);
    expect(reenvio.texto).toContain('revísalo y aprueba de nuevo');
    expect((await estadoDe(fila.id)).estado).toBe('PENDIENTE');

    // El procesador marca el resumen reenviado cuando Telegram confirma el envío.
    await servicio.marcarMostrada(fila.id, 1);
    const respuesta = await servicio.aprobar(CHAT_A, vista, USUARIO);

    expect(respuesta.texto).toContain('aprobada');
    expect((await estadoDe(fila.id)).estado).toBe('APROBADO');
  });

  it('si la versión cambia entre la lectura y el updateMany, no aprueba (count 0)', async () => {
    // En la base ya hay una corrección mostrada (v2), pero la lectura del botón vio la v1.
    const fila = await crearPendiente(CHAT_B, 2, 2);
    const lecturaVieja = { ...fila, version: 1, versionMostrada: 1 };
    const prismaConLecturaVieja = {
      borrador: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(lecturaVieja)
          .mockImplementation(
            (args: Parameters<typeof db.borrador.findFirst>[0]) =>
              db.borrador.findFirst(args),
          ),
        updateMany: (args: Parameters<typeof db.borrador.updateMany>[0]) =>
          db.borrador.updateMany(args),
      },
    } as unknown as PrismaService;
    const conCarrera = new ConversacionService(
      prismaConLecturaVieja,
      interprete,
    );

    const respuesta = await conCarrera.aprobar(
      CHAT_B,
      {
        borradorId: fila.id,
        version: 1,
      },
      USUARIO,
    );

    expect(respuesta.texto).not.toContain('aprobada');
    expect(respuesta.texto).toContain('ya no está vigente');
    expect((await estadoDe(fila.id)).estado).toBe('PENDIENTE');
  });
});
