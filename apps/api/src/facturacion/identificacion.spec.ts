// Todos los NIT, cédulas y documentos de este archivo son ficticios.
import {
  analizarIdentificacion,
  digitoVerificacion,
  esDocumentoExtranjero,
} from './identificacion.js';

describe('digitoVerificacion (Orden Administrativa 4 de 1989 de la DIAN, Anexo 3)', () => {
  it.each([
    // Cálculo a mano: 1×3 + 9×41 = 372; 372 mod 11 = 9; DV = 11 − 9 = 2.
    ['900000001', 2],
    // 2×3 + 8×41 = 334; 334 mod 11 = 4; DV = 11 − 4 = 7.
    ['800000002', 7],
    // 3×3 + 6×37 + 8×41 = 559; 559 mod 11 = 9; DV = 2.
    ['860000003', 2],
    // 5×3 = 15; 15 mod 11 = 4; DV = 7 (un solo dígito).
    ['5', 7],
    ['12345678', 8],
  ])('%s → %i', (numero, dv) => {
    expect(digitoVerificacion(numero)).toBe(dv);
  });

  it.each([
    // Residuo 0 → DV 0; residuo 1 → DV 1 ("el DV es el mismo valor").
    ['900000009', 0],
    ['900000002', 1],
  ])('residuo 0 o 1: %s → %i', (numero, dv) => {
    expect(digitoVerificacion(numero)).toBe(dv);
  });

  it.each(['', '1000000001', '90000000a'])(
    'rechaza "%s" (solo de 1 a 9 dígitos)',
    (numero) => {
      expect(() => digitoVerificacion(numero)).toThrow();
    },
  );
});

describe('analizarIdentificacion: normalización', () => {
  it.each([
    ['900.000.001-2', '900000001', '2'],
    ['900000001-2', '900000001', '2'],
    ['900000001 - 2', '900000001', '2'],
    ['NIT 900.000.001-2', '900000001', '2'],
    ['N.I.T. 900000001-2', '900000001', '2'],
    ['nit: 900 000 001-2', '900000001', '2'],
    ['CC 1.000.000.001', '1000000001', null],
    ['C.C. 12.345.678', '12345678', null],
    ['cédula 12345678', '12345678', null],
    ['  12,345,678  ', '12345678', null],
  ])('"%s" → número %s, DV %s', (texto, numero, dv) => {
    const resultado = analizarIdentificacion(texto);

    expect(resultado.numero).toBe(numero);
    expect(resultado.dv).toBe(dv);
    expect(resultado.problema).toBeNull();
  });
});

describe('analizarIdentificacion: forma (solo reglas de fuentes oficiales)', () => {
  it.each([
    ['900000001', 'nit_persona_juridica'],
    ['800000002', 'nit_persona_juridica'],
    ['999999999', 'nit_persona_juridica'],
    ['600000000', 'nit_persona_extranjera'],
    ['799999999', 'nit_persona_extranjera'],
    ['12345678', 'cedula_antigua'],
    ['1000001', 'cedula_antigua'],
    ['1000000001', 'cedula_nuip'],
    // No se restringe el primer dígito de una cédula de 10 dígitos (cupo desde 2.000.000.000 no
    // confirmado, ver el plan): no se pregunta.
    ['2000000001', 'cedula_nuip'],
  ])('%s → %s, sin problema', (numero, forma) => {
    const resultado = analizarIdentificacion(numero);

    expect(resultado.forma).toBe(forma);
    expect(resultado.problema).toBeNull();
  });

  it('11 dígitos: avisa con la cuenta de dígitos y pregunta', () => {
    const resultado = analizarIdentificacion('10000000012');

    expect(resultado.forma).toBe('desconocida');
    expect(resultado.problema).toBe(
      'Tiene 11 dígitos; una cédula tiene hasta 10 y un NIT, 9 más el dígito de verificación. ¿Lo revisas?',
    );
  });

  it('9 dígitos por debajo de 600.000.000: no coincide con ninguna forma confirmada', () => {
    const resultado = analizarIdentificacion('123456789');

    expect(resultado.forma).toBe('desconocida');
    expect(resultado.problema).toContain('9 dígitos');
    expect(resultado.problema).toContain('¿Lo revisas?');
  });

  it.each(['', '   ', 'NIT'])('sin número ("%s"): lo pide', (texto) => {
    expect(analizarIdentificacion(texto).problema).toBe(
      'No encontré el número de identificación.',
    );
  });

  it.each(['90000000A', '900000001-23', 'abc'])(
    'formato que no se entiende ("%s"): pide escribirlo solo con números',
    (texto) => {
      const resultado = analizarIdentificacion(texto);

      expect(resultado.forma).toBe('desconocida');
      expect(resultado.problema).toContain('solo con números');
    },
  );
});

describe('analizarIdentificacion: dígito de verificación', () => {
  it('DV correcto: verificado, sin problema', () => {
    expect(analizarIdentificacion('900.000.001-2')).toEqual({
      numero: '900000001',
      dv: '2',
      dvCalculado: '2',
      dvVerificado: true,
      forma: 'nit_persona_juridica',
      problema: null,
    });
  });

  it('DV incorrecto: pregunta, sin decir cuál "debería" ser', () => {
    const resultado = analizarIdentificacion('900000001-5');

    expect(resultado.dvVerificado).toBe(false);
    expect(resultado.problema).toBe(
      'El dígito de verificación 5 no coincide con el número 900000001. ¿Lo revisas?',
    );
    expect(resultado.problema).not.toContain('2');
  });

  it('NIT de persona natural (cédula de 8 dígitos) con DV: se valida', () => {
    expect(analizarIdentificacion('12345678-8').dvVerificado).toBe(true);
    expect(analizarIdentificacion('12345678-3').dvVerificado).toBe(false);
  });

  it('sin DV: se calcula para mostrarlo, pero no se inventa como escrito', () => {
    const resultado = analizarIdentificacion('900000001');

    expect(resultado.dv).toBeNull();
    expect(resultado.dvCalculado).toBe('2');
    expect(resultado.dvVerificado).toBeNull();
    expect(resultado.problema).toBeNull();
  });

  it('10 dígitos con DV: no verificable (peso de la décima posición no confirmado), sin problema', () => {
    const resultado = analizarIdentificacion('1000000001-4');

    expect(resultado.dv).toBe('4');
    expect(resultado.dvCalculado).toBeNull();
    expect(resultado.dvVerificado).toBeNull();
    expect(resultado.problema).toBeNull();
  });

  it('forma desconocida con DV: conserva el DV escrito y avisa por la forma', () => {
    const resultado = analizarIdentificacion('123456789-1');

    expect(resultado.dv).toBe('1');
    expect(resultado.forma).toBe('desconocida');
    expect(resultado.problema).toContain('9 dígitos');
  });
});

describe('documentos extranjeros', () => {
  it.each([
    'cédula de extranjería 123456',
    'Cedula de extranjeria 123456',
    'CE 123456',
    'C.E. 654321',
    'ce: 123456',
    'pasaporte AB123456',
    'PPT 1234567',
    'PEP 123456789012345',
    'permiso por protección temporal 1234567',
  ])('"%s" se reconoce como documento extranjero', (texto) => {
    expect(esDocumentoExtranjero(texto)).toBe(true);
  });

  it.each([
    'factura a Ana, cédula 12345678',
    'NIT 900000001-2',
    'cemento gris 25 mil',
    'Pinturas Pepito SAS',
  ])('"%s" no es un documento extranjero', (texto) => {
    expect(esDocumentoExtranjero(texto)).toBe(false);
  });

  it('con documento extranjero no se aplican reglas de forma ni de DV, y admite letras', () => {
    expect(analizarIdentificacion('ab 123.456', true)).toEqual({
      numero: 'AB123456',
      dv: null,
      dvCalculado: null,
      dvVerificado: null,
      forma: 'documento_extranjero',
      problema: null,
    });
    // 11 dígitos serían un problema para una cédula colombiana, no para un pasaporte.
    expect(analizarIdentificacion('12345678901', true).problema).toBeNull();
  });
});
