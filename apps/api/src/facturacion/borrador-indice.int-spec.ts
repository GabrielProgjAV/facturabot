// Prueba de integración del índice único parcial borradores_chat_id_pendiente_key
// (docs/planes/fase-4.3-cola.md §4, condición 2 de §15). Necesita PostgreSQL con las
// migraciones aplicadas: un mock no puede probar un índice. Correr con `pnpm test:int`.
//
// Si se sube Prisma (hoy fijado en 7.10.0 por la preview feature partialIndexes), esta
// prueba debe seguir en verde.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

const CHAT_A = 999000001n; // chat ficticio
const CHAT_B = 999000002n; // chat ficticio

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
/** Solo se borran las filas que creó esta prueba. */
const creadas: string[] = [];

async function crearBorrador(
  chatId: bigint,
  estado: 'PENDIENTE' | 'APROBADO' | 'CANCELADO' = 'PENDIENTE',
) {
  const fila = await db.borrador.create({
    data: { chatId, estado, datos: {} },
  });
  creadas.push(fila.id);
  return fila;
}

beforeAll(async () => {
  const pendientes = await db.borrador.count({
    where: { chatId: { in: [CHAT_A, CHAT_B] }, estado: 'PENDIENTE' },
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

describe('índice único parcial: a lo sumo un PENDIENTE por chat', () => {
  it('rechaza un segundo PENDIENTE del mismo chat con P2002', async () => {
    await crearBorrador(CHAT_A);

    const error: unknown = await crearBorrador(CHAT_A).catch((e: unknown) => e);

    // Solo se compara el code: con un índice parcial, Prisma no rellena meta.target.
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('acepta un PENDIENTE en otro chat', async () => {
    await crearBorrador(CHAT_A);

    await expect(crearBorrador(CHAT_B)).resolves.toMatchObject({
      estado: 'PENDIENTE',
    });
  });

  it('acepta APROBADO y CANCELADO del mismo chat junto a su PENDIENTE', async () => {
    await crearBorrador(CHAT_A);

    await expect(crearBorrador(CHAT_A, 'APROBADO')).resolves.toBeDefined();
    await expect(crearBorrador(CHAT_A, 'CANCELADO')).resolves.toBeDefined();
    await expect(crearBorrador(CHAT_A, 'APROBADO')).resolves.toBeDefined();
  });

  it('un borrador nuevo empieza en version 1 y sin versión mostrada', async () => {
    const fila = await crearBorrador(CHAT_A);

    expect(fila.version).toBe(1);
    expect(fila.versionMostrada).toBeNull();
  });
});
