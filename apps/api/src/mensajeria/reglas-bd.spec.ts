import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describirError, REGLAS_BD } from './procesador-mensajes.js';

/**
 * `REGLAS_BD` es la lista cerrada de nombres de la base que se pueden imprimir en el log. Este test
 * la compara con lo que de verdad dejan las migraciones, para que un nombre nuevo olvidado (saldría
 * como `bd_regla_desconocida`) o uno que ya no existe rompan el CI.
 */

const CARPETA_MIGRACIONES = fileURLToPath(
  new URL('../../prisma/migrations/', import.meta.url),
);

interface NombresDeLaBase {
  /** Restricciones e índices (salen como `bd_restriccion`). */
  restricciones: Set<string>;
  /** Reglas de los triggers, el texto antes de ":" en `RAISE EXCEPTION` (`bd_trigger`). */
  reglas: Set<string>;
}

/** Lee las migraciones en orden y devuelve los nombres que quedan vigentes al final. */
function nombresDeLasMigraciones(): NombresDeLaBase {
  const sqls = readdirSync(CARPETA_MIGRACIONES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((carpeta) =>
      readFileSync(join(CARPETA_MIGRACIONES, carpeta, 'migration.sql'), 'utf8'),
    );

  const restricciones = new Set<string>();
  // Cuerpo vigente de cada función: un CREATE OR REPLACE reemplaza las reglas de la anterior.
  const funciones = new Map<string, string>();
  // Tablas cuyos triggers ejecutan cada función (para las reglas que usan TG_TABLE_NAME).
  const tablasPorFuncion = new Map<string, Set<string>>();

  for (const sql of sqls) {
    for (const m of sql.matchAll(
      /(DROP\s+)?(?:CONSTRAINT|INDEX)\s+(?:IF\s+EXISTS\s+)?"(\w+)"/g,
    )) {
      if (m[1]) restricciones.delete(m[2]);
      else restricciones.add(m[2]);
    }
    for (const m of sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"(\w+)"[\s\S]*?\$\$([\s\S]*?)\$\$/g,
    )) {
      funciones.set(m[1], m[2]);
    }
    for (const m of sql.matchAll(
      /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"(\w+)"/g,
    )) {
      funciones.delete(m[1]);
    }
    for (const m of sql.matchAll(
      /CREATE\s+TRIGGER\s+"\w+"[\s\S]*?\sON\s+"(\w+)"[\s\S]*?EXECUTE\s+FUNCTION\s+"(\w+)"/g,
    )) {
      const tablas = tablasPorFuncion.get(m[2]) ?? new Set<string>();
      tablas.add(m[1]);
      tablasPorFuncion.set(m[2], tablas);
    }
  }

  const reglas = new Set<string>();
  for (const [funcion, cuerpo] of funciones) {
    for (const m of cuerpo.matchAll(/RAISE\s+EXCEPTION\s+'([%\w]+):/g)) {
      const regla = m[1];
      if (regla.startsWith('%')) {
        // '%_sin_borrado' con TG_TABLE_NAME: una regla por cada tabla del trigger.
        for (const tabla of tablasPorFuncion.get(funcion) ?? []) {
          reglas.add(tabla + regla.slice(1));
        }
      } else {
        reglas.add(regla);
      }
    }
  }
  return { restricciones, reglas };
}

const deBase = (mensaje: string) =>
  Object.assign(new Error(mensaje), {
    name: 'PrismaClientUnknownRequestError',
  });

describe('REGLAS_BD frente a las migraciones', () => {
  const { restricciones, reglas } = nombresDeLasMigraciones();
  const enMigraciones = new Set([...restricciones, ...reglas]);

  it('lee las migraciones (si el análisis falla, este test lo dice)', () => {
    expect(restricciones).toContain('emisiones_codigo_error_check');
    expect(reglas).toContain('emisiones_transicion_no_permitida');
    // La regla con TG_TABLE_NAME se expande por tabla, y TRUNCATE no tiene nombre propio.
    expect(reglas).toContain('emisiones_sin_borrado');
    expect(reglas).toContain('borradores_sin_borrado');
    // Reemplazada por la lista de transiciones permitidas en cerrar_emisiones.
    expect(reglas).not.toContain('emisiones_estado_final');
  });

  it('todo nombre de las migraciones está en REGLAS_BD', () => {
    const faltan = [...enMigraciones].filter((n) => !REGLAS_BD.has(n));
    expect(faltan).toEqual([]);
  });

  it('REGLAS_BD no tiene nombres que ya no existen', () => {
    const sobran = [...REGLAS_BD].filter((n) => !enMigraciones.has(n));
    expect(sobran).toEqual([]);
  });

  it('cada restricción se imprime como bd_restriccion', () => {
    for (const nombre of restricciones) {
      expect(describirError(deBase(`constraint "${nombre}"`))).toBe(
        `PrismaClientUnknownRequestError [bd_restriccion:${nombre}]`,
      );
    }
  });

  it('cada regla de trigger se imprime como bd_trigger', () => {
    for (const regla of reglas) {
      expect(describirError(deBase(`ERROR: ${regla}: detalle`))).toBe(
        `PrismaClientUnknownRequestError [bd_trigger:${regla}]`,
      );
    }
  });
});
