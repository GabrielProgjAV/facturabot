import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

/**
 * Contexto que Whisper usa como pista del vocabulario esperado. Mejora palabras del negocio
 * ("laca negra" en vez de "la canegra", "80 mil"); no corrige dígitos perdidos en números largos.
 */
const CONTEXTO_NEGOCIO =
  'Factura electrónica en Colombia. Cliente con NIT o cédula. Productos de pinturas: galón, ' +
  'cuarto, octavo, vinilo, laca, esmalte, brocha, rodillo, estuco, thinner. Ferretería, ' +
  'Construcciones. Valores en pesos: 80 mil, $25.000.';

/** Convierte audio en texto con el servicio Whisper (docker-compose). No depende del canal. */
@Injectable()
export class TranscriptorService {
  private readonly url: string;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('WHISPER_URL', { infer: true });
  }

  async transcribir(
    audio: Uint8Array<ArrayBuffer>,
    nombreArchivo: string,
  ): Promise<string> {
    const formulario = new FormData();
    formulario.append('audio_file', new Blob([audio]), nombreArchivo);

    const parametros = new URLSearchParams({
      task: 'transcribe',
      language: 'es',
      output: 'json',
      encode: 'true',
      vad_filter: 'true', // ignora silencios y ruido
      initial_prompt: CONTEXTO_NEGOCIO,
    });
    const respuesta = await fetch(`${this.url}/asr?${parametros}`, {
      method: 'POST',
      body: formulario,
      signal: AbortSignal.timeout(120_000),
    });
    if (!respuesta.ok) {
      throw new Error(`Whisper respondió ${respuesta.status}`);
    }
    const { text } = (await respuesta.json()) as { text: string };
    return text.trim();
  }
}
