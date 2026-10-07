/** Mensaje recibido por cualquier canal (Telegram hoy, WhatsApp después). */
export type MensajeEntrante =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'imagen' }
  | { tipo: 'audio' }
  | { tipo: 'otro' };

/** Bot eco (fase 2): devuelve lo recibido. No depende de ningún canal. */
export function responderEco(mensaje: MensajeEntrante): string {
  switch (mensaje.tipo) {
    case 'texto':
      return mensaje.texto;
    case 'imagen':
      return 'Recibí una foto 📷';
    case 'audio':
      return 'Recibí una nota de voz 🎤';
    case 'otro':
      return 'Por ahora solo entiendo texto, fotos y notas de voz.';
  }
}
