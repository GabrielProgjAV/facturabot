import {
  type BorradorFactura,
  calcularTotales,
  conOrigenDeIdentificacion,
  itemsQuitadosSinPedir,
  camposFaltantes,
  motivoNoAprobable,
  parsePesos,
  resumenBorrador,
  sumaNoCuadra,
  totalBase,
} from './factura.js';

const completo: BorradorFactura = {
  cliente: { nombre: 'Acrílicos Ejemplo SAS', identificacion: '900123456' }, // NIT ficticio
  items: [
    { descripcion: '1 galón laca negra', valor: 78000 },
    { descripcion: '1/2 laca azul', valor: 45000 },
    { descripcion: '1/8 laca amarilla', valor: 18000 },
  ],
  totalEscrito: 141000,
};

describe('parsePesos', () => {
  it.each([
    ['78.000', 78000],
    ['$78.000', 78000],
    ['$ 1.250.000', 1250000],
    ['78 mil', 78000],
    ['78mil', 78000],
    ['45000', 45000],
    ['12,5 mil', 12500],
  ])('"%s" → %d', (entrada, esperado) => {
    expect(parsePesos(entrada)).toBe(esperado);
  });

  it('acepta números ya convertidos', () => {
    expect(parsePesos(45000)).toBe(45000);
  });

  it.each(['abc', '', '-5000', null])(
    '"%s" no es un valor válido',
    (entrada) => {
      expect(parsePesos(entrada)).toBeNull();
    },
  );
});

describe('camposFaltantes', () => {
  it('no falta nada en una factura completa', () => {
    expect(camposFaltantes(completo)).toEqual([]);
  });

  it('lista lo que falta', () => {
    const vacio: BorradorFactura = {
      cliente: { nombre: null, identificacion: null },
      items: [],
      totalEscrito: null,
    };

    expect(camposFaltantes(vacio)).toEqual([
      'nombre del cliente',
      'NIT o cédula del cliente',
      'total de la factura',
    ]);
  });

  it('el total puede salir de la suma de los ítems', () => {
    expect(camposFaltantes({ ...completo, totalEscrito: null })).toEqual([]);
  });
});

describe('totalBase', () => {
  it('prefiere el total escrito', () => {
    expect(totalBase(completo)).toBe(141000);
  });

  it('suma los ítems si no hay total escrito', () => {
    expect(totalBase({ ...completo, totalEscrito: null })).toBe(141000);
  });

  it('no inventa un total si a un ítem le falta el valor', () => {
    const items = [{ descripcion: 'laca', valor: null }];
    expect(totalBase({ ...completo, items, totalEscrito: null })).toBeNull();
  });
});

describe('sumaNoCuadra', () => {
  it('cuadra cuando los ítems suman el total', () => {
    expect(sumaNoCuadra(completo)).toBe(false);
  });

  it('detecta un dato mal leído (13.000 en vez de 18.000)', () => {
    const items = completo.items.map((item, i) =>
      i === 2 ? { ...item, valor: 13000 } : item,
    );
    expect(sumaNoCuadra({ ...completo, items })).toBe(true);
  });

  it('no compara si falta el total escrito', () => {
    expect(sumaNoCuadra({ ...completo, totalEscrito: null })).toBe(false);
  });
});

describe('resumenBorrador', () => {
  it('muestra cliente, ítems y totales con IVA', () => {
    const resumen = resumenBorrador(completo);

    expect(resumen).toContain('Acrílicos Ejemplo SAS');
    expect(resumen).toContain('78.000');
    expect(resumen).toContain('26.790'); // IVA de 141.000
    expect(resumen).toContain('167.790'); // total a pagar
    expect(resumen).not.toContain('Falta');
  });

  it('avisa lo que falta y si la suma no cuadra', () => {
    const resumen = resumenBorrador({
      ...completo,
      cliente: { nombre: 'Juan', identificacion: null },
      totalEscrito: 999000,
    });

    expect(resumen).toContain('Falta: NIT o cédula del cliente.');
    expect(resumen).toContain('no suman el total');
  });
});

describe('motivoNoAprobable', () => {
  it('una factura completa se puede aprobar', () => {
    expect(motivoNoAprobable(completo)).toBeNull();
  });

  it('no se aprueba si falta un dato', () => {
    const sinNit = {
      ...completo,
      cliente: { nombre: 'Ana', identificacion: null },
    };
    expect(motivoNoAprobable(sinNit)).toContain('NIT o cédula');
  });

  it('no se aprueba un total escrito de 0', () => {
    expect(motivoNoAprobable({ ...completo, totalEscrito: 0 })).toContain(
      'total de la factura',
    );
  });

  it('no se aprueba si los ítems suman 0 y no hay total escrito', () => {
    const enCero: BorradorFactura = {
      ...completo,
      items: [{ descripcion: 'muestra', valor: 0 }],
      totalEscrito: null,
    };
    expect(motivoNoAprobable(enCero)).toContain('total de la factura');
  });

  it('no se aprueba si la suma no cuadra', () => {
    expect(motivoNoAprobable({ ...completo, totalEscrito: 1 })).toContain(
      'no suman',
    );
  });
});

describe('identificación del cliente en el borrador (4.4 §5)', () => {
  // Todos los números son ficticios. El DV de 900000001 es 2 (Orden Administrativa 4 de 1989).
  const con = (identificacion: string): BorradorFactura => ({
    ...completo,
    cliente: { nombre: 'Acrílicos Ejemplo SAS', identificacion },
  });

  it('NIT con DV correcto: aprobable, y el resumen lo muestra normalizado', () => {
    const borrador = con('NIT 900.000.001-2'); // ficticio

    expect(motivoNoAprobable(borrador)).toBeNull();
    expect(resumenBorrador(borrador)).toContain('NIT/CC: 900000001-2');
    expect(resumenBorrador(borrador)).not.toContain('⚠️');
  });

  it('NIT con DV que no cuadra: no aprobable, y el resumen lo advierte', () => {
    const borrador = con('900000001-5'); // ficticio, DV incorrecto a propósito

    expect(motivoNoAprobable(borrador)).toContain(
      'El dígito de verificación 5 no coincide',
    );
    expect(resumenBorrador(borrador)).toContain(
      '⚠️ El dígito de verificación 5 no coincide',
    );
  });

  it('número sin forma confirmada (11 dígitos): no aprobable', () => {
    expect(motivoNoAprobable(con('12345678901'))).toContain('Tiene 11 dígitos'); // ficticio
  });

  it('cédula con puntos: aprobable, sin puntos en el resumen', () => {
    const borrador = con('1.000.000.001'); // cédula ficticia

    expect(motivoNoAprobable(borrador)).toBeNull();
    expect(resumenBorrador(borrador)).toMatch(/NIT\/CC: 1000000001$/m);
  });

  it('pasaporte: no se le aplican las reglas de forma ni de DV', () => {
    const borrador = con('pasaporte AB123456'); // ficticio

    expect(motivoNoAprobable(borrador)).toBeNull();
  });

  it('sin identificación sigue diciendo que falta, no un problema de forma', () => {
    const borrador = {
      ...completo,
      cliente: { nombre: 'Ana', identificacion: null },
    };

    expect(motivoNoAprobable(borrador)).toContain('Aún falta');
    expect(resumenBorrador(borrador)).toContain('NIT/CC: ❓');
  });
});

describe('calcularTotales', () => {
  it('suma el IVA del 19 %', () => {
    expect(calcularTotales(135000)).toEqual({
      subtotal: 135000,
      iva: 25650,
      total: 160650,
    });
  });

  it('redondea el IVA a pesos', () => {
    expect(calcularTotales(1001).iva).toBe(190);
  });
});

describe('itemsQuitadosSinPedir (CLAUDE.md: un ítem que desaparece se pregunta)', () => {
  const sinLaAzul: BorradorFactura = {
    ...completo,
    items: completo.items.filter((i) => i.descripcion !== '1/2 laca azul'),
  };

  it('si una corrección baja los ítems sin pedirlo, devuelve cuáles faltan', () => {
    expect(
      itemsQuitadosSinPedir(completo, sinLaAzul, 'el total es 96 mil'),
    ).toEqual({ cantidad: 1, descripciones: ['1/2 laca azul'] });
  });

  it.each([
    'quita la laca azul',
    'quítale la azul',
    'elimina la laca azul',
    'borra la azul',
    'bórrala',
  ])('"%s" pide quitar: no es un problema', (mensaje) => {
    expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).toBeNull();
  });

  it('"borrador" no cuenta como "borra"', () => {
    expect(
      itemsQuitadosSinPedir(
        completo,
        sinLaAzul,
        'en el borrador cambia el total',
      ),
    ).not.toBeNull();
  });

  it('con los mismos ítems o más, no hay problema', () => {
    expect(itemsQuitadosSinPedir(completo, completo, 'x')).toBeNull();
  });

  it('si la IA reescribió las descripciones, reporta la cantidad sin nombres', () => {
    const reescrito: BorradorFactura = {
      ...completo,
      items: [{ descripcion: 'lacas varias', valor: 141000 }],
    };

    expect(itemsQuitadosSinPedir(completo, reescrito, 'x')).toEqual({
      cantidad: 2,
      descripciones: [],
    });
  });
});

describe('identificación dictada por voz (decisión 3 de la 4.4, solo advertencia)', () => {
  const AVISO = 'La identificación vino de una nota de voz';
  const ana = (identificacion: string | null, porVoz?: boolean) => ({
    ...completo,
    cliente: {
      nombre: 'Ana',
      identificacion,
      ...(porVoz ? { identificacionPorVoz: true } : {}),
    },
  });

  it('el resumen advierte, pero no bloquea la aprobación', () => {
    const borrador = ana('52111222', true); // cédula ficticia

    expect(resumenBorrador(borrador)).toContain(`⚠️ ${AVISO}`);
    expect(resumenBorrador(borrador)).toContain('antes de aprobar');
    expect(motivoNoAprobable(borrador)).toBeNull();
  });

  it('sin la marca, el resumen no advierte', () => {
    expect(resumenBorrador(ana('52111222'))).not.toContain(AVISO);
  });

  it('un mensaje de voz que trae la identificación la marca', () => {
    const marcado = conOrigenDeIdentificacion(undefined, ana('52111222'), true);

    expect(marcado.cliente.identificacionPorVoz).toBe(true);
  });

  it('un texto que cambia la identificación quita la marca', () => {
    const marcado = ana('52111222', true);

    const corregido = conOrigenDeIdentificacion(
      marcado,
      ana('52111223'),
      false,
    );

    expect(corregido.cliente.identificacionPorVoz).toBeUndefined();
  });

  it('si la identificación no cambia, conserva la marca anterior (voz o no)', () => {
    const porVoz = ana('52111222', true);
    const porTexto = ana('52111222');

    expect(
      conOrigenDeIdentificacion(porVoz, ana('52111222'), false).cliente
        .identificacionPorVoz,
    ).toBe(true);
    expect(
      conOrigenDeIdentificacion(porTexto, ana('52111222'), true).cliente
        .identificacionPorVoz,
    ).toBeUndefined();
  });

  it('una nota de voz sin identificación no marca nada', () => {
    expect(
      conOrigenDeIdentificacion(undefined, ana(null), true).cliente
        .identificacionPorVoz,
    ).toBeUndefined();
  });
});
