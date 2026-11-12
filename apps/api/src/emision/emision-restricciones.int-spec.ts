// Prueba de integración de las reglas de la base para borradores y emisiones (plan de la fase 5 §4;
// migraciones crear_emisiones, proteger_emisiones y cerrar_emisiones). Un mock no puede probar un
// índice, un CHECK ni un trigger. Corre sobre la base de pruebas (_test), recreada en cada corrida:
// las filas no se borran (los triggers lo impiden). Chats, cuentas e ids son ficticios.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

const CHAT = 999000101n; // chat ficticio
const CUENTA = 'cuenta-ficticia-1';
const USUARIO = 999000111n; // usuario ficticio que pulsa los botones

type Estado = Prisma.EmisionUncheckedCreateInput['estado'];
type Destino = 'PROVEEDOR' | 'MANUAL' | 'SIN_FACTURA';

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** Un id externo distinto en cada uso. */
let ultimoId = 0;
const idUnico = () => String(++ultimoId);

/** Un borrador que nace PENDIENTE y, si se pide, se aprueba (o cancela) como lo hace el bot. */
async function borrador(
  estado: 'PENDIENTE' | 'APROBADO' | 'CANCELADO' = 'APROBADO',
  destino: Destino = 'PROVEEDOR',
): Promise<string> {
  const { id } = await db.borrador.create({
    data: { chatId: CHAT, datos: { n: 1 }, versionMostrada: 1 },
  });
  if (estado === 'APROBADO') {
    await db.borrador.update({
      where: { id },
      data: aprobacion(destino),
    });
  } else if (estado === 'CANCELADO') {
    await db.borrador.update({ where: { id }, data: { estado: 'CANCELADO' } });
  }
  return id;
}

const aprobacion = (destino: Destino = 'PROVEEDOR') => ({
  estado: 'APROBADO' as const,
  aprobadoPor: USUARIO,
  aprobadoEn: new Date(),
  destinoFactura: destino,
});

/** Lo que hay que pasarle a cada transición para llegar a cada estado. */
const PASO: Record<string, (fila: { idExterno: string | null }) => object> = {
  PENDIENTE: () => ({ estado: 'PENDIENTE' }),
  CREANDO_BORRADOR: () => ({ estado: 'CREANDO_BORRADOR' }),
  BORRADOR_CREADO: (f) => ({
    estado: 'BORRADOR_CREADO',
    idExterno: f.idExterno ?? idUnico(),
  }),
  TIMBRANDO: () => ({ estado: 'TIMBRANDO' }),
  EMITIDA: () => ({
    estado: 'EMITIDA',
    estadoDian: 'PENDIENTE',
    emitidaEn: new Date(),
  }),
  RECHAZADA: () => ({ estado: 'RECHAZADA' }),
  NO_CREADA: () => ({ estado: 'NO_CREADA' }),
  DESCONOCIDO: () => ({ estado: 'DESCONOCIDO' }),
  CANCELADA: () => ({
    estado: 'CANCELADA',
    canceladaPor: USUARIO,
    canceladaEn: new Date(),
  }),
};

/** Camino de transiciones permitidas desde PENDIENTE hasta cada estado. */
const CAMINO: Record<NonNullable<Estado>, string[]> = {
  PENDIENTE: [],
  CREANDO_BORRADOR: ['CREANDO_BORRADOR'],
  BORRADOR_CREADO: ['CREANDO_BORRADOR', 'BORRADOR_CREADO'],
  TIMBRANDO: ['CREANDO_BORRADOR', 'BORRADOR_CREADO', 'TIMBRANDO'],
  EMITIDA: ['CREANDO_BORRADOR', 'BORRADOR_CREADO', 'TIMBRANDO', 'EMITIDA'],
  RECHAZADA: ['CREANDO_BORRADOR', 'BORRADOR_CREADO', 'TIMBRANDO', 'RECHAZADA'],
  NO_CREADA: ['CREANDO_BORRADOR', 'NO_CREADA'],
  DESCONOCIDO: ['CREANDO_BORRADOR', 'DESCONOCIDO'],
  CANCELADA: ['CANCELADA'],
};

/**
 * Una emisión de un borrador APROBADO nuevo, llevada hasta `estado` por transiciones permitidas.
 * `idExterno` fija el id que se guarda al pasar a BORRADOR_CREADO.
 */
async function emision(
  opciones: {
    estado?: NonNullable<Estado>;
    modo?: 'SOLO_BORRADOR' | 'TIMBRAR';
    cuenta?: string;
    idExterno?: string;
  } = {},
) {
  let fila = await db.emision.create({
    data: {
      borradorId: await borrador(),
      proveedor: 'ALEGRA',
      cuentaProveedor: opciones.cuenta ?? CUENTA,
      modo: opciones.modo ?? 'TIMBRAR',
      fechaFactura: new Date('2026-11-12'),
    },
  });
  for (const paso of CAMINO[opciones.estado ?? 'PENDIENTE']) {
    fila = await db.emision.update({
      where: { id: fila.id },
      data: PASO[paso]({ idExterno: opciones.idExterno ?? null }),
    });
  }
  return fila;
}

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
  // Los PENDIENTE que quedan se cancelan: el siguiente test empieza sin ninguno en el chat.
  await db.borrador.updateMany({
    where: { chatId: CHAT, estado: 'PENDIENTE' },
    data: { estado: 'CANCELADO' },
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('nacer: borradores PENDIENTE, emisiones PENDIENTE y solo de lo aprobado', () => {
  it('un borrador no nace APROBADO', async () => {
    const texto = await rechazoDe(
      db.borrador.create({
        data: { chatId: CHAT, datos: {}, ...aprobacion() },
      }),
    );

    expect(texto).toContain('borradores_nacer_pendiente');
  });

  it('una emisión no nace en un estado avanzado ni con id externo', async () => {
    const base = {
      borradorId: await borrador(),
      proveedor: 'ALEGRA' as const,
      cuentaProveedor: CUENTA,
      modo: 'TIMBRAR' as const,
      fechaFactura: new Date('2026-11-12'),
    };

    expect(
      await rechazoDe(
        db.emision.create({
          data: { ...base, estado: 'BORRADOR_CREADO', idExterno: '1' },
        }),
      ),
    ).toContain('emisiones_nacer_pendiente');
    expect(
      await rechazoDe(db.emision.create({ data: { ...base, idExterno: '1' } })),
    ).toContain('emisiones_nacer_pendiente');
  });

  it.each([
    ['PENDIENTE', 'PROVEEDOR'],
    ['CANCELADO', 'PROVEEDOR'],
    ['APROBADO', 'MANUAL'],
    ['APROBADO', 'SIN_FACTURA'],
  ] as const)(
    'no nace de un borrador %s con destino %s',
    async (estado, destino) => {
      const texto = await rechazoDe(
        db.emision.create({
          data: {
            borradorId: await borrador(estado, destino),
            proveedor: 'ALEGRA',
            cuentaProveedor: CUENTA,
            modo: 'TIMBRAR',
            fechaFactura: new Date('2026-11-12'),
          },
        }),
      );

      expect(texto).toContain('emisiones_borrador_aprobado');
    },
  );

  it('nace en PENDIENTE de un borrador APROBADO con destino PROVEEDOR', async () => {
    expect(await emision()).toMatchObject({
      estado: 'PENDIENTE',
      idExterno: null,
      estadoDian: null,
    });
  });
});

describe('unicidad', () => {
  it('una segunda emisión del mismo borrador se rechaza con P2002', async () => {
    const borradorId = await borrador();
    const datos = {
      borradorId,
      proveedor: 'ALEGRA' as const,
      cuentaProveedor: CUENTA,
      modo: 'TIMBRAR' as const,
      fechaFactura: new Date('2026-11-12'),
    };
    await db.emision.create({ data: datos });

    const error: unknown = await db.emision
      .create({ data: datos })
      .catch((e: unknown) => e);

    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('el mismo id externo en la misma cuenta se rechaza; en otra cuenta, no', async () => {
    const id = idUnico();
    await emision({ estado: 'BORRADOR_CREADO', idExterno: id });

    const error: unknown = await emision({
      estado: 'BORRADOR_CREADO',
      idExterno: id,
    }).catch((e: unknown) => e);

    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    await expect(
      emision({
        estado: 'BORRADOR_CREADO',
        idExterno: id,
        cuenta: 'cuenta-ficticia-2',
      }),
    ).resolves.toBeDefined();
  });
});

describe('nada se borra (DELETE ni TRUNCATE)', () => {
  it('una emisión no se borra', async () => {
    const { id } = await emision();

    expect(await rechazoDe(db.emision.delete({ where: { id } }))).toContain(
      'emisiones_sin_borrado',
    );
  });

  it('un borrador no se borra, tenga o no emisión', async () => {
    const id = await borrador('CANCELADO');

    expect(await rechazoDe(db.borrador.delete({ where: { id } }))).toContain(
      'borradores_sin_borrado',
    );
  });

  it.each(['emisiones', 'borradores'])(
    'TRUNCATE de %s se rechaza',
    async (tabla) => {
      await emision();

      expect(
        await rechazoDe(db.$executeRawUnsafe(`TRUNCATE "${tabla}" CASCADE`)),
      ).toMatch(/_sin_borrado/);
    },
  );
});

describe('transiciones: solo las permitidas', () => {
  it.each([
    ['PENDIENTE', 'CREANDO_BORRADOR'],
    ['PENDIENTE', 'CANCELADA'],
    ['CREANDO_BORRADOR', 'BORRADOR_CREADO'],
    ['CREANDO_BORRADOR', 'NO_CREADA'],
    ['CREANDO_BORRADOR', 'DESCONOCIDO'],
    ['DESCONOCIDO', 'BORRADOR_CREADO'],
    ['BORRADOR_CREADO', 'TIMBRANDO'],
    ['BORRADOR_CREADO', 'DESCONOCIDO'],
    ['TIMBRANDO', 'EMITIDA'],
    ['TIMBRANDO', 'RECHAZADA'],
    ['RECHAZADA', 'TIMBRANDO'],
    ['RECHAZADA', 'EMITIDA'],
    ['NO_CREADA', 'PENDIENTE'],
    ['NO_CREADA', 'CANCELADA'],
  ] as const)('%s → %s se acepta', async (desde, hasta) => {
    const fila = await emision({ estado: desde });

    await expect(cambiar(fila.id, PASO[hasta](fila))).resolves.toMatchObject({
      estado: hasta,
    });
  });

  it('DESCONOCIDO → NO_CREADA se acepta con quién y cuándo', async () => {
    const fila = await emision({ estado: 'DESCONOCIDO' });

    await expect(
      cambiar(fila.id, {
        estado: 'NO_CREADA',
        noExisteConfirmadoPor: USUARIO,
        noExisteConfirmadoEn: new Date(),
      }),
    ).resolves.toMatchObject({ estado: 'NO_CREADA' });
  });

  it.each([
    ['PENDIENTE', 'BORRADOR_CREADO'],
    ['PENDIENTE', 'EMITIDA'],
    ['PENDIENTE', 'NO_CREADA'],
    ['CREANDO_BORRADOR', 'PENDIENTE'],
    ['CREANDO_BORRADOR', 'TIMBRANDO'],
    ['DESCONOCIDO', 'PENDIENTE'],
    ['DESCONOCIDO', 'TIMBRANDO'],
    ['BORRADOR_CREADO', 'EMITIDA'],
    ['TIMBRANDO', 'BORRADOR_CREADO'],
    ['TIMBRANDO', 'DESCONOCIDO'],
    ['EMITIDA', 'DESCONOCIDO'],
    ['EMITIDA', 'RECHAZADA'],
    ['CANCELADA', 'PENDIENTE'],
    ['NO_CREADA', 'BORRADOR_CREADO'],
    ['NO_CREADA', 'TIMBRANDO'],
  ] as const)('%s → %s se rechaza', async (desde, hasta) => {
    const fila = await emision({ estado: desde });

    const texto = await rechazoDe(cambiar(fila.id, PASO[hasta](fila)));

    expect(texto).toContain('emisiones_transicion_no_permitida');
  });

  it('DESCONOCIDO → NO_CREADA sin quién ni cuándo se rechaza', async () => {
    const fila = await emision({ estado: 'DESCONOCIDO' });

    expect(
      await rechazoDe(cambiar(fila.id, { estado: 'NO_CREADA' })),
    ).toContain('emisiones_no_existe_sin_confirmar');
  });

  it('CREANDO_BORRADOR → NO_CREADA (error definitivo) no necesita confirmación', async () => {
    const fila = await emision({ estado: 'CREANDO_BORRADOR' });

    await expect(
      cambiar(fila.id, { estado: 'NO_CREADA' }),
    ).resolves.toMatchObject({ estado: 'NO_CREADA' });
  });

  it.each(['PENDIENTE', 'NO_CREADA'] as const)(
    '%s → CANCELADA sin quién ni cuándo se rechaza',
    async (desde) => {
      const fila = await emision({ estado: desde });

      expect(
        await rechazoDe(cambiar(fila.id, { estado: 'CANCELADA' })),
      ).toContain('emisiones_cancelada_sin_quien');
    },
  );

  it('EMITIDA admite completar número, CUFE y estado DIAN', async () => {
    const fila = await emision({ estado: 'EMITIDA' });

    await expect(
      cambiar(fila.id, { numero: 'FE1', cufe: 'abc', estadoDian: 'ACEPTADA' }),
    ).resolves.toMatchObject({ estado: 'EMITIDA', estadoDian: 'ACEPTADA' });
  });
});

describe('columnas que no cambian', () => {
  it('modo y estado cambiados en el mismo UPDATE: una fila SOLO_BORRADOR no se vuelve TIMBRAR', async () => {
    const fila = await emision({
      estado: 'BORRADOR_CREADO',
      modo: 'SOLO_BORRADOR',
    });

    expect(
      await rechazoDe(
        cambiar(fila.id, { modo: 'TIMBRAR', estado: 'TIMBRANDO' }),
      ),
    ).toContain('emisiones_columnas_inmutables');
  });

  it.each([
    ['modo', { modo: 'TIMBRAR' }],
    ['cuenta_proveedor', { cuentaProveedor: 'cuenta-ficticia-2' }],
    ['proveedor', { proveedor: 'SIIGO' }],
    ['creada_en', { creadaEn: new Date('2020-01-01') }],
  ] as const)('%s no se puede cambiar', async (_columna, datos) => {
    const fila = await emision({ modo: 'SOLO_BORRADOR' });

    expect(await rechazoDe(cambiar(fila.id, datos))).toContain(
      'emisiones_columnas_inmutables',
    );
  });

  it('borrador_id no se puede cambiar', async () => {
    const fila = await emision();

    expect(
      await rechazoDe(cambiar(fila.id, { borradorId: await borrador() })),
    ).toContain('emisiones_columnas_inmutables');
  });

  it.each([
    ['cambiarlo', { idExterno: 'otro' }],
    ['borrarlo', { idExterno: null }],
  ] as const)('el id externo guardado no admite %s', async (_caso, datos) => {
    const fila = await emision({ estado: 'BORRADOR_CREADO' });

    expect(await rechazoDe(cambiar(fila.id, datos))).toContain(
      'emisiones_id_externo_inmutable',
    );
  });

  it('fecha_factura cambia en PENDIENTE sin id externo (también al reintentar desde NO_CREADA)', async () => {
    const fila = await emision({ estado: 'NO_CREADA' });
    await cambiar(fila.id, { estado: 'PENDIENTE' });

    const cambiada = await cambiar(fila.id, {
      fechaFactura: new Date('2026-11-13'),
    });

    expect(cambiada.fechaFactura.toISOString().slice(0, 10)).toBe('2026-11-13');
  });

  it.each(['CREANDO_BORRADOR', 'DESCONOCIDO', 'BORRADOR_CREADO'] as const)(
    'fecha_factura no cambia en %s',
    async (estado) => {
      const fila = await emision({ estado });

      expect(
        await rechazoDe(
          cambiar(fila.id, { fechaFactura: new Date('2026-11-13') }),
        ),
      ).toContain('emisiones_fecha_factura_inmutable');
    },
  );
});

describe('restricciones CHECK de emisiones', () => {
  it('pasar a BORRADOR_CREADO sin id externo se rechaza', async () => {
    const fila = await emision({ estado: 'CREANDO_BORRADOR' });

    expect(
      await rechazoDe(cambiar(fila.id, { estado: 'BORRADOR_CREADO' })),
    ).toContain('emisiones_id_externo_segun_estado_check');
  });

  it('un id externo en CREANDO_BORRADOR se rechaza', async () => {
    const fila = await emision({ estado: 'CREANDO_BORRADOR' });

    expect(await rechazoDe(cambiar(fila.id, { idExterno: '1' }))).toContain(
      'emisiones_sin_id_externo_segun_estado_check',
    );
  });

  it('una fila SOLO_BORRADOR no pasa a TIMBRANDO', async () => {
    const fila = await emision({
      estado: 'BORRADOR_CREADO',
      modo: 'SOLO_BORRADOR',
    });

    expect(
      await rechazoDe(cambiar(fila.id, { estado: 'TIMBRANDO' })),
    ).toContain('emisiones_solo_borrador_no_timbra_check');
  });

  it.each([
    ['numero', { numero: 'FE1' }],
    ['cufe', { cufe: 'abc' }],
    ['emitida_en', { emitidaEn: new Date() }],
  ] as const)('una fila SOLO_BORRADOR no tiene %s', async (_c, datos) => {
    const fila = await emision({
      estado: 'BORRADOR_CREADO',
      modo: 'SOLO_BORRADOR',
    });

    expect(await rechazoDe(cambiar(fila.id, datos))).toContain(
      'emisiones_solo_borrador_sin_timbre_check',
    );
  });

  it('EMITIDA sin estado DIAN se rechaza', async () => {
    const fila = await emision({ estado: 'TIMBRANDO' });

    expect(
      await rechazoDe(
        cambiar(fila.id, { estado: 'EMITIDA', emitidaEn: new Date() }),
      ),
    ).toContain('emisiones_emitida_completa_check');
  });

  it.each(['El cliente Ana', 'HTTP_401', '', 'a'.repeat(65)])(
    'codigo_error "%s" se rechaza; "alegra_905" se acepta',
    async (codigoError) => {
      const fila = await emision({ estado: 'CREANDO_BORRADOR' });

      expect(await rechazoDe(cambiar(fila.id, { codigoError }))).toContain(
        'emisiones_codigo_error_check',
      );
      await expect(
        cambiar(fila.id, { codigoError: 'alegra_905' }),
      ).resolves.toBeDefined();
    },
  );

  it('una cuenta vacía se rechaza al nacer', async () => {
    expect(await rechazoDe(emision({ cuenta: '' }))).toContain(
      'emisiones_textos_no_vacios_check',
    );
  });
});

describe('borradores: aprobar es aprobar lo mostrado; lo aprobado no cambia', () => {
  async function pendiente(versionMostrada: number | null = 1) {
    const { id } = await db.borrador.create({
      data: { chatId: CHAT, datos: { n: 1 }, versionMostrada },
    });
    return id;
  }

  it('aprobar con los mismos datos, la versión mostrada, quién, cuándo y destino', async () => {
    const id = await pendiente();

    await expect(
      db.borrador.update({ where: { id }, data: aprobacion('MANUAL') }),
    ).resolves.toMatchObject({ estado: 'APROBADO', destinoFactura: 'MANUAL' });
  });

  it.each([
    ['cambiando los datos', { datos: { n: 2 } }],
    ['cambiando la versión', { version: 2 }],
  ] as const)('aprobar %s se rechaza', async (_caso, cambio) => {
    const id = await pendiente();

    expect(
      await rechazoDe(
        db.borrador.update({
          where: { id },
          data: { ...aprobacion(), ...cambio },
        }),
      ),
    ).toContain('borradores_aprobacion_coherente');
  });

  it('aprobar una versión que no se mostró se rechaza', async () => {
    const id = await pendiente(null);

    expect(
      await rechazoDe(
        db.borrador.update({ where: { id }, data: aprobacion() }),
      ),
    ).toContain('borradores_aprobacion_coherente');
  });

  it('aprobar sin destino se rechaza', async () => {
    const id = await pendiente();

    expect(
      await rechazoDe(
        db.borrador.update({
          where: { id },
          data: { ...aprobacion(), destinoFactura: null },
        }),
      ),
    ).toContain('borradores_destino_solo_aprobado_check');
  });

  it('aprobar sin quién se rechaza', async () => {
    const id = await pendiente();

    expect(
      await rechazoDe(
        db.borrador.update({
          where: { id },
          data: { ...aprobacion(), aprobadoPor: null },
        }),
      ),
    ).toContain('borradores_aprobacion_completa_check');
  });

  it('un PENDIENTE no tiene destino', async () => {
    const id = await pendiente();

    expect(
      await rechazoDe(
        db.borrador.update({
          where: { id },
          data: { destinoFactura: 'MANUAL' },
        }),
      ),
    ).toContain('borradores_destino_solo_aprobado_check');
  });

  it.each([
    ['datos', { datos: { n: 2 } }],
    ['version', { version: 2 }],
    ['estado', { estado: 'PENDIENTE' }],
    ['aprobado_por', { aprobadoPor: 1n }],
    ['destino_factura', { destinoFactura: 'PROVEEDOR' }],
    ['chat_id', { chatId: 999000102n }],
  ] as const)('un borrador APROBADO no cambia %s', async (_c, data) => {
    const id = await borrador('APROBADO', 'MANUAL');

    expect(
      await rechazoDe(db.borrador.update({ where: { id }, data })),
    ).toContain('borradores_no_pendiente_inmutable');
  });

  it('un borrador APROBADO sí admite marcar la versión mostrada', async () => {
    const id = await borrador();

    await expect(
      db.borrador.update({ where: { id }, data: { versionMostrada: 1 } }),
    ).resolves.toMatchObject({ versionMostrada: 1 });
  });
});
