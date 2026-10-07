import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

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

    const respuesta = await fetch(
      `${this.url}/asr?task=transcribe&language=es&output=json&encode=true`,
      {
        method: 'POST',
        body: formulario,
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!respuesta.ok) {
      throw new Error(`Whisper respondió ${respuesta.status}`);
    }
    const { text } = (await respuesta.json()) as { text: string };
    return text.trim();
  }
}
