import {
  estadoTokenAlegra,
  leerTokenAlegra,
  sufijoCuenta,
} from './token-alegra.js';
import { tokenFicticio, ORG_FICTICIA } from './token-ficticio.spec-util.js';

const AHORA = new Date('2026-11-12T12:00:00Z');
const DIA = 86_400_000;

describe('leerTokenAlegra', () => {
  it('lee org (canónica, en minúsculas) y exp', () => {
    const vence = new Date('2026-11-22T00:00:00Z');

    expect(
      leerTokenAlegra(
        tokenFicticio({ org: ORG_FICTICIA.toUpperCase(), exp: vence }),
      ),
    ).toEqual({ org: ORG_FICTICIA, vence });
  });

  it.each([
    ['no es un JWT', 'abc'],
    ['contenido que no es JSON', 'a.@@@.c'],
    [
      'contenido que no es un objeto',
      `a.${Buffer.from('7').toString('base64url')}.c`,
    ],
  ])('%s: null en los dos campos, sin lanzar', (_caso, token) => {
    expect(leerTokenAlegra(token)).toEqual({ org: null, vence: null });
  });

  it.each([
    ['sin org', { org: undefined }],
    ['org que no es UUID', { org: '1234567' }],
    ['org numérica', { org: 123 }],
  ])('%s: org null', (_caso, cambio) => {
    expect(leerTokenAlegra(tokenFicticio(cambio)).org).toBeNull();
  });

  it('exp que no es un número: vence null', () => {
    expect(leerTokenAlegra(tokenFicticio({ exp: 'mañana' })).vence).toBeNull();
  });
});

describe('estadoTokenAlegra', () => {
  const conDias = (dias: number) =>
    tokenFicticio({ exp: new Date(AHORA.getTime() + dias * DIA) });

  it('sin token', () => {
    expect(estadoTokenAlegra('  ', AHORA)).toEqual({ estado: 'sin_token' });
  });

  it('sin org con forma de UUID: cuenta_invalida (no se emite)', () => {
    expect(estadoTokenAlegra(tokenFicticio({ org: 'x' }), AHORA)).toEqual({
      estado: 'cuenta_invalida',
    });
  });

  it('sin exp: sin_vencimiento (no se emite)', () => {
    expect(estadoTokenAlegra(tokenFicticio({ exp: undefined }), AHORA)).toEqual(
      {
        estado: 'sin_vencimiento',
      },
    );
  });

  it.each([
    [10, 'vigente', 10],
    [5, 'vigente', 5],
    [4.9, 'por_vencer', 4],
    [0.5, 'por_vencer', 0],
  ])('a %s días: %s (%s días restantes)', (dias, estado, restantes) => {
    expect(estadoTokenAlegra(conDias(dias), AHORA)).toEqual({
      estado,
      cuenta: ORG_FICTICIA,
      diasRestantes: restantes,
    });
  });

  it.each([0, -1])('a %s días: vencido', (dias) => {
    expect(estadoTokenAlegra(conDias(dias), AHORA)).toEqual({
      estado: 'vencido',
      cuenta: ORG_FICTICIA,
    });
  });
});

describe('sufijoCuenta', () => {
  it('muestra solo los últimos 4 caracteres', () => {
    expect(sufijoCuenta(ORG_FICTICIA)).toBe('…0001');
  });
});
