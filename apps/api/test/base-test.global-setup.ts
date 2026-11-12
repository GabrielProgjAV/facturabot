// Antes de `pnpm test:int`: recrea la base de pruebas (nombre terminado en _test) y le aplica las
// migraciones. Borrar la base entera (DROP DATABASE) no pasa por los triggers: nunca se desactivan.
// Las pruebas no borran filas (los triggers lo impiden): cada corrida empieza de una base nueva.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  exigirBaseDePruebas,
  nombreDeBase,
  urlBaseDePruebas,
} from './base-test.js';

export default async function prepararBaseDePruebas(): Promise<void> {
  const url = urlBaseDePruebas(process.env);
  exigirBaseDePruebas(url);
  const nombre = nombreDeBase(url);

  // Conexión de administración a la base "postgres" del mismo servidor, para recrear la de pruebas.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: admin.href }),
  });
  try {
    await db.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${nombre}" WITH (FORCE)`,
    );
    await db.$executeRawUnsafe(`CREATE DATABASE "${nombre}"`);
  } finally {
    await db.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });

  // Las pruebas leen DATABASE_URL: desde aquí apunta a la base de pruebas.
  process.env.DATABASE_URL = url;
}
