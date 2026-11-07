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
    // Todo NIT de 9 dígitos va con su DV (hallazgo 3): estos son los correctos.
    ['900000001-2', 'nit_persona_juridica'],
    ['800000002-7', 'nit_persona_juridica'],
    ['999999999-4', 'nit_persona_juridica'],
    ['600000000-7', 'nit_persona_extranjera'],
    ['799999999-9', 'nit_persona_extranjera'],
    ['12345678', 'cedula_antigua'],
    ['1000001', 'cedula_antigua'],
    ['1000000001', 'cedula_nuip'],
    // No se restringe el primer dígito de una cédula de 10 dígitos (cupo desde 2.000.000.000 no
    // confirmado, ver el plan): no se pregunta.
    ['2000000001', 'cedula_nuip'],
    ['5999999999', 'cedula_nuip'],
  ])('%s → %s, sin problema', (numero, forma) => {
    const resultado = analizarIdentificacion(numero);

    expect(resultado.forma).toBe(forma);
    expect(resultado.problema).toBeNull();
  });

  it.each([
    ['5', 'Tiene 1 dígito:'],
    ['123', 'Tiene 3 dígitos:'],
    ['1.23', 'Tiene 3 dígitos:'],
    ['NIT 456', 'Tiene 3 dígitos:'],
    ['456-7', 'Tiene 3 dígitos:'],
  ])(
    'menos de 4 dígitos ("%s", ficticio): no es aprobable y pregunta',
    (texto, inicio) => {
      const resultado = analizarIdentificacion(texto);

      expect(resultado.forma).toBe('desconocida');
      expect(resultado.problema).toBe(
        `${inicio} es muy corto para una cédula o un NIT. ¿Lo revisas?`,
      );
    },
  );

  it('4 dígitos (ficticio): primera longitud aceptada como cédula antigua', () => {
    const resultado = analizarIdentificacion('1234');

    expect(resultado.forma).toBe('cedula_antigua');
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

  it('NIT sin DV: no se inventa como escrito, y se pide sin decir cuál es (hallazgo 3)', () => {
    const resultado = analizarIdentificacion('900000001');

    expect(resultado.dv).toBeNull();
    expect(resultado.dvCalculado).toBe('2');
    expect(resultado.dvVerificado).toBeNull();
    expect(resultado.problema).toBe(
      'Falta el dígito de verificación del NIT 900000001. Escríbelo después de un guion (900000001-…).',
    );
  });

  it.each(['600000000', '799999999', '800000002', '999999999'])(
    'NIT %s (rango 600 a 999 millones) sin DV: lo pide',
    (numero) => {
      expect(analizarIdentificacion(numero).problema).toContain(
        'Falta el dígito de verificación',
      );
    },
  );

  it.each(['599999999', '12345678', '1000000001'])(
    '%s no es un NIT de 9 dígitos: no pide DV',
    (numero) => {
      expect(analizarIdentificacion(numero).problema ?? '').not.toContain(
        'Falta el dígito',
      );
    },
  );

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

describe('NIT con el DV pegado o separado (hallazgo 1)', () => {
  it.each([
    ['900000001 2', '900000001-2'],
    ['900.000.001.2', '900000001-2'],
    ['900,000,001,2', '900000001-2'],
    ['NIT 900 000 001 2', '900000001-2'],
    // Un DV equivocado tampoco pasa: también se pregunta (el código no lo corrige).
    ['900000001 5', '900000001-5'],
    // Cédula de 8 dígitos con el DV de su NIT separado por un punto.
    ['12.345.678.8', '12345678-8'],
  ])('"%s": pregunta si el último dígito es el DV', (texto, sugerido) => {
    const resultado = analizarIdentificacion(texto);

    expect(resultado.forma).toBe('desconocida');
    expect(resultado.problema).toMatch(
      /^¿El último \d es el dígito de verificación\?/,
    );
    expect(resultado.problema).toContain(sugerido);
  });

  it.each(['9000000012', '6000000007', '7999999999', '8000000027'])(
    '"%s" (10 dígitos que empiezan por 6 a 9): no aprobable, pregunta',
    (texto) => {
      const resultado = analizarIdentificacion(texto);

      expect(resultado.forma).toBe('desconocida');
      expect(resultado.problema).toContain(
        'Tiene 10 dígitos y empieza como un NIT',
      );
    },
  );

  it('"9000000012": propone el NIT con su DV separado, con los dígitos que escribió', () => {
    expect(analizarIdentificacion('9000000012').problema).toBe(
      'Tiene 10 dígitos y empieza como un NIT. Si es el NIT 900000001 con dígito de verificación 2, escríbelo con guion: 900000001-2. Si es una cédula, revisa el número.',
    );
  });

  it.each(['0900000001', '0900000001-5'])(
    '"%s" (10 dígitos que empiezan por 0): no es un NUIP, pregunta',
    (texto) => {
      const resultado = analizarIdentificacion(texto);

      expect(resultado.forma).toBe('desconocida');
      expect(resultado.problema).toBe(
        'Tiene 10 dígitos y empieza por 0: no coincide con una cédula ni con un NIT. ¿Lo revisas?',
      );
    },
  );

  it.each(['NIT 90000001', 'nit: 12345678', 'N.I.T. 1000000001'])(
    '"%s": quien escribe "NIT" sin DV, con cualquier longitud, debe darlo (hallazgo 3)',
    (texto) => {
      expect(analizarIdentificacion(texto).problema).toContain(
        'Falta el dígito de verificación del NIT',
      );
    },
  );

  it('"NIT 12345678-8": NIT de persona natural con su DV correcto, sin problema', () => {
    expect(analizarIdentificacion('NIT 12345678-8').problema).toBeNull();
  });

  it('10 dígitos que empiezan por 6 a 9 con DV: tampoco pasa', () => {
    expect(analizarIdentificacion('9000000012-3').problema).toBe(
      'Tiene 10 dígitos y empieza como un NIT; un NIT tiene 9 más el dígito de verificación. ¿Lo revisas?',
    );
  });

  it.each(['1.000.000.001', '12.345.678', '1 000 000 001', '900.000.001-2'])(
    '"%s": grupos de miles normales, no pregunta por un DV suelto',
    (texto) => {
      expect(analizarIdentificacion(texto).problema).toBeNull();
    },
  );
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

  it.each([
    ['pasaporte AB123456', 'AB123456'],
    ['Pasaporte No. AB123456', 'AB123456'],
    ['CE: 123456', '123456'],
    ['C.E. 654321', '654321'],
    ['cédula de extranjería # 123456', '123456'],
    ['PEP 123456789012345', '123456789012345'],
  ])(
    '"%s": quita el nombre del documento y deja el número %s',
    (texto, numero) => {
      const resultado = analizarIdentificacion(texto, true);

      expect(resultado.numero).toBe(numero);
      expect(resultado.problema).toBeNull();
    },
  );

  it.each([
    'pasaporte',
    'PEP',
    'PPT',
    'cédula de extranjería',
    'pasaporte No.',
  ])('"%s" sin número: lo pide (hallazgo 2)', (texto) => {
    expect(analizarIdentificacion(texto, true).problema).toBe(
      'No encontré el número del documento.',
    );
  });

  it.each([
    'CE 900000001',
    'PPT 9000000012',
    'pasaporte 900.000.001 2',
    'CE 600000000',
    'CE 12.345.678.8',
  ])('"%s": número con forma de NIT sin guion, pregunta cuál es', (texto) => {
    expect(analizarIdentificacion(texto, true).problema).toContain(
      'el número tiene forma de NIT. ¿Cuál es?',
    );
  });

  it.each([
    'pasaporte AB',
    'PEP 1234',
    'pasaporte ABCDEF',
    'pasaporte AB#123456',
  ])(
    '"%s": número que no se entiende (menos de 5, sin dígitos o con símbolos), pregunta',
    (texto) => {
      expect(analizarIdentificacion(texto, true).problema).toContain(
        'No entiendo el número del documento extranjero',
      );
    },
  );

  it.each([
    'CE: 900000001-9',
    'CE 900.000.001-2',
    'pasaporte 12345678-8',
    'pasaporte NIT 900000001',
  ])(
    '"%s": forma de NIT con DV, pregunta cuál es en vez de saltarse el DV (hallazgo 2)',
    (texto) => {
      expect(esDocumentoExtranjero(texto)).toBe(true);
      expect(analizarIdentificacion(texto, true).problema).toContain(
        'tiene forma de NIT con dígito de verificación',
      );
    },
  );
});
