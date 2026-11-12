/**
 * Puerto del proveedor de factura electrónica (docs/planes/fase-5-alegra.md §4 y §5), en términos
 * nuestros: nada de Alegra (ni de Siigo) sale de aquí. Lo usa el servicio de emisión (paso 6).
 *
 * Emisión en dos tiempos: `crearBorrador` (nunca timbra) y luego `timbrar` el mismo id. Repetir
 * `timbrar` no duplica. Las operaciones con id exigen la cuenta y fallan, sin llamar al proveedor,
 * si no es la del token actual.
 */

/** Proveedores que existen en el esquema (mismos valores que el enum ProveedorFacturacion de Prisma). */
export type NombreProveedor = 'ALEGRA' | 'SIIGO';

/** Con qué valor de la bandera de emisión nació una emisión (enum ModoEmision de Prisma). */
export type ModoEmision = 'SOLO_BORRADOR' | 'TIMBRAR';

/** Resultado de la DIAN en nuestros términos (enum EstadoDian de Prisma). */
export type EstadoDian = 'PENDIENTE' | 'ACEPTADA' | 'RECHAZADA';

/** Una línea de la factura: el valor es sin IVA; el IVA (19 %) lo calcula el proveedor. */
export interface LineaFactura {
  descripcion: string;
  /** Pesos enteros, sin IVA. */
  valor: number;
}

/**
 * Lo que se le pide al proveedor. Por ahora solo consumidor final (§6: las primeras facturas reales
 * son a consumidor final); el cliente identificado llega en el paso 7.
 */
export interface FacturaParaProveedor {
  /** Nuestra referencia ("facturabot:<emisionId>"): con ella se reconcilia. */
  referencia: string;
  /** Día de la factura (AAAA-MM-DD, hora de Colombia), fijado al nacer la emisión. */
  fecha: string;
  cliente: { tipo: 'consumidor_final' };
  lineas: LineaFactura[];
}

/** Una factura tal como la ve el proveedor, en nuestros términos. */
export interface FacturaProveedor {
  /** Id en el proveedor, en forma canónica. */
  idExterno: string;
  /** La referencia que guardamos al crearla, o null si no tiene (no es nuestra). */
  referencia: string | null;
  /** true si sigue en borrador (no timbrada). */
  borrador: boolean;
  /**
   * true solo si el proveedor confirma el timbrado (trae CUFE o estado ante la DIAN). Si no es
   * borrador ni está confirmada, el estado es incierto: no se da por emitida.
   */
  timbrada: boolean;
  /** Número con prefijo, si ya está timbrada. */
  numero: string | null;
  /** CUFE, si el proveedor lo devuelve. */
  cufe: string | null;
  estadoDian: EstadoDian | null;
}

/** Qué identifica a una factura del proveedor, con la cuenta y el modo con que nació la emisión. */
export interface RefFactura {
  cuenta: string;
  idExterno: string;
  /** La referencia que debe tener (se comprueba antes de timbrar). */
  referencia: string;
}

export type ResultadoTimbrado =
  | { resultado: 'timbrada' }
  /** El proveedor dice que ya estaba timbrada (repetir el timbrado no duplica). */
  | { resultado: 'ya_timbrada' }
  /** El proveedor rechazó el timbrado de esa factura; `codigo` es solo un código. */
  | { resultado: 'rechazada'; codigo: string };

/**
 * Por qué falló una operación.
 * - `definitivo` **solo en `crearBorrador`**: seguro que no se creó nada (el servicio puede marcar
 *   NO_CREADA y permitir un reintento explícito).
 * - `incierto`: pudo haber llegado (timeout, red, 5xx, respuesta rara): se reconcilia, nunca se
 *   repite solo (§4).
 * En `timbrar` y `consultar` la factura ya existe en el proveedor: **ningún** error, definitivo o
 * no, permite volver al paso 1 (PENDIENTE o NO_CREADA); la emisión conserva su id externo.
 */
export const CATEGORIAS_ERROR_PROVEEDOR = {
  // Configuración y guardas: nunca se llamó al proveedor.
  token_ausente: 'definitivo',
  token_vencido: 'definitivo',
  cuenta_invalida: 'definitivo',
  otra_cuenta: 'definitivo',
  emision_apagada: 'definitivo',
  modo_solo_borrador: 'definitivo',
  /** La factura del proveedor no tiene nuestra referencia: no se timbra. */
  factura_ajena: 'definitivo',
  /** Falta en la cuenta algo que la emisión necesita (impuesto, producto, consumidor final). */
  recurso_faltante: 'definitivo',
  // Respuestas del proveedor que dicen claramente que no se hizo.
  no_autorizado: 'definitivo',
  plan_sin_api: 'definitivo',
  sin_permiso: 'definitivo',
  no_encontrada: 'definitivo',
  limite_de_pedidos: 'definitivo',
  rechazo_validacion: 'definitivo',
  // Pudo haber llegado.
  timeout: 'incierto',
  red: 'incierto',
  error_servidor: 'incierto',
  respuesta_invalida: 'incierto',
  http_inesperado: 'incierto',
} as const;

export type CategoriaErrorProveedor = keyof typeof CATEGORIAS_ERROR_PROVEEDOR;

/** Error del proveedor con una categoría fija y segura para los logs (sin datos ni mensajes). */
export class ErrorProveedor extends Error {
  override readonly name = 'ErrorProveedor';
  readonly definitivo: boolean;
  constructor(
    readonly categoria: CategoriaErrorProveedor,
    opciones?: { cause?: unknown },
  ) {
    super(categoria, opciones);
    this.definitivo = CATEGORIAS_ERROR_PROVEEDOR[categoria] === 'definitivo';
  }
}

export interface ProveedorFacturacion {
  readonly nombre: NombreProveedor;
  /**
   * La cuenta del token actual (forma canónica). Lanza ErrorProveedor si no hay token, venció o
   * no se sabe de qué cuenta es: en ese caso no se emite.
   */
  cuenta(): string;
  /** Crea la factura en borrador (nunca la timbra). */
  crearBorrador(factura: FacturaParaProveedor): Promise<FacturaProveedor>;
  /** Timbra ante la DIAN la factura creada por `crearBorrador`. */
  timbrar(ref: RefFactura, modo: ModoEmision): Promise<ResultadoTimbrado>;
  consultar(ref: Omit<RefFactura, 'referencia'>): Promise<FacturaProveedor>;
}
