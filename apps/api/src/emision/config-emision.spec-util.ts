import { ORG_FICTICIA } from './alegra/token-ficticio.spec-util.js';
import type { ConfigEmision } from './config-emision.js';
import {
  ErrorProveedor,
  type ModoEmision,
  type ProveedorFacturacion,
} from './proveedor-facturacion.js';

/**
 * Configuración de emisión para las pruebas: un proveedor que solo responde `cuenta()` (la cuenta
 * ficticia, o el error de un token vencido). Ninguna prueba de la conversación llama a Alegra.
 */
export function configEmisionFalsa(
  opciones: { tokenValido?: boolean; modo?: ModoEmision } = {},
): ConfigEmision {
  const { tokenValido = true, modo = 'SOLO_BORRADOR' } = opciones;
  const noSeUsa = () =>
    Promise.reject(new Error('La conversación no llama al proveedor'));
  const proveedor: ProveedorFacturacion = {
    nombre: 'ALEGRA',
    cuenta: () => {
      if (!tokenValido) throw new ErrorProveedor('token_vencido');
      return ORG_FICTICIA;
    },
    crearBorrador: noSeUsa,
    timbrar: noSeUsa,
    consultar: noSeUsa,
    buscarPorReferencia: noSeUsa,
  };
  return { proveedor, modo };
}
