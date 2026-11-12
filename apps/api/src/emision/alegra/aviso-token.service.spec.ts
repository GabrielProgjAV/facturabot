// Tokens y cuentas ficticios.
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import { tokenFicticio } from './token-ficticio.spec-util.js';
import { AvisoTokenService } from './aviso-token.service.js';

const DIA = 86_400_000;
const AHORA = new Date('2026-11-12T15:00:00Z'); // 10 a. m. en Colombia

function servicio(token: string, emitir = false) {
  const valores: Record<string, unknown> = {
    ALEGRA_TOKEN: token,
    ALEGRA_EMITIR: emitir,
  };
  return new AvisoTokenService({
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService<Env, true>);
}
const venceEn = (dias: number) =>
  tokenFicticio({ exp: new Date(AHORA.getTime() + dias * DIA) });

describe('AvisoTokenService: línea de arranque', () => {
  it('dice el modo, los últimos 4 caracteres de la cuenta y los días; nunca el token', () => {
    const token = venceEn(10);
    const linea = servicio(token).lineaDeArranque(AHORA);

    expect(linea).toBe(
      'ALEGRA_EMITIR apagada: solo borradores en Alegra; cuenta …0001; el token vence en 10 días',
    );
    expect(linea).not.toContain(token);
    expect(linea).not.toContain('00000000-0000');
  });

  it.each([
    ['', 'sin ALEGRA_TOKEN: no se envía nada a Alegra'],
    [
      tokenFicticio({ org: 'x' }),
      'el token no trae una cuenta (org) válida: no se emite',
    ],
    [venceEn(-1), 'el token VENCIÓ: no se emite'],
  ])('%#: %s', (token, texto) => {
    expect(servicio(token, true).lineaDeArranque(AHORA)).toContain(texto);
  });
});

describe('AvisoTokenService: aviso del día', () => {
  it('con más de 5 días no avisa', () => {
    expect(servicio(venceEn(6)).avisoDelDia(AHORA)).toBeNull();
  });

  it('sin token no avisa (no hay proveedor a propósito)', () => {
    expect(servicio('').avisoDelDia(AHORA)).toBeNull();
  });

  it('con menos de 5 días avisa una sola vez por día de Colombia', () => {
    const aviso = servicio(venceEn(3));

    expect(aviso.avisoDelDia(AHORA)).toContain('vence en 3 día(s)');
    expect(aviso.avisoDelDia(new Date(AHORA.getTime() + 60_000))).toBeNull();
    // 11 p. m. en Colombia (ya es el día siguiente en UTC): sigue siendo el mismo día.
    expect(aviso.avisoDelDia(new Date('2026-11-13T04:00:00Z'))).toBeNull();
    // Al día siguiente de Colombia vuelve a avisar.
    expect(aviso.avisoDelDia(new Date('2026-11-13T15:00:00Z'))).toContain(
      'vence en 2 día(s)',
    );
  });

  it.each([
    [venceEn(-1), 'venció: la emisión está apagada'],
    [tokenFicticio({ org: 'x' }), 'no tiene la forma esperada'],
  ])('%#: avisa que la emisión está apagada', (token, texto) => {
    expect(servicio(token).avisoDelDia(AHORA)).toContain(texto);
  });
});
