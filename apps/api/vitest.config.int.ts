import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Pruebas de integración: usan una base PostgreSQL real con las migraciones aplicadas
// (DATABASE_URL). Se corren con `pnpm test:int`; `pnpm test` no las incluye.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    // Comparten la base: una a la vez.
    fileParallelism: false,
  },
});
