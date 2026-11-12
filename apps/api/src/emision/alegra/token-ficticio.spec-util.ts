// Utilidad de pruebas: un JWT ficticio, sin firma válida, con los campos que el bot lee de Alegra.
// Nunca es un token real.

/** Organización ficticia de las pruebas. */
export const ORG_FICTICIA = '00000000-0000-4000-8000-000000000001';
/** Otra organización ficticia, para probar la guarda de la cuenta. */
export const OTRA_ORG_FICTICIA = '00000000-0000-4000-8000-000000000002';

export function tokenFicticio(
  campos: { org?: unknown; exp?: Date | unknown } = {},
): string {
  const contenido: Record<string, unknown> = {
    org: 'org' in campos ? campos.org : ORG_FICTICIA,
    exp:
      'exp' in campos
        ? campos.exp instanceof Date
          ? Math.floor(campos.exp.getTime() / 1000)
          : campos.exp
        : Math.floor(Date.now() / 1000) + 10 * 86_400,
    email: 'ficticio@example.invalid',
  };
  const parte = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${parte({ alg: 'none', typ: 'JWT' })}.${parte(contenido)}.firma-ficticia`;
}
