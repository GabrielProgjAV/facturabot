// Archivos Ogg Opus sintéticos para los tests: solo cabeceras con los campos que se leen, sin audio
// real (el repo es público y nunca lleva audios). No se usa en producción.

export const PRE_SKIP_PRUEBA = 312;
const audioFalso = new Uint8Array(50).fill(7);

/** Una página Ogg con su granule y su contenido (un solo segmento). */
export function paginaOgg(granule: bigint, contenido: Uint8Array): Uint8Array {
  const cabecera = new Uint8Array(27 + 1);
  const vista = new DataView(cabecera.buffer);
  cabecera.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  cabecera[4] = 0; // versión
  vista.setBigUint64(6, granule, true);
  cabecera[26] = 1; // un segmento
  cabecera[27] = contenido.byteLength;
  return unirBytes(cabecera, contenido);
}

export function opusHead(preSkip: number): Uint8Array {
  const paquete = new Uint8Array(19);
  paquete.set(
    'OpusHead'.split('').map((c) => c.charCodeAt(0)),
    0,
  );
  paquete[8] = 1; // versión
  paquete[9] = 1; // canales
  new DataView(paquete.buffer).setUint16(10, preSkip, true);
  return paquete;
}

export function unirBytes(...partes: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = partes.reduce((n, p) => n + p.byteLength, 0);
  const salida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) {
    salida.set(p, i);
    i += p.byteLength;
  }
  return salida;
}

/** Nota de voz Ogg Opus sintética de la duración indicada. */
export function notaOggSintetica(segundos: number): Uint8Array<ArrayBuffer> {
  return unirBytes(
    paginaOgg(0n, opusHead(PRE_SKIP_PRUEBA)),
    paginaOgg(0n, new Uint8Array(20)), // OpusTags
    paginaOgg(BigInt(48_000 * (segundos / 2) + PRE_SKIP_PRUEBA), audioFalso),
    paginaOgg(BigInt(48_000 * segundos + PRE_SKIP_PRUEBA), audioFalso),
  );
}

export const AUDIO_FALSO = audioFalso;
