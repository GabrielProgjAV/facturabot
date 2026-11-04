/**
 * NIT y cédula: normalización, dígito de verificación (DV) y forma del número.
 * Funciones puras. La IA solo extrae el texto; aquí el código decide si cuadra (CLAUDE.md).
 *
 * Solo hay reglas confirmadas en fuentes oficiales (docs/planes/fase-4.4-voz-borradores.md §5.1):
 * - Registraduría, "Ahora la cédula es de 10 dígitos" (2004): el NUIP tiene 10 dígitos; las
 *   cédulas anteriores tienen hasta 8.
 * - DIAN, Orden Administrativa 4 de 1989: NIT de personas jurídicas de 800.000.000 a 999.999.999;
 *   de personas naturales extranjeras y sucesiones de 600.000.000 a 799.999.999; el NIT de un
 *   mayor de edad es su cédula; y el cálculo del DV (Anexo 3).
 */

/**
 * Primos del Anexo 3 de la Orden Administrativa 4 de 1989, desde el dígito de la derecha. El
 * documento solo los muestra para 9 posiciones: un número más largo no tiene DV verificable.
 */
const PRIMOS_DV = [3, 7, 13, 17, 19, 23, 29, 37, 41] as const;

export type FormaIdentificacion =
  /** 1 a 8 dígitos: cédula antigua, o NIT de persona natural (su cédula). */
  | 'cedula_antigua'
  /** 10 dígitos que empiezan por 1 a 5: cédula con NUIP, o NIT de persona natural. */
  | 'cedula_nuip'
  /** 9 dígitos de 800.000.000 a 999.999.999. */
  | 'nit_persona_juridica'
  /** 9 dígitos de 600.000.000 a 799.999.999. */
  | 'nit_persona_extranjera'
  /** Cédula de extranjería, pasaporte, PEP o PPT: sin reglas de forma ni de DV. */
  | 'documento_extranjero'
  /** No coincide con ninguna forma confirmada. */
  | 'desconocida';

export interface Identificacion {
  /** Solo dígitos (o, en un documento extranjero, el número sin su nombre, espacios, puntos ni guiones). */
  numero: string;
  /** Dígito de verificación tal como lo escribió el usuario, o null. */
  dv: string | null;
  /** DV calculado para mostrarlo, si el número lo admite; nunca reemplaza al escrito. */
  dvCalculado: string | null;
  /** true o false si se pudo comprobar el DV escrito; null si no hay DV o no es verificable. */
  dvVerificado: boolean | null;
  forma: FormaIdentificacion;
  /** Qué debe revisar el usuario, o null si todo cuadra. */
  problema: string | null;
}

/** DV de un número de 1 a 9 dígitos (Anexo 3 de la Orden Administrativa 4 de 1989). */
export function digitoVerificacion(numero: string): number {
  if (!/^\d{1,9}$/.test(numero)) {
    throw new Error('El DV solo se calcula para números de 1 a 9 dígitos');
  }
  const suma = numero
    .split('')
    .reverse()
    .reduce((total, digito, i) => total + Number(digito) * PRIMOS_DV[i], 0);
  const residuo = suma % 11;
  // "Si este número es igual a uno o cero, el DV es el mismo valor; de lo contrario, once menos".
  return residuo <= 1 ? residuo : 11 - residuo;
}

const DOCUMENTO_EXTRANJERO =
  /c[eé]dula\s+de\s+extranjer[ií]a|pasaporte|\bpermiso\s+por\s+protecci[oó]n\s+temporal\b|\bP\.?P\.?T\b|\bP\.?E\.?P\b|\bC\.?\s?E\b\.?(?=\s*(?:n[o°º]?\.?|#|:)?\s*\d)/i;

/** El nombre del documento extranjero, para quitarlo y quedarse con el número. */
const NOMBRE_DOCUMENTO_EXTRANJERO =
  /c[eé]dula\s+de\s+extranjer[ií]a|pasaporte|\bpermiso\s+por\s+protecci[oó]n\s+temporal\b|\bP\.?P\.?T\b\.?|\bP\.?E\.?P\b\.?|\bC\.?\s?E\b\.?/gi;

/** "No.", "#" o ":" entre el nombre del documento y el número. */
const SEPARADOR_NUMERO = /^\s*[:#]?\s*(?:n[o°º](?:\.|\s)|#)?\s*[:#]?\s*/i;

/** Un número de documento extranjero: de 5 a 20 letras o dígitos, con al menos un dígito. */
const NUMERO_EXTRANJERO = /^(?=.*\d)[A-Z0-9]{5,20}$/;

/** true si el mensaje dice que el cliente se identifica con un documento extranjero. */
export function esDocumentoExtranjero(texto: string): boolean {
  return DOCUMENTO_EXTRANJERO.test(texto);
}

/** "NIT", "C.C.", "cédula" y similares al comienzo, con su separador. */
const PREFIJO =
  /^\s*(?:n\.?\s?i\.?\s?t\.?|c\.?\s?c\.?|c[eé]dula(?:\s+de\s+ciudadan[ií]a)?)(?=[\s.:#\d]|$)\s*(?:n[o°º]\.?)?\s*[:#.]?\s*/i;

/**
 * Normaliza y valida una identificación escrita o dictada. Ejemplos ficticios:
 * "900.000.001-2" → número 900000001, DV 2; "1.000.000.001" → cédula de 10 dígitos.
 * @param extranjero el mensaje indica cédula de extranjería, pasaporte, PEP o PPT.
 */
export function analizarIdentificacion(
  texto: string,
  extranjero = false,
): Identificacion {
  const limpio = texto.trim();
  if (extranjero) return analizarDocumentoExtranjero(limpio);

  const sinPrefijo = limpio.replace(PREFIJO, '');
  // Quien escribe "NIT" dice que el número lleva DV, también el de una persona natural.
  const diceNit = /^\s*n\.?\s?i\.?\s?t(?![a-z])/i.test(limpio);
  // Número con puntos, comas o espacios de miles, y opcionalmente "-DV" (un solo dígito).
  const partes = /^([\d.,\s]+?)(?:\s*-\s*(\d))?$/.exec(sinPrefijo);
  if (!partes) {
    return desconocida(
      sinPrefijo.replace(/\D/g, ''),
      sinPrefijo
        ? 'No entiendo el formato del NIT o la cédula. Escríbelo solo con números (y el dígito de verificación después de un guion, si es un NIT).'
        : 'No encontré el número de identificación.',
    );
  }
  const numero = partes[1].replace(/\D/g, '');
  const dv = partes[2] ?? null;
  if (!numero)
    return desconocida('', 'No encontré el número de identificación.');

  // "900.000.001.2" o "900000001 2": el último dígito suelto puede ser el DV (hallazgo 1 de la
  // auditoría del PR #3). No se adivina: se pregunta.
  const grupos = partes[1].trim().split(/[.,\s]+/);
  const ultimo = grupos[grupos.length - 1];
  if (dv === null && grupos.length > 1 && ultimo.length === 1) {
    const sinUltimo = numero.slice(0, -1);
    return desconocida(
      numero,
      `¿El último ${ultimo} es el dígito de verificación? Si es un NIT, escríbelo con guion: ${sinUltimo}-${ultimo}. Si no, escribe el número sin separar ese dígito.`,
    );
  }

  const forma = formaSegunNumero(numero);
  if (forma === 'desconocida') {
    return desconocida(numero, problemaDeForma(numero, dv), dv);
  }

  const verificable = numero.length <= PRIMOS_DV.length;
  const dvCalculado = verificable ? String(digitoVerificacion(numero)) : null;
  const dvVerificado =
    dv === null || dvCalculado === null ? null : dv === dvCalculado;
  return {
    numero,
    dv,
    dvCalculado,
    dvVerificado,
    forma,
    problema: problemaDeDv(numero, dv, forma, dvVerificado, diceNit),
  };
}

/** true si la forma es un NIT de 9 dígitos (persona jurídica o extranjera): siempre lleva DV. */
export function esNitDeNueveDigitos(forma: FormaIdentificacion): boolean {
  return forma === 'nit_persona_juridica' || forma === 'nit_persona_extranjera';
}

function problemaDeDv(
  numero: string,
  dv: string | null,
  forma: FormaIdentificacion,
  dvVerificado: boolean | null,
  diceNit: boolean,
): string | null {
  // No se dice cuál "debería" ser: si el número está mal escrito, ese DV también estaría mal.
  if (dvVerificado === false) {
    return `El dígito de verificación ${dv} no coincide con el número ${numero}. ¿Lo revisas?`;
  }
  // Todo NIT de 9 dígitos tiene DV, y también el que se escribe como "NIT": sin él no se puede
  // comprobar que el número esté completo (hallazgo 3 de la auditoría del PR #3).
  if (dv === null && (esNitDeNueveDigitos(forma) || diceNit)) {
    return `Falta el dígito de verificación del NIT ${numero}. Escríbelo después de un guion (${numero}-…).`;
  }
  return null;
}

/**
 * Cédula de extranjería, pasaporte, PEP o PPT: sin reglas de forma ni de DV, pero con un número
 * que se pueda leer (hallazgo 2 de la auditoría del PR #3). Si trae algo con forma de NIT, se
 * pregunta cuál es: la palabra no puede saltarse la comprobación del DV.
 */
function analizarDocumentoExtranjero(texto: string): Identificacion {
  const resto = texto
    .replace(NOMBRE_DOCUMENTO_EXTRANJERO, ' ')
    .replace(SEPARADOR_NUMERO, '')
    .trim();
  const numero = resto.replace(/[\s.-]/g, '').toUpperCase();
  let problema: string | null = null;
  if (/\bn\.?\s?i\.?\s?t\b/i.test(texto) || /\d\s*-\s*\d\s*$/.test(resto)) {
    problema =
      'Dice que es un documento extranjero, pero el número tiene forma de NIT con dígito de verificación. ¿Cuál es? Si es un NIT, escríbelo así: NIT 900000001-2 (ejemplo ficticio).';
  } else if (tieneFormaDeNit(resto, numero)) {
    problema =
      'Dice que es un documento extranjero, pero el número tiene forma de NIT. ¿Cuál es? Si es un NIT, escríbelo con su dígito de verificación: NIT 900000001-2 (ejemplo ficticio).';
  } else if (!numero) {
    problema = 'No encontré el número del documento.';
  } else if (!NUMERO_EXTRANJERO.test(numero)) {
    problema =
      'No entiendo el número del documento extranjero. Escríbelo completo, con sus letras y dígitos (de 5 a 20).';
  }
  return {
    numero,
    dv: null,
    dvCalculado: null,
    dvVerificado: null,
    forma: 'documento_extranjero',
    problema,
  };
}

/**
 * Un número de documento extranjero con forma de NIT: 9 dígitos desde 600.000.000, 10 que
 * empiezan por 6 a 9 (DV pegado) o un último dígito suelto (DV separado). Se pregunta: la palabra
 * "CE" o "pasaporte" no puede saltarse la comprobación del DV.
 */
function tieneFormaDeNit(resto: string, numero: string): boolean {
  if (!/^\d+$/.test(numero)) return false;
  const grupos = resto.split(/[.,\s]+/);
  return (
    (numero.length === 9 && Number(numero) >= 600_000_000) ||
    (numero.length === 10 && /^[6-9]/.test(numero)) ||
    (grupos.length > 1 && grupos[grupos.length - 1].length === 1)
  );
}

function formaSegunNumero(numero: string): FormaIdentificacion {
  if (numero.length <= 8) return 'cedula_antigua';
  // Una cédula de 10 dígitos que empieza por 6 a 9 tiene la forma de un NIT con el DV pegado
  // ("9000000012", ficticio): no hay NUIP confirmados en ese rango (hallazgo 1, decisión de Gabriel).
  // Uno que empieza por 0 ("0900000001") tampoco es un NUIP.
  if (numero.length === 10) {
    return /^[1-5]/.test(numero) ? 'cedula_nuip' : 'desconocida';
  }
  if (numero.length === 9) {
    const valor = Number(numero);
    if (valor >= 800_000_000) return 'nit_persona_juridica';
    if (valor >= 600_000_000) return 'nit_persona_extranjera';
  }
  return 'desconocida';
}

function problemaDeForma(numero: string, dv: string | null): string {
  if (numero.length === 10 && numero.startsWith('0')) {
    return 'Tiene 10 dígitos y empieza por 0: no coincide con una cédula ni con un NIT. ¿Lo revisas?';
  }
  if (numero.length === 10) {
    const nit = numero.slice(0, 9);
    return dv === null
      ? `Tiene 10 dígitos y empieza como un NIT. Si es el NIT ${nit} con dígito de verificación ${numero[9]}, escríbelo con guion: ${nit}-${numero[9]}. Si es una cédula, revisa el número.`
      : 'Tiene 10 dígitos y empieza como un NIT; un NIT tiene 9 más el dígito de verificación. ¿Lo revisas?';
  }
  if (numero.length > 10) {
    return `Tiene ${numero.length} dígitos; una cédula tiene hasta 10 y un NIT, 9 más el dígito de verificación. ¿Lo revisas?`;
  }
  return 'Tiene 9 dígitos, pero no coincide con una cédula (hasta 8 o 10 dígitos) ni con un NIT (empieza por 6, 7, 8 o 9). ¿Lo revisas?';
}

function desconocida(
  numero: string,
  problema: string,
  dv: string | null = null,
): Identificacion {
  return {
    numero,
    dv,
    dvCalculado: null,
    dvVerificado: null,
    forma: 'desconocida',
    problema,
  };
}
