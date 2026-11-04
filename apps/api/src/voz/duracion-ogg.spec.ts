import { duracionOggOpusSegundos } from './duracion-ogg.js';
import {
  AUDIO_FALSO,
  notaOggSintetica,
  opusHead,
  paginaOgg,
  unirBytes,
} from './ogg-sintetico.spec-util.js';

describe('duracionOggOpusSegundos', () => {
  it.each([10, 87, 120, 121, 600])('nota de %i s', (segundos) => {
    expect(duracionOggOpusSegundos(notaOggSintetica(segundos))).toBe(segundos);
  });

  it('descuenta el pre-skip', () => {
    const nota = unirBytes(
      paginaOgg(0n, opusHead(48_000)),
      paginaOgg(96_000n, AUDIO_FALSO),
    );

    expect(duracionOggOpusSegundos(nota)).toBe(1);
  });

  it('salta las páginas finales con granule −1 (no terminan ningún paquete)', () => {
    const nota = unirBytes(
      notaOggSintetica(30),
      paginaOgg(0xffff_ffff_ffff_ffffn, AUDIO_FALSO),
    );

    expect(duracionOggOpusSegundos(nota)).toBe(30);
  });

  it('funciona con un Uint8Array que es una vista dentro de un buffer más grande', () => {
    const nota = notaOggSintetica(45);
    const grande = new Uint8Array(nota.byteLength + 10);
    grande.set(nota, 5);

    expect(
      duracionOggOpusSegundos(grande.subarray(5, 5 + nota.byteLength)),
    ).toBe(45);
  });

  it.each([
    ['vacío', new Uint8Array(0)],
    ['muy corto', new Uint8Array(10)],
    ['no es Ogg', new Uint8Array(100).fill(1)],
    [
      'Ogg sin OpusHead (p. ej. Vorbis)',
      unirBytes(
        paginaOgg(0n, new Uint8Array(30)),
        paginaOgg(48_000n, AUDIO_FALSO),
      ),
    ],
    [
      'OpusHead cortado',
      paginaOgg(
        0n,
        new Uint8Array('OpusHead'.split('').map((c) => c.charCodeAt(0))),
      ),
    ],
  ])('%s → null', (_caso, audio) => {
    expect(duracionOggOpusSegundos(audio)).toBeNull();
  });
});
