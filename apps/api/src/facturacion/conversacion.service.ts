import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { Borrador } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type BorradorFactura,
  motivoNoAprobable,
  resumenBorrador,
} from './factura.js';
import { InterpreteTextoService } from './interprete-texto.service.js';

const CANCELAR = /^\s*cancelar\s*$/i;
// Aprobar es la acción más delicada: se reconoce con código, nunca con la IA. Solo aprueba un
// mensaje que sea únicamente una de estas palabras ("sí, pero cambia el NIT" es una corrección).
const APROBAR =
  /^\s*(s[ií]|ok|dale|listo|apruebo|aprobado|aprobar|confirmo|confirmar)\s*[.!]*\s*$/i;

/** "sí" y sus variantes: el handler captura la versión que el usuario tenía en pantalla. */
export function esAprobacion(texto: string): boolean {
  return APROBAR.test(texto);
}

/** "sí" o "cancelar": no pasan por la IA, así que no hace falta avisar "Procesando…". */
export function esComando(texto: string): boolean {
  return CANCELAR.test(texto) || APROBAR.test(texto);
}

export interface RespuestaConversacion {
  texto: string;
  /**
   * El texto lleva el resumen de esta versión del borrador. Quien lo envía llama a
   * `marcarMostrada` solo cuando el canal confirma el envío.
   */
  mostrar?: { borradorId: string; version: number };
}

/**
 * Lleva la conversación de cada chat: crea el borrador con el primer mensaje, lo corrige o
 * completa con los siguientes, y termina cuando se aprueba o se cancela.
 * No depende del canal: recibe un id de chat y un texto, devuelve el texto de respuesta.
 *
 * Cada escritura de `datos` sube `version`. Un "sí" solo aprueba la versión que el usuario vio:
 * la que el canal confirmó haber mostrado (`versionMostrada`) y que el usuario tenía en pantalla
 * al escribir (`versionVista`). Ver docs/planes/fase-4.3-cola.md §3.
 */
@Injectable()
export class ConversacionService {
  private readonly logger = new Logger(ConversacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly interprete: InterpreteTextoService,
  ) {}

  /**
   * Versión del borrador PENDIENTE que el usuario tiene en pantalla, o null si no hay borrador
   * o nunca se mostró. Sale de `versionMostrada`, nunca de `version`: `version` puede ir por
   * delante con una corrección guardada que el usuario todavía no recibió.
   */
  async versionMostrada(chatId: number): Promise<number | null> {
    const pendiente = await this.buscarPendiente(chatId);
    return pendiente?.versionMostrada ?? null;
  }

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

  /**
   * @param versionVista versión que el usuario tenía en pantalla cuando escribió el mensaje
   *   (`versionMostrada` leída al recibirlo). Solo se usa para aprobar.
   */
  async responder(
    chatId: number,
    texto: string,
    versionVista: number | null,
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
      return this.aprobar(pendiente, versionVista);
    }

    const fila = pendiente
      ? await this.corregir(pendiente, texto)
      : await this.crear(chatId, texto);
    return this.conResumen(fila, false);
  }

  private async aprobar(
    pendiente: Borrador,
    versionVista: number | null,
  ): Promise<RespuestaConversacion> {
    const v = pendiente.version;
    // Las dos condiciones (§3): lo guardado es lo que se mostró, y lo mostrado es lo que el
    // usuario tenía en pantalla al escribir "sí".
    if (pendiente.versionMostrada !== v || versionVista !== v) {
      return this.conResumen(pendiente, true);
    }

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
      data: { estado: 'APROBADO' },
    });
    if (count !== 1) {
      this.logger.warn('Aprobación descartada: el borrador cambió al aprobar');
      const ahora = await this.buscarPendiente(pendiente.chatId);
      return ahora
        ? this.conResumen(ahora, true)
        : { texto: 'No hay ninguna factura en curso.' };
    }
    return {
      texto: `✅ Factura aprobada.\n\n${resumenBorrador(actual)}\n\n(Se emitirá en Alegra cuando conectemos esa fase.)`,
    };
  }

  /**
   * Resumen del borrador y qué hacer después.
   * @param reenvio el "sí" no coincidió con lo mostrado: se pide confirmar otra vez.
   */
  private conResumen(fila: Borrador, reenvio: boolean): RespuestaConversacion {
    const borrador = datosDe(fila);
    let siguiente =
      '👉 Responde "sí" para aprobar, escribe una corrección, o "cancelar".';
    if (motivoNoAprobable(borrador)) {
      siguiente =
        '✏️ Escribe los datos que faltan o una corrección, o "cancelar".';
    } else if (reenvio) {
      siguiente = '👀 Revisa este resumen y responde "sí" otra vez.';
    }
    return {
      texto: `${resumenBorrador(borrador)}\n\n${siguiente}`,
      mostrar: { borradorId: fila.id, version: fila.version },
    };
  }

  private async corregir(
    pendiente: Borrador,
    texto: string,
  ): Promise<Borrador> {
    const borrador = await this.interprete.interpretar(
      texto,
      datosDe(pendiente),
    );
    return this.prisma.borrador.update({
      where: { id: pendiente.id },
      data: { datos: aJson(borrador), version: { increment: 1 } },
    });
  }

  private async crear(chatId: number, texto: string): Promise<Borrador> {
    const borrador = await this.interprete.interpretar(texto, undefined);
    try {
      return await this.prisma.borrador.create({
        data: { chatId: BigInt(chatId), datos: aJson(borrador) },
      });
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
      return this.corregir(ganador, texto);
    }
  }

  private buscarPendiente(chatId: number | bigint): Promise<Borrador | null> {
    return this.prisma.borrador.findFirst({
      where: { chatId: BigInt(chatId), estado: 'PENDIENTE' },
    });
  }
}

function datosDe(fila: Borrador): BorradorFactura {
  return fila.datos as unknown as BorradorFactura;
}

function aJson(borrador: BorradorFactura): Prisma.InputJsonValue {
  return borrador as unknown as Prisma.InputJsonValue;
}
