// Pruebas del adaptador de Alegra contra un servidor HTTP falso local: ninguna llama a Alegra.
// Tokens, cuentas e ids son ficticios.
import {
  ErrorProveedor,
  type FacturaParaProveedor,
} from '../proveedor-facturacion.js';
import { AlegraAdaptador, idCanonicoAlegra } from './alegra.adaptador.js';
import { AlegraFalso } from './alegra-falso.spec-util.js';
import {
  ORG_FICTICIA,
  OTRA_ORG_FICTICIA,
  tokenFicticio,
} from './token-ficticio.spec-util.js';

const REFERENCIA = 'facturabot:00000000-0000-7000-8000-00000000000a';
const FACTURA: FacturaParaProveedor = {
  referencia: REFERENCIA,
  fecha: '2026-11-12',
  cliente: { tipo: 'consumidor_final' },
  lineas: [{ descripcion: 'Pinturas varias: vinilo', valor: 50000 }],
};
const REF = { cuenta: ORG_FICTICIA, idExterno: '7', referencia: REFERENCIA };

/** Una factura de Alegra como la devolvería la API (campos que se usan y alguno de más). */
const borradorAlegra = (cambios: Record<string, unknown> = {}) => ({
  id: '007',
  status: 'draft',
  observations: REFERENCIA,
  numberTemplate: { id: '1', prefix: 'FE', number: 12 },
  total: 59500,
  ...cambios,
});

let alegra: AlegraFalso;

beforeEach(async () => {
  alegra = await new AlegraFalso().iniciar();
});

afterEach(async () => {
  await alegra.detener();
});

function adaptador(
  opciones: Partial<{ token: string; emitir: boolean; url: string }> = {},
) {
  return new AlegraAdaptador({
    token: tokenFicticio(),
    url: alegra.url,
    emitir: true,
    ...opciones,
  });
}

/** El ErrorProveedor que lanza la promesa. */
async function errorDe(promesa: Promise<unknown>): Promise<ErrorProveedor> {
  const error: unknown = await promesa.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ErrorProveedor);
  return error as ErrorProveedor;
}

describe('idCanonicoAlegra', () => {
  it.each([
    ['7', '7'],
    ['007', '7'],
    [7, '7'],
    [' 12 ', '12'],
    [
      '0193A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B',
      '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    ],
  ])('%s → %s', (id, canonico) => {
    expect(idCanonicoAlegra(id)).toBe(canonico);
  });

  it.each(['', '7a', '-1', '1.5', ' 7 8', null, -3, 1.5, {}, '1'.repeat(20)])(
    '%s no es un id de Alegra',
    (id) => {
      expect(idCanonicoAlegra(id)).toBeNull();
    },
  );
});

describe('AlegraAdaptador: token y cuenta', () => {
  it('la cuenta es el org del token', () => {
    expect(adaptador().cuenta()).toBe(ORG_FICTICIA);
  });

  it.each([
    ['sin token', '', 'token_ausente'],
    [
      'org sin forma de UUID',
      tokenFicticio({ org: '1234567' }),
      'cuenta_invalida',
    ],
    ['sin org', tokenFicticio({ org: undefined }), 'cuenta_invalida'],
    ['sin exp', tokenFicticio({ exp: undefined }), 'cuenta_invalida'],
    [
      'vencido',
      tokenFicticio({ exp: new Date(Date.now() - 1000) }),
      'token_vencido',
    ],
  ])('%s: no emite y no llama a Alegra', async (_caso, token, categoria) => {
    alegra.conRecursos();
    const error = await errorDe(adaptador({ token }).crearBorrador(FACTURA));

    expect(error.categoria).toBe(categoria);
    expect(error.definitivo).toBe(true);
    expect(alegra.pedidos).toHaveLength(0);
  });

  it('rechaza una URL sin https que no sea local: el token viaja en cada pedido', () => {
    expect(() => adaptador({ url: 'http://api.alegra.com/api/v1' })).toThrow(
      'https',
    );
  });
});

describe('AlegraAdaptador.crearBorrador', () => {
  it('crea la factura en borrador, sin stamp ni status, con nuestra referencia', async () => {
    alegra
      .conRecursos()
      .responder('POST /invoices', { status: 201, cuerpo: borradorAlegra() });

    const factura = await adaptador().crearBorrador(FACTURA);

    expect(factura).toEqual({
      idExterno: '7',
      referencia: REFERENCIA,
      borrador: true,
      timbrada: false,
      numero: null,
      cufe: null,
      estadoDian: null,
    });
    const [pedido] = alegra.pedidosA('POST /invoices');
    expect(pedido.autorizacion).toBe(`Bearer ${tokenFicticio()}`);
    expect(pedido.cuerpo).toEqual({
      date: '2026-11-12',
      dueDate: '2026-11-12',
      client: { id: '1' },
      items: [
        {
          id: '1',
          price: 50000,
          quantity: 1,
          description: 'Pinturas varias: vinilo',
          tax: [{ id: '4' }],
        },
      ],
      paymentForm: 'CASH',
      paymentMethod: 'CASH',
      observations: REFERENCIA,
    });
    expect(JSON.stringify(pedido.cuerpo)).not.toMatch(/stamp|status/i);
  });

  it('lee los recursos de la cuenta una sola vez', async () => {
    alegra
      .conRecursos()
      .responder('POST /invoices', { status: 201, cuerpo: borradorAlegra() });
    const proveedor = adaptador();

    await proveedor.crearBorrador(FACTURA);
    await proveedor.crearBorrador(FACTURA);

    expect(alegra.pedidosA('GET /taxes')).toHaveLength(1);
    expect(alegra.pedidosA('POST /invoices')).toHaveLength(2);
  });

  it('un 400 que trae la factura creada es un borrador creado (§4)', async () => {
    alegra
      .conRecursos()
      .responder('POST /invoices', { status: 400, cuerpo: borradorAlegra() });

    await expect(adaptador().crearBorrador(FACTURA)).resolves.toMatchObject({
      idExterno: '7',
    });
  });

  it.each([
    [
      400,
      { code: 1, message: 'datos de Ana 52111222' }, // ficticio
      'rechazo_validacion',
      true,
    ], // ficticios
    [401, { code: 401 }, 'no_autorizado', true],
    [402, { code: 402 }, 'plan_sin_api', true],
    [403, { code: 403 }, 'sin_permiso', true],
    [429, { code: 429 }, 'limite_de_pedidos', true],
    [500, { code: 500 }, 'error_servidor', false],
    [503, null, 'error_servidor', false],
    [418, null, 'http_inesperado', false],
    // Una redirección no se sigue (el token no se reenvía a otro sitio): sale como red.
    [302, null, 'red', false],
  ])(
    'HTTP %i → %s (definitivo: %s), sin el mensaje de Alegra',
    async (status, cuerpo, categoria, definitivo) => {
      alegra.conRecursos().responder('POST /invoices', { status, cuerpo });

      const error = await errorDe(adaptador().crearBorrador(FACTURA));

      expect(error.categoria).toBe(categoria);
      expect(error.definitivo).toBe(definitivo);
      expect(error.message).toBe(categoria);
    },
  );

  it.each([
    ['sin id', { status: 'draft' }],
    ['id con forma desconocida', borradorAlegra({ id: 'abc' })],
  ])('2xx %s → respuesta_invalida (incierto)', async (_caso, cuerpo) => {
    alegra.conRecursos().responder('POST /invoices', { status: 201, cuerpo });

    const error = await errorDe(adaptador().crearBorrador(FACTURA));

    expect(error.categoria).toBe('respuesta_invalida');
    expect(error.definitivo).toBe(false);
  });

  it('2xx que no es JSON → respuesta_invalida', async () => {
    alegra
      .conRecursos()
      .responder('POST /invoices', { status: 201, crudo: '<html>' });

    expect((await errorDe(adaptador().crearBorrador(FACTURA))).categoria).toBe(
      'respuesta_invalida',
    );
  });

  it.each([
    [
      'sin IVA 19 %',
      'GET /taxes',
      [{ id: '1', type: 'IVA', percentage: '5', status: 'active' }],
    ],
    [
      'sin el producto genérico (solo uno con nombre parecido)',
      'GET /items',
      [{ id: '9', name: 'Pinturas varias especiales' }],
    ],
    [
      'sin el contacto exacto de consumidor final (solo uno que lo contiene)',
      'GET /contacts',
      [{ id: '5', identificationObject: { number: '2222222222221' } }],
    ],
  ])('%s: recurso_faltante y no crea nada', async (_caso, ruta, cuerpo) => {
    alegra.conRecursos().responder(ruta, { status: 200, cuerpo });

    const error = await errorDe(adaptador().crearBorrador(FACTURA));

    expect(error.categoria).toBe('recurso_faltante');
    expect(alegra.pedidosA('POST /invoices')).toHaveLength(0);
  });

  it('Alegra caído: red (incierto)', async () => {
    const url = alegra.url;
    await alegra.detener();

    const error = await errorDe(adaptador({ url }).crearBorrador(FACTURA));

    expect(error.categoria).toBe('red');
    expect(error.definitivo).toBe(false);
    alegra = await new AlegraFalso().iniciar();
  });
});

describe('AlegraAdaptador.timbrar', () => {
  const conBorrador = (cambios: Record<string, unknown> = {}) =>
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra(cambios),
    });

  it('timbra nuestra factura: primero la consulta y luego pide el stamp de ese id', async () => {
    conBorrador().responder('POST /invoices/stamp', {
      status: 200,
      cuerpo: { data: [{ id: '7', success: true, message: 'ok' }] },
    });

    await expect(adaptador().timbrar(REF, 'TIMBRAR')).resolves.toEqual({
      resultado: 'timbrada',
    });
    expect(alegra.pedidos.map((p) => `${p.metodo} ${p.ruta}`)).toEqual([
      'GET /invoices/7',
      'POST /invoices/stamp',
    ]);
    expect(alegra.pedidosA('POST /invoices/stamp')[0].cuerpo).toEqual({
      ids: ['7'],
    });
  });

  it.each([
    [
      'con ALEGRA_EMITIR apagada',
      { emitir: false },
      'TIMBRAR',
      'emision_apagada',
    ],
    ['una emisión SOLO_BORRADOR', {}, 'SOLO_BORRADOR', 'modo_solo_borrador'],
  ] as const)(
    'nunca timbra %s y no llama a Alegra',
    async (_caso, opciones, modo, categoria) => {
      conBorrador();

      const error = await errorDe(adaptador(opciones).timbrar(REF, modo));

      expect(error.categoria).toBe(categoria);
      expect(alegra.pedidos).toHaveLength(0);
    },
  );

  it('una factura de otra cuenta: otra_cuenta y no llama a Alegra', async () => {
    conBorrador();

    const error = await errorDe(
      adaptador().timbrar({ ...REF, cuenta: OTRA_ORG_FICTICIA }, 'TIMBRAR'),
    );

    expect(error.categoria).toBe('otra_cuenta');
    expect(alegra.pedidos).toHaveLength(0);
  });

  it.each([
    ['otra referencia', { observations: 'facturabot:otra' }],
    ['sin referencia', { observations: null }],
  ])(
    'una factura con %s: factura_ajena y no pide el stamp',
    async (_caso, cambios) => {
      conBorrador(cambios);

      const error = await errorDe(adaptador().timbrar(REF, 'TIMBRAR'));

      expect(error.categoria).toBe('factura_ajena');
      expect(alegra.pedidosA('POST /invoices/stamp')).toHaveLength(0);
    },
  );

  it('ya timbrada al consultarla: no pide el stamp otra vez', async () => {
    conBorrador({
      status: 'open',
      stamp: { legalStatus: 'STAMPED_AND_ACCEPTED' },
    });

    await expect(adaptador().timbrar(REF, 'TIMBRAR')).resolves.toEqual({
      resultado: 'ya_timbrada',
    });
    expect(alegra.pedidosA('POST /invoices/stamp')).toHaveLength(0);
  });

  it('código 3226 ("ya está emitida"): ya_timbrada', async () => {
    conBorrador().responder('POST /invoices/stamp', {
      status: 400,
      cuerpo: { data: [{ id: '7', code: 3226, message: 'ya emitida' }] },
    });

    await expect(adaptador().timbrar(REF, 'TIMBRAR')).resolves.toEqual({
      resultado: 'ya_timbrada',
    });
  });

  it('otro código para nuestra factura: rechazada, solo con el código', async () => {
    conBorrador().responder('POST /invoices/stamp', {
      status: 400,
      cuerpo: { data: [{ id: '7', code: 905, message: 'Ana 52111222' }] }, // ficticios
    });

    await expect(adaptador().timbrar(REF, 'TIMBRAR')).resolves.toEqual({
      resultado: 'rechazada',
      codigo: 'alegra_905',
    });
  });

  it('un 200 que no trae nuestro id: respuesta_invalida (incierto)', async () => {
    conBorrador().responder('POST /invoices/stamp', {
      status: 200,
      cuerpo: { data: [{ id: '8', success: true }] },
    });

    const error = await errorDe(adaptador().timbrar(REF, 'TIMBRAR'));

    expect(error.categoria).toBe('respuesta_invalida');
    expect(error.definitivo).toBe(false);
  });

  it('un 500 al timbrar: error_servidor (incierto, se repite el mismo id)', async () => {
    conBorrador().responder('POST /invoices/stamp', { status: 500 });

    const error = await errorDe(adaptador().timbrar(REF, 'TIMBRAR'));

    expect(error.categoria).toBe('error_servidor');
    expect(error.definitivo).toBe(false);
  });
});

describe('AlegraAdaptador.consultar', () => {
  it('traduce la factura timbrada a nuestros términos', async () => {
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra({
        status: 'open',
        stamp: { cufe: 'cufe-ficticio', legalStatus: 'STAMPED_AND_ACCEPTED' },
      }),
    });

    await expect(adaptador().consultar(REF)).resolves.toEqual({
      idExterno: '7',
      referencia: REFERENCIA,
      borrador: false,
      timbrada: true,
      numero: 'FE12',
      cufe: 'cufe-ficticio',
      estadoDian: 'ACEPTADA',
    });
  });

  it('acepta el id guardado en otra forma ("007") y pide la forma canónica', async () => {
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra(),
    });

    await adaptador().consultar({ ...REF, idExterno: '007' });

    expect(alegra.pedidosA('GET /invoices/7')).toHaveLength(1);
  });

  it('otra cuenta: no llama a Alegra', async () => {
    const error = await errorDe(
      adaptador().consultar({ ...REF, cuenta: OTRA_ORG_FICTICIA }),
    );

    expect(error.categoria).toBe('otra_cuenta');
    expect(alegra.pedidos).toHaveLength(0);
  });

  it('un id que no es de Alegra: no llama a Alegra', async () => {
    const error = await errorDe(
      adaptador().consultar({ ...REF, idExterno: '../contacts' }),
    );

    expect(error.categoria).toBe('rechazo_validacion');
    expect(alegra.pedidos).toHaveLength(0);
  });

  it('Alegra devuelve otra factura: respuesta_invalida', async () => {
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra({ id: '8' }),
    });

    expect((await errorDe(adaptador().consultar(REF))).categoria).toBe(
      'respuesta_invalida',
    );
  });

  it('404: no_encontrada (definitivo)', async () => {
    alegra.responder('GET /invoices/7', { status: 404, cuerpo: { code: 404 } });

    const error = await errorDe(adaptador().consultar(REF));

    expect(error.categoria).toBe('no_encontrada');
    expect(error.definitivo).toBe(true);
  });
});

describe('AlegraAdaptador: revisión de seguridad del PR (clasificación sin duplicar)', () => {
  it.each([
    ['un 400 con cuerpo que no es JSON', { status: 400, crudo: '<html>' }],
    [
      'un 400 con un id de forma nueva',
      { status: 400, cuerpo: { id: 'abc', status: 'draft' } },
    ],
    ['un 400 vacío', { status: 400, cuerpo: null }],
  ])(
    '%s al crear: respuesta_invalida (incierto, se reconcilia)',
    async (_caso, respuesta) => {
      alegra.conRecursos().responder('POST /invoices', respuesta);

      const error = await errorDe(adaptador().crearBorrador(FACTURA));

      expect(error.categoria).toBe('respuesta_invalida');
      expect(error.definitivo).toBe(false);
    },
  );

  it.each([
    ['ya timbrada', borradorAlegra({ status: 'open' })],
    [
      'con otra referencia',
      borradorAlegra({ observations: 'facturabot:otra' }),
    ],
  ])(
    'crear devuelve una factura %s: respuesta_invalida',
    async (_caso, cuerpo) => {
      alegra.conRecursos().responder('POST /invoices', { status: 201, cuerpo });

      expect(
        (await errorDe(adaptador().crearBorrador(FACTURA))).categoria,
      ).toBe('respuesta_invalida');
    },
  );

  it.each([
    ['fecha con otra forma', { fecha: '12/11/2026' }],
    ['sin líneas', { lineas: [] }],
    [
      'un valor con decimales',
      { lineas: [{ descripcion: 'vinilo', valor: 1.5 }] },
    ],
    ['una descripción vacía', { lineas: [{ descripcion: ' ', valor: 1 }] }],
    [
      'una descripción demasiado larga',
      { lineas: [{ descripcion: 'x'.repeat(1001), valor: 1 }] },
    ],
    ['una referencia ajena', { referencia: 'otra' }],
  ])(
    'entrada con %s: rechazo_validacion sin llamar a Alegra',
    async (_caso, cambio) => {
      alegra.conRecursos();

      const error = await errorDe(
        adaptador().crearBorrador({
          ...FACTURA,
          ...cambio,
        } as FacturaParaProveedor),
      );

      expect(error.categoria).toBe('rechazo_validacion');
      expect(alegra.pedidos).toHaveLength(0);
    },
  );

  it('timbrar una factura "open" sin CUFE ni estado DIAN: incierta, no pide el stamp', async () => {
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra({ status: 'open' }),
    });

    const error = await errorDe(adaptador().timbrar(REF, 'TIMBRAR'));

    expect(error.categoria).toBe('respuesta_invalida');
    expect(alegra.pedidosA('POST /invoices/stamp')).toHaveLength(0);
  });

  it('el stamp responde nuestro id sin success ni código: respuesta_invalida (pudo timbrarse)', async () => {
    alegra
      .responder('GET /invoices/7', { status: 200, cuerpo: borradorAlegra() })
      .responder('POST /invoices/stamp', {
        status: 200,
        cuerpo: { data: [{ id: '7' }] },
      });

    const error = await errorDe(adaptador().timbrar(REF, 'TIMBRAR'));

    expect(error.categoria).toBe('respuesta_invalida');
    expect(error.definitivo).toBe(false);
  });

  it('el código de rechazo se recorta a 32 caracteres', async () => {
    alegra
      .responder('GET /invoices/7', { status: 200, cuerpo: borradorAlegra() })
      .responder('POST /invoices/stamp', {
        status: 400,
        cuerpo: { data: [{ id: '7', code: '9'.repeat(100) }] },
      });

    await expect(adaptador().timbrar(REF, 'TIMBRAR')).resolves.toEqual({
      resultado: 'rechazada',
      codigo: `alegra_${'9'.repeat(32)}`,
    });
  });

  it('una respuesta de más de 1 MB: respuesta_invalida, sin leerla', async () => {
    // Una factura válida, pero enorme: sin el tope, pasaría.
    alegra.responder('GET /invoices/7', {
      status: 200,
      cuerpo: borradorAlegra({ observations: 'x'.repeat(1_000_001) }),
    });

    expect((await errorDe(adaptador().consultar(REF))).categoria).toBe(
      'respuesta_invalida',
    );
  });
});
