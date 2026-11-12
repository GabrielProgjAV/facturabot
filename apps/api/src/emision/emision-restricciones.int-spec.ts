// Prueba de integración de las restricciones de la tabla emisiones (docs/planes/fase-5-alegra.md
// §4, paso 4): un mock no puede probar un índice, un CHECK ni un trigger. Necesita PostgreSQL con
// las migraciones aplicadas. Correr con `pnpm test:int`. Los chats y cuentas son ficticios.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

const CHAT = 999000101n; // chat ficticio
const CUENTA = 'cuenta-ficticia-1';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
/** Un id externo distinto en cada uso: las filas no se borran entre tests. */
let ultimoId = 0;
const idUnico = () => String(++ultimoId);

async function borrador(
  estado: 'PENDIENTE' | 'APROBADO' | 'CANCELADO' = 'APROBADO',
): Promise<string> {
  const { id } = await db.borrador.create({
    data: { chatId: CHAT, estado, datos: { n: 1 } },
  });
  return id;
}

type DatosEmision = Partial<Prisma.EmisionUncheckedCreateInput>;

/** Una emisión de un borrador APROBADO nuevo (o del que se indique). */
async function emision(datos: DatosEmision = {}, borradorId?: string) {
  return db.emision.create({
    data: {
      borradorId: borradorId ?? (await borrador()),
      proveedor: 'ALEGRA',
      cuentaProveedor: CUENTA,
      modo: 'TIMBRAR',
      fechaFactura: new Date('2026-11-10'),
      ...datos,
    },
  });
}

const creado = (): DatosEmision => ({
  estado: 'BORRADOR_CREADO',
  idExterno: idUnico(),
});
const emitida = (): DatosEmision => ({
  estado: 'EMITIDA',
  idExterno: idUnico(),
  estadoDian: 'PENDIENTE',
  emitidaEn: new Date('2026-11-10T15:00:00Z'),
});

function cambiar(id: string, data: Prisma.EmisionUncheckedUpdateInput) {
  return db.emision.update({ where: { id }, data });
}

/** El error de la base nombra la restricción o la regla del trigger que lo rechazó. */
async function rechazoDe(promesa: Promise<unknown>): Promise<string> {
  const error: unknown = await promesa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  return `${String(error)} ${JSON.stringify(error)}`;
}

afterEach(async () => {
  // Las filas no se borran (los triggers lo impiden y la base de pruebas se recrea en cada corrida):
  // los PENDIENTE que quedan se cancelan, para que el siguiente test empiece sin ninguno.
  await db.borrador.updateMany({
    where: { chatId: CHAT, estado: 'PENDIENTE' },
    data: { estado: 'CANCELADO' },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('emisiones: un borrador, una emisión', () => {
  it('una segunda emisión del mismo borrador se rechaza con P2002', async () => {
    const id = await borrador();
    await emision({}, id);

    const error: unknown = await emision({}, id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('nace en PENDIENTE, sin id externo ni datos de la DIAN', async () => {
    expect(await emision()).toMatchObject({
      estado: 'PENDIENTE',
      idExterno: null,
      numero: null,
      cufe: null,
      estadoDian: null,
    });
  });

  it('no se puede borrar un borrador que tiene emisión (ON DELETE RESTRICT)', async () => {
    const id = await borrador();
    await emision({}, id);

    const texto = await rechazoDe(db.borrador.delete({ where: { id } }));

    expect(texto).toMatch(/emisiones_borrador_id_fkey|P2003|foreign key/i);
  });

  it.each(['PENDIENTE', 'CANCELADO'] as const)(
    'no nace de un borrador %s: solo de uno APROBADO',
    async (estado) => {
      const texto = await rechazoDe(emision({}, await borrador(estado)));

      expect(texto).toContain('emisiones_borrador_aprobado');
    },
  );
});

describe('emisiones: una factura del proveedor, una emisión', () => {
  it('el mismo id externo en la misma cuenta se rechaza con P2002', async () => {
    const datos = creado();
    await emision(datos);

    const error: unknown = await emision(datos).catch((e: unknown) => e);

    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('el mismo id externo en otra cuenta sí se acepta (los ids son de cada cuenta)', async () => {
    const datos = creado();
    await emision(datos);

    await expect(
      emision({ ...datos, cuentaProveedor: 'cuenta-ficticia-2' }),
    ).resolves.toBeDefined();
  });

  it('varias emisiones sin id externo conviven (los NULL no chocan)', async () => {
    await emision();

    await expect(emision()).resolves.toBeDefined();
  });
});

describe('emisiones: restricciones CHECK', () => {
  it.each(['BORRADOR_CREADO', 'TIMBRANDO', 'RECHAZADA'] as const)(
    '%s sin id externo se rechaza',
    async (estado) => {
      const texto = await rechazoDe(emision({ estado }));

      expect(texto).toContain('emisiones_id_externo_segun_estado_check');
    },
  );

  it('EMITIDA sin id externo se rechaza', async () => {
    const texto = await rechazoDe(emision({ ...emitida(), idExterno: null }));

    expect(texto).toContain('emisiones_id_externo_segun_estado_check');
  });

  it.each(['PENDIENTE', 'CREANDO_BORRADOR', 'NO_CREADA', 'CANCELADA'] as const)(
    '%s con id externo se rechaza: lo que ya existe en el proveedor no vuelve al paso 1',
    async (estado) => {
      const texto = await rechazoDe(emision({ estado, idExterno: idUnico() }));

      expect(texto).toContain('emisiones_sin_id_externo_segun_estado_check');
    },
  );

  it.each([
    'PENDIENTE',
    'CREANDO_BORRADOR',
    'NO_CREADA',
    'DESCONOCIDO',
    'CANCELADA',
  ] as const)('%s sin id externo se acepta', async (estado) => {
    await expect(emision({ estado })).resolves.toBeDefined();
  });

  it('DESCONOCIDO con id externo se acepta (la factura no coincidió antes de timbrar)', async () => {
    await expect(
      emision({ estado: 'DESCONOCIDO', idExterno: idUnico() }),
    ).resolves.toBeDefined();
  });

  it.each(['TIMBRANDO', 'EMITIDA', 'RECHAZADA'] as const)(
    'una fila SOLO_BORRADOR no puede pasar a %s, ni con un UPDATE directo',
    async (estado) => {
      const fila = await emision({ ...creado(), modo: 'SOLO_BORRADOR' });

      const texto = await rechazoDe(
        // Con los datos de una EMITIDA completa, para que el rechazo sea por el modo.
        cambiar(fila.id, {
          estado,
          estadoDian: 'PENDIENTE',
          emitidaEn: new Date(),
        }),
      );

      expect(texto).toContain('emisiones_solo_borrador_no_timbra_check');
    },
  );

  it.each([
    ['numero', { numero: 'FE1' }],
    ['cufe', { cufe: 'abc' }],
    ['emitida_en', { emitidaEn: new Date() }],
  ] as const)(
    'una fila SOLO_BORRADOR no puede tener %s',
    async (_campo, datos) => {
      const fila = await emision({ ...creado(), modo: 'SOLO_BORRADOR' });

      const texto = await rechazoDe(cambiar(fila.id, datos));

      expect(texto).toContain('emisiones_solo_borrador_sin_timbre_check');
    },
  );

  it.each([
    ['sin emitida_en', { emitidaEn: null }],
    ['sin estado_dian', { estadoDian: null }],
  ] as const)('EMITIDA %s se rechaza', async (_caso, datos) => {
    const texto = await rechazoDe(emision({ ...emitida(), ...datos }));

    expect(texto).toContain('emisiones_emitida_completa_check');
  });

  it.each(['El cliente Ana no existe', 'HTTP_401', '', 'a'.repeat(65)])(
    'codigo_error "%s" se rechaza: solo códigos, nunca texto',
    async (codigoError) => {
      const texto = await rechazoDe(emision({ codigoError }));

      expect(texto).toContain('emisiones_codigo_error_check');
    },
  );

  it.each(['http_401', 'alegra_3226'])(
    'codigo_error "%s" se acepta',
    async (codigoError) => {
      await expect(emision({ codigoError })).resolves.toBeDefined();
    },
  );

  it.each([
    ['cuenta_proveedor', { cuentaProveedor: '' }],
    ['id_externo', { estado: 'BORRADOR_CREADO', idExterno: '' }],
  ] as const)('%s vacío se rechaza', async (_campo, datos) => {
    const texto = await rechazoDe(emision(datos));

    expect(texto).toContain('emisiones_textos_no_vacios_check');
  });
});

describe('emisiones: columnas que no cambian (trigger)', () => {
  it('modo y estado cambiados en el mismo UPDATE: una fila SOLO_BORRADOR no se vuelve TIMBRAR', async () => {
    const fila = await emision({ ...creado(), modo: 'SOLO_BORRADOR' });

    const texto = await rechazoDe(
      cambiar(fila.id, { modo: 'TIMBRAR', estado: 'TIMBRANDO' }),
    );

    expect(texto).toContain('emisiones_columnas_inmutables');
  });

  it.each([
    ['modo', { modo: 'TIMBRAR' }],
    ['cuenta_proveedor', { cuentaProveedor: 'cuenta-ficticia-2' }],
    ['proveedor', { proveedor: 'SIIGO' }],
    ['creada_en', { creadaEn: new Date('2020-01-01') }],
  ] as const)('%s no se puede cambiar', async (_columna, datos) => {
    const fila = await emision({ ...creado(), modo: 'SOLO_BORRADOR' });

    const texto = await rechazoDe(cambiar(fila.id, datos));

    expect(texto).toContain('emisiones_columnas_inmutables');
  });

  it('borrador_id no se puede cambiar: una emisión no pasa a otro borrador', async () => {
    const fila = await emision();

    const texto = await rechazoDe(
      cambiar(fila.id, { borradorId: await borrador() }),
    );

    expect(texto).toContain('emisiones_columnas_inmutables');
  });

  it.each([
    ['cambiarlo', { idExterno: '10' }],
    ['borrarlo', { idExterno: null, estado: 'DESCONOCIDO' }],
  ] as const)(
    'el id externo ya guardado no admite %s',
    async (_caso, datos) => {
      const fila = await emision(creado());

      const texto = await rechazoDe(cambiar(fila.id, datos));

      expect(texto).toContain('emisiones_id_externo_inmutable');
    },
  );

  it('el id externo se guarda una vez, al pasar a BORRADOR_CREADO', async () => {
    const fila = await emision({ estado: 'CREANDO_BORRADOR' });

    const datos = creado();

    await expect(cambiar(fila.id, datos)).resolves.toMatchObject(datos);
  });

  it('fecha_factura se puede actualizar en PENDIENTE y sin id externo', async () => {
    const fila = await emision();

    const cambiada = await cambiar(fila.id, {
      fechaFactura: new Date('2026-11-12'),
    });

    expect(cambiada.fechaFactura.toISOString().slice(0, 10)).toBe('2026-11-12');
  });

  it.each([
    ['CREANDO_BORRADOR', { estado: 'CREANDO_BORRADOR' }],
    ['DESCONOCIDO', { estado: 'DESCONOCIDO' }],
    ['BORRADOR_CREADO', creado()],
  ] as const)('fecha_factura no cambia en %s', async (_estado, datos) => {
    const fila = await emision(datos);

    const texto = await rechazoDe(
      cambiar(fila.id, { fechaFactura: new Date('2026-11-12') }),
    );

    expect(texto).toContain('emisiones_fecha_factura_inmutable');
  });
});

describe('emisiones: transiciones de estado (trigger)', () => {
  it('camino feliz: PENDIENTE → CREANDO_BORRADOR → BORRADOR_CREADO → TIMBRANDO → EMITIDA', async () => {
    const { id } = await emision();

    await cambiar(id, { estado: 'CREANDO_BORRADOR' });
    await cambiar(id, creado());
    await cambiar(id, { estado: 'TIMBRANDO' });
    await expect(
      cambiar(id, {
        estado: 'EMITIDA',
        estadoDian: 'PENDIENTE',
        emitidaEn: new Date(),
      }),
    ).resolves.toMatchObject({ estado: 'EMITIDA' });
  });

  it.each([
    'DESCONOCIDO',
    'RECHAZADA',
    'TIMBRANDO',
    'BORRADOR_CREADO',
  ] as const)('EMITIDA es final: no pasa a %s', async (estado) => {
    const fila = await emision(emitida());

    const texto = await rechazoDe(cambiar(fila.id, { estado }));

    expect(texto).toContain('emisiones_estado_final');
  });

  it('EMITIDA sí admite completar número, CUFE y estado DIAN', async () => {
    const fila = await emision(emitida());

    await expect(
      cambiar(fila.id, {
        numero: 'FE1',
        cufe: 'abc',
        estadoDian: 'ACEPTADA',
      }),
    ).resolves.toMatchObject({ estado: 'EMITIDA', estadoDian: 'ACEPTADA' });
  });

  it.each(['PENDIENTE', 'CREANDO_BORRADOR'] as const)(
    'CANCELADA es final: no vuelve a %s (se reemitiría lo ya facturado a mano)',
    async (estado) => {
      const fila = await emision({ estado: 'CANCELADA' });

      const texto = await rechazoDe(cambiar(fila.id, { estado }));

      expect(texto).toContain('emisiones_estado_final');
    },
  );

  it('PENDIENTE → CANCELADA se acepta (plan B: "ya la facturé a mano")', async () => {
    const fila = await emision();

    await expect(
      cambiar(fila.id, { estado: 'CANCELADA' }),
    ).resolves.toMatchObject({ estado: 'CANCELADA' });
  });

  it.each(['CREANDO_BORRADOR', 'NO_CREADA', 'DESCONOCIDO'] as const)(
    '%s → CANCELADA se rechaza: solo se cancela una PENDIENTE',
    async (estado) => {
      const fila = await emision({ estado });

      const texto = await rechazoDe(cambiar(fila.id, { estado: 'CANCELADA' }));

      expect(texto).toContain('emisiones_transicion_a_cancelada');
    },
  );

  it.each(['NO_CREADA', 'DESCONOCIDO'] as const)(
    '%s → PENDIENTE se acepta (reintento explícito)',
    async (estado) => {
      const fila = await emision({ estado });

      await expect(
        cambiar(fila.id, { estado: 'PENDIENTE' }),
      ).resolves.toMatchObject({ estado: 'PENDIENTE' });
    },
  );

  it('CREANDO_BORRADOR → PENDIENTE se rechaza: el POST pudo haber llegado', async () => {
    const fila = await emision({ estado: 'CREANDO_BORRADOR' });

    const texto = await rechazoDe(cambiar(fila.id, { estado: 'PENDIENTE' }));

    expect(texto).toContain('emisiones_transicion_a_pendiente');
  });

  it.each(['BORRADOR_CREADO', 'TIMBRANDO'] as const)(
    '%s no vuelve al paso 1 ni borrando el id externo',
    async (estado) => {
      const fila = await emision({ ...creado(), estado });

      const texto = await rechazoDe(
        cambiar(fila.id, { estado: 'PENDIENTE', idExterno: null }),
      );

      expect(texto).toContain('emisiones_id_externo_inmutable');
    },
  );
});

describe('borradores: lo aprobado o cancelado ya no cambia (trigger)', () => {
  it.each([
    ['datos', { datos: { n: 2 } }],
    ['version', { version: 2 }],
    ['estado', { estado: 'PENDIENTE' }],
    ['aprobado_por', { aprobadoPor: 1n }],
    ['aprobado_en', { aprobadoEn: new Date() }],
    ['chat_id', { chatId: 999000102n }],
  ] as const)('un borrador APROBADO no cambia %s', async (_columna, data) => {
    const id = await borrador('APROBADO');

    const texto = await rechazoDe(db.borrador.update({ where: { id }, data }));

    expect(texto).toContain('borradores_no_pendiente_inmutable');
  });

  it('un borrador CANCELADO no vuelve a PENDIENTE', async () => {
    const id = await borrador('CANCELADO');

    const texto = await rechazoDe(
      db.borrador.update({ where: { id }, data: { estado: 'PENDIENTE' } }),
    );

    expect(texto).toContain('borradores_no_pendiente_inmutable');
  });

  it('un borrador APROBADO sí admite marcar la versión mostrada', async () => {
    const id = await borrador('APROBADO');

    await expect(
      db.borrador.update({ where: { id }, data: { versionMostrada: 1 } }),
    ).resolves.toMatchObject({ versionMostrada: 1 });
  });

  it('un borrador PENDIENTE se corrige y se aprueba como siempre', async () => {
    const id = await borrador('PENDIENTE');

    await db.borrador.update({
      where: { id },
      data: { datos: { n: 2 }, version: { increment: 1 } },
    });
    await expect(
      db.borrador.update({
        where: { id },
        data: { estado: 'APROBADO', aprobadoPor: 1n, aprobadoEn: new Date() },
      }),
    ).resolves.toMatchObject({ estado: 'APROBADO', version: 2 });
  });
});
