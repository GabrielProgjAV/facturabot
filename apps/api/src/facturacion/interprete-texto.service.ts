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

/**
 * Por qué falló el intérprete, en una categoría fija y segura para los logs (Ley 1581 de 2012):
 * nunca el texto del mensaje, la respuesta de la IA ni datos del cliente.
 */
export type CategoriaInterprete =
  | `ollama_http_${number}`
  | 'ollama_timeout'
  | 'ollama_red'
  | 'ollama_respuesta_invalida'
  | 'ia_json_invalido'
  | 'ia_esquema_invalido';

/** Error del intérprete con su categoría. El error original, si lo hay, queda en `cause`. */
export class ErrorInterprete extends Error {
  override readonly name = 'ErrorInterprete';
  constructor(
    readonly categoria: CategoriaInterprete,
    opciones?: { cause?: unknown },
  ) {
    super(categoria, opciones);
  }
}

/**
 * Textos con los que la IA dice "no hay dato" en lugar de devolver null: se tratan como ausencia
 * de dato, antes de compararlos con el mensaje (si no, "null" parecería un NIT inventado).
 */
// Sin "na" ni "nil": pueden ser un nombre real (revisión de seguridad del PR #11).
const SIN_DATO = new Set(['', 'null', 'none', 'n/a', 'undefined']);

/** El texto de la IA, o null si está vacío o es una forma de decir "no hay dato". */
export function textoONull(texto: string | null): string | null {
  const limpio = texto?.trim() ?? '';
  return SIN_DATO.has(limpio.toLowerCase()) ? null : limpio;
}

/** Lo que importa de la respuesta de /api/chat de Ollama. */
const sobreOllamaSchema = z.object({
  message: z.object({ content: z.string() }),
});

// Todos los nombres, NIT y cédulas de los ejemplos de estas instrucciones son ficticios. El
// texto no se cambia sin pasar por el set de evaluación (CLAUDE.md).
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
  return {
    cliente: {
      nombre: textoONull(respuesta.cliente_nombre),
      identificacion: textoONull(respuesta.cliente_identificacion),
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
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.url}/api/chat`, {
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
        // Un trabajo real llegó a 116 s (corrección de 9 productos con recarga de qwen): 240 s deja
        // margen (4.4 §14.2, opción A).
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err) {
      // El original va en `cause`: el procesador reintenta si ahí dice ECONNREFUSED.
      throw new ErrorInterprete(
        err instanceof Error && err.name === 'TimeoutError'
          ? 'ollama_timeout'
          : 'ollama_red',
        { cause: err },
      );
    }
    if (!respuesta.ok) {
      throw new ErrorInterprete(`ollama_http_${respuesta.status}`);
    }
    // Respuesta externa: se valida también el sobre, no solo el contenido (CLAUDE.md).
    const cuerpo = sobreOllamaSchema.safeParse(
      await respuesta.json().catch(() => null),
    );
    if (!cuerpo.success) throw new ErrorInterprete('ollama_respuesta_invalida');
    let contenido: unknown;
    try {
      contenido = JSON.parse(cuerpo.data.message.content);
    } catch {
      throw new ErrorInterprete('ia_json_invalido');
    }
    const datos = respuestaIaSchema.safeParse(contenido);
    if (!datos.success) throw new ErrorInterprete('ia_esquema_invalido');
    const borrador = aBorrador(datos.data);
    borrador.totalEscrito = totalSegunMensaje(
      texto,
      borrador.totalEscrito,
      actual?.totalEscrito ?? null,
    );
    return borrador;
  }
}
