import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONFIG_EMISION,
  type ConfigEmision,
} from '../emision/config-emision.js';
import { fechaFacturaParaGuardar } from '../emision/fecha-factura.js';
import { ErrorProveedor } from '../emision/proveedor-facturacion.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Borrador } from '../generated/prisma/client.js';
import type { DestinoFactura } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  aConsumidorFinal,
  type BorradorFactura,
  clienteDeVenta,
  conMarcaDeVaciado,
  conOrigenDeIdentificacion,
  esConsumidorFinal,
  sinNombreConsumidorFinal,
  DatosBorradorInvalidosError,
  type DatoCambiado,
  type DatoVaciado,
  datosCambiadosSinPedir,
  type ItemsQuitados,
  itemsQuitadosSinPedir,
  itemsReemplazadosSinPedir,
  leerBorradorFactura,
  motivoNoAprobable,
  pesos,
  resumenBorrador,
  sinDatosNoDichos,
  type ValorCambiado,
  valoresCambiadosSinPedir,
} from './factura.js';
import { InterpreteTextoService } from './interprete-texto.service.js';

// Admite signos finales: Whisper transcribe "Cancelar." (4.4).
const CANCELAR = /^\s*cancelar\s*[.!]*\s*$/i;
// "sí" y sus variantes ya no aprueban (decisión 1 de la 4.4): solo se aprueba con el botón, que
// lleva la versión exacta del mensaje. Se reconocen para responder con el resumen y el botón, sin
// pasar el mensaje a la IA ("sí, pero cambia el NIT" sí es una corrección).
const APROBAR =
  /^\s*(s[ií]|ok|dale|listo|apruebo|aprobado|aprobar|confirmo|confirmar)\s*[.!]*\s*$/i;

/**
 * Un PENDIENTE sin escrituras en este tiempo se da por olvidado (4.4 §14.1). `actualizadoEn` cambia
 * también al marcar un resumen como mostrado: lo que el usuario acaba de ver no está olvidado.
 */
export const QUIETO_MS = 2 * 60 * 60 * 1000;

const formatoFecha = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** Fecha y hora de Colombia para el usuario: "30 de oct, 9:15 a. m.". */
export function fechaCorta(fecha: Date): string {
  return formatoFecha.format(fecha);
}

/** "sí", "cancelar" o "consumidor final": no pasan por la IA, así que no se avisa "Procesando…". */
export function esComando(texto: string): boolean {
  return (
    CANCELAR.test(texto) || APROBAR.test(texto) || esConsumidorFinal(texto)
  );
}

/**
 * Qué borrador, en qué versión y con qué destino: lo que lleva el botón del resumen que el usuario
 * tiene en pantalla. Con solo la versión, se podría aprobar otro borrador en la misma versión; sin
 * el destino, una venta podría quedar "para facturar a mano" sin que el usuario viera el aviso
 * (p. ej. si el token venció entre el resumen y el botón).
 */
export interface VistaBorrador {
  borradorId: string;
  version: number;
  destino: DestinoFactura;
}

/** El texto del botón según el destino de la venta. */
export const TEXTO_BOTON: Record<DestinoFactura, string> = {
  PROVEEDOR: '✅ Aprobar',
  SIN_FACTURA: '📝 Registrar sin factura',
  MANUAL: '📝 Registrar para facturar a mano',
};

/** Avisos que van en el resumen, antes del botón, cuando la venta no se emitirá desde el bot. */
export const AVISO_DESTINO = {
  SIN_FACTURA:
    '⚠️ Esta venta tiene NIT o cédula. Por ahora el bot solo factura a consumidor final: esta venta no se facturará desde aquí. Si el cliente necesita la factura, hazla a mano en Alegra.',
  MANUAL:
    '⚠️ La conexión con Alegra no está lista (el token falta, venció o no es válido). Si la registras, esta venta queda para facturar a mano en Alegra, y el bot no la emitirá después, aunque se arregle el token.',
} as const;

export interface RespuestaConversacion {
  texto: string;
  /**
   * El texto lleva el resumen de esta versión del borrador. Quien lo envía llama a
   * `marcarMostrada` solo cuando el canal confirma el envío, y le pone el botón "✅ Aprobar" si es
   * aprobable.
   */
  mostrar?: VistaBorrador & { aprobable: boolean };
}

/** Lo que una corrección cambiaba sin que el mensaje lo pidiera; por eso no se guardó. */
interface CambiosSinPedir {
  quitados: ItemsQuitados | null;
  /** Descripciones de ítems que la IA cambió por otros sin que el mensaje los nombrara. */
  reemplazados: string[];
  valores: ValorCambiado[];
  /** Identificación o total. */
  datos: DatoCambiado[];
}

/**
 * El borrador tras crear o corregir; con `descartada`, la corrección no se guardó. `vaciados`:
 * al crear, lo que la IA leyó sin que estuviera en el mensaje y quedó vacío.
 */
interface Escritura {
  fila: Borrador;
  descartada: CambiosSinPedir | null;
  vaciados: DatoVaciado[];
}

/** Qué decirle al usuario debajo del resumen. */
type AvisoResumen =
  'ninguno' | 'usarBoton' | 'noVigente' | 'quieto' | 'destinoCambio';

/** A dónde iría la venta si se aprobara ahora, con la cuenta del proveedor si es PROVEEDOR. */
type DestinoActual =
  | { destino: 'PROVEEDOR'; cuenta: string }
  | { destino: 'SIN_FACTURA' | 'MANUAL' };

/**
 * Lleva la conversación de cada chat: crea el borrador con el primer mensaje, lo corrige o
 * completa con los siguientes, y termina cuando se aprueba o se cancela.
 * No depende del canal: recibe un id de chat y un texto, devuelve el texto de respuesta.
 *
 * Cada escritura de `datos` sube `version`. Solo se aprueba con el botón, y solo la versión que el
 * usuario vio: la que el canal confirmó haber mostrado (`versionMostrada`) y la que lleva el botón
 * pulsado, del mismo borrador. Ver docs/planes/fase-4.3-cola.md §3 y §18, y 4.4 §3.
 */
@Injectable()
export class ConversacionService {
  private readonly logger = new Logger(ConversacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly interprete: InterpreteTextoService,
    @Inject(CONFIG_EMISION) private readonly emision: ConfigEmision,
  ) {}

  /**
   * Marca la versión como mostrada, solo si el borrador sigue en esa versión.
   * Si entretanto se guardó otra, no marca nada.
   */
  async marcarMostrada(borradorId: string, version: number): Promise<void> {
    await this.prisma.borrador.updateMany({
      where: { id: borradorId, version },
      data: { versionMostrada: version },
    });
  }

  /** @param porVoz el texto es la transcripción de una nota de voz. */
  async responder(
    chatId: number,
    texto: string,
    porVoz = false,
  ): Promise<RespuestaConversacion> {
    const pendiente = await this.buscarPendiente(chatId);

    if (CANCELAR.test(texto)) {
      if (!pendiente) return { texto: 'No hay ninguna factura en curso.' };
      await this.prisma.borrador.update({
        where: { id: pendiente.id },
        data: { estado: 'CANCELADO' },
      });
      return {
        texto: 'Borrador cancelado. Escribe una nueva factura cuando quieras.',
      };
    }

    if (APROBAR.test(texto)) {
      if (!pendiente) return { texto: 'No hay ninguna factura en curso.' };
      // Un "sí" (escrito o dictado) no aprueba: se reenvía el resumen vigente con su botón.
      return this.conResumen(pendiente, 'usarBoton');
    }

    if (esConsumidorFinal(texto)) {
      if (!pendiente) return { texto: 'No hay ninguna factura en curso.' };
      // Lo dice el usuario, no la IA: sin nombre ni identificación y sin la marca de vaciado. El
      // resumen nuevo se muestra antes de poder aprobar, así que no hace falta el aviso de quieto.
      const fila = await this.prisma.borrador.update({
        where: { id: pendiente.id },
        data: {
          datos: aJson(aConsumidorFinal(datosDe(pendiente))),
          version: { increment: 1 },
        },
      });
      return this.conResumen(fila, 'ninguno');
    }

    if (pendiente && quieto(pendiente)) {
      // Antes de reemplazar: si se leyera después y los datos viejos fueran inválidos, el error
      // diría "no lo toqué" con el viejo ya cancelado y el nuevo creado. Con datos inválidos el
      // aviso va sin nombre: el viejo se cancela igual, que es lo que se le pediría al usuario.
      let nombre: string | null = null;
      try {
        nombre = datosDe(pendiente).cliente.nombre;
      } catch (err) {
        if (!(err instanceof DatosBorradorInvalidosError)) throw err;
        this.logger.warn(
          'Borrador quieto con datos inválidos: se cancela al reemplazarlo',
        );
      }
      const { fila: nuevo, vaciados } = await this.reemplazar(
        pendiente,
        texto,
        porVoz,
      );
      const resumen = this.conResumen(nuevo, 'ninguno');
      return {
        ...resumen,
        texto: `📝 Tenías un borrador sin aprobar del ${fechaCorta(pendiente.actualizadoEn)}${nombre ? ` (${nombre})` : ''}. Lo dejé cancelado y empecé uno nuevo con tu mensaje.\n\n${conAvisoVaciados(vaciados, resumen.texto)}`,
      };
    }

    const { fila, descartada, vaciados } = pendiente
      ? await this.corregir(pendiente, texto, porVoz)
      : await this.crear(chatId, texto, porVoz);
    const resumen = this.conResumen(fila, 'ninguno');
    if (vaciados.length > 0)
      return { ...resumen, texto: conAvisoVaciados(vaciados, resumen.texto) };
    if (!descartada) return resumen;
    // La corrección no se guardó: el resumen es el mismo que el usuario ya tenía.
    return {
      ...resumen,
      texto: `${avisoDescartada(descartada)}\n\n${resumen.texto}`,
    };
  }

  /**
   * Aprueba con el botón "✅ Aprobar" pulsado: solo si es el borrador PENDIENTE del chat y
   * `version == versionMostrada ==` la versión del botón. Si no, reenvía el resumen vigente.
   * @param usuarioId id de Telegram de quien pulsó el botón: se guarda en `aprobadoPor`.
   */
  async aprobar(
    chatId: number,
    vista: VistaBorrador,
    usuarioId: number,
  ): Promise<RespuestaConversacion> {
    const pendiente = await this.buscarPendiente(chatId);
    if (!pendiente) {
      return {
        texto:
          'Ese resumen ya no está vigente: no hay ninguna factura en curso.',
      };
    }
    const v = pendiente.version;
    // Lo guardado es lo que se mostró, y lo mostrado es lo que llevaba el botón: el mismo
    // borrador y la misma versión (§3 y §18 de la 4.3).
    if (
      pendiente.id !== vista.borradorId ||
      pendiente.versionMostrada !== v ||
      vista.version !== v
    ) {
      return this.conResumen(pendiente, 'noVigente');
    }
    // Un botón de hace horas no aprueba directo: se reenvía el resumen para revisarlo. Al mostrarlo
    // se refresca actualizadoEn, así que el botón nuevo sí aprueba.
    if (quieto(pendiente)) return this.conResumen(pendiente, 'quieto');

    const actual = datosDe(pendiente);
    const motivo = motivoNoAprobable(actual);
    if (motivo) return { texto: `No puedo aprobarla todavía. ${motivo}` };

    // El destino se fija ahora y para siempre; tiene que ser el que el usuario vio con su aviso.
    const destino = this.destinoActual(actual);
    if (destino.destino !== vista.destino) {
      this.logger.warn(
        `Aprobación descartada: el destino cambió (${vista.destino} → ${destino.destino})`,
      );
      return this.conResumen(pendiente, 'destinoCambio');
    }

    // Bandeja de salida (§4): en una transacción, el borrador pasa a APROBADO con su destino y, solo
    // si va al proveedor, nace la emisión PENDIENTE. Si el borrador cambió entre la lectura y aquí,
    // no se aprueba ni se crea nada.
    const ahora = new Date();
    const aprobado = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.borrador.updateMany({
        where: {
          id: pendiente.id,
          estado: 'PENDIENTE',
          version: v,
          versionMostrada: v,
        },
        data: {
          estado: 'APROBADO',
          aprobadoPor: BigInt(usuarioId),
          aprobadoEn: ahora,
          destinoFactura: destino.destino,
        },
      });
      if (count !== 1) return false;
      if (destino.destino === 'PROVEEDOR') {
        await tx.emision.create({
          data: {
            borradorId: pendiente.id,
            proveedor: this.emision.proveedor.nombre,
            cuentaProveedor: destino.cuenta,
            modo: this.emision.modo,
            fechaFactura: fechaFacturaParaGuardar(ahora),
          },
        });
      }
      return true;
    });
    if (!aprobado) {
      this.logger.warn('Aprobación descartada: el borrador cambió al aprobar');
      const vigente = await this.buscarPendiente(pendiente.chatId);
      return vigente
        ? this.conResumen(vigente, 'noVigente')
        : { texto: 'No hay ninguna factura en curso.' };
    }
    return { texto: this.textoAprobado(actual, destino.destino) };
  }

  /** Lo que se le dice al usuario al aprobar, según el destino. */
  private textoAprobado(
    borrador: BorradorFactura,
    destino: DestinoFactura,
  ): string {
    const resumen = resumenBorrador(borrador, tituloAprobado(destino));
    switch (destino) {
      case 'PROVEEDOR':
        return this.emision.modo === 'TIMBRAR'
          ? `${resumen}\n\n🧾 Quedó en cola para emitirse en Alegra ante la DIAN.`
          : `${resumen}\n\n🧾 Quedó en cola para Alegra. Modo de prueba: solo se crea el borrador en Alegra, no se envía a la DIAN.`;
      case 'SIN_FACTURA':
        return `${resumen}\n\nNo se facturó desde el bot. Si el cliente necesita la factura, hazla a mano en Alegra.`;
      case 'MANUAL':
        return `${resumen}\n\nHazla a mano en Alegra. El bot no la emitirá, ni siquiera cuando se arregle el token.`;
    }
  }

  /**
   * A dónde iría la venta si se aprobara ahora (decisiones de Gabriel del 2026-11-12): con NIT o
   * cédula, sin factura; a consumidor final, al proveedor si el token es válido, y si no, a mano.
   */
  private destinoActual(borrador: BorradorFactura): DestinoActual {
    if (clienteDeVenta(borrador) === 'identificado')
      return { destino: 'SIN_FACTURA' };
    try {
      return { destino: 'PROVEEDOR', cuenta: this.emision.proveedor.cuenta() };
    } catch (err) {
      // Token que falta, venció o no trae cuenta: no se emite.
      if (err instanceof ErrorProveedor) return { destino: 'MANUAL' };
      throw err;
    }
  }

  /**
   * Qué decirle al usuario cuando un trabajo se cortó (p. ej. un reinicio): el estado real de su
   * borrador, porque la corrección o la aprobación pudieron guardarse antes del corte (4.4 §6).
   * null si no hay nada que mostrar: el aviso genérico ("reenvíalo") es entonces lo correcto.
   * @param desde cuándo se encoló el trabajo cortado.
   */
  async estadoTrasFallo(
    chatId: number,
    desde: Date,
  ): Promise<RespuestaConversacion | null> {
    const pendiente = await this.buscarPendiente(chatId);
    if (pendiente) {
      const resumen = this.conResumen(pendiente, 'ninguno');
      return {
        ...resumen,
        texto: `No alcancé a terminar tu último mensaje. Este es tu borrador ahora; si era una corrección y no se ve aquí, reenvíala.\n\n${resumen.texto}`,
      };
    }
    const ultimo = await this.prisma.borrador.findFirst({
      where: { chatId: BigInt(chatId) },
      orderBy: { actualizadoEn: 'desc' },
    });
    if (!ultimo) return null;
    // La hora exacta de la aprobación, si la hay: actualizadoEn cambia con cualquier escritura.
    const cambio = ultimo.aprobadoEn ?? ultimo.actualizadoEn;
    if (cambio < desde) return null;
    if (ultimo.estado === 'APROBADO') {
      const titulo = {
        PROVEEDOR: '✅ Tu factura quedó aprobada',
        SIN_FACTURA: '📝 Tu venta quedó registrada sin factura',
        MANUAL: '📝 Tu venta quedó registrada para facturar a mano',
      }[ultimo.destinoFactura ?? 'PROVEEDOR'];
      return { texto: resumenBorrador(datosDe(ultimo), titulo) };
    }
    if (ultimo.estado === 'CANCELADO') {
      return {
        texto:
          'Tu borrador quedó cancelado. Escribe una nueva factura cuando quieras.',
      };
    }
    return null;
  }

  /**
   * Resumen del borrador y qué hacer después; el botón va solo si es aprobable, y su texto depende
   * del destino. Los avisos de "no se facturará" y "facturar a mano" van antes del botón.
   */
  private conResumen(
    fila: Borrador,
    aviso: AvisoResumen,
  ): RespuestaConversacion {
    const borrador = datosDe(fila);
    const aprobable = motivoNoAprobable(borrador) === null;
    const { destino } = this.destinoActual(borrador);
    const boton = TEXTO_BOTON[destino];
    const partes = [resumenBorrador(borrador)];
    if (!aprobable) {
      partes.push(
        '✏️ Escribe los datos que faltan o una corrección, o "cancelar".',
      );
    } else {
      if (destino !== 'PROVEEDOR') partes.push(AVISO_DESTINO[destino]);
      if (aviso === 'usarBoton') {
        partes.push(`👉 Para seguir, toca ${boton} en este mensaje.`);
      } else if (destino === 'SIN_FACTURA') {
        partes.push(
          `👉 Toca ${boton}, escribe una corrección (o "consumidor final"), o "cancelar".`,
        );
      } else {
        partes.push(`👉 Toca ${boton}, escribe una corrección, o "cancelar".`);
      }
    }
    let encabezado = '';
    if (aviso === 'noVigente') {
      encabezado = 'Ese resumen ya no está vigente. Este es el actual:\n\n';
    } else if (aviso === 'quieto') {
      encabezado = `Este borrador es del ${fechaCorta(fila.actualizadoEn)}; revísalo y aprueba de nuevo.\n\n`;
    } else if (aviso === 'destinoCambio') {
      encabezado =
        'La conexión con Alegra cambió desde ese resumen, así que no lo aprobé. Este es el actual:\n\n';
    }
    return {
      texto: `${encabezado}${partes.join('\n\n')}`,
      mostrar: {
        borradorId: fila.id,
        version: fila.version,
        aprobable,
        destino,
      },
    };
  }

  /**
   * Si la IA hizo desaparecer ítems que el mensaje no nombró, o cambió valores que el mensaje no
   * dice, no guarda nada: se pregunta (CLAUDE.md: nunca se corrige en silencio).
   */
  private async corregir(
    pendiente: Borrador,
    texto: string,
    porVoz: boolean,
  ): Promise<Escritura> {
    const actual = datosDe(pendiente);
    const borrador = conMarcaDeVaciado(
      actual,
      sinNombreConsumidorFinal(
        conOrigenDeIdentificacion(
          actual,
          await this.interprete.interpretar(texto, actual),
          porVoz,
        ),
      ),
    );
    const quitados = itemsQuitadosSinPedir(actual, borrador, texto);
    const reemplazados = itemsReemplazadosSinPedir(actual, borrador, texto);
    const valores = valoresCambiadosSinPedir(actual, borrador, texto);
    const datos = datosCambiadosSinPedir(actual, borrador, texto);
    if (
      quitados ||
      reemplazados.length > 0 ||
      valores.length > 0 ||
      datos.length > 0
    ) {
      // Solo cantidades y nombres de campo: nunca descripciones, valores ni identificaciones en
      // los logs (Ley 1581 de 2012).
      this.logger.warn(
        `Corrección descartada: ${quitados?.cantidad ?? 0} ítems desaparecían, ${reemplazados.length} se reemplazaban, ${valores.length} valores cambiaban y cambiaban [${datos.map((d) => d.campo).join(', ')}], sin que el mensaje lo pidiera`,
      );
      return {
        fila: pendiente,
        descartada: { quitados, reemplazados, valores, datos },
        vaciados: [],
      };
    }
    const fila = await this.prisma.borrador.update({
      where: { id: pendiente.id },
      data: { datos: aJson(borrador), version: { increment: 1 } },
    });
    return { fila, descartada: null, vaciados: [] };
  }

  /**
   * Cancela un PENDIENTE quieto y crea uno nuevo con el mensaje, en una transacción: o pasan las
   * dos escrituras, o ninguna. Se interpreta antes: si la IA falla, el viejo sigue igual.
   */
  private async reemplazar(
    viejo: Borrador,
    texto: string,
    porVoz: boolean,
  ): Promise<{ fila: Borrador; vaciados: DatoVaciado[] }> {
    const { borrador, vaciados } = await this.interpretarNuevo(texto, porVoz);
    const fila = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.borrador.updateMany({
        where: { id: viejo.id, estado: 'PENDIENTE', version: viejo.version },
        data: { estado: 'CANCELADO' },
      });
      // Otro proceso lo aprobó, canceló o corrigió mientras la IA interpretaba: el aviso "Lo dejé
      // cancelado" sería falso.
      // Al lanzar se deshace la transacción y el usuario recibe el aviso de falla.
      if (count !== 1) {
        throw new Error('El borrador viejo cambió antes de cancelarlo');
      }
      return tx.borrador.create({
        data: { chatId: viejo.chatId, datos: aJson(borrador) },
      });
    });
    return { fila, vaciados };
  }

  /**
   * Interpreta el primer mensaje de un borrador y deja vacío lo que la IA leyó sin que estuviera
   * escrito (`sinDatosNoDichos`): nunca se guarda un dato inventado.
   */
  private async interpretarNuevo(
    texto: string,
    porVoz: boolean,
  ): Promise<{ borrador: BorradorFactura; vaciados: DatoVaciado[] }> {
    const { borrador, vaciados } = sinDatosNoDichos(
      await this.interprete.interpretar(texto, undefined),
      texto,
    );
    if (vaciados.length > 0) {
      // Solo la cantidad y los campos: nunca los valores (Ley 1581 de 2012).
      this.logger.warn(
        `Borrador nuevo: ${vaciados.length} datos que no estaban en el mensaje quedaron vacíos [${vaciados.map((v) => v.campo).join(', ')}]`,
      );
    }
    return {
      borrador: sinNombreConsumidorFinal(
        conOrigenDeIdentificacion(undefined, borrador, porVoz),
      ),
      vaciados,
    };
  }

  private async crear(
    chatId: number,
    texto: string,
    porVoz: boolean,
  ): Promise<Escritura> {
    const { borrador, vaciados } = await this.interpretarNuevo(texto, porVoz);
    try {
      const fila = await this.prisma.borrador.create({
        data: { chatId: BigInt(chatId), datos: aJson(borrador) },
      });
      return { fila, descartada: null, vaciados };
    } catch (err) {
      // El índice único parcial detectó un PENDIENTE que no vimos al leer (otra copia del bot
      // o un cambio manual en la base). Se mira solo el code: `meta.target` no viene relleno
      // con un índice parcial. Se reinterpreta el mensaje como corrección de ese borrador, en
      // lugar de sobrescribirlo, para no borrar lo que guardó el otro mensaje.
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
      const ganador = await this.buscarPendiente(chatId);
      if (!ganador) throw err;
      this.logger.warn(
        'P2002 al crear el borrador: se reinterpreta como corrección del PENDIENTE existente',
      );
      return this.corregir(ganador, texto, porVoz);
    }
  }

  private buscarPendiente(chatId: number | bigint): Promise<Borrador | null> {
    return this.prisma.borrador.findFirst({
      where: { chatId: BigInt(chatId), estado: 'PENDIENTE' },
    });
  }
}

/**
 * El resumen con el aviso de lo que se dejó vacío al crear el borrador, si hay algo. Se muestra el
 * dato leído para que el usuario lo escriba si era correcto.
 */
function conAvisoVaciados(vaciados: DatoVaciado[], resumen: string): string {
  if (vaciados.length === 0) return resumen;
  const cuales = vaciados.map((v) => {
    if (v.campo === 'item') return `${v.descripcion}: ${pesos(v.valor)}`;
    if (v.campo === 'total') return `total: ${pesos(v.valor)}`;
    return `${v.campo === 'nombre' ? 'cliente' : 'NIT o cédula'}: ${v.valor}`;
  });
  return `⚠️ Entendí datos que no están escritos en tu mensaje y los dejé vacíos (❓): ${cuales.join('; ')}. Si son correctos, escríbelos.\n\n${resumen}`;
}

/** Qué cambiaba la corrección sin pedirlo, y cómo pedirlo si era lo que se quería. */
function avisoDescartada({
  quitados,
  reemplazados,
  valores,
  datos,
}: CambiosSinPedir): string {
  const lineas: string[] = [];
  if (quitados) {
    const cuales = quitados.descripciones.length
      ? `: ${quitados.descripciones.join(', ')}`
      : '';
    lineas.push(
      `⚠️ Con tu corrección desaparecían ${quitados.cantidad} producto(s), y tu mensaje no pide quitarlos por su nombre${cuales}.`,
    );
  }
  if (reemplazados.length > 0) {
    lineas.push(
      `⚠️ Con tu corrección se cambiaba por otro producto: ${reemplazados.join(', ')}, y tu mensaje no lo nombra.`,
    );
  }
  for (const v of valores) {
    lineas.push(
      v.nuevo
        ? `⚠️ Con tu corrección aparecía ${v.descripcion} con ${pesos(v.despues)}, y ese valor no está en tu mensaje.`
        : `⚠️ Con tu corrección, ${v.descripcion} pasaba de ${pesos(v.antes)} a ${pesos(v.despues)}, y tu mensaje no dice ese valor para ese producto.`,
    );
  }
  for (const d of datos) {
    const pide = d.despues === null ? 'que lo quite' : null;
    if (d.campo === 'total') {
      lineas.push(
        `⚠️ Con tu corrección, el total pasaba de ${d.antes === null ? '(ninguno)' : pesos(d.antes)} a ${d.despues === null ? '(ninguno)' : pesos(d.despues)}, y tu mensaje no dice ${pide ?? 'ese valor después de "total"'}.`,
      );
    } else {
      const que = d.campo === 'nombre' ? 'el cliente' : 'el NIT o la cédula';
      lineas.push(
        `⚠️ Con tu corrección, ${que} pasaba de ${d.antes ?? '(ninguno)'} a ${d.despues ?? '(ninguno)'}, y tu mensaje no dice ${pide ?? (d.campo === 'nombre' ? 'ese nombre' : 'ese número')}.`,
      );
    }
  }
  lineas.push(
    'No cambié el borrador. Si eso era lo que querías, escríbelo con el nombre del producto (por ejemplo, "quita la brocha" o "la brocha a 15 mil"); si no, escribe la corrección de nuevo.',
  );
  return lineas.join('\n');
}

/** Título del resumen al aprobar, según el destino. */
function tituloAprobado(destino: DestinoFactura): string {
  switch (destino) {
    case 'PROVEEDOR':
      return '✅ Factura aprobada';
    case 'SIN_FACTURA':
      return '📝 Venta registrada sin factura';
    case 'MANUAL':
      return '📝 Venta registrada para facturar a mano';
  }
}

function quieto(fila: Borrador): boolean {
  return Date.now() - fila.actualizadoEn.getTime() > QUIETO_MS;
}

/** Los `datos` del borrador, validados con Zod (CLAUDE.md: validar el JSON leído de la BD). */
function datosDe(fila: Borrador): BorradorFactura {
  return leerBorradorFactura(fila.datos);
}

function aJson(borrador: BorradorFactura): Prisma.InputJsonValue {
  return borrador as unknown as Prisma.InputJsonValue;
}
