import { aBorrador, totalSegunMensaje } from './interprete-texto.service.js';

describe('totalSegunMensaje', () => {
  it('ignora un total que la IA inventó si el mensaje no dice "total"', () => {
    expect(
      totalSegunMensaje('factura a pedro por laca a 78.000', 78000, null),
    ).toBeNull();
  });

  it('acepta el total si el mensaje lo menciona', () => {
    expect(totalSegunMensaje('el total es 100 mil', 100000, null)).toBe(100000);
  });

  it('al corregir sin mencionar el total, conserva el anterior', () => {
    expect(
      totalSegunMensaje('agrega una brocha de 12 mil', 90000, 100000),
    ).toBe(100000);
  });
});

describe('aBorrador', () => {
  it('normaliza los pesos y limpia los textos', () => {
    const borrador = aBorrador({
      cliente_nombre: ' Juan Pérez ',
      cliente_identificacion: '1020304050',
      items: [
        { descripcion: '2 galones vinilo blanco', valor: '80 mil' },
        { descripcion: '1/4 esmalte rojo', valor: '$25.000' },
      ],
      total: '105.000',
    });

    expect(borrador).toEqual({
      cliente: { nombre: 'Juan Pérez', identificacion: '1020304050' },
      items: [
        { descripcion: '2 galones vinilo blanco', valor: 80000 },
        { descripcion: '1/4 esmalte rojo', valor: 25000 },
      ],
      totalEscrito: 105000,
    });
  });

  it('convierte textos vacíos y valores ilegibles en null', () => {
    const borrador = aBorrador({
      cliente_nombre: '',
      cliente_identificacion: null,
      items: [{ descripcion: 'laca', valor: 'no sé' }],
      total: null,
    });

    expect(borrador.cliente).toEqual({ nombre: null, identificacion: null });
    expect(borrador.items[0].valor).toBeNull();
    expect(borrador.totalEscrito).toBeNull();
  });
});
