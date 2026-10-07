import {
  type BorradorFactura,
  calcularTotales,
  camposFaltantes,
  motivoNoAprobable,
  parsePesos,
  resumenBorrador,
  sumaNoCuadra,
  totalBase,
} from './factura.js';

const completo: BorradorFactura = {
  cliente: { nombre: 'Central de Acrílicos', identificacion: '900123456' },
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

    expect(resumen).toContain('Central de Acrílicos');
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

  it('no se aprueba si la suma no cuadra', () => {
    expect(motivoNoAprobable({ ...completo, totalEscrito: 1 })).toContain(
      'no suman',
    );
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
