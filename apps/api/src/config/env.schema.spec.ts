import { validateEnv } from './env.schema.js';

const envValido = {
  DATABASE_URL: 'postgresql://usuario:clave@localhost:5433/facturacion',
  REDIS_URL: 'redis://localhost:6379',
  TELEGRAM_BOT_TOKEN: '123456789:AAH_token-de-prueba-falso-1234567890',
};

describe('validateEnv', () => {
  it('acepta una configuración válida y aplica valores por defecto', () => {
    const env = validateEnv(envValido);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('convierte PORT de texto a número', () => {
    const env = validateEnv({ ...envValido, PORT: '4000' });

    expect(env.PORT).toBe(4000);
  });

  it('falla si falta DATABASE_URL', () => {
    const { DATABASE_URL: _omitida, ...sinBaseDeDatos } = envValido;

    expect(() => validateEnv(sinBaseDeDatos)).toThrow(/DATABASE_URL/);
  });

  it('falla si DATABASE_URL no es de PostgreSQL', () => {
    expect(() =>
      validateEnv({ ...envValido, DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('falla si TELEGRAM_BOT_TOKEN está vacío', () => {
    expect(() => validateEnv({ ...envValido, TELEGRAM_BOT_TOKEN: '' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('sin TELEGRAM_CHATS_PERMITIDOS no permite ningún chat', () => {
    expect(validateEnv(envValido).TELEGRAM_CHATS_PERMITIDOS).toEqual([]);
  });

  it('convierte la lista de chats permitidos en números', () => {
    const env = validateEnv({
      ...envValido,
      TELEGRAM_CHATS_PERMITIDOS: '123, -456',
    });

    expect(env.TELEGRAM_CHATS_PERMITIDOS).toEqual([123, -456]);
  });

  it('falla si un chat permitido no es numérico', () => {
    expect(() =>
      validateEnv({ ...envValido, TELEGRAM_CHATS_PERMITIDOS: '123,abc' }),
    ).toThrow(/TELEGRAM_CHATS_PERMITIDOS/);
  });

  it('falla si PORT no es un número', () => {
    expect(() => validateEnv({ ...envValido, PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('validateEnv: Alegra', () => {
  it('sin variables de Alegra: sin token, URL oficial y emisión apagada', () => {
    const env = validateEnv(envValido);

    expect(env.ALEGRA_TOKEN).toBe('');
    expect(env.ALEGRA_URL).toBe('https://api.alegra.com/api/v1');
    expect(env.ALEGRA_EMITIR).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['0', false],
  ])('ALEGRA_EMITIR="%s" → %s', (valor, esperado) => {
    expect(
      validateEnv({ ...envValido, ALEGRA_EMITIR: valor }).ALEGRA_EMITIR,
    ).toBe(esperado);
  });

  it('ALEGRA_EMITIR con otro texto falla (no se adivina)', () => {
    expect(() => validateEnv({ ...envValido, ALEGRA_EMITIR: 'si' })).toThrow(
      /ALEGRA_EMITIR/,
    );
  });

  it('acepta un token con forma de JWT (ficticio)', () => {
    expect(
      validateEnv({ ...envValido, ALEGRA_TOKEN: ' aaa.bbb.ccc ' }).ALEGRA_TOKEN,
    ).toBe('aaa.bbb.ccc');
  });

  it('un token sin forma de JWT falla sin mostrarlo', () => {
    const error = (() => {
      try {
        validateEnv({ ...envValido, ALEGRA_TOKEN: 'usuario:secreto123' });
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error?.message).toContain('ALEGRA_TOKEN');
    expect(error?.message).not.toContain('secreto123');
  });

  it('ALEGRA_URL sin https falla: el token viaja en cada pedido', () => {
    expect(() =>
      validateEnv({ ...envValido, ALEGRA_URL: 'http://api.alegra.com/api/v1' }),
    ).toThrow(/ALEGRA_URL/);
  });
});
