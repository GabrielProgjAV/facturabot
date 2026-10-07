import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
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

/**
 * Lleva la conversación de cada chat: crea el borrador con el primer mensaje, lo corrige o
 * completa con los siguientes, y termina cuando se aprueba o se cancela.
 * No depende del canal: recibe un id de chat y un texto, devuelve el texto de respuesta.
 */
@Injectable()
export class ConversacionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly interprete: InterpreteTextoService,
  ) {}

  async responder(chatId: number, texto: string): Promise<string> {
    const pendiente = await this.prisma.borrador.findFirst({
      where: { chatId: BigInt(chatId), estado: 'PENDIENTE' },
    });
    const actual = pendiente?.datos as unknown as BorradorFactura | undefined;

    if (CANCELAR.test(texto) || APROBAR.test(texto)) {
      if (!pendiente || !actual) return 'No hay ninguna factura en curso.';

      if (CANCELAR.test(texto)) {
        await this.prisma.borrador.update({
          where: { id: pendiente.id },
          data: { estado: 'CANCELADO' },
        });
        return 'Borrador cancelado. Escribe una nueva factura cuando quieras.';
      }

      const motivo = motivoNoAprobable(actual);
      if (motivo) return `No puedo aprobarla todavía. ${motivo}`;
      await this.prisma.borrador.update({
        where: { id: pendiente.id },
        data: { estado: 'APROBADO' },
      });
      return `✅ Factura aprobada.\n\n${resumenBorrador(actual)}\n\n(Se emitirá en Alegra cuando conectemos esa fase.)`;
    }

    const borrador = await this.interprete.interpretar(texto, actual);
    const datos = borrador as unknown as Prisma.InputJsonValue;

    if (pendiente) {
      await this.prisma.borrador.update({
        where: { id: pendiente.id },
        data: { datos },
      });
    } else {
      await this.prisma.borrador.create({
        data: { chatId: BigInt(chatId), datos },
      });
    }

    const siguiente = motivoNoAprobable(borrador)
      ? '✏️ Escribe los datos que faltan o una corrección, o "cancelar".'
      : '👉 Responde "sí" para aprobar, escribe una corrección, o "cancelar".';
    return `${resumenBorrador(borrador)}\n\n${siguiente}`;
  }
}
