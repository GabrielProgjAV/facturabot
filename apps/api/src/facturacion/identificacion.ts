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
  /** 10 dígitos: cédula con NUIP, o NIT de persona natural. */
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
  /** Solo dígitos (o, en un documento extranjero, el texto sin espacios ni puntos). */
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
  const suma = [...numero]
    .reverse()
    .reduce((total, digito, i) => total + Number(digito) * PRIMOS_DV[i], 0);
  const residuo = suma % 11;
  // "Si este número es igual a uno o cero, el DV es el mismo valor; de lo contrario, once menos".
  return residuo <= 1 ? residuo : 11 - residuo;
}

const DOCUMENTO_EXTRANJERO =
  /c[eé]dula\s+de\s+extranjer[ií]a|pasaporte|\bpermiso\s+por\s+protecci[oó]n\s+temporal\b|\bP\.?P\.?T\b|\bP\.?E\.?P\b|\bC\.?\s?E\b\.?(?=\s*(?:n[o°º]?\.?|#|:)?\s*\d)/i;

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
  if (extranjero) {
    return {
      numero: limpio.replace(/[\s.]/g, '').toUpperCase(),
      dv: null,
      dvCalculado: null,
      dvVerificado: null,
      forma: 'documento_extranjero',
      problema: limpio ? null : 'No encontré el número del documento.',
    };
  }

  const sinPrefijo = limpio.replace(PREFIJO, '');
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

  const forma = formaSegunNumero(numero);
  if (forma === 'desconocida') {
    return desconocida(numero, problemaDeForma(numero), dv);
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
    // No se dice cuál "debería" ser: si el número está mal escrito, ese DV también estaría mal.
    problema:
      dvVerificado === false
        ? `El dígito de verificación ${dv} no coincide con el número ${numero}. ¿Lo revisas?`
        : null,
  };
}

function formaSegunNumero(numero: string): FormaIdentificacion {
  if (numero.length <= 8) return 'cedula_antigua';
  if (numero.length === 10) return 'cedula_nuip';
  if (numero.length === 9) {
    const valor = Number(numero);
    if (valor >= 800_000_000) return 'nit_persona_juridica';
    if (valor >= 600_000_000) return 'nit_persona_extranjera';
  }
  return 'desconocida';
}

function problemaDeForma(numero: string): string {
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
