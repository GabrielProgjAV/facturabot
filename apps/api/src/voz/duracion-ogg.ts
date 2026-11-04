/**
 * Duración real de una nota de voz Ogg Opus (las de Telegram), sin decodificar el audio.
 * La duración que manda el cliente de Telegram la declara el propio cliente y puede mentir
 * (docs/planes/fase-4.4-voz-borradores.md §4).
 *
 * Formato (RFC 3533 y RFC 7845):
 * - Cada página empieza con "OggS"; en los bytes 6 a 13 lleva la *granule position* (entero de 64
 *   bits, little-endian). En Opus cuenta muestras a 48 kHz, sea cual sea la frecuencia original.
 * - El primer paquete es "OpusHead"; sus bytes 10 y 11 son el *pre-skip*, las muestras iniciales
 *   que no se reproducen.
 * - Duración = (granule de la última página − pre-skip) / 48.000.
 *
 * Límite conocido: un archivo fabricado a propósito podría declarar una granule menor que su audio
 * real. Por eso el tamaño también está acotado (1 MB).
 */

const MUESTRAS_POR_SEGUNDO = 48_000;
const CABECERA_PAGINA = 27;
/** Granule -1: la página no termina ningún paquete; no sirve para medir. */
const SIN_GRANULE = 0xffff_ffff_ffff_ffffn;

/** Segundos de audio, o null si el archivo no es un Ogg Opus que se pueda leer. */
export function duracionOggOpusSegundos(audio: Uint8Array): number | null {
  if (audio.byteLength < CABECERA_PAGINA || !esCapturaOgg(audio, 0))
    return null;
  const vista = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);

  // Primer paquete: OpusHead, justo después de la tabla de segmentos de la primera página.
  const segmentos = audio[26];
  const inicioPaquete = CABECERA_PAGINA + segmentos;
  if (
    inicioPaquete + 19 > audio.byteLength ||
    textoEn(audio, inicioPaquete, 8) !== 'OpusHead'
  ) {
    return null;
  }
  const preSkip = vista.getUint16(inicioPaquete + 10, true);

  // Se busca desde el final la última página con una granule válida.
  for (let i = audio.byteLength - CABECERA_PAGINA; i > 0; i--) {
    if (!esCapturaOgg(audio, i)) continue;
    const granule = vista.getBigUint64(i + 6, true);
    if (granule === SIN_GRANULE) continue;
    const muestras = Number(granule) - preSkip;
    return Math.max(0, muestras) / MUESTRAS_POR_SEGUNDO;
  }
  return null;
}

/** "OggS" con la versión 0 del formato en esa posición. */
function esCapturaOgg(audio: Uint8Array, i: number): boolean {
  return (
    audio[i] === 0x4f && // O
    audio[i + 1] === 0x67 && // g
    audio[i + 2] === 0x67 && // g
    audio[i + 3] === 0x53 && // S
    audio[i + 4] === 0
  );
}

function textoEn(audio: Uint8Array, inicio: number, largo: number): string {
  return String.fromCharCode(...audio.subarray(inicio, inicio + largo));
}
