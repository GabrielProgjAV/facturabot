// Todos los NIT, cédulas y documentos de este archivo son ficticios.
import {
  type BorradorFactura,
  calcularTotales,
  conOrigenDeIdentificacion,
  DatosBorradorInvalidosError,
  datosCambiadosSinPedir,
  itemsQuitadosSinPedir,
  itemsReemplazadosSinPedir,
  leerBorradorFactura,
  camposFaltantes,
  motivoNoAprobable,
  pareceEmpresa,
  pareceNegocio,
  parsePesos,
  resumenBorrador,
  sumaNoCuadra,
  sumaParcialSupera,
  totalBase,
  valoresCambiadosSinPedir,
  valoresDelMensaje,
} from './factura.js';

const completo: BorradorFactura = {
  cliente: { nombre: 'Acrílicos Ejemplo SAS', identificacion: '900123456-8' }, // NIT ficticio (DV 8)
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

describe('sumaParcialSupera (ítems sin valor y los demás ya pasan el total)', () => {
  // Negra 78.000 y azul 45.000 con valor, amarilla sin valor: suman 123.000.
  const conUnoSinValor = (totalEscrito: number | null): BorradorFactura => ({
    ...completo,
    items: completo.items.map((item, i) =>
      i === 2 ? { ...item, valor: null } : item,
    ),
    totalEscrito,
  });

  it.each([
    [123001, false], // aún cabe la amarilla (1 peso)
    [123000, false], // igual: no se marca (la amarilla quedaría en 0)
    [122999, true],
    [100000, true],
  ])('total %i → %s', (total, esperado) => {
    expect(sumaParcialSupera(conUnoSinValor(total))).toBe(esperado);
  });

  it('sin total escrito o con todos los valores, no aplica', () => {
    expect(sumaParcialSupera(conUnoSinValor(null))).toBe(false);
    expect(sumaParcialSupera({ ...completo, totalEscrito: 1 })).toBe(false);
  });

  it('no es aprobable y el resumen lo advierte', () => {
    const borrador = conUnoSinValor(100000);

    expect(motivoNoAprobable(borrador)).toBe(
      'Los productos con valor ya suman más que el total escrito. Corrígelo antes de aprobar.',
    );
    expect(resumenBorrador(borrador)).toContain(
      '⚠️ Los productos con valor ya suman más que el total escrito.',
    );
  });

  it('con el total suficiente, sí es aprobable (modo simple: va el total)', () => {
    expect(motivoNoAprobable(conUnoSinValor(141000))).toBeNull();
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

  /** Una persona natural: el nombre no tiene forma de empresa. */
  const deAna = (identificacion: string): BorradorFactura => ({
    ...completo,
    cliente: { nombre: 'Ana Ejemplo', identificacion },
  });

  it('cédula con puntos: aprobable, sin puntos en el resumen', () => {
    const borrador = deAna('1.000.000.001'); // cédula ficticia

    expect(motivoNoAprobable(borrador)).toBeNull();
    expect(resumenBorrador(borrador)).toMatch(/NIT\/CC: 1000000001$/m);
  });

  it('pasaporte: no se le aplican las reglas de forma ni de DV', () => {
    const borrador = deAna('pasaporte AB123456'); // ficticio

    expect(motivoNoAprobable(borrador)).toBeNull();
  });

  it('"pasaporte" sin número: no aprobable (hallazgo 2)', () => {
    expect(motivoNoAprobable(deAna('pasaporte'))).toBe(
      'No encontré el número del documento.',
    );
  });

  it('NIT de empresa sin DV: no aprobable, y el resumen lo pide (hallazgo 3)', () => {
    const borrador = con('900000001'); // ficticio

    expect(motivoNoAprobable(borrador)).toContain(
      'Falta el dígito de verificación del NIT 900000001',
    );
    expect(resumenBorrador(borrador)).toContain('⚠️ Falta el dígito');
  });

  it('NIT con el DV pegado: no aprobable, pregunta si el último dígito es el DV (hallazgo 1)', () => {
    expect(motivoNoAprobable(con('9000000012'))).toContain('900000001-2'); // ficticio
  });

  it.each([
    // A este NIT de empresa (ficticio) le falta un dígito, y el DV escrito cuadra por azar con
    // los 8 que quedan (DV de 90000001 = 5): solo el nombre lo delata.
    ['90000001-5', 'tiene 8 dígitos'],
    ['90000001', 'tiene 8 dígitos'],
    ['1000000001', 'tiene 10 dígitos'],
    ['pasaporte AB123456', 'no es un NIT'],
  ])(
    'empresa con "%s": no aprobable, pregunta (hallazgo 3)',
    (identificacion, detalle) => {
      expect(motivoNoAprobable(con(identificacion))).toBe(
        `El cliente parece una empresa, pero su identificación ${detalle}: un NIT de empresa tiene 9 dígitos (desde 800.000.000) más el dígito de verificación. ¿Lo revisas?`,
      );
    },
  );

  it('la misma cédula de 8 dígitos con nombre de persona sí es aprobable', () => {
    expect(motivoNoAprobable(deAna('90000001'))).toBeNull(); // ficticia
  });

  it('empresa con NIT de 600 a 799 millones (persona extranjera): pregunta', () => {
    expect(motivoNoAprobable(con('600000000-7'))).toContain(
      'parece una empresa',
    ); // ficticio
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

  it('redondea al peso más cercano, también hacia arriba', () => {
    // 1003 × 0,19 = 190,57 → 191 (truncar daría 190).
    expect(calcularTotales(1003)).toEqual({
      subtotal: 1003,
      iva: 191,
      total: 1194,
    });
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
    'Quita la LACA AZÚL',
  ])('"%s" pide quitar y la nombra: no es un problema', (mensaje) => {
    expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).toBeNull();
  });

  it.each([
    'bórrala', // no dice cuál
    'quita la negra', // nombra otra
    'quita la laca', // "laca" la tienen las tres: no distingue
    'la azul ya no va', // nombra, pero no pide quitar (se pregunta de más)
  ])(
    '"%s": no nombra el ítem que se va o no pide quitarlo, pregunta (hallazgo 4)',
    (mensaje) => {
      expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).toEqual({
        cantidad: 1,
        descripciones: ['1/2 laca azul'],
      });
    },
  );

  it('"quita la azul" no permite que se vaya también la amarilla (hallazgo 4)', () => {
    const soloLaNegra: BorradorFactura = {
      ...completo,
      items: [completo.items[0]],
    };

    expect(
      itemsQuitadosSinPedir(completo, soloLaNegra, 'quita la azul'),
    ).toEqual({ cantidad: 2, descripciones: ['1/8 laca amarilla'] });
    expect(
      itemsQuitadosSinPedir(
        completo,
        soloLaNegra,
        'quita la azul y la amarilla',
      ),
    ).toBeNull();
  });

  it('ítems repetidos: nombrar uno por una palabra compartida basta, porque no hay otra', () => {
    const dosGalones: BorradorFactura = {
      ...completo,
      items: [
        { descripcion: 'galón vinilo', valor: 40000 },
        { descripcion: 'galón vinilo', valor: 40000 },
      ],
    };
    const uno: BorradorFactura = {
      ...dosGalones,
      items: [dosGalones.items[0]],
    };

    expect(
      itemsQuitadosSinPedir(dosGalones, uno, 'quita un galón de vinilo'),
    ).toBeNull();
  });

  it('plural simple: "quita los galones" nombra "galón"', () => {
    const conGalon: BorradorFactura = {
      ...completo,
      items: [
        { descripcion: 'galón', valor: 40000 },
        { descripcion: 'brocha', valor: 12000 },
      ],
    };
    const sinGalon: BorradorFactura = {
      ...conGalon,
      items: [conGalon.items[1]],
    };

    expect(
      itemsQuitadosSinPedir(conGalon, sinGalon, 'quita los galones'),
    ).toBeNull();
  });

  it.each([
    'no quites la azul',
    'no le borres la azul',
    'sin eliminar la azul',
  ])('"%s" es una negación: no pide quitar, pregunta', (mensaje) => {
    expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).not.toBeNull();
  });

  it.each([
    'quítamela, la azul',
    'elimínala, la azul',
    'bórramela, la azul',
    'quitemos la azul',
    'quiten la laca azul',
    'hay que quitar la azul',
    'eliminar la azul',
  ])('"%s": otras formas del verbo también piden quitar', (mensaje) => {
    expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).toBeNull();
  });

  it.each([
    'agrega un quitamanchas para la azul',
    'el quitapinturas va con la azul',
    'la azul es borrable',
    'eliminador de óxido como la azul',
  ])('"%s": una palabra compuesta no cuenta como "quita"', (mensaje) => {
    expect(itemsQuitadosSinPedir(completo, sinLaAzul, mensaje)).toEqual({
      cantidad: 1,
      descripciones: ['1/2 laca azul'],
    });
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

describe('valoresCambiadosSinPedir (hallazgo 5: un valor no mencionado no cambia en silencio)', () => {
  const conAzul = (valor: number | null): BorradorFactura => ({
    ...completo,
    items: completo.items.map((i) =>
      i.descripcion === '1/2 laca azul' ? { ...i, valor } : i,
    ),
  });

  it('un ítem conservado que cambia a un valor que el mensaje no dice: se reporta', () => {
    expect(
      valoresCambiadosSinPedir(completo, conAzul(50000), 'el nit es 12345678'),
    ).toEqual([
      {
        descripcion: '1/2 laca azul',
        antes: 45000,
        despues: 50000,
        nuevo: false,
      },
    ]);
  });

  it.each([
    'la azul a 50 mil',
    'la azul vale 50.000',
    'azul $50.000.',
    'la azul a 50', // "50" también cuenta como 50 mil
    'azul 50000',
  ])('"%s": el valor nuevo aparece en el mensaje, no se reporta', (mensaje) => {
    expect(valoresCambiadosSinPedir(completo, conAzul(50000), mensaje)).toEqual(
      [],
    );
  });

  it('un valor que se pierde (pasa a null) se reporta aunque el mensaje tenga números', () => {
    expect(
      valoresCambiadosSinPedir(completo, conAzul(null), 'el total es 96 mil'),
    ).toEqual([
      {
        descripcion: '1/2 laca azul',
        antes: 45000,
        despues: null,
        nuevo: false,
      },
    ]);
  });

  it('un valor que faltaba y el mensaje lo da: no se reporta; si no lo da, sí', () => {
    const sinValor = conAzul(null);

    expect(
      valoresCambiadosSinPedir(sinValor, completo, 'la azul a 45 mil'),
    ).toEqual([]);
    expect(valoresCambiadosSinPedir(sinValor, completo, 'listo')).toHaveLength(
      1,
    );
  });

  it('sin cambios de valor, o con descripciones en otro formato de mayúsculas, no reporta', () => {
    const otraLetra: BorradorFactura = {
      ...completo,
      items: completo.items.map((i) => ({
        ...i,
        descripcion: i.descripcion.toUpperCase(),
      })),
    };

    expect(valoresCambiadosSinPedir(completo, completo, 'x')).toEqual([]);
    expect(valoresCambiadosSinPedir(completo, otraLetra, 'x')).toEqual([]);
  });

  it('un valor dicho para otro ítem no le cambia el valor a la azul (el mensaje no la nombra)', () => {
    expect(
      valoresCambiadosSinPedir(completo, conAzul(78000), 'la negra a 78 mil'),
    ).toHaveLength(1);
    expect(
      valoresCambiadosSinPedir(completo, conAzul(78000), 'la azul a 78 mil'),
    ).toEqual([]);
  });

  it('un ítem nuevo con un valor que no está en el mensaje: se reporta como nuevo', () => {
    const conBrocha: BorradorFactura = {
      ...completo,
      items: [...completo.items, { descripcion: 'brocha', valor: 12000 }],
    };

    expect(
      valoresCambiadosSinPedir(completo, conBrocha, 'agrega una brocha'),
    ).toEqual([
      { descripcion: 'brocha', antes: null, despues: 12000, nuevo: true },
    ]);
    expect(
      valoresCambiadosSinPedir(
        completo,
        conBrocha,
        'agrega una brocha de 12 mil',
      ),
    ).toEqual([]);
  });

  it('descripción reescrita con otro valor: se reporta; con el mismo valor, no', () => {
    const reescrita = (valor: number): BorradorFactura => ({
      ...completo,
      items: completo.items.map((i) =>
        i.descripcion === '1/2 laca azul'
          ? { descripcion: '1/2 galón laca azul', valor }
          : i,
      ),
    });

    expect(
      valoresCambiadosSinPedir(completo, reescrita(60000), 'es de galón'),
    ).toEqual([
      {
        descripcion: '1/2 galón laca azul',
        antes: null,
        despues: 60000,
        nuevo: true,
      },
    ]);
    expect(
      valoresCambiadosSinPedir(completo, reescrita(45000), 'es de galón'),
    ).toEqual([]);
  });

  it('el mismo valor en otro ítem del mensaje no basta si no es ese valor', () => {
    expect(
      valoresCambiadosSinPedir(completo, conAzul(46000), 'la negra a 45 mil'),
    ).toHaveLength(1);
  });
});

describe('valoresDelMensaje', () => {
  it('lee pesos colombianos en sus formas habituales', () => {
    const valores = valoresDelMensaje(
      'negra 78.000, azul $45 mil, amarilla 1,5 mil y brocha 12000.',
    );

    expect([...valores]).toEqual(
      expect.arrayContaining([78000, 45000, 1500, 12000]),
    );
  });

  it('un número menor de mil cuenta también como miles', () => {
    expect(valoresDelMensaje('a 80').has(80000)).toBe(true);
    expect(valoresDelMensaje('a 80').has(80)).toBe(true);
  });

  it('sin números, vacío', () => {
    expect(valoresDelMensaje('quita la azul').size).toBe(0);
  });
});

describe('pareceEmpresa', () => {
  it.each([
    'Pinturas Sol SAS',
    'Pinturas Sol S.A.S.',
    'Acrílicos Ejemplo S.A.',
    'Ferretería Ejemplo Ltda.',
    'Comercial Ejemplo Limitada',
    'Ejemplo E.U.',
    'Ejemplo S. en C.',
    'Pérez & Cía.',
    'Pérez y Cía',
    'Pinturas Ejemplo S.A.S. BIC',
  ])('"%s" parece una empresa', (nombre) => {
    expect(pareceEmpresa(nombre)).toBe(true);
  });

  it.each(['Ana', 'Rosa', 'Elsa', 'Marisa', 'Lucía', 'Pinturas Pepito', null])(
    '"%s" no parece una empresa',
    (nombre) => {
      expect(pareceEmpresa(nombre)).toBe(false);
    },
  );
});

describe('leerBorradorFactura (JSON de la BD validado con Zod)', () => {
  it('un borrador válido sale igual, con la marca de voz si la tiene', () => {
    const conVoz = {
      ...completo,
      cliente: { ...completo.cliente, identificacionPorVoz: true },
    };

    expect(leerBorradorFactura(completo)).toEqual(completo);
    expect(leerBorradorFactura(conVoz)).toEqual(conVoz);
  });

  it.each([
    ['null', null, '(raíz)'],
    ['sin items', { ...completo, items: undefined }, 'items'],
    [
      'valor en texto',
      { ...completo, items: [{ descripcion: 'vinilo', valor: '78.000' }] },
      'items.0.valor',
    ],
    [
      'valor negativo',
      { ...completo, items: [{ descripcion: 'vinilo', valor: -1 }] },
      'items.0.valor',
    ],
    ['total con decimales', { ...completo, totalEscrito: 1.5 }, 'totalEscrito'],
    [
      'identificación numérica',
      { ...completo, cliente: { nombre: 'Ana', identificacion: 900123456 } },
      'cliente.identificacion',
    ],
  ])('%s: lanza con la ruta del campo, sin su valor', (_caso, datos, ruta) => {
    let error: unknown;
    try {
      leerBorradorFactura(datos);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(DatosBorradorInvalidosError);
    expect((error as DatosBorradorInvalidosError).campos).toContain(ruta);
    expect((error as Error).message).not.toMatch(/78\.000|900123456|Ana/);
  });
});

describe('datosCambiadosSinPedir (identificación o total que cambian sin decirlos)', () => {
  const conId = (identificacion: string | null): BorradorFactura => ({
    ...completo,
    cliente: { ...completo.cliente, identificacion },
  });
  const conTotal = (totalEscrito: number | null): BorradorFactura => ({
    ...completo,
    totalEscrito,
  });

  it('sin cambios: nada', () => {
    expect(datosCambiadosSinPedir(completo, completo, 'x')).toEqual([]);
  });

  it.each([
    ['el nit es 900.123.457-5', '900123457-5'],
    ['nit 900123457 - 5', '900123457-5'],
    ['es la cédula 1.000.000.001', '1000000001'],
    ['pasaporte ab-123456', 'pasaporte AB123456'],
  ])(
    'identificación dicha en el mensaje ("%s"): se acepta',
    (mensaje, nueva) => {
      expect(datosCambiadosSinPedir(completo, conId(nueva), mensaje)).toEqual(
        [],
      );
    },
  );

  it('solo cambió el formato de la misma identificación: no es un cambio', () => {
    expect(
      datosCambiadosSinPedir(conId('900.123.456-8'), conId('900123456-8'), 'x'),
    ).toEqual([]);
  });

  it.each([
    ['el cliente es Acrílicos', '900123457-5'],
    ['el nit termina en 457', '900123457-5'],
    ['agrega una brocha de 12 mil', '12000'],
  ])(
    'identificación que no está en el mensaje ("%s"): se pregunta',
    (mensaje, nueva) => {
      expect(datosCambiadosSinPedir(completo, conId(nueva), mensaje)).toEqual([
        { campo: 'identificacion', antes: '900123456-8', despues: nueva },
      ]);
    },
  );

  it('identificación inventada donde no había: se pregunta', () => {
    expect(datosCambiadosSinPedir(conId(null), conId('52111222'), 'x')).toEqual(
      [{ campo: 'identificacion', antes: null, despues: '52111222' }],
    );
  });

  it.each(['quita el nit', 'bórrale la cédula', 'elimina la identificación'])(
    'quitar la identificación nombrándola ("%s"): se acepta',
    (mensaje) => {
      expect(datosCambiadosSinPedir(completo, conId(null), mensaje)).toEqual(
        [],
      );
    },
  );

  it.each(['el cliente es otro', 'quita la brocha', 'no le quites el nit'])(
    'identificación perdida sin pedirlo ("%s"): se pregunta',
    (mensaje) => {
      expect(datosCambiadosSinPedir(completo, conId(null), mensaje)).toEqual([
        { campo: 'identificacion', antes: '900123456-8', despues: null },
      ]);
    },
  );

  it.each([
    ['el total es 150 mil', 150000],
    ['total 150.000', 150000],
    ['el total es 150', 150000],
  ])('total dicho en el mensaje ("%s"): se acepta', (mensaje, total) => {
    expect(datosCambiadosSinPedir(completo, conTotal(total), mensaje)).toEqual(
      [],
    );
  });

  it('total que no está en el mensaje: se pregunta', () => {
    expect(
      datosCambiadosSinPedir(completo, conTotal(150000), 'el total es 140 mil'),
    ).toEqual([{ campo: 'total', antes: 141000, despues: 150000 }]);
  });

  it('total perdido: solo vale si el mensaje pide quitarlo', () => {
    expect(
      datosCambiadosSinPedir(completo, conTotal(null), 'quita el total'),
    ).toEqual([]);
    expect(
      datosCambiadosSinPedir(completo, conTotal(null), 'el total es raro'),
    ).toEqual([{ campo: 'total', antes: 141000, despues: null }]);
  });
});

describe('itemsReemplazadosSinPedir (caso f del set de evaluación)', () => {
  const conEstuco: BorradorFactura = {
    cliente: { nombre: 'Marta', identificacion: null },
    items: [{ descripcion: 'estuco', valor: 40000 }],
    totalEscrito: null,
  };
  const conVinilo = (valor: number | null): BorradorFactura => ({
    ...conEstuco,
    items: [{ descripcion: '3 galones de vinilo', valor }],
  });

  it.each([40000, null])(
    'la IA cambia el estuco por vinilo (valor %s) sin que el mensaje nombre el estuco: lo devuelve',
    (valor) => {
      expect(
        itemsReemplazadosSinPedir(
          conEstuco,
          conVinilo(valor),
          'el vinilo son 3 galones y quita la brocha',
        ),
      ).toEqual(['estuco']);
    },
  );

  it.each([
    'cambia el estuco por 3 galones de vinilo',
    'en vez de estuco, vinilo',
  ])('"%s" nombra el estuco: no es un problema', (mensaje) => {
    expect(
      itemsReemplazadosSinPedir(conEstuco, conVinilo(40000), mensaje),
    ).toEqual([]);
  });

  it('con un ítem más y otro reemplazado, devuelve solo el reemplazado', () => {
    const despues: BorradorFactura = {
      ...completo,
      items: [
        completo.items[0],
        { descripcion: '1/2 esmalte azul', valor: 45000 },
        completo.items[2],
        { descripcion: 'brocha', valor: 12000 },
      ],
    };

    expect(
      itemsReemplazadosSinPedir(
        completo,
        despues,
        'agrega una brocha de 12 mil',
      ),
    ).toEqual(['1/2 laca azul']);
  });

  it('mismos ítems, solo con otro valor, o con un ítem nuevo: nada', () => {
    const otroValor: BorradorFactura = {
      ...completo,
      items: completo.items.map((i, n) =>
        n === 0 ? { ...i, valor: 80000 } : i,
      ),
    };
    const conBrocha: BorradorFactura = {
      ...completo,
      items: [...completo.items, { descripcion: 'brocha', valor: 12000 }],
    };

    expect(itemsReemplazadosSinPedir(completo, otroValor, 'x')).toEqual([]);
    expect(itemsReemplazadosSinPedir(completo, conBrocha, 'x')).toEqual([]);
  });

  it('si la cantidad baja, no aplica (lo cubre itemsQuitadosSinPedir)', () => {
    expect(
      itemsReemplazadosSinPedir(conEstuco, { ...conEstuco, items: [] }, 'x'),
    ).toEqual([]);
  });
});

describe('pareceNegocio (nombre de negocio sin tipo de sociedad: solo advierte)', () => {
  it.each([
    'Ferretería El Tornillo',
    'PINTURAS DEL VALLE',
    'Inversiones Ejemplo',
    'Distribuidora Ficticia',
    'Fundación Ejemplo',
    'Gómez e Hijos',
  ])('"%s": parece un negocio', (nombre) => {
    expect(pareceNegocio(nombre)).toBe(true);
  });

  it.each(['Rosa', 'Marta Gómez', 'Pinturas Sol SAS', 'Grupito', null])(
    '"%s": no (persona, o ya tiene tipo de sociedad y lo cubre pareceEmpresa)',
    (nombre) => {
      expect(pareceNegocio(nombre)).toBe(false);
    },
  );

  const negocio = (identificacion: string): BorradorFactura => ({
    ...completo,
    cliente: { nombre: 'Ferretería El Tornillo', identificacion },
  });

  it.each(['12345678', '1000000001'])(
    'con forma de cédula (%s, ficticia): advierte en el resumen pero sigue aprobable',
    (identificacion) => {
      const borrador = negocio(identificacion);

      expect(resumenBorrador(borrador)).toContain(
        '⚠️ El cliente parece un negocio.',
      );
      expect(motivoNoAprobable(borrador)).toBeNull();
    },
  );

  it('con NIT de empresa (ficticio) no advierte', () => {
    expect(resumenBorrador(negocio('900123456-8'))).not.toContain(
      'parece un negocio',
    );
  });

  it('una persona con cédula no recibe la advertencia', () => {
    const rosa: BorradorFactura = {
      ...completo,
      cliente: { nombre: 'Rosa', identificacion: '52111222' },
    };

    expect(resumenBorrador(rosa)).not.toContain('parece un negocio');
  });
});
