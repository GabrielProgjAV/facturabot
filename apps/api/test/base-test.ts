/**
 * Base de datos aparte para `pnpm test:int` (obligatoria antes de usar datos reales, plan de la
 * fase 5 §4). Nunca es la base del bot: su nombre tiene que terminar en `_test`.
 */

/** La URL de la base de pruebas: DATABASE_URL_TEST, o DATABASE_URL con `_test` en el nombre. */
export function urlBaseDePruebas(env: NodeJS.ProcessEnv): string {
  const explicita = env.DATABASE_URL_TEST?.trim();
  if (explicita) return explicita;
  const base = env.DATABASE_URL?.trim();
  if (!base) throw new Error('Falta DATABASE_URL (o DATABASE_URL_TEST)');
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}_test`;
  return url.href;
}

/** El nombre de la base de una URL de PostgreSQL. */
export function nombreDeBase(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
}

/** Se niega a seguir si la base no es de pruebas. El mensaje nunca lleva la URL (trae la clave). */
export function exigirBaseDePruebas(url: string): void {
  const nombre = nombreDeBase(url);
  if (!/^[a-z0-9_]+_test$/.test(nombre)) {
    throw new Error(
      'Las pruebas de integración solo corren sobre una base cuyo nombre termina en _test',
    );
  }
}
