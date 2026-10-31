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

const borrador: BorradorFactura = {
  cliente: { nombre: 'Ferretería Ejemplo', identificacion: '900000001' }, // NIT ficticio
  items: [{ descripcion: 'vinilo', valor: 50000 }],
  totalEscrito: null,
};

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
  it('flujo completo: crear, marcar como mostrada y aprobar con la versión vista', async () => {
    const creada = await servicio.responder(
      CHAT_A,
      'factura a Ferretería Ejemplo',
      null,
    );
    const id = creada.mostrar!.borradorId;
    creadas.push(id);
    expect(await estadoDe(id)).toEqual({
      estado: 'PENDIENTE',
      version: 1,
      versionMostrada: null,
    });

    await servicio.marcarMostrada(id, 1);
    const vista = await servicio.vistaActual(CHAT_A);
    const respuesta = await servicio.responder(CHAT_A, 'sí', vista);

    expect(vista).toEqual({ borradorId: id, version: 1 });
    expect(respuesta.texto).toContain('aprobada');
    expect((await estadoDe(id)).estado).toBe('APROBADO');
  });

  it('version 2, versionMostrada 1, versionVista 2: no aprueba y la fila sigue PENDIENTE', async () => {
    const fila = await crearPendiente(CHAT_A, 2, 1);

    const respuesta = await servicio.responder(CHAT_A, 'sí', {
      borradorId: fila.id,
      version: 2,
    });

    expect(respuesta.texto).toContain('otra vez');
    expect(await estadoDe(fila.id)).toEqual({
      estado: 'PENDIENTE',
      version: 2,
      versionMostrada: 1,
    });
  });

  it('"cancelar" → factura nueva → "sí" en cola: el "sí" no aprueba el borrador nuevo', async () => {
    // El usuario veía A v1 al escribir "sí"; al procesarlo, A está cancelado y B (v1) ya se mostró.
    const a = await crearPendiente(CHAT_A, 1, 1);
    const vistaDeA = await servicio.vistaActual(CHAT_A);
    await servicio.responder(CHAT_A, 'cancelar', null);
    const nueva = await servicio.responder(
      CHAT_A,
      'factura a Ferretería Ejemplo',
      null,
    );
    const b = nueva.mostrar!.borradorId;
    creadas.push(b);
    await servicio.marcarMostrada(b, 1);

    const respuesta = await servicio.responder(CHAT_A, 'sí', vistaDeA);

    expect(vistaDeA).toEqual({ borradorId: a.id, version: 1 });
    expect(respuesta.texto).toContain('otra vez');
    expect((await estadoDe(a.id)).estado).toBe('CANCELADO');
    expect(await estadoDe(b)).toEqual({
      estado: 'PENDIENTE',
      version: 1,
      versionMostrada: 1,
    });
  });

  it('marcarMostrada con una versión vieja no cambia nada', async () => {
    const fila = await crearPendiente(CHAT_A, 2, null);

    await servicio.marcarMostrada(fila.id, 1);

    expect((await estadoDe(fila.id)).versionMostrada).toBeNull();
  });

  it('una corrección sube la versión en la base', async () => {
    const fila = await crearPendiente(CHAT_A, 1, 1);

    const respuesta = await servicio.responder(
      CHAT_A,
      'el vinilo vale 55.000',
      null,
    );

    expect(respuesta.mostrar).toEqual({ borradorId: fila.id, version: 2 });
    expect(await estadoDe(fila.id)).toMatchObject({
      version: 2,
      versionMostrada: 1,
    });
  });

  it('si la versión cambia entre la lectura y el updateMany, no aprueba (count 0)', async () => {
    // En la base ya hay una corrección mostrada (v2), pero la lectura del "sí" vio la v1.
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

    const respuesta = await conCarrera.responder(CHAT_B, 'sí', {
      borradorId: fila.id,
      version: 1,
    });

    expect(respuesta.texto).not.toContain('aprobada');
    expect(respuesta.texto).toContain('otra vez');
    expect((await estadoDe(fila.id)).estado).toBe('PENDIENTE');
  });
});
