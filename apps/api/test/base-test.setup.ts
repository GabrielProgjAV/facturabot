// En cada archivo de `pnpm test:int`: DATABASE_URL tiene que ser la base de pruebas.
import { exigirBaseDePruebas } from './base-test.js';

exigirBaseDePruebas(process.env.DATABASE_URL ?? '');
