import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { Borrador } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type BorradorFactura,
  conOrigenDeIdentificacion,
  type ItemsQuitados,
  itemsQuitadosSinPedir,
  motivoNoAprobable,
  pesos,
  resumenBorrador,
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

/** "sí" o "cancelar": no pasan por la IA, así que no hace falta avisar "Procesando…". */
export function esComando(texto: string): boolean {
  return CANCELAR.test(texto) || APROBAR.test(texto);
}

/**
 * Qué borrador y en qué versión: lo que lleva el botón "✅ Aprobar" del resumen que el usuario tiene
 * en pantalla. Con solo la versión, se podría aprobar otro borrador en la misma versión.
 */
export interface VistaBorrador {
  borradorId: string;
  version: number;
}

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
  valores: ValorCambiado[];
}

/** El borrador tras crear o corregir; con `descartada`, la corrección no se guardó. */
interface Escritura {
  fila: Borrador;
  descartada: CambiosSinPedir | null;
}

/** Qué decirle al usuario debajo del resumen. */
type AvisoResumen = 'ninguno' | 'usarBoton' | 'noVigente' | 'quieto';

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

    if (pendiente && quieto(pendiente)) {
      const nuevo = await this.reemplazar(pendiente, texto, porVoz);
      const resumen = this.conResumen(nuevo, 'ninguno');
      const { nombre } = datosDe(pendiente).cliente;
      return {
        ...resumen,
        texto: `📝 Tenías un borrador sin aprobar del ${fechaCorta(pendiente.actualizadoEn)}${nombre ? ` (${nombre})` : ''}. Lo dejé cancelado y empecé uno nuevo con tu mensaje.\n\n${resumen.texto}`,
      };
    }

    const { fila, descartada } = pendiente
      ? await this.corregir(pendiente, texto, porVoz)
      : await this.crear(chatId, texto, porVoz);
    const resumen = this.conResumen(fila, 'ninguno');
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

    // Una sola escritura atómica: si el borrador cambió entre la lectura y aquí, no aprueba.
    const { count } = await this.prisma.borrador.updateMany({
      where: {
        id: pendiente.id,
        estado: 'PENDIENTE',
        version: v,
        versionMostrada: v,
      },
      data: {
        estado: 'APROBADO',
        aprobadoPor: BigInt(usuarioId),
        aprobadoEn: new Date(),
      },
    });
    if (count !== 1) {
      this.logger.warn('Aprobación descartada: el borrador cambió al aprobar');
      const ahora = await this.buscarPendiente(pendiente.chatId);
      return ahora
        ? this.conResumen(ahora, 'noVigente')
        : { texto: 'No hay ninguna factura en curso.' };
    }
    return {
      texto: `${resumenBorrador(actual, '✅ Factura aprobada')}\n\n(Se emitirá en Alegra cuando conectemos esa fase.)`,
    };
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
      return {
        texto: resumenBorrador(datosDe(ultimo), '✅ Tu factura quedó aprobada'),
      };
    }
    if (ultimo.estado === 'CANCELADO') {
      return {
        texto:
          'Tu borrador quedó cancelado. Escribe una nueva factura cuando quieras.',
      };
    }
    return null;
  }

  /** Resumen del borrador y qué hacer después; el botón va solo si es aprobable. */
  private conResumen(
    fila: Borrador,
    aviso: AvisoResumen,
  ): RespuestaConversacion {
    const borrador = datosDe(fila);
    const aprobable = motivoNoAprobable(borrador) === null;
    let siguiente = '👉 Toca ✅ Aprobar, escribe una corrección, o "cancelar".';
    if (!aprobable) {
      siguiente =
        '✏️ Escribe los datos que faltan o una corrección, o "cancelar".';
    } else if (aviso === 'usarBoton') {
      siguiente = '👉 Para aprobar, toca ✅ Aprobar en este mensaje.';
    }
    let encabezado = '';
    if (aviso === 'noVigente') {
      encabezado = 'Ese resumen ya no está vigente. Este es el actual:\n\n';
    } else if (aviso === 'quieto') {
      encabezado = `Este borrador es del ${fechaCorta(fila.actualizadoEn)}; revísalo y aprueba de nuevo.\n\n`;
    }
    return {
      texto: `${encabezado}${resumenBorrador(borrador)}\n\n${siguiente}`,
      mostrar: { borradorId: fila.id, version: fila.version, aprobable },
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
    const borrador = conOrigenDeIdentificacion(
      actual,
      await this.interprete.interpretar(texto, actual),
      porVoz,
    );
    const quitados = itemsQuitadosSinPedir(actual, borrador, texto);
    const valores = valoresCambiadosSinPedir(actual, borrador, texto);
    if (quitados || valores.length > 0) {
      // Solo cantidades: nunca descripciones ni valores en los logs (Ley 1581 de 2012).
      this.logger.warn(
        `Corrección descartada: ${quitados?.cantidad ?? 0} ítems desaparecían y ${valores.length} valores cambiaban sin que el mensaje lo pidiera`,
      );
      return { fila: pendiente, descartada: { quitados, valores } };
    }
    const fila = await this.prisma.borrador.update({
      where: { id: pendiente.id },
      data: { datos: aJson(borrador), version: { increment: 1 } },
    });
    return { fila, descartada: null };
  }

  /**
   * Cancela un PENDIENTE quieto y crea uno nuevo con el mensaje, en una transacción: o pasan las
   * dos escrituras, o ninguna. Se interpreta antes: si la IA falla, el viejo sigue igual.
   */
  private async reemplazar(
    viejo: Borrador,
    texto: string,
    porVoz: boolean,
  ): Promise<Borrador> {
    const borrador = conOrigenDeIdentificacion(
      undefined,
      await this.interprete.interpretar(texto, undefined),
      porVoz,
    );
    return this.prisma.$transaction(async (tx) => {
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
  }

  private async crear(
    chatId: number,
    texto: string,
    porVoz: boolean,
  ): Promise<Escritura> {
    const borrador = conOrigenDeIdentificacion(
      undefined,
      await this.interprete.interpretar(texto, undefined),
      porVoz,
    );
    try {
      const fila = await this.prisma.borrador.create({
        data: { chatId: BigInt(chatId), datos: aJson(borrador) },
      });
      return { fila, descartada: null };
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

/** Qué cambiaba la corrección sin pedirlo, y cómo pedirlo si era lo que se quería. */
function avisoDescartada({ quitados, valores }: CambiosSinPedir): string {
  const lineas: string[] = [];
  if (quitados) {
    const cuales = quitados.descripciones.length
      ? `: ${quitados.descripciones.join(', ')}`
      : '';
    lineas.push(
      `⚠️ Con tu corrección desaparecían ${quitados.cantidad} producto(s), y tu mensaje no pide quitarlos por su nombre${cuales}.`,
    );
  }
  for (const v of valores) {
    lineas.push(
      `⚠️ Con tu corrección, ${v.descripcion} pasaba de ${pesos(v.antes)} a ${pesos(v.despues)}, y ese valor no está en tu mensaje.`,
    );
  }
  lineas.push(
    'No cambié el borrador. Si eso era lo que querías, escríbelo con el nombre del producto (por ejemplo, "quita la brocha" o "la brocha a 15 mil"); si no, escribe la corrección de nuevo.',
  );
  return lineas.join('\n');
}

function quieto(fila: Borrador): boolean {
  return Date.now() - fila.actualizadoEn.getTime() > QUIETO_MS;
}

function datosDe(fila: Borrador): BorradorFactura {
  return fila.datos as unknown as BorradorFactura;
}

function aJson(borrador: BorradorFactura): Prisma.InputJsonValue {
  return borrador as unknown as Prisma.InputJsonValue;
}
