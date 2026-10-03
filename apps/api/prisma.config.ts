import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Configuración del CLI de Prisma (migraciones, generación del cliente).
// La app en ejecución NO usa este archivo: obtiene DATABASE_URL de ConfigService.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
