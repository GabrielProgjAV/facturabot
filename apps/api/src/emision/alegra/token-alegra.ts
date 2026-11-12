import { z } from 'zod';

/**
 * Lectura del JWT de Integraciones de Alegra (docs/planes/fase-5-alegra.md §2). El token es
 * secreto y trae datos del usuario: de él solo se leen dos campos, `exp` (vencimiento) y `org`
 * (la cuenta, decisión de Gabriel del 2026-11-12; Alegra no lo documenta). Nada de esto valida la
 * firma: la valida Alegra en cada pedido.
 */

/** Días antes del vencimiento en los que se empieza a avisar. */
export const DIAS_AVISO_VENCIMIENTO = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Solo los dos campos que se usan; el resto del contenido del token se descarta sin leerlo. */
const camposTokenSchema = z.object({
  exp: z.number().int().positive().optional().catch(undefined),
  org: z
    .string()
    .transform((org) => org.trim().toLowerCase())
    .pipe(z.string().regex(UUID))
    .optional()
    .catch(undefined),
});

export interface DatosTokenAlegra {
  /** La cuenta (organización) del token en forma canónica (UUID en minúsculas), o null. */
  org: string | null;
  /** Cuándo vence, o null si no se pudo leer. */
  vence: Date | null;
}

/** Lee `org` y `exp` del token. Nunca lanza: lo que no se entiende queda en null. */
export function leerTokenAlegra(token: string): DatosTokenAlegra {
  const partes = token.trim().split('.');
  if (partes.length !== 3) return { org: null, vence: null };
  let contenido: unknown;
  try {
    contenido = JSON.parse(
      Buffer.from(partes[1], 'base64url').toString('utf8'),
    );
  } catch {
    return { org: null, vence: null };
  }
  const campos = camposTokenSchema.safeParse(contenido);
  if (!campos.success) return { org: null, vence: null };
  return {
    org: campos.data.org ?? null,
    vence: vencimiento(campos.data.exp),
  };
}

/** La fecha de `exp`, o null si no hay o no es una fecha válida (p. ej. un número absurdo). */
function vencimiento(exp: number | undefined): Date | null {
  if (exp === undefined) return null;
  const fecha = new Date(exp * 1000);
  return Number.isFinite(fecha.getTime()) ? fecha : null;
}

export type EstadoTokenAlegra =
  | { estado: 'sin_token' }
  /** Falta `org` o no tiene forma de UUID: no se sabe de qué cuenta es, no se emite. */
  | { estado: 'cuenta_invalida' }
  /** Falta `exp`: no se puede saber si venció, no se emite. */
  | { estado: 'sin_vencimiento' }
  | { estado: 'vencido'; cuenta: string }
  | { estado: 'por_vencer'; cuenta: string; diasRestantes: number }
  | { estado: 'vigente'; cuenta: string; diasRestantes: number };

/** En qué estado está el token ahora. Solo `por_vencer` y `vigente` permiten hablar con Alegra. */
export function estadoTokenAlegra(
  token: string,
  ahora: Date,
): EstadoTokenAlegra {
  if (token.trim() === '') return { estado: 'sin_token' };
  const { org, vence } = leerTokenAlegra(token);
  if (!org) return { estado: 'cuenta_invalida' };
  if (!vence) return { estado: 'sin_vencimiento' };
  const restanteMs = vence.getTime() - ahora.getTime();
  if (restanteMs <= 0) return { estado: 'vencido', cuenta: org };
  const diasRestantes = Math.floor(restanteMs / 86_400_000);
  return diasRestantes < DIAS_AVISO_VENCIMIENTO
    ? { estado: 'por_vencer', cuenta: org, diasRestantes }
    : { estado: 'vigente', cuenta: org, diasRestantes };
}

/** Los últimos 4 caracteres de la cuenta: lo único de ella que va a los logs. */
export function sufijoCuenta(cuenta: string): string {
  return `…${cuenta.slice(-4)}`;
}
