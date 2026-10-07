/** Línea de la factura tal como la entendimos (valor = total de la línea, sin IVA). */
export interface ItemBorrador {
  descripcion: string;
  valor: number | null;
}

/** Factura en construcción: lo que se sabe hasta ahora. null = todavía no se sabe. */
export interface BorradorFactura {
  cliente: { nombre: string | null; identificacion: string | null };
  items: ItemBorrador[];
  /** Total escrito por el usuario, sin IVA. */
  totalEscrito: number | null;
}

export const TASA_IVA = 0.19;

/**
 * Convierte un valor en pesos escrito por una persona a número.
 * En Colombia el punto separa miles y la coma decimales: "78.000" = 78000.
 * Acepta "$78.000", "78 mil", "1.250.000", 45000. Devuelve null si no es un valor válido.
 */
export function parsePesos(valor: string | number | null): number | null {
  if (valor === null) return null;
  if (typeof valor === 'number') return valor >= 0 ? valor : null;

  let texto = valor.toLowerCase().replace(/\$|\s/g, '');
  const multiplicador = texto.endsWith('mil') ? 1000 : 1;
  texto = texto.replace(/mil$/, '').replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(texto)) return null;

  return Math.round(Number(texto) * multiplicador);
}

/** Base gravable: el total escrito, o la suma de los ítems si todos tienen valor. */
export function totalBase(borrador: BorradorFactura): number | null {
  if (borrador.totalEscrito !== null) return borrador.totalEscrito;
  const valores = borrador.items.map((item) => item.valor);
  if (valores.length === 0 || valores.includes(null)) return null;
  return (valores as number[]).reduce((suma, v) => suma + v, 0);
}

/** Datos que faltan para poder emitir la factura, en palabras para el usuario. */
export function camposFaltantes(borrador: BorradorFactura): string[] {
  const faltantes: string[] = [];
  if (!borrador.cliente.nombre) faltantes.push('nombre del cliente');
  if (!borrador.cliente.identificacion)
    faltantes.push('NIT o cédula del cliente');
  if (!totalBase(borrador)) faltantes.push('total de la factura');
  return faltantes;
}

/** true si hay total escrito y todos los ítems tienen valor, pero no suman lo mismo. */
export function sumaNoCuadra(borrador: BorradorFactura): boolean {
  const valores = borrador.items.map((item) => item.valor);
  if (borrador.totalEscrito === null || valores.length === 0) return false;
  if (valores.includes(null)) return false;
  const suma = (valores as number[]).reduce((total, v) => total + v, 0);
  return suma !== borrador.totalEscrito;
}

/** Por qué no se puede aprobar todavía, o null si está lista para aprobar. */
export function motivoNoAprobable(borrador: BorradorFactura): string | null {
  const faltantes = camposFaltantes(borrador);
  if (faltantes.length > 0) return `Aún falta: ${faltantes.join(', ')}.`;
  if (sumaNoCuadra(borrador))
    return 'Los productos no suman el total escrito. Corrígelo antes de aprobar.';
  return null;
}

const pesos = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

/** Mensaje para el usuario con lo entendido, lo que falta y los totales con IVA. */
export function resumenBorrador(borrador: BorradorFactura): string {
  const { nombre, identificacion } = borrador.cliente;
  const lineas = [
    '🧾 Borrador de factura',
    `Cliente: ${nombre ?? '❓'} · NIT/CC: ${identificacion ?? '❓'}`,
    ...borrador.items.map(
      (item) =>
        `• ${item.descripcion}: ${item.valor === null ? '❓' : pesos.format(item.valor)}`,
    ),
  ];

  const base = totalBase(borrador);
  if (base) {
    const { subtotal, iva, total } = calcularTotales(base);
    lineas.push(
      `Subtotal: ${pesos.format(subtotal)}`,
      `IVA 19 %: ${pesos.format(iva)}`,
      `Total a pagar: ${pesos.format(total)}`,
    );
  }
  if (sumaNoCuadra(borrador)) {
    lineas.push(
      '⚠️ Los productos no suman el total escrito. Revisa los valores o escribe "el total es …".',
    );
  }

  const faltantes = camposFaltantes(borrador);
  if (faltantes.length > 0) {
    lineas.push(`Falta: ${faltantes.join(', ')}.`);
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
