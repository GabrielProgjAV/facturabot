import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Pruebas de integración: usan una base PostgreSQL real, APARTE de la del bot (nombre terminado en
// _test), recreada con las migraciones antes de cada corrida (test/base-test.global-setup.ts). Se
// corren con `pnpm test:int`; `pnpm test` no las incluye.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    globalSetup: ['./test/base-test.global-setup.ts'],
    setupFiles: ['./test/base-test.setup.ts'],
    // Comparten la base: una a la vez.
    fileParallelism: false,
  },
});
