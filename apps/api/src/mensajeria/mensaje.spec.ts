import { responderEco } from './mensaje.js';

describe('responderEco', () => {
  it('repite el texto recibido', () => {
    expect(responderEco({ tipo: 'texto', texto: 'hola' })).toBe('hola');
  });

  it('confirma una foto', () => {
    expect(responderEco({ tipo: 'imagen' })).toMatch(/foto/);
  });

  it('confirma una nota de voz', () => {
    expect(responderEco({ tipo: 'audio' })).toMatch(/nota de voz/);
  });

  it('avisa si no entiende el tipo de mensaje', () => {
    expect(responderEco({ tipo: 'otro' })).toMatch(/solo entiendo/);
  });
});
