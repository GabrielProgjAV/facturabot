import { z } from 'zod';
import {
  analizarIdentificacion,
  esDocumentoExtranjero,
  type Identificacion,
} from './identificacion.js';

/**
 * Nombre que termina en un tipo de sociedad: S.A.S., S.A., Ltda., E.U., S. en C., S.C.A., "& Cía.",
 * con "BIC" opcional al final. Heurística: un nombre comercial sin tipo de sociedad no se reconoce.
 * Solo al final del nombre, para no confundir "Rosa" o "Elsa" con "S.A.".
 */
const NOMBRE_DE_EMPRESA =
  /(?:(?:^|[\s,.])(?:s\.?\s?a\.?\s?s|s\.?\s?a|ltda|limitada|e\.?\s?u|s\.?\s?c\.?\s?a|s\.?\s?en\s?c(?:\.?\s?s|\.?\s?a)?)|(?:&|\by)\s*c[ií]a)(?:\.?\s+bic)?\.?\s*$/i;

/** true si el nombre del cliente tiene la forma de una persona jurídica (p. ej. "Pinturas Sol SAS"). */
export function pareceEmpresa(nombre: string | null): boolean {
  return nombre !== null && NOMBRE_DE_EMPRESA.test(nombre.trim());
}

/**
 * Palabras de nombres de negocio que no son un tipo de sociedad ("Ferretería El Tornillo",
 * "Inversiones Ejemplo"). Heurística: no distingue una empresa de una persona natural comerciante,
 * cuyo NIT es su cédula; por eso solo advierte, no bloquea la aprobación.
 */
const NOMBRE_DE_NEGOCIO =
  /\b(?:ferreteria|pinturas?|distribuidora|distribuciones|comercializadora|importadora|inversiones|constructora|construcciones|almacen(?:es)?|deposito|industrias?|grupo|corporacion|fundacion|asociacion|cooperativa|hermanos|servicios|soluciones|taller|drogueria|panaderia|restaurante|hotel|colegio|clinica|e\s+hijos|y\s+asociados)\b/;

/** true si el nombre parece de un negocio sin tipo de sociedad (ver `NOMBRE_DE_NEGOCIO`). */
export function pareceNegocio(nombre: string | null): boolean {
  return (
    nombre !== null &&
    !pareceEmpresa(nombre) &&
    NOMBRE_DE_NEGOCIO.test(
      nombre.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
    )
  );
}

/** Línea de la factura tal como la entendimos (valor = total de la línea, sin IVA). */
export interface ItemBorrador {
  descripcion: string;
  valor: number | null;
}

/** Factura en construcción: lo que se sabe hasta ahora. null = todavía no se sabe. */
export interface BorradorFactura {
  cliente: {
    nombre: string | null;
    identificacion: string | null;
    /** La identificación actual la dictó el usuario en una nota de voz (Whisper pierde dígitos). */
    identificacionPorVoz?: boolean;
    /**
     * Al crear el borrador, la IA leyó un nombre o una identificación que no está escrito en el
     * mensaje y se dejó vacío (`sinDatosNoDichos`). Mientras siga así, un cliente vacío **no** es
     * consumidor final: el usuario escribe el dato o "consumidor final" (Gabriel, 2026-11-12).
     */
    vaciado?: boolean;
  };
  items: ItemBorrador[];
  /** Total escrito por el usuario, sin IVA. */
  totalEscrito: number | null;
}

/** Pesos enteros y no negativos: así los deja `parsePesos`. */
const pesosSchema = z
  .number()
  .int()
  .nonnegative()
  .max(1_000_000_000_000)
  .nullable();

/**
 * Forma de `BorradorFactura` guardada en la BD (`Borrador.datos`). Se valida al leer: la emisión
 * lee de aquí lo que va a la DIAN, y un JSON de la BD no es de fiar (CLAUDE.md).
 */
export const borradorFacturaSchema = z.object({
  cliente: z.object({
    nombre: z.string().nullable(),
    identificacion: z.string().nullable(),
    identificacionPorVoz: z.boolean().optional(),
    vaciado: z.boolean().optional(),
  }),
  items: z.array(z.object({ descripcion: z.string(), valor: pesosSchema })),
  totalEscrito: pesosSchema,
}) satisfies z.ZodType<BorradorFactura>;

/**
 * Los `datos` guardados no tienen la forma de un borrador (cambio manual en la BD, o un error de
 * una versión anterior). No se corrigen solos: el usuario cancela y empieza de nuevo.
 */
export class DatosBorradorInvalidosError extends Error {
  override readonly name = 'DatosBorradorInvalidosError';
  /** @param campos rutas de los campos que fallaron (p. ej. "items.0.valor"), nunca sus valores. */
  constructor(readonly campos: string[]) {
    super(`Datos del borrador inválidos en: ${campos.join(', ')}`);
  }
}

/** Valida el JSON de `Borrador.datos`; lanza `DatosBorradorInvalidosError` si no cuadra. */
export function leerBorradorFactura(datos: unknown): BorradorFactura {
  const resultado = borradorFacturaSchema.safeParse(datos);
  if (!resultado.success) {
    throw new DatosBorradorInvalidosError(
      resultado.error.issues.map(
        (i) => i.path.map(String).join('.') || '(raíz)',
      ),
    );
  }
  return resultado.data;
}

export const TASA_IVA = 0.19;

/**
 * Convierte un valor en pesos escrito por una persona a número.
 * En Colombia el punto separa miles y la coma decimales: "78.000" = 78000.
 * Acepta "$78.000", "78 mil", "1.250.000", 45000. Devuelve null si no es un valor válido.
 */
export function parsePesos(valor: string | number | null): number | null {
  if (valor === null) return null;
  if (typeof valor === 'number') return enRango(valor);

  let texto = valor.toLowerCase().replace(/\$|\s/g, '');
  const multiplicador = texto.endsWith('mil') ? 1000 : 1;
  texto = texto.replace(/mil$/, '').replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(texto)) return null;

  return enRango(Math.round(Number(texto) * multiplicador));
}

/**
 * Tope de un valor en pesos (un billón): más que eso es un error de lectura, y pasado el rango de
 * enteros seguros la suma perdería precisión. Se devuelve null: el resumen muestra ❓ y se pregunta.
 */
export const MAXIMO_PESOS = 1_000_000_000_000;

function enRango(valor: number): number | null {
  return Number.isFinite(valor) && valor >= 0 && valor <= MAXIMO_PESOS
    ? valor
    : null;
}

/** Base gravable: el total escrito, o la suma de los ítems si todos tienen valor. */
export function totalBase(borrador: BorradorFactura): number | null {
  if (borrador.totalEscrito !== null) return borrador.totalEscrito;
  const valores = borrador.items.map((item) => item.valor);
  if (valores.length === 0 || valores.includes(null)) return null;
  return (valores as number[]).reduce((suma, v) => suma + v, 0);
}

/**
 * A quién va la venta (Res. DIAN 000202 de 2025, art. 3, y decisiones de Gabriel del 2026-11-12):
 * - `consumidor_final`: sin nombre ni identificación, y nada de eso se vació al crear.
 * - `identificado`: con nombre e identificación. El bot todavía no emite a nombre de alguien.
 * - `a_medias`: solo uno de los dos, o un cliente que la IA leyó sin estar escrito: se pregunta.
 */
export type ClienteDeVenta = 'consumidor_final' | 'identificado' | 'a_medias';

export function clienteDeVenta(borrador: BorradorFactura): ClienteDeVenta {
  const { nombre, identificacion, vaciado } = borrador.cliente;
  if (nombre && identificacion) return 'identificado';
  if (!nombre && !identificacion && !vaciado) return 'consumidor_final';
  return 'a_medias';
}

/** "consumidor final" como mensaje completo ("es consumidor final", "a consumidor final."). */
const CONSUMIDOR_FINAL =
  /^\s*(?:(?:es|a|para)\s+)?(?:un\s+)?consumidor\s+final\s*[.!]*\s*$/i;

/** true si el mensaje entero dice que la venta es a consumidor final. */
export function esConsumidorFinal(mensaje: string): boolean {
  return CONSUMIDOR_FINAL.test(mensaje);
}

/**
 * El borrador como venta a consumidor final: sin nombre ni identificación y sin la marca de
 * vaciado. Solo se usa cuando el usuario lo escribió (`esConsumidorFinal`), nunca por la IA.
 */
export function aConsumidorFinal(borrador: BorradorFactura): BorradorFactura {
  return {
    ...borrador,
    cliente: { nombre: null, identificacion: null },
  };
}

/**
 * Si la IA puso "consumidor final" como nombre del cliente (sin identificación), es lo que el
 * usuario escribió: se deja sin nombre, que es como se guarda un consumidor final.
 */
export function sinNombreConsumidorFinal(
  borrador: BorradorFactura,
): BorradorFactura {
  const { nombre, identificacion } = borrador.cliente;
  if (identificacion || !nombre || !/^\s*consumidor\s+final\s*$/i.test(nombre))
    return borrador;
  return { ...borrador, cliente: { ...borrador.cliente, nombre: null } };
}

/**
 * La marca de vaciado pasa de una versión a la siguiente (la IA no la ve) hasta que el usuario
 * escribe el nombre o la identificación.
 */
export function conMarcaDeVaciado(
  anterior: BorradorFactura,
  nuevo: BorradorFactura,
): BorradorFactura {
  const { vaciado: _descartada, ...cliente } = nuevo.cliente;
  const sigue =
    anterior.cliente.vaciado === true &&
    !nuevo.cliente.nombre &&
    !nuevo.cliente.identificacion;
  return { ...nuevo, cliente: sigue ? { ...cliente, vaciado: true } : cliente };
}

/** Datos que faltan para poder aprobar, en palabras para el usuario. */
export function camposFaltantes(borrador: BorradorFactura): string[] {
  const faltantes: string[] = [];
  if (clienteDeVenta(borrador) === 'a_medias') {
    if (!borrador.cliente.nombre) faltantes.push('nombre del cliente');
    if (!borrador.cliente.identificacion)
      faltantes.push('NIT o cédula del cliente');
  }
  if (!totalBase(borrador)) faltantes.push('total de la factura');
  return faltantes;
}

/** Cómo decir que la venta es a consumidor final, cuando faltan datos del cliente. */
const O_CONSUMIDOR_FINAL =
  'Si la venta es a consumidor final, escribe "consumidor final".';

/** true si hay total escrito y todos los ítems tienen valor, pero no suman lo mismo. */
export function sumaNoCuadra(borrador: BorradorFactura): boolean {
  const valores = borrador.items.map((item) => item.valor);
  if (borrador.totalEscrito === null || valores.length === 0) return false;
  if (valores.includes(null)) return false;
  const suma = (valores as number[]).reduce((total, v) => total + v, 0);
  return suma !== borrador.totalEscrito;
}

/**
 * true si hay total escrito, algún ítem sin valor, y los que sí tienen valor ya suman más que el
 * total: ningún valor de los que faltan puede cuadrarlo (no hay valores negativos).
 */
export function sumaParcialSupera(borrador: BorradorFactura): boolean {
  const valores = borrador.items.map((item) => item.valor);
  if (borrador.totalEscrito === null || !valores.includes(null)) return false;
  const suma = valores.reduce<number>((total, v) => total + (v ?? 0), 0);
  return suma > borrador.totalEscrito;
}

/**
 * La identificación del cliente analizada (forma y DV), o null si no hay. Se guarda tal como la
 * escribió el usuario y se analiza al mostrarla o aprobarla: el código decide, nunca la IA.
 */
export function identificacionCliente(
  borrador: BorradorFactura,
): Identificacion | null {
  const { identificacion, nombre } = borrador.cliente;
  if (!identificacion) return null;
  const id = analizarIdentificacion(
    identificacion,
    esDocumentoExtranjero(identificacion),
  );
  // Un NIT de empresa al que le falta un dígito tiene la forma de una cédula antigua: solo el
  // nombre lo delata (hallazgo 3 de la auditoría del PR #3). Se pregunta, no se corrige.
  if (
    !id.problema &&
    pareceEmpresa(nombre) &&
    id.forma !== 'nit_persona_juridica'
  ) {
    const digitos = /^\d+$/.test(id.numero)
      ? `tiene ${id.numero.length} dígitos`
      : 'no es un NIT';
    return {
      ...id,
      problema: `El cliente parece una empresa, pero su identificación ${digitos}: un NIT de empresa tiene 9 dígitos (desde 800.000.000) más el dígito de verificación. ¿Lo revisas?`,
    };
  }
  return id;
}

/**
 * Marca de dónde viene la identificación: si cambió con este mensaje, vino por voz o por texto
 * según `porVoz`; si no cambió, conserva la marca anterior. La IA no ve la marca, así que se
 * vuelve a poner aquí tras interpretar.
 */
export function conOrigenDeIdentificacion(
  anterior: BorradorFactura | undefined,
  nuevo: BorradorFactura,
  porVoz: boolean,
): BorradorFactura {
  const { identificacion } = nuevo.cliente;
  const cambio = identificacion !== (anterior?.cliente.identificacion ?? null);
  const marca = cambio
    ? porVoz
    : (anterior?.cliente.identificacionPorVoz ?? false);
  const { identificacionPorVoz: _descartada, ...cliente } = nuevo.cliente;
  return {
    ...nuevo,
    cliente:
      identificacion && marca
        ? { ...cliente, identificacionPorVoz: true }
        : cliente,
  };
}

/**
 * "quita", "elimina", "borra" y sus formas ("quítale", "elimínalo", "bórramelo", "quitamos"),
 * como palabra entera (límites Unicode: "quitaría" no cuenta): no "borrador" ni "quitamanchas" (un
 * producto). Tampoco con una negación hasta 3 palabras antes ("no quites la brocha", "no se la
 * borres", "nunca quites", "no quiero que quites"); una coma corta la negación ("no, quita…").
 */
const PIDE_QUITAR =
  /(?<!(?<![\p{L}\p{N}])(?:no|sin|nunca|tampoco)(?:\s+\p{L}+){0,3}\s+)(?<![\p{L}\p{N}])(?:qu[ií]t|elim[ií]n|b[oó]rr)(?:a|e|o|ar|as|an|es|en|amos|emos|ando|ado|ada|ados|adas)(?:me|te|se|nos)?(?:le|la|lo|les|las|los)?(?![\p{L}\p{N}])/iu;

/** Palabras que no distinguen un producto de otro. */
const PALABRAS_VACIAS = new Set([
  'del',
  'las',
  'los',
  'con',
  'por',
  'para',
  'una',
  'uno',
  'unos',
  'unas',
  'que',
]);

/** Minúsculas y sin tildes, para comparar descripciones. */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

/** Palabras con las que se puede nombrar un producto: 3 letras o más, sin números sueltos. */
function palabras(texto: string): string[] {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (p) => p.length >= 3 && !/^\d+$/.test(p) && !PALABRAS_VACIAS.has(p),
    );
}

/** La misma palabra, en singular o plural simple ("galón" y "galones"). */
function mismaPalabra(a: string, b: string): boolean {
  return (
    [a, `${a}s`, `${a}es`].includes(b) || [b, `${b}s`, `${b}es`].includes(a)
  );
}

/**
 * true si el mensaje nombra el ítem: alguna de sus palabras que no tengan los demás ítems
 * ("blanco" entre "galón blanco" y "galón azul"); si no tiene ninguna propia, cualquiera.
 */
function nombraItem(
  item: ItemBorrador,
  todos: ItemBorrador[],
  palabrasMensaje: string[],
): boolean {
  const suyas = palabras(item.descripcion);
  const deOtros = todos
    .filter((otro) => otro !== item)
    .flatMap((otro) => palabras(otro.descripcion));
  const propias = suyas.filter((p) => !deOtros.some((o) => mismaPalabra(o, p)));
  const candidatas = propias.length > 0 ? propias : suyas;
  return candidatas.some((p) =>
    palabrasMensaje.some((m) => mismaPalabra(m, p)),
  );
}

/**
 * Empareja los ítems de antes con los de después por descripción (sin tildes ni mayúsculas).
 * Cada ítem de después se usa una sola vez, para que dos "vinilo" no cuenten como uno.
 */
function emparejar(
  antes: ItemBorrador[],
  despues: ItemBorrador[],
): {
  pares: [ItemBorrador, ItemBorrador][];
  faltan: ItemBorrador[];
  /** Ítems de después sin pareja: nuevos, o con la descripción reescrita. */
  sobran: ItemBorrador[];
} {
  const libres = [...despues];
  const pares: [ItemBorrador, ItemBorrador][] = [];
  const faltan: ItemBorrador[] = [];
  for (const item of antes) {
    const i = libres.findIndex(
      (d) => normalizar(d.descripcion) === normalizar(item.descripcion),
    );
    if (i === -1) faltan.push(item);
    else
      pares.push([item, ...libres.splice(i, 1)] as [
        ItemBorrador,
        ItemBorrador,
      ]);
  }
  return { pares, faltan, sobran: libres };
}

export interface ItemsQuitados {
  cantidad: number;
  /**
   * Los que se iban sin que el mensaje los nombrara; vacía si la IA reescribió alguna descripción
   * y no se sabe cuáles se fueron.
   */
  descripciones: string[];
}

/**
 * Ítems que una corrección hizo desaparecer sin que el mensaje lo pidiera, o null si no hay.
 * La IA a veces "olvida" productos al devolver el borrador completo (CLAUDE.md: un ítem que
 * desaparece se pregunta, nunca se deja pasar en silencio). Para quitarlo, el mensaje tiene que
 * pedirlo ("quita", "elimina", "borra") y nombrar cada ítem que se va (hallazgo 4 de la auditoría
 * del PR #3): "quita la brocha" no permite que desaparezca también el vinilo.
 * Un ítem reemplazado por otro (caso f) lo detecta `itemsReemplazadosSinPedir`. Límites
 * conocidos: no reconoce "saca" o "ya no va" como pedido de quitar (se pregunta de más); y nombrar
 * no es pedir: con "quita la brocha y el vinilo déjalo a 45 mil" el vinilo también puede irse,
 * porque el código no relaciona cada ítem con el verbo.
 */
export function itemsQuitadosSinPedir(
  antes: BorradorFactura,
  despues: BorradorFactura,
  mensaje: string,
): ItemsQuitados | null {
  if (despues.items.length >= antes.items.length) return null;
  const cantidad = antes.items.length - despues.items.length;
  const { faltan } = emparejar(antes.items, despues.items);
  // Si faltan más de los que se fueron, la IA reescribió alguno: no se sabe cuáles se quitaron.
  if (faltan.length !== cantidad) return { cantidad, descripciones: [] };
  const pide = PIDE_QUITAR.test(mensaje);
  const palabrasMensaje = palabras(mensaje);
  const sinNombrar = faltan.filter(
    (item) => !pide || !nombraItem(item, antes.items, palabrasMensaje),
  );
  if (sinNombrar.length === 0) return null;
  return { cantidad, descripciones: sinNombrar.map((i) => i.descripcion) };
}

/**
 * Ítems que una corrección reemplazó por otros sin que el mensaje los nombrara (caso f del set de
 * evaluación: "el vinilo son 3 galones y quita la brocha" sobre un borrador con estuco, y la IA
 * devuelve vinilo en lugar del estuco). Aplica cuando la cantidad de ítems no baja (si baja, lo
 * cubre `itemsQuitadosSinPedir`): cada ítem de antes que ya no está con la misma descripción
 * tiene que estar nombrado en el mensaje ("cambia el estuco por vinilo"). Si la IA solo reescribe
 * una descripción sin que se lo pidan, también se pregunta (de más, nunca de menos).
 */
export function itemsReemplazadosSinPedir(
  antes: BorradorFactura,
  despues: BorradorFactura,
  mensaje: string,
): string[] {
  if (despues.items.length < antes.items.length) return [];
  const { faltan } = emparejar(antes.items, despues.items);
  const palabrasMensaje = palabras(mensaje);
  return faltan
    .filter((item) => !nombraItem(item, antes.items, palabrasMensaje))
    .map((item) => item.descripcion);
}

/** Un ítem que se conservó con otro valor, o uno nuevo o reescrito con un valor que no se dijo. */
export interface ValorCambiado {
  descripcion: string;
  antes: number | null;
  despues: number | null;
  /** true si el ítem no estaba antes (nuevo, o con la descripción reescrita por la IA). */
  nuevo: boolean;
}

/**
 * Valores en pesos que aparecen en el mensaje. "80" cuenta también como 80.000, porque así se
 * habla ("la azul a 80"). Lo que no se entiende no cuenta: se pregunta de más, nunca de menos.
 */
export function valoresDelMensaje(mensaje: string): Set<number> {
  const valores = new Set<number>();
  for (const [texto] of mensaje.matchAll(/\d[\d.,]*(?:\s*mil\b)?/gi)) {
    const valor = parsePesos(texto.replace(/[.,]+$/, ''));
    if (valor === null) continue;
    valores.add(valor);
    if (!/mil$/i.test(texto) && valor < 1000) valores.add(valor * 1000);
  }
  return valores;
}

/**
 * Valores que la corrección cambió sin que el mensaje los diga (hallazgo 5 de la auditoría del
 * PR #3). La IA devuelve el borrador completo y puede cambiar un valor que nadie mencionó.
 * - Un ítem conservado con otro valor: el valor nuevo tiene que aparecer en el mensaje y el
 *   mensaje tiene que nombrar ese ítem ("la negra a 45 mil" no le cambia el valor a la azul).
 *   Un valor que se pierde (pasa a null) siempre se pregunta.
 * - Un ítem nuevo o con la descripción reescrita: su valor tiene que aparecer en el mensaje,
 *   salvo que sea el mismo valor de un ítem que ya no está (solo se reescribió la descripción).
 */
export function valoresCambiadosSinPedir(
  antes: BorradorFactura,
  despues: BorradorFactura,
  mensaje: string,
): ValorCambiado[] {
  const enMensaje = valoresDelMensaje(mensaje);
  const palabrasMensaje = palabras(mensaje);
  const { pares, faltan, sobran } = emparejar(antes.items, despues.items);
  const cambiados = pares
    .filter(
      ([a, d]) =>
        a.valor !== d.valor &&
        (d.valor === null ||
          !enMensaje.has(d.valor) ||
          !nombraItem(a, antes.items, palabrasMensaje)),
    )
    .map(([a, d]) => ({
      descripcion: d.descripcion,
      antes: a.valor,
      despues: d.valor,
      nuevo: false,
    }));
  const valoresQueSeFueron = faltan.map((i) => i.valor);
  const nuevos: ValorCambiado[] = [];
  for (const d of sobran) {
    const i = valoresQueSeFueron.indexOf(d.valor);
    if (i !== -1) {
      valoresQueSeFueron.splice(i, 1);
      continue;
    }
    if (d.valor === null) {
      // Un ítem reescrito sin valor, cuando a uno que se fue le quedaba un valor: lo perdió.
      const perdido = valoresQueSeFueron.findIndex((v) => v !== null);
      if (perdido === -1) continue;
      const [antesValor] = valoresQueSeFueron.splice(perdido, 1);
      nuevos.push({
        descripcion: d.descripcion,
        antes: antesValor,
        despues: null,
        nuevo: true,
      });
      continue;
    }
    if (!enMensaje.has(d.valor))
      nuevos.push({
        descripcion: d.descripcion,
        antes: null,
        despues: d.valor,
        nuevo: true,
      });
  }
  return [...cambiados, ...nuevos];
}

/** El nombre, la identificación o el total que una corrección cambió sin que el mensaje los diga. */
export type DatoCambiado =
  | {
      campo: 'nombre' | 'identificacion';
      antes: string | null;
      despues: string | null;
    }
  | { campo: 'total'; antes: number | null; despues: number | null };

/** Solo letras y dígitos, en mayúsculas. */
function soloAlfanumerico(texto: string): string {
  return normalizar(texto)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toUpperCase();
}

/**
 * Número y DV de una identificación, para comparar: "900.123.456-8" y "900123456-8" son la misma;
 * "1234567-8" (NIT con DV) y "12345678" (otra cédula) no. Ejemplos ficticios.
 */
function claveIdentificacion(texto: string, extranjero: boolean): string {
  const { numero, dv } = analizarIdentificacion(texto, extranjero);
  return numero ? `${numero}-${dv ?? ''}` : '';
}

/**
 * Cada número escrito del mensaje: letras y dígitos unidos por puntos o guiones ("900.123.456-8",
 * "ab-123456"). Una coma o un espacio sin guion los separan: "1234567, 2 galones" son dos.
 */
function numerosEscritos(mensaje: string): string[] {
  return [
    ...mensaje.matchAll(
      /[\p{L}\p{N}]+(?:\s*-\s*[\p{L}\p{N}]+|\.[\p{L}\p{N}]+)*/gu,
    ),
  ].map(([texto]) => texto);
}

/** El mensaje nombra la identificación ("el NIT", "la cédula", "la identificación"). */
const NOMBRA_IDENTIFICACION =
  /\bn\.?\s?i\.?\s?t\b|c[eé]dula|\bc\.?\s?c\b|identificaci/i;

/** El mensaje pide quitar el total: el verbo junto a "total" ("quita el total"). */
const PIDE_QUITAR_TOTAL =
  /(?<![\p{L}\p{N}])(?:qu[ií]t|elim[ií]n|b[oó]rr)\p{L}*\s+(?:(?:el|lo|del)\s+)*total(?![\p{L}\p{N}])/iu;

/** El mensaje nombra el nombre del cliente ("quita el nombre"). */
const NOMBRA_NOMBRE = /\bnombre\b/i;

/** Tipos de sociedad: no hace falta repetirlos en el mensaje ("S.A.S." y "SAS"). */
const PALABRAS_DE_SOCIEDAD = new Set(['sas', 'ltda', 'limitada', 'cia', 'bic']);

/**
 * Valores que siguen a la palabra "total": el primer número después de cada "total" ("el total es
 * 150 mil"). Un número del mensaje que no es el total (una cantidad, el NIT) no cuenta.
 */
function totalesDelMensaje(mensaje: string): Set<number> {
  const totales = new Set<number>();
  for (const { index } of mensaje.matchAll(/\btotal\b/gi)) {
    const resto = mensaje.slice(index + 'total'.length);
    const primero = /\d[\d.,]*(?:\s*mil\b)?/i.exec(resto);
    if (primero) for (const v of valoresDelMensaje(primero[0])) totales.add(v);
  }
  return totales;
}

/** true si el mensaje dice el nombre nuevo: todas sus palabras (salvo el tipo de sociedad). */
function nombreDicho(nombre: string, mensaje: string): boolean {
  const suyas = palabras(nombre).filter((p) => !PALABRAS_DE_SOCIEDAD.has(p));
  if (suyas.length === 0) {
    const clave = soloAlfanumerico(nombre);
    return clave !== '' && soloAlfanumerico(mensaje).includes(clave);
  }
  const delMensaje = palabras(mensaje);
  return suyas.every((p) => delMensaje.some((m) => mismaPalabra(m, p)));
}

/**
 * El nombre, la identificación o el total que la corrección cambió sin que el mensaje los diga
 * (pendiente de la revisión de seguridad del PR #5). La IA devuelve el borrador completo y puede
 * cambiar o inventar un dato que nadie escribió; eso llegaría a la DIAN.
 * - Nombre nuevo: todas sus palabras tienen que estar en el mensaje. Si solo cambian mayúsculas o
 *   tildes, no es un cambio.
 * - Identificación nueva: tiene que ser uno de los números escritos del mensaje, con el mismo
 *   número y DV. Si solo cambia el formato, no es un cambio.
 * - Total nuevo: tiene que ser el número que sigue a "total" ("80" cuenta como 80 mil).
 * Perder un dato solo vale si el mensaje pide quitarlo y lo nombra ("quita el NIT").
 */
export function datosCambiadosSinPedir(
  antes: BorradorFactura,
  despues: BorradorFactura,
  mensaje: string,
): DatoCambiado[] {
  const cambiados: DatoCambiado[] = [];
  const pideQuitar = PIDE_QUITAR.test(mensaje);

  const nombreAntes = antes.cliente.nombre;
  const nombreDespues = despues.cliente.nombre;
  const mismoNombre =
    nombreAntes !== null &&
    nombreDespues !== null &&
    normalizar(nombreAntes) === normalizar(nombreDespues);
  if (nombreAntes !== nombreDespues && !mismoNombre) {
    const dicho =
      nombreDespues === null
        ? pideQuitar && NOMBRA_NOMBRE.test(mensaje)
        : nombreDicho(nombreDespues, mensaje);
    if (!dicho)
      cambiados.push({
        campo: 'nombre',
        antes: nombreAntes,
        despues: nombreDespues,
      });
  }

  const idAntes = antes.cliente.identificacion;
  const idDespues = despues.cliente.identificacion;
  const extranjero = idDespues !== null && esDocumentoExtranjero(idDespues);
  const clave =
    idDespues === null ? '' : claveIdentificacion(idDespues, extranjero);
  const mismaId =
    idAntes !== null &&
    clave !== '' &&
    claveIdentificacion(idAntes, esDocumentoExtranjero(idAntes)) === clave;
  if (idAntes !== idDespues && !mismaId) {
    const dicha =
      idDespues === null
        ? pideQuitar && NOMBRA_IDENTIFICACION.test(mensaje)
        : clave !== '' &&
          numerosEscritos(mensaje).some(
            (n) => claveIdentificacion(n, extranjero) === clave,
          );
    if (!dicha)
      cambiados.push({
        campo: 'identificacion',
        antes: idAntes,
        despues: idDespues,
      });
  }

  const totalAntes = antes.totalEscrito;
  const totalDespues = despues.totalEscrito;
  if (totalAntes !== totalDespues) {
    const dicho =
      totalDespues === null
        ? pideQuitar && PIDE_QUITAR_TOTAL.test(mensaje)
        : totalesDelMensaje(mensaje).has(totalDespues);
    if (!dicho)
      cambiados.push({
        campo: 'total',
        antes: totalAntes,
        despues: totalDespues,
      });
  }
  return cambiados;
}

/** Un dato que la IA leyó en el primer mensaje sin que estuviera escrito: se dejó vacío. */
export type DatoVaciado =
  | { campo: 'nombre' | 'identificacion'; valor: string }
  | { campo: 'total'; valor: number }
  | { campo: 'item'; descripcion: string; valor: number };

/** Un borrador sin ningún dato: lo que había "antes" del primer mensaje. */
const BORRADOR_VACIO: BorradorFactura = {
  cliente: { nombre: null, identificacion: null },
  items: [],
  totalEscrito: null,
};

/**
 * Al crear un borrador, deja vacío (null, ❓ en el resumen) todo dato que no esté escrito en el
 * mensaje: nombre, identificación, total y el valor de cada ítem (decisión de Gabriel del
 * 2026-11-07, revisión de seguridad del PR #9). Son las mismas reglas que en una corrección,
 * comparando contra un borrador vacío: nunca se guarda un dato que la IA inventó.
 */
export function sinDatosNoDichos(
  borrador: BorradorFactura,
  mensaje: string,
): { borrador: BorradorFactura; vaciados: DatoVaciado[] } {
  const vaciados: DatoVaciado[] = [];
  const cliente = { ...borrador.cliente };
  let { totalEscrito } = borrador;
  for (const dato of datosCambiadosSinPedir(
    BORRADOR_VACIO,
    borrador,
    mensaje,
  )) {
    if (dato.campo === 'total') {
      if (dato.despues !== null)
        vaciados.push({ campo: 'total', valor: dato.despues });
      totalEscrito = null;
    } else {
      if (dato.despues !== null)
        vaciados.push({ campo: dato.campo, valor: dato.despues });
      cliente[dato.campo] = null;
      // Un cliente vaciado no es consumidor final (decisión de Gabriel del 2026-11-12).
      cliente.vaciado = true;
    }
  }
  const enMensaje = valoresDelMensaje(mensaje);
  const items = borrador.items.map((item) => {
    if (item.valor === null || enMensaje.has(item.valor)) return item;
    vaciados.push({
      campo: 'item',
      descripcion: item.descripcion,
      valor: item.valor,
    });
    return { ...item, valor: null };
  });
  return { borrador: { cliente, items, totalEscrito }, vaciados };
}

/** Por qué no se puede aprobar todavía, o null si está lista para aprobar. */
export function motivoNoAprobable(borrador: BorradorFactura): string | null {
  const faltantes = camposFaltantes(borrador);
  if (faltantes.length > 0) {
    const datosCliente =
      clienteDeVenta(borrador) === 'a_medias' ? ` ${O_CONSUMIDOR_FINAL}` : '';
    return `Aún falta: ${faltantes.join(', ')}.${datosCliente}`;
  }
  // El DV no cuadra o el número no tiene una forma confirmada: no se corrige solo (4.4 §5.1).
  const problema = identificacionCliente(borrador)?.problema;
  if (problema) return problema;
  if (sumaNoCuadra(borrador))
    return 'Los productos no suman el total escrito. Corrígelo antes de aprobar.';
  if (sumaParcialSupera(borrador))
    return 'Los productos con valor ya suman más que el total escrito. Corrígelo antes de aprobar.';
  return null;
}

const formatoPesos = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

/** "$ 78.000" para mostrar al usuario; "❓" si no hay valor. */
export function pesos(valor: number | null): string {
  return valor === null ? '❓' : formatoPesos.format(valor);
}

/** Mensaje para el usuario con lo entendido, lo que falta y los totales con IVA. */
export function resumenBorrador(
  borrador: BorradorFactura,
  titulo = '🧾 Borrador de factura',
): string {
  const { nombre } = borrador.cliente;
  const id = identificacionCliente(borrador);
  // Normalizada (sin puntos ni prefijo) si se entendió; si no, tal como se escribió.
  const numero = id?.numero ? `${id.numero}${id.dv ? `-${id.dv}` : ''}` : null;
  const lineas = [
    titulo,
    // Nunca en silencio: rehacer una factura a nombre equivocado exige nota crédito (§6).
    clienteDeVenta(borrador) === 'consumidor_final'
      ? 'Cliente: consumidor final'
      : `Cliente: ${nombre ?? '❓'} · NIT/CC: ${numero ?? borrador.cliente.identificacion ?? '❓'}`,
    ...borrador.items.map(
      (item) => `• ${item.descripcion}: ${pesos(item.valor)}`,
    ),
  ];

  const base = totalBase(borrador);
  if (base) {
    const { subtotal, iva, total } = calcularTotales(base);
    lineas.push(
      `Subtotal: ${pesos(subtotal)}`,
      `IVA 19 %: ${pesos(iva)}`,
      `Total a pagar: ${pesos(total)}`,
    );
  }
  if (id?.problema) lineas.push(`⚠️ ${id.problema}`);
  // Un NIT de empresa al que le falta un dígito tiene forma de cédula; con un nombre de negocio
  // sin tipo de sociedad no se sabe si es empresa o persona natural: se advierte (pendiente de la
  // revisión de seguridad del PR #5).
  if (
    id &&
    !id.problema &&
    (id.forma === 'cedula_antigua' || id.forma === 'cedula_nuip') &&
    pareceNegocio(nombre)
  ) {
    lineas.push(
      '⚠️ El cliente parece un negocio. Si es una empresa (S.A.S., Ltda., fundación…), su NIT tiene 9 dígitos más el dígito de verificación; si es una persona natural, su NIT es la cédula. Revisa el número antes de aprobar.',
    );
  }
  if (borrador.cliente.identificacionPorVoz) {
    lineas.push(
      '⚠️ La identificación vino de una nota de voz: revisa que esté completa antes de aprobar.',
    );
  }
  if (sumaNoCuadra(borrador)) {
    lineas.push(
      '⚠️ Los productos no suman el total escrito. Revisa los valores o escribe "el total es …".',
    );
  }
  if (sumaParcialSupera(borrador)) {
    lineas.push(
      '⚠️ Los productos con valor ya suman más que el total escrito. Revisa los valores o escribe "el total es …".',
    );
  }

  const faltantes = camposFaltantes(borrador);
  if (faltantes.length > 0) {
    const datosCliente =
      clienteDeVenta(borrador) === 'a_medias' ? ` ${O_CONSUMIDOR_FINAL}` : '';
    lineas.push(`Falta: ${faltantes.join(', ')}.${datosCliente}`);
  }
  return lineas.join('\n');
}

/** Subtotal (sin IVA), IVA del 19 % y total a pagar, redondeados a pesos. */
export function calcularTotales(base: number): {
  subtotal: number;
  iva: number;
  total: number;
} {
  const iva = Math.round(base * TASA_IVA);
  return { subtotal: base, iva, total: base + iva };
}
