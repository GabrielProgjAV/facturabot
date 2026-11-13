import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { AlegraAdaptador } from './alegra/alegra.adaptador.js';
import type {
  ModoEmision,
  ProveedorFacturacion,
} from './proveedor-facturacion.js';

/** Token de inyección de `ConfigEmision`. */
export const CONFIG_EMISION = Symbol('CONFIG_EMISION');

/**
 * Con qué proveedor y en qué modo nace una emisión al aprobar (plan de la fase 5, §4). El modo
 * queda guardado en la fila y no cambia: una emisión SOLO_BORRADOR nunca se timbra.
 */
export interface ConfigEmision {
  proveedor: ProveedorFacturacion;
  modo: ModoEmision;
}

/** La configuración real: Alegra con el token y la bandera del .env. */
export function configEmisionDesdeEnv(
  config: ConfigService<Env, true>,
): ConfigEmision {
  const emitir = config.get('ALEGRA_EMITIR', { infer: true });
  return {
    proveedor: new AlegraAdaptador({
      token: config.get('ALEGRA_TOKEN', { infer: true }),
      url: config.get('ALEGRA_URL', { infer: true }),
      emitir,
    }),
    modo: emitir ? 'TIMBRAR' : 'SOLO_BORRADOR',
  };
}
