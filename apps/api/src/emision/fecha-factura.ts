/**
 * Fecha de la factura (plan de la fase 5, §4): el día se calcula en hora de Colombia, nunca en UTC
 * (una venta a las 9 p. m. en Colombia ya es el día siguiente en UTC). Se guarda como `DATE`.
 */

const diaColombia = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** El día de Colombia (AAAA-MM-DD) de ese instante. */
export function diaDeColombia(instante: Date): string {
  return diaColombia.format(instante);
}

/**
 * El valor que se guarda en `fecha_factura`: medianoche UTC de ese día, porque Prisma lee y escribe
 * un `DATE` como medianoche UTC.
 */
export function fechaFacturaParaGuardar(instante: Date): Date {
  return new Date(`${diaDeColombia(instante)}T00:00:00Z`);
}

/** El día guardado en `fecha_factura`, leído siempre en UTC (en hora de Bogotá sería el anterior). */
export function diaDeFechaGuardada(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}
