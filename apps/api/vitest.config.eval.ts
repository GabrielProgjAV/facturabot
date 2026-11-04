import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Set de evaluación del intérprete: llama al Ollama local de verdad. Se corre a mano con
// `pnpm eval:interprete`, nunca en el CI.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/eval/**/*.eval.ts'],
    // Cada caso imprime su tiempo y lo que entendió la IA (datos ficticios).
    reporters: ['verbose'],
    silent: false,
    // Ollama atiende un mensaje a la vez: en paralelo solo se miden esperas.
    fileParallelism: false,
  },
});
