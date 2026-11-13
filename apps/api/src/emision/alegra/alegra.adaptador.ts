import { z } from 'zod';
import {
  type BusquedaPorReferencia,
  type CategoriaErrorProveedor,
  type EstadoDian,
  ErrorProveedor,
  type FacturaParaProveedor,
  type FacturaProveedor,
  type ModoEmision,
  type ProveedorFacturacion,
  type RefFactura,
  type ResultadoTimbrado,
} from '../proveedor-facturacion.js';
import { estadoTokenAlegra } from './token-alegra.js';

/**
 * Adaptador de Alegra (docs/planes/fase-5-alegra.md §4 y §5). Mínimo a propósito (el proveedor
 * final del piloto será probablemente Siigo): consumidor final, crear borrador, timbrar,
 * consultar y buscar por referencia. Todo lo de Alegra vive aquí; afuera solo se ve el puerto.
 *
 * Garantías: nunca envía `stamp` al crear; solo timbra con ALEGRA_EMITIR encendida, una emisión
 * TIMBRAR y una factura que tenga nuestra referencia; y nunca toca una factura de otra cuenta.
 * Zod en cada respuesta; los ids se pasan a forma canónica. Nada del cuerpo de las respuestas va a
 * los errores ni a los logs.
 */

/** Identificador genérico de la DIAN para "Consumidor final": no es de ninguna persona. */
const CONSUMIDOR_FINAL = '222222222222';
/** Producto genérico del modo simple (CLAUDE.md, decisiones de negocio). */
const PRODUCTO_GENERICO = 'Pinturas varias';
/** Código de Alegra al timbrar una factura ya emitida (documentación de POST /invoices/stamp). */
const CODIGO_YA_EMITIDA = 3226;
const TIEMPO_LIMITE_MS = 30_000;
/** Tope del cuerpo de una respuesta: más que esto no es una respuesta normal de Alegra. */
const MAXIMO_RESPUESTA_BYTES = 1_000_000;
/** Tope de la descripción de una línea (un borrador aceptó 20.000; el límite al timbrar, 🔴). */
const MAXIMO_DESCRIPCION = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Forma canónica de un id de Alegra: número en texto sin ceros a la izquierda ("007" → "7"), o
 * UUID en minúsculas (Alegra está pasando sus ids a UUID). Cualquier otra cosa se rechaza.
 */
export function idCanonicoAlegra(id: unknown): string | null {
  const texto =
    typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
      ? String(id)
      : typeof id === 'string'
        ? id.trim().toLowerCase()
        : null;
  if (texto === null) return null;
  if (/^\d{1,19}$/.test(texto)) return BigInt(texto).toString();
  return UUID.test(texto) ? texto : null;
}

const idSchema = z.unknown().transform((id, ctx) => {
  const canonico = idCanonicoAlegra(id);
  if (canonico === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'id de Alegra con forma desconocida',
    });
    return z.NEVER;
  }
  return canonico;
});

/** Una factura de venta, solo con lo que se usa. Lo demás se ignora (Alegra agrega campos). */
const facturaSchema = z.object({
  id: idSchema,
  status: z.string(),
  observations: z.string().nullish(),
  numberTemplate: z
    .object({
      prefix: z.string().nullish(),
      number: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
  // 🔴 Sin documentar en la respuesta (§10, pregunta 3): se leen si llegan, si no quedan en null.
  stamp: z
    .object({
      cufe: z.string().nullish(),
      legalStatus: z.string().nullish(),
    })
    .nullish(),
});

/** Lo que se le pide al adaptador, validado al entrar (en el paso 6 sale de la BD). */
const facturaEntradaSchema = z.object({
  referencia: z.string().regex(/^facturabot:[0-9a-f-]{36}$/),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cliente: z.object({ tipo: z.literal('consumidor_final') }),
  lineas: z
    .array(
      z.object({
        descripcion: z.string().trim().min(1).max(MAXIMO_DESCRIPCION),
        valor: z.number().int().positive().max(1_000_000_000_000),
      }),
    )
    .min(1),
});

/** La búsqueda, validada al entrar: sale de la BD. Hasta 3 días (la fecha original y la siguiente). */
const busquedaSchema = z.object({
  cuenta: z.string().min(1),
  referencia: z.string().regex(/^facturabot:[0-9a-f-]{36}$/),
  fechas: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1)
    .max(3),
  cliente: z.object({ tipo: z.literal('consumidor_final') }),
});

/** Facturas por página al listar (el máximo de `limit` en GET /invoices, 🔴 sin confirmar). */
const POR_PAGINA = 30;
/**
 * Tope de páginas por día (1.500 facturas a consumidor final en un día). Pasarlo es incierto: se
 * lanza un error en vez de responder "no está" sin haber leído todo.
 */
const MAXIMO_PAGINAS = 50;

/** Un error de Alegra con la forma conocida, sin id de factura: no se creó nada. */
const errorAlegraSchema = z
  .object({ code: z.unknown().optional(), message: z.unknown().optional() })
  .refine((e) => e.code !== undefined || e.message !== undefined)
  .refine((e) => !('id' in e));

const impuestosSchema = z.array(
  z.object({
    id: idSchema,
    type: z.string().nullish(),
    percentage: z.union([z.string(), z.number()]),
    status: z.string().nullish(),
  }),
);

const productosSchema = z.array(z.object({ id: idSchema, name: z.string() }));

const contactosSchema = z.array(
  z.object({
    id: idSchema,
    identification: z.string().nullish(),
    identificationObject: z.object({ number: z.string() }).nullish(),
  }),
);

const timbradoSchema = z.object({
  data: z.array(
    z.object({
      id: idSchema,
      success: z.boolean().optional(),
      code: z.union([z.number(), z.string()]).optional(),
    }),
  ),
});

/** Estados legales de Alegra en nuestros términos (catálogo Colombia del reporte; 🔴 sin confirmar). */
const ESTADOS_DIAN: Record<string, EstadoDian> = {
  PENDING: 'PENDIENTE',
  STAMPED_AND_WAITING_RESPONSE: 'PENDIENTE',
  ACCEPTED: 'ACEPTADA',
  STAMPED_AND_ACCEPTED: 'ACEPTADA',
  STAMPED_AND_ACCEPTED_WITH_OBSERVATIONS: 'ACEPTADA',
  REJECTED: 'RECHAZADA',
  STAMPED_AND_REJECTED: 'RECHAZADA',
};

function aFactura(datos: z.infer<typeof facturaSchema>): FacturaProveedor {
  const cufe = datos.stamp?.cufe ?? null;
  const estadoDian = ESTADOS_DIAN[datos.stamp?.legalStatus ?? ''] ?? null;
  const borrador = datos.status === 'draft';
  // Timbrada solo si Alegra lo confirma con CUFE o estado ante la DIAN (🔴 nombres sin confirmar):
  // un estado distinto de borrador sin esos datos es incierto, no "emitida".
  const timbrada =
    !borrador &&
    datos.status !== 'void' &&
    (cufe !== null || estadoDian !== null);
  const numero = datos.numberTemplate?.number;
  return {
    idExterno: datos.id,
    referencia: datos.observations?.trim() || null,
    borrador,
    timbrada,
    numero:
      timbrada && numero !== null && numero !== undefined
        ? `${datos.numberTemplate?.prefix ?? ''}${numero}`
        : null,
    cufe,
    estadoDian,
  };
}

/** Categoría según el código HTTP de una respuesta que no fue 2xx. */
function categoriaHttp(status: number): CategoriaErrorProveedor {
  if (status === 400) return 'rechazo_validacion';
  if (status === 401) return 'no_autorizado';
  if (status === 402) return 'plan_sin_api';
  if (status === 403) return 'sin_permiso';
  if (status === 404) return 'no_encontrada';
  if (status === 429) return 'limite_de_pedidos';
  if (status >= 500) return 'error_servidor';
  return 'http_inesperado';
}

export interface OpcionesAlegra {
  /** JWT de Integraciones (ALEGRA_TOKEN). */
  token: string;
  /** Base de la API (ALEGRA_URL). Solo https, salvo localhost para las pruebas. */
  url: string;
  /** ALEGRA_EMITIR: sin ella encendida, nunca se timbra. */
  emitir: boolean;
  /** Reloj inyectable para las pruebas del vencimiento. */
  ahora?: () => Date;
}

interface Respuesta {
  status: number;
  cuerpo: unknown;
}

export class AlegraAdaptador implements ProveedorFacturacion {
  readonly nombre = 'ALEGRA' as const;
  private readonly base: string;
  private readonly ahora: () => Date;
  /** Ids de la cuenta que la emisión necesita, leídos una vez (no cambian entre facturas). */
  private recursos?: Promise<{
    iva: string;
    producto: string;
    cliente: string;
  }>;

  constructor(private readonly opciones: OpcionesAlegra) {
    const url = new URL(opciones.url);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('La URL de Alegra debe ser https');
    }
    this.base = url.href.replace(/\/+$/, '');
    this.ahora = opciones.ahora ?? (() => new Date());
  }

  cuenta(): string {
    const estado = estadoTokenAlegra(this.opciones.token, this.ahora());
    switch (estado.estado) {
      case 'sin_token':
        throw new ErrorProveedor('token_ausente');
      case 'cuenta_invalida':
      case 'sin_vencimiento':
        throw new ErrorProveedor('cuenta_invalida');
      case 'vencido':
        throw new ErrorProveedor('token_vencido');
      default:
        return estado.cuenta;
    }
  }

  async crearBorrador(
    factura: FacturaParaProveedor,
  ): Promise<FacturaProveedor> {
    if (!facturaEntradaSchema.safeParse(factura).success) {
      throw new ErrorProveedor('rechazo_validacion');
    }
    const { iva, producto, cliente } = await this.leerRecursos();
    // Sin `stamp` ni `status`: Alegra la crea en borrador (exploración del 2026-11-06).
    const cuerpo = {
      date: factura.fecha,
      dueDate: factura.fecha,
      client: { id: cliente },
      items: factura.lineas.map((linea) => ({
        id: producto,
        price: linea.valor,
        quantity: 1,
        description: linea.descripcion,
        tax: [{ id: iva }],
      })),
      paymentForm: 'CASH',
      paymentMethod: 'CASH',
      observations: factura.referencia,
    };
    const respuesta = await this.pedir('POST', '/invoices', cuerpo);
    let creada: FacturaProveedor;
    if (respuesta.status === 400) {
      // Un 400 que trae la factura creada también es un borrador creado (§4). Solo es "no se creó"
      // (definitivo) si el cuerpo es un error conocido sin id; si no se pudo leer, es incierto.
      const conFactura = facturaSchema.safeParse(respuesta.cuerpo);
      if (!conFactura.success) {
        throw new ErrorProveedor(
          errorAlegraSchema.safeParse(respuesta.cuerpo).success
            ? 'rechazo_validacion'
            : 'respuesta_invalida',
        );
      }
      creada = aFactura(conFactura.data);
    } else {
      creada = aFactura(this.validar(respuesta, facturaSchema));
    }
    // Tiene que ser nuestro borrador: si llegó timbrada o con otra referencia, algo no cuadra.
    if (!creada.borrador || creada.referencia !== factura.referencia) {
      throw new ErrorProveedor('respuesta_invalida');
    }
    return creada;
  }

  async timbrar(
    ref: RefFactura,
    modo: ModoEmision,
  ): Promise<ResultadoTimbrado> {
    if (modo !== 'TIMBRAR') throw new ErrorProveedor('modo_solo_borrador');
    if (!this.opciones.emitir) throw new ErrorProveedor('emision_apagada');
    const id = this.idPropio(ref);
    // Antes de timbrar: la factura tiene que ser nuestra (§4).
    const actual = await this.consultar(ref);
    if (actual.referencia !== ref.referencia) {
      throw new ErrorProveedor('factura_ajena');
    }
    if (actual.timbrada) return { resultado: 'ya_timbrada' };
    // Ni borrador ni timbrada confirmada: no se sabe en qué estado está, no se pide el stamp.
    if (!actual.borrador) throw new ErrorProveedor('respuesta_invalida');
    const respuesta = await this.pedir('POST', '/invoices/stamp', {
      ids: [id],
    });
    // Alegra responde 200 si al menos una salió, y 400 con el detalle por factura si no.
    const resultado = timbradoSchema.safeParse(respuesta.cuerpo);
    const nuestra = resultado.success
      ? resultado.data.data.find((d) => d.id === id)
      : undefined;
    if (!nuestra) {
      if (respuesta.status >= 200 && respuesta.status < 300) {
        throw new ErrorProveedor('respuesta_invalida');
      }
      throw new ErrorProveedor(categoriaHttp(respuesta.status));
    }
    if (nuestra.success === true) return { resultado: 'timbrada' };
    if (Number(nuestra.code) === CODIGO_YA_EMITIDA) {
      return { resultado: 'ya_timbrada' };
    }
    // Rechazada solo con un código de error explícito; sin success ni código, pudo timbrarse.
    const codigo = String(nuestra.code ?? '')
      .replace(/\W/g, '')
      .slice(0, 32);
    if (codigo === '') throw new ErrorProveedor('respuesta_invalida');
    return { resultado: 'rechazada', codigo: `alegra_${codigo}` };
  }

  async consultar(
    ref: Omit<RefFactura, 'referencia'>,
  ): Promise<FacturaProveedor> {
    const id = this.idPropio(ref);
    const respuesta = await this.pedir('GET', `/invoices/${id}`);
    const factura = aFactura(this.validar(respuesta, facturaSchema));
    if (factura.idExterno !== id)
      throw new ErrorProveedor('respuesta_invalida');
    return factura;
  }

  /**
   * Solo GET: lista las facturas a consumidor final de cada fecha, todas las páginas, y se queda con
   * las que tienen exactamente nuestra referencia en `observations` (el filtro de Alegra por
   * `observations` se ignora: investigación del 2026-11-04). Nunca crea ni timbra nada.
   */
  async buscarPorReferencia(
    busqueda: BusquedaPorReferencia,
  ): Promise<FacturaProveedor[]> {
    if (!busquedaSchema.safeParse(busqueda).success) {
      throw new ErrorProveedor('rechazo_validacion');
    }
    // Una fila de otra cuenta no causa ni un GET.
    if (busqueda.cuenta !== this.cuenta()) {
      throw new ErrorProveedor('otra_cuenta');
    }
    const encontradas = new Map<string, FacturaProveedor>();
    for (const fecha of new Set(busqueda.fechas)) {
      for (let pagina = 0; ; pagina++) {
        if (pagina >= MAXIMO_PAGINAS) {
          throw new ErrorProveedor('respuesta_invalida');
        }
        const consulta = new URLSearchParams({
          date: fecha,
          client_identification: CONSUMIDOR_FINAL,
          start: String(pagina * POR_PAGINA),
          limit: String(POR_PAGINA),
        });
        const facturas = this.validar(
          await this.pedir('GET', `/invoices?${consulta}`),
          z.array(facturaSchema).max(POR_PAGINA),
        );
        for (const datos of facturas) {
          // Exacta y sin recortar: "facturabot:<id> " o "facturabot:<id>-x" no son nuestras.
          if (datos.observations === busqueda.referencia) {
            encontradas.set(datos.id, aFactura(datos));
          }
        }
        if (facturas.length < POR_PAGINA) break;
      }
    }
    return [...encontradas.values()];
  }

  /** El id en forma canónica, si la referencia es de la cuenta del token actual. */
  private idPropio(ref: Omit<RefFactura, 'referencia'>): string {
    if (ref.cuenta !== this.cuenta()) throw new ErrorProveedor('otra_cuenta');
    const id = idCanonicoAlegra(ref.idExterno);
    if (id === null) throw new ErrorProveedor('rechazo_validacion');
    return id;
  }

  /** IVA 19 %, producto genérico y contacto "Consumidor final": deben existir en la cuenta. */
  private leerRecursos(): Promise<{
    iva: string;
    producto: string;
    cliente: string;
  }> {
    this.recursos ??= (async () => {
      const impuestos = this.validar(
        await this.pedir('GET', '/taxes'),
        impuestosSchema,
      );
      const iva = impuestos.find(
        (t) =>
          Number(t.percentage) === 19 &&
          (t.type ?? 'IVA') === 'IVA' &&
          (t.status ?? 'active') === 'active',
      );
      const productos = this.validar(
        await this.pedir(
          'GET',
          `/items?query=${encodeURIComponent(PRODUCTO_GENERICO)}`,
        ),
        productosSchema,
      );
      const producto = productos.find((p) => p.name === PRODUCTO_GENERICO);
      // La búsqueda de Alegra es "contiene": se compara el número exacto de nuestro lado.
      const contactos = this.validar(
        await this.pedir('GET', `/contacts?identification=${CONSUMIDOR_FINAL}`),
        contactosSchema,
      );
      const cliente = contactos.find(
        (c) =>
          (c.identificationObject?.number ?? c.identification) ===
          CONSUMIDOR_FINAL,
      );
      if (!iva || !producto || !cliente) {
        throw new ErrorProveedor('recurso_faltante');
      }
      return { iva: iva.id, producto: producto.id, cliente: cliente.id };
    })();
    // Si falla, la próxima factura lo vuelve a intentar.
    this.recursos.catch(() => (this.recursos = undefined));
    return this.recursos;
  }

  /** Respuesta 2xx que cumple el esquema; si no, el error que corresponde. */
  private validar<T>(respuesta: Respuesta, esquema: z.ZodType<T>): T {
    if (respuesta.status < 200 || respuesta.status >= 300) {
      throw new ErrorProveedor(categoriaHttp(respuesta.status));
    }
    const datos = esquema.safeParse(respuesta.cuerpo);
    if (!datos.success) throw new ErrorProveedor('respuesta_invalida');
    return datos.data;
  }

  private async pedir(
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo?: unknown,
  ): Promise<Respuesta> {
    // Antes de cualquier pedido: hay token vigente y se sabe de qué cuenta es.
    this.cuenta();
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.base}${ruta}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${this.opciones.token}`,
          Accept: 'application/json',
          ...(cuerpo === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch (err) {
      throw new ErrorProveedor(
        err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'red',
        { cause: err },
      );
    }
    const texto = await leerConTope(respuesta);
    let json: unknown = null;
    try {
      json = JSON.parse(texto);
    } catch {
      // Sin cuerpo JSON: cuenta el código HTTP (y Zod lo rechaza si era 2xx).
    }
    return { status: respuesta.status, cuerpo: json };
  }
}

/**
 * El cuerpo como texto, contando los bytes mientras llegan (con o sin Content-Length): más de
 * MAXIMO_RESPUESTA_BYTES es respuesta_invalida y se deja de leer. Un corte (p. ej. el tiempo
 * límite) a mitad del cuerpo deja un texto vacío, que Zod rechaza si era 2xx.
 */
async function leerConTope(respuesta: Response): Promise<string> {
  if (!respuesta.body) return '';
  const lector = respuesta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMO_RESPUESTA_BYTES) {
        await lector.cancel();
        throw new ErrorProveedor('respuesta_invalida');
      }
      partes.push(value);
    }
  } catch (err) {
    if (err instanceof ErrorProveedor) throw err;
    return '';
  }
  return Buffer.concat(partes).toString('utf8');
}
