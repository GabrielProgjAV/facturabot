import {
  diaDeColombia,
  diaDeFechaGuardada,
  fechaFacturaParaGuardar,
} from './fecha-factura.js';

describe('fecha de la factura en hora de Colombia (§4)', () => {
  it.each([
    // 7 p. m. a 11:59 p. m. en Colombia ya es el día siguiente en UTC.
    ['2026-11-13T00:00:00Z', '2026-11-12'], // 7:00 p. m. del 12
    ['2026-11-13T04:59:59Z', '2026-11-12'], // 11:59:59 p. m. del 12
    ['2026-11-13T05:00:00Z', '2026-11-13'], // medianoche del 13
    ['2026-11-12T15:00:00Z', '2026-11-12'], // 10 a. m. del 12
  ])('%s → %s', (instante, dia) => {
    expect(diaDeColombia(new Date(instante))).toBe(dia);
    const guardada = fechaFacturaParaGuardar(new Date(instante));
    expect(guardada.toISOString()).toBe(`${dia}T00:00:00.000Z`);
    // Se lee en UTC: en hora de Bogotá daría el día anterior.
    expect(diaDeFechaGuardada(guardada)).toBe(dia);
  });
});
