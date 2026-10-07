import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Env } from '../config/env.schema.js';
import { type BorradorFactura, parsePesos } from './factura.js';

/**
 * Forma exacta que debe devolver la IA. Los valores van como texto ("78.000") para que los
 * convierta parsePesos: la IA no debe decidir si el punto es de miles o decimal.
 */
export const respuestaIaSchema = z.object({
  cliente_nombre: z.string().nullable(),
  cliente_identificacion: z.string().nullable(),
  items: z.array(
    z.object({ descripcion: z.string(), valor: z.string().nullable() }),
  ),
  total: z.string().nullable(),
});

export type RespuestaIa = z.infer<typeof respuestaIaSchema>;

const INSTRUCCIONES = `Eres el asistente de facturación de un comercio en Colombia.
Del mensaje del usuario extrae los datos de una factura de venta.
- cliente_nombre: nombre de la persona o empresa que compra.
- cliente_identificacion: NIT o cédula, tal como está escrito.
- items: cada producto con su descripción (incluye cantidad o presentación, p. ej. "1 galón vinilo blanco") y su valor tal como está escrito (p. ej. "78.000" o "78 mil").
- total: solo si el usuario escribe un total explícito; si no, null.
Usa null para lo que no aparezca. No inventes datos ni hagas cálculos.
El nombre del cliente nunca incluye palabras como NIT, CC, cédula ni números.

Ejemplos:
Mensaje: factura a Marta NIT 456 por estuco 40 mil y brocha 12 mil, total 52 mil
{"cliente_nombre":"Marta","cliente_identificacion":"456","items":[{"descripcion":"estuco","valor":"40 mil"},{"descripcion":"brocha","valor":"12 mil"}],"total":"52 mil"}
Mensaje: factura para Pinturas Sol SAS NIT 900555444, 2 galones de vinilo 80.000
{"cliente_nombre":"Pinturas Sol SAS","cliente_identificacion":"900555444","items":[{"descripcion":"2 galones de vinilo","valor":"80.000"}],"total":null}
Mensaje: cliente Rosa cc 52111222, un cuarto de esmalte 25 mil
{"cliente_nombre":"Rosa","cliente_identificacion":"52111222","items":[{"descripcion":"1/4 de esmalte","valor":"25 mil"}],"total":null}`;

const INSTRUCCIONES_CORRECCION = `Si recibes un "Borrador actual", el mensaje del usuario lo completa o lo corrige.
Devuelve el borrador COMPLETO actualizado: aplica solo lo que el mensaje cambia, agrega o quita, y conserva todo lo demás igual.
Ejemplo:
Borrador actual: {"cliente_nombre":"Marta","cliente_identificacion":null,"items":[{"descripcion":"estuco","valor":"40000"}],"total":null}
Mensaje: el nit es 456 y agrega una brocha de 12 mil
{"cliente_nombre":"Marta","cliente_identificacion":"456","items":[{"descripcion":"estuco","valor":"40000"},{"descripcion":"brocha","valor":"12 mil"}],"total":null}`;

/**
 * La IA a veces "calcula" un total que nadie escribió. Solo se acepta el total de la IA si el
 * mensaje menciona la palabra "total"; si no, se conserva el anterior (o null: se suman los ítems).
 */
export function totalSegunMensaje(
  texto: string,
  totalIa: number | null,
  totalAnterior: number | null,
): number | null {
  return /\btotal\b/i.test(texto) ? totalIa : totalAnterior;
}

/** Formato de la IA a partir de un borrador, para dárselo como contexto al corregir. */
export function aRespuestaIa(borrador: BorradorFactura): RespuestaIa {
  const texto = (valor: number | null) =>
    valor === null ? null : String(valor);
  return {
    cliente_nombre: borrador.cliente.nombre,
    cliente_identificacion: borrador.cliente.identificacion,
    items: borrador.items.map((item) => ({
      descripcion: item.descripcion,
      valor: texto(item.valor),
    })),
    total: texto(borrador.totalEscrito),
  };
}

/** Convierte la respuesta de la IA en un borrador, normalizando los pesos. */
export function aBorrador(respuesta: RespuestaIa): BorradorFactura {
  const vacioANull = (texto: string | null) => texto?.trim() || null;
  return {
    cliente: {
      nombre: vacioANull(respuesta.cliente_nombre),
      identificacion: vacioANull(respuesta.cliente_identificacion),
    },
    items: respuesta.items.map((item) => ({
      descripcion: item.descripcion.trim(),
      valor: parsePesos(item.valor),
    })),
    totalEscrito: parsePesos(respuesta.total),
  };
}

/** Entiende un mensaje de texto libre usando un modelo local de Ollama. */
@Injectable()
export class InterpreteTextoService {
  private readonly url: string;
  private readonly modelo: string;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('OLLAMA_URL', { infer: true });
    this.modelo = config.get('OLLAMA_MODELO_TEXTO', { infer: true });
  }

  /** Entiende el mensaje. Con `actual`, devuelve ese borrador corregido o completado. */
  async interpretar(
    texto: string,
    actual?: BorradorFactura,
  ): Promise<BorradorFactura> {
    const sistema = actual
      ? `${INSTRUCCIONES}\n\n${INSTRUCCIONES_CORRECCION}`
      : INSTRUCCIONES;
    const usuario = actual
      ? `Borrador actual: ${JSON.stringify(aRespuestaIa(actual))}\nMensaje: ${texto}`
      : texto;
    const respuesta = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelo,
        stream: false,
        format: z.toJSONSchema(respuestaIaSchema),
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: sistema },
          { role: 'user', content: usuario },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!respuesta.ok) {
      throw new Error(`Ollama respondió ${respuesta.status}`);
    }
    const cuerpo = (await respuesta.json()) as { message: { content: string } };
    const datos = respuestaIaSchema.parse(JSON.parse(cuerpo.message.content));
    const borrador = aBorrador(datos);
    borrador.totalEscrito = totalSegunMensaje(
      texto,
      borrador.totalEscrito,
      actual?.totalEscrito ?? null,
    );
    return borrador;
  }
}
