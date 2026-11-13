import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema.js';
import {
  type EstadoTokenAlegra,
  estadoTokenAlegra,
  sufijoCuenta,
} from './token-alegra.js';

const diaColombia = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota',
});

/** Texto para el usuario según el estado del token, o null si no hay nada que avisar. */
export function textoAvisoToken(estado: EstadoTokenAlegra): string | null {
  switch (estado.estado) {
    case 'por_vencer':
      return estado.diasRestantes === 0
        ? // Sin ruta del menú: la documentación oficial solo da la del token clásico, no la del JWT.
          '⚠️ El token de Alegra vence hoy. Genera uno nuevo en Alegra y cámbialo en el .env.'
        : `⚠️ El token de Alegra vence en ${estado.diasRestantes} día(s). Genera uno nuevo en Alegra y cámbialo en el .env.`;
    case 'vencido':
      return '⚠️ El token de Alegra venció: la emisión está apagada. Los borradores siguen funcionando. Genera uno nuevo en Alegra y cámbialo en el .env.';
    case 'cuenta_invalida':
    case 'sin_vencimiento':
      return '⚠️ El token de Alegra no tiene la forma esperada: la emisión está apagada. Revisa ALEGRA_TOKEN en el .env.';
    default:
      return null;
  }
}

/**
 * Aviso del token de Alegra (docs/planes/fase-5-alegra.md §2): al arrancar lo dice el log (sin el
 * token; de la cuenta, solo sus últimos 4 caracteres), y si falta poco para que venza o ya no
 * sirve, el bot lo dice una vez al día, antes de su primera respuesta del día.
 */
@Injectable()
export class AvisoTokenService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Alegra');
  private readonly token: string;
  private readonly emitir: boolean;
  /** Día de Colombia (AAAA-MM-DD) del último aviso al usuario. */
  private ultimoDiaAvisado: string | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.token = config.get('ALEGRA_TOKEN', { infer: true });
    this.emitir = config.get('ALEGRA_EMITIR', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.logger.log(this.lineaDeArranque(new Date()));
  }

  /** Lo que dice el log al arrancar: modo y estado del token, sin datos del token. */
  lineaDeArranque(ahora: Date): string {
    const estado = estadoTokenAlegra(this.token, ahora);
    const modo = this.emitir
      ? 'ALEGRA_EMITIR encendida: timbra ante la DIAN'
      : 'ALEGRA_EMITIR apagada: solo borradores en Alegra';
    switch (estado.estado) {
      case 'sin_token':
        return 'sin ALEGRA_TOKEN: no se envía nada a Alegra';
      case 'cuenta_invalida':
        return `${modo}; el token no trae una cuenta (org) válida: no se emite`;
      case 'sin_vencimiento':
        return `${modo}; el token no trae vencimiento: no se emite`;
      case 'vencido':
        return `${modo}; cuenta ${sufijoCuenta(estado.cuenta)}; el token VENCIÓ: no se emite`;
      case 'por_vencer':
        return `${modo}; cuenta ${sufijoCuenta(estado.cuenta)}; el token vence en ${estado.diasRestantes} día(s)`;
      case 'vigente':
        return `${modo}; cuenta ${sufijoCuenta(estado.cuenta)}; el token vence en ${estado.diasRestantes} días`;
    }
  }

  /** El aviso para el usuario, solo la primera vez de cada día de Colombia; si no, null. */
  avisoDelDia(ahora: Date = new Date()): string | null {
    const texto = textoAvisoToken(estadoTokenAlegra(this.token, ahora));
    if (!texto) return null;
    const dia = diaColombia.format(ahora);
    if (dia === this.ultimoDiaAvisado) return null;
    this.ultimoDiaAvisado = dia;
    return texto;
  }
}
