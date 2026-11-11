// Prueba de integración de las restricciones de la tabla emisiones (docs/planes/fase-5-alegra.md
// §4, paso 4): un mock no puede probar un índice ni un CHECK. Necesita PostgreSQL con las
// migraciones aplicadas. Correr con `pnpm test:int`. Los chats y cuentas son ficticios.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

const CHAT = 999000101n; // chat ficticio
const CUENTA = 'cuenta-ficticia-1';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
/** Solo se borran las filas que creó esta prueba (primero emisiones: la FK es RESTRICT). */
const borradores: string[] = [];

async function borradorAprobado(): Promise<string> {
  const { id } = await db.borrador.create({
    data: { chatId: CHAT, estado: 'APROBADO', datos: {} },
  });
  borradores.push(id);
  return id;
}

function emision(
  borradorId: string,
  datos: Partial<Prisma.EmisionUncheckedCreateInput> = {},
) {
  return db.emision.create({
    data: {
      borradorId,
      proveedor: 'ALEGRA',
      cuentaProveedor: CUENTA,
      modo: 'TIMBRAR',
      fechaFactura: new Date('2026-11-10'),
      ...datos,
    },
  });
}

/** El error de la base nombra la restricción que lo rechazó. */
async function rechazoDe(promesa: Promise<unknown>): Promise<string> {
  const error: unknown = await promesa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return `${String(error)} ${JSON.stringify(error)}`;
}

afterEach(async () => {
  await db.emision.deleteMany({ where: { borradorId: { in: borradores } } });
  await db.borrador.deleteMany({ where: { id: { in: borradores } } });
  borradores.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('emisiones: un borrador, una emisión', () => {
  it('una segunda emisión del mismo borrador se rechaza con P2002', async () => {
    const id = await borradorAprobado();
    await emision(id);

    const error: unknown = await emision(id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('nace en PENDIENTE, sin id externo ni datos de la DIAN', async () => {
    const fila = await emision(await borradorAprobado());

    expect(fila).toMatchObject({
      estado: 'PENDIENTE',
      idExterno: null,
      numero: null,
      cufe: null,
      estadoDian: null,
    });
  });

  it('no se puede borrar un borrador que tiene emisión (ON DELETE RESTRICT)', async () => {
    const id = await borradorAprobado();
    await emision(id);

    const texto = await rechazoDe(db.borrador.delete({ where: { id } }));

    expect(texto).toMatch(/emisiones_borrador_id_fkey|P2003|foreign key/i);
  });
});

describe('emisiones: una factura del proveedor, una emisión', () => {
  it('el mismo id externo en la misma cuenta se rechaza con P2002', async () => {
    await emision(await borradorAprobado(), {
      estado: 'BORRADOR_CREADO',
      idExterno: '7',
    });

    const error: unknown = await emision(await borradorAprobado(), {
      estado: 'BORRADOR_CREADO',
      idExterno: '7',
    }).catch((e: unknown) => e);

    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('el mismo id externo en otra cuenta sí se acepta (los ids son de cada cuenta)', async () => {
    await emision(await borradorAprobado(), {
      estado: 'BORRADOR_CREADO',
      idExterno: '7',
    });

    await expect(
      emision(await borradorAprobado(), {
        estado: 'BORRADOR_CREADO',
        idExterno: '7',
        cuentaProveedor: 'cuenta-ficticia-2',
      }),
    ).resolves.toBeDefined();
  });

  it('varias emisiones sin id externo conviven (los NULL no chocan)', async () => {
    await emision(await borradorAprobado());

    await expect(emision(await borradorAprobado())).resolves.toBeDefined();
  });
});

describe('emisiones: CHECK escritos a mano en la migración', () => {
  it.each(['BORRADOR_CREADO', 'TIMBRANDO', 'EMITIDA', 'RECHAZADA'] as const)(
    '%s sin id externo se rechaza',
    async (estado) => {
      const texto = await rechazoDe(
        emision(await borradorAprobado(), { estado }),
      );

      expect(texto).toContain('emisiones_id_externo_segun_estado_check');
    },
  );

  it.each([
    'PENDIENTE',
    'CREANDO_BORRADOR',
    'NO_CREADA',
    'DESCONOCIDO',
    'CANCELADA',
  ] as const)('%s sin id externo se acepta', async (estado) => {
    await expect(
      emision(await borradorAprobado(), { estado }),
    ).resolves.toBeDefined();
  });

  it.each(['TIMBRANDO', 'EMITIDA', 'RECHAZADA'] as const)(
    'una fila SOLO_BORRADOR no puede pasar a %s, ni con un UPDATE directo',
    async (estado) => {
      const fila = await emision(await borradorAprobado(), {
        modo: 'SOLO_BORRADOR',
        estado: 'BORRADOR_CREADO',
        idExterno: '9',
      });

      const texto = await rechazoDe(
        db.emision.update({ where: { id: fila.id }, data: { estado } }),
      );

      expect(texto).toContain('emisiones_solo_borrador_no_timbra_check');
    },
  );

  it('una fila TIMBRAR sí pasa de BORRADOR_CREADO a TIMBRANDO y a EMITIDA', async () => {
    const fila = await emision(await borradorAprobado(), {
      estado: 'BORRADOR_CREADO',
      idExterno: '9',
    });

    await db.emision.update({
      where: { id: fila.id },
      data: { estado: 'TIMBRANDO' },
    });
    await expect(
      db.emision.update({
        where: { id: fila.id },
        data: { estado: 'EMITIDA' },
      }),
    ).resolves.toMatchObject({ estado: 'EMITIDA' });
  });
});
