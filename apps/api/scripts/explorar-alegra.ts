/**
 * Script exploratorio de la API de Alegra (fase 5, paso 2 del plan). Se corre a mano, nunca en CI:
 *
 *   node --env-file=.env scripts/explorar-alegra.ts <carpeta de salida fuera del repo> [--largos]
 *
 * `--largos` crea además 4 borradores para medir el largo máximo de la descripción por línea.
 *
 * Solo contra la CUENTA DE PRUEBA: se detiene antes de cualquier POST si la cuenta tiene una
 * numeración electrónica (señal de cuenta habilitada ante la DIAN). Nunca timbra: `pedir` solo
 * acepta GET y POST (también al ejecutar) y rechaza cualquier ruta o cuerpo con "stamp" o "void".
 * Las respuestas crudas se guardan en la carpeta de salida;
 * en la consola solo salen códigos, claves y campos elegidos (nunca el token ni datos de contactos).
 * Todos los datos que envía son ficticios.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.alegra.com/api/v1';
/** Identificador genérico de la DIAN para "Consumidor final": no es de ninguna persona. */
const CONSUMIDOR_FINAL = '222222222222';
const CEDULA_FICTICIA_1 = '1000000001'; // ficticia
const CEDULA_FICTICIA_2 = '1000000002'; // ficticia
const REPO = path.resolve(import.meta.dirname, '../../..');

// Las respuestas se exploran a mano: por eso son `any` y no se validan con Zod (el adaptador sí).
type Json = any;

const token = (process.env.ALEGRA_TOKEN ?? '').trim().replace(/^"|"$/g, '');
if (!token) salir('Falta ALEGRA_TOKEN en .env.');

/** `carpeta` queda fuera de `repo` (no basta `startsWith('..')`: "..salida" está dentro). */
function fueraDe(repo: string, carpeta: string): boolean {
  const relativa = path.relative(repo, carpeta);
  return (
    relativa === '..' ||
    relativa.startsWith('..' + path.sep) ||
    path.isAbsolute(relativa)
  );
}

if (!process.argv[2]) salir('Indica una carpeta de salida FUERA del repo.');
const salida = path.resolve(process.argv[2]);
// Primero con la ruta escrita (para no crear nada dentro del repo) y, ya creada, con las rutas
// reales: resuelven enlaces, junctions y nombres cortos 8.3.
if (!fueraDe(REPO, salida))
  salir('Indica una carpeta de salida FUERA del repo.');
mkdirSync(salida, { recursive: true });
if (!fueraDe(realpathSync.native(REPO), realpathSync.native(salida)))
  salir('Indica una carpeta de salida FUERA del repo.');

let contador = 0;
const exito = (status: number): boolean => status >= 200 && status < 300;

/** Una petición a Alegra. Guarda lo enviado y lo recibido en la carpeta de salida. */
async function pedir(
  paso: string,
  metodo: 'GET' | 'POST',
  ruta: string,
  cuerpo?: unknown,
): Promise<{ status: number; json: Json }> {
  // El tipo no basta: al correr con Node los tipos se borran.
  if (metodo !== 'GET' && metodo !== 'POST')
    throw new Error(`Bloqueado: "${paso}" usa ${String(metodo)}.`);
  const texto = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
  if (/stamp|void/i.test(ruta) || (texto && /stamp|void/i.test(texto)))
    throw new Error(`Bloqueado: "${paso}" intentaría timbrar o anular.`);

  let status = 0;
  let json: Json = null;
  try {
    const respuesta = await fetch(BASE + ruta, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(texto ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(texto ? { body: texto } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    status = respuesta.status;
    const crudo = await respuesta.text();
    try {
      json = JSON.parse(crudo);
    } catch {
      json = { textoNoJson: crudo.slice(0, 2000) };
    }
  } catch (error) {
    json = { errorDeRed: (error as Error).name };
  }

  contador += 1;
  const archivo = `${String(contador).padStart(2, '0')}-${paso}.json`;
  writeFileSync(
    path.join(salida, archivo),
    JSON.stringify(
      { metodo, ruta, cuerpo: cuerpo ?? null, status, respuesta: json },
      null,
      2,
    ),
  );
  console.log(
    `\n[${paso}] ${metodo} ${ruta.split('?')[0]} → HTTP ${status || 'sin respuesta'}`,
  );
  if (status === 401 || status === 403) {
    console.log(`   ${json?.message ?? ''} (code ${json?.code ?? '?'})`);
    salir(
      `Sin permiso para ${metodo} ${ruta.split('?')[0]}: revisa los permisos del token.`,
    );
  }
  if (status === 0 && metodo === 'POST')
    salir(
      `Sin respuesta en "${paso}": revisa la cuenta de prueba, pudo quedar algo creado.`,
    );
  if (!exito(status))
    console.log(
      `   error: ${json?.message ?? JSON.stringify(json).slice(0, 300)}`,
    );
  return { status, json };
}

function salir(mensaje: string): never {
  console.error(mensaje);
  process.exit(1);
}

const hoy = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota',
}).format(new Date());
const lista = (json: Json): Json[] =>
  Array.isArray(json) ? json : (json?.data ?? []);

/** Claves de una factura que pueden nombrar el CUFE, el timbrado o el estado ante la DIAN. */
function pistasDian(factura: Json): Record<string, unknown> {
  const pistas: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(factura ?? {}))
    if (
      /cufe|stamp|emission|legal|electronic|status|numberTemplate|uuid/i.test(
        clave,
      )
    )
      pistas[clave] = valor;
  return pistas;
}

/** Siguiente número de la numeración preferida de facturas de venta. */
async function numeracionPreferida(paso: string): Promise<Json> {
  const { json } = await pedir(
    paso,
    'GET',
    '/number-templates?documentType=invoice',
  );
  const plantillas = lista(json);
  for (const p of plantillas)
    console.log(
      `   numeración id=${p.id} tipo=${p.documentType} electrónica=${p.isElectronic} ` +
        `preferida=${p.preferred} estado=${p.status} prefijo=${p.prefix ?? ''} ` +
        `siguiente=${p.nextInvoiceNumber}`,
    );
  if (plantillas.some((p: Json) => String(p.isElectronic) === 'true'))
    salir(
      'La cuenta tiene numeración electrónica: no parece la cuenta de prueba. No se crea nada.',
    );
  return (
    plantillas.find(
      (p: Json) => p.preferred === true || p.preferred === 'true',
    ) ?? plantillas[0]
  );
}

/** Contacto cuyo número coincide EXACTO (la búsqueda de Alegra es "contiene"). */
async function contactoPorNumero(paso: string, numero: string): Promise<Json> {
  const { json } = await pedir(
    paso,
    'GET',
    `/contacts?identification=${numero}`,
  );
  return (
    lista(json).find((c: Json) => c.identificationObject?.number === numero) ??
    null
  );
}

async function crearBorrador(
  paso: string,
  clienteId: string,
  itemId: string,
  ivaId: string,
  descripcion: string,
  referencia: string,
): Promise<Json> {
  // Sin `status` ni pagos, Alegra la crea en "draft" (documentación de POST /invoices). Sin stamp.
  const { status, json } = await pedir(paso, 'POST', '/invoices', {
    date: hoy,
    dueDate: hoy,
    client: { id: clienteId },
    items: [
      {
        id: itemId,
        price: 1000,
        quantity: 1,
        description: descripcion,
        tax: [{ id: ivaId }],
      },
    ],
    paymentForm: 'CASH',
    paymentMethod: 'CASH',
    observations: referencia,
  });
  if (!exito(status)) return null;
  const linea = json.items?.[0] ?? {};
  console.log(
    `   factura id=${json.id} estado=${json.status} total=${json.total} ` +
      `descripción enviada=${descripcion.length} devuelta=${String(linea.description ?? '').length}`,
  );
  console.log(
    `   pistas DIAN: ${JSON.stringify(pistasDian(json)).slice(0, 600)}`,
  );
  return json;
}

async function main(): Promise<void> {
  console.log(`Salida cruda en: ${salida}\nFecha (Bogotá): ${hoy}`);

  // 1. IVA 19 %: el id es propio de cada cuenta.
  const impuestos = lista((await pedir('impuestos', 'GET', '/taxes')).json);
  const iva = impuestos.find(
    (t: Json) => Number(t.percentage) === 19 && t.type === 'IVA',
  );
  if (!iva) salir('No hay IVA 19 % en la cuenta.');
  console.log(`   IVA 19 % → id ${iva.id}`);

  // 2. Numeración preferida, antes de crear borradores (pregunta 4: ¿un borrador consume número?).
  const antes = await numeracionPreferida('numeracion-antes');

  // 3. Ítem genérico "Pinturas varias".
  const items = lista(
    (await pedir('items-buscar', 'GET', '/items?query=Pinturas%20varias')).json,
  );
  let item = items.find((i: Json) => i.name === 'Pinturas varias');
  if (!item) {
    const creado = await pedir('item-crear', 'POST', '/items', {
      name: 'Pinturas varias',
      price: 1000,
      tax: [{ id: iva.id }],
    });
    if (!exito(creado.status)) salir('No se pudo crear el ítem.');
    item = creado.json;
  }
  console.log(`   ítem "Pinturas varias" → id ${item.id}`);

  // 4. Contacto "Consumidor final".
  const cf = lista(
    (
      await pedir(
        'consumidor-final',
        'GET',
        `/contacts?identification=${CONSUMIDOR_FINAL}`,
      )
    ).json,
  ).find(
    (c: Json) =>
      c.identification === CONSUMIDOR_FINAL ||
      c.identificationObject?.number === CONSUMIDOR_FINAL,
  );
  console.log(
    cf
      ? `   consumidor final → id ${cf.id} kindOfPerson=${cf.kindOfPerson} regime=${cf.regime}`
      : '   no existe el contacto "Consumidor final"',
  );

  // 5. Contactos ficticios: uno completo y otro solo con lo que permite pedir la Res. 202 (art. 3).
  // Si ya existen (corrida anterior), se reutilizan.
  const completo =
    (await contactoPorNumero('contacto-completo-buscar', CEDULA_FICTICIA_1)) ??
    (
      await pedir('contacto-completo', 'POST', '/contacts', {
        nameObject: { firstName: 'Cliente', lastName: 'Ficticio' },
        identificationObject: { type: 'CC', number: CEDULA_FICTICIA_1 },
        kindOfPerson: 'PERSON_ENTITY',
        regime: 'SIMPLIFIED_REGIME',
        address: {
          address: 'Calle ficticia 1',
          department: 'Bogotá D.C.',
          city: 'Bogotá, D.C.',
          country: 'Colombia',
        },
        type: ['client'],
      })
    ).json;
  if (!(await contactoPorNumero('contacto-res-202-buscar', CEDULA_FICTICIA_2)))
    await pedir('contacto-res-202', 'POST', '/contacts', {
      nameObject: { firstName: 'Otro', lastName: 'Ficticio' },
      identificationObject: { type: 'CC', number: CEDULA_FICTICIA_2 },
      type: ['client'],
    });

  // 6. Borradores. La referencia propia va en observations (pregunta 3).
  const referencia = `facturabot:explorar-${Date.now()}`;
  const conCf = cf
    ? await crearBorrador(
        'borrador-consumidor-final',
        cf.id,
        item.id,
        iva.id,
        'Prueba ficticia facturabot',
        referencia,
      )
    : null;
  if (completo?.id)
    await crearBorrador(
      'borrador-contacto',
      completo.id,
      item.id,
      iva.id,
      'Prueba ficticia con contacto',
      referencia,
    );

  // 7. ¿Cambió el siguiente número de la numeración? (pregunta 4)
  const despues = await numeracionPreferida('numeracion-despues');
  console.log(
    `   siguiente número: antes=${antes?.nextInvoiceNumber} después=${despues?.nextInvoiceNumber}`,
  );

  if (!conCf) return;

  // 8. Consulta de una factura: sin fields y con cada fields por separado (juntos dieron 500).
  for (const fields of ['', 'pdf', 'xml', 'events', 'pdf,xml,events']) {
    const { status, json: detalle } = await pedir(
      `factura-detalle-${fields.replace(/,/g, '-') || 'sin-fields'}`,
      'GET',
      `/invoices/${conCf.id}${fields ? `?fields=${fields}` : ''}`,
    );
    if (!exito(status)) continue;
    console.log(
      `   pdf=${JSON.stringify(detalle?.pdf ?? null).slice(0, 80)} xml=${Boolean(detalle?.xml)} ` +
        `eventos=${JSON.stringify(detalle?.events ?? null).slice(0, 200)}`,
    );
    console.log(
      `   pistas DIAN: ${JSON.stringify(pistasDian(detalle)).slice(0, 400)}`,
    );
  }

  // 9. ¿observations vuelve en el listado y sirve para filtrar? (pregunta 3)
  // Un borrador de control con OTRA referencia: si el filtro lo trae, el filtro se ignora.
  await crearBorrador(
    'borrador-control',
    cf.id,
    item.id,
    iva.id,
    'Prueba ficticia de control',
    `facturabot:control-${Date.now()}`,
  );
  const base = `/invoices?date=${hoy}&client_identification=${CONSUMIDOR_FINAL}`;
  const listado = lista((await pedir('listado', 'GET', base)).json);
  const nuestra = listado.find((f: Json) => f.id === conCf.id);
  console.log(
    `   ${listado.length} facturas; la nuestra ${nuestra ? 'aparece' : 'NO aparece'}; observations en el listado: ${JSON.stringify(nuestra?.observations ?? '(no viene)')}`,
  );
  for (const filtro of ['observations', 'query']) {
    const r = lista(
      (
        await pedir(
          `listado-${filtro}`,
          'GET',
          `/invoices?date=${hoy}&${filtro}=${encodeURIComponent(referencia)}`,
        )
      ).json,
    );
    const soloNuestras = r.every((f: Json) => f.observations === referencia);
    console.log(
      `   filtro ${filtro}: ${r.length} resultados; ${soloNuestras ? 'todas con nuestra referencia' : 'trae otras (el filtro se ignora)'}`,
    );
  }

  // 10. Largo máximo de la descripción por línea (pregunta 2). Crea 4 borradores: solo con --largos.
  if (!process.argv.includes('--largos')) return;
  for (const largo of [500, 1000, 4000, 20000]) {
    const f = await crearBorrador(
      `descripcion-${largo}`,
      cf.id,
      item.id,
      iva.id,
      'x'.repeat(largo),
      referencia,
    );
    if (!f) break;
  }
}

main().catch((error: Error) => salir(`Falló: ${error.message}`));
