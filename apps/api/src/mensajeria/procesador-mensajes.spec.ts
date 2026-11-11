import {
  AVISO_DEMORA,
  AVISO_DEMORA_MS,
  avisarTrabajoFallido,
  describirError,
  type DependenciasProcesador,
  ESPERA_REINTENTO_MS,
  MENSAJES_FALLA,
  procesarMensaje,
  VozDemasiadoPesadaError,
} from './procesador-mensajes.js';
import { DatosBorradorInvalidosError } from '../facturacion/factura.js';
import { ErrorInterprete } from '../facturacion/interprete-texto.service.js';
import { notaOggSintetica } from '../voz/ogg-sintetico.spec-util.js';

/** Nota de voz sintética de 10 s (sin audio real). */
const NOTA = notaOggSintetica(10);

const CHAT = 4242; // chat ficticio
const TEXTO = 'factura a Ana, vinilo 50 mil';

/** Como lo lanza fetch cuando el servicio no está escuchando. */
function conexionRechazada(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new AggregateError([], 'connect'), {
      code: 'ECONNREFUSED',
    }),
  });
}

/** Como lo lanza fetch con AbortSignal.timeout. */
function timeout(): Error {
  return new DOMException(
    'The operation was aborted due to timeout',
    'TimeoutError',
  );
}

function crearDeps() {
  const logs: string[] = [];
  const registrar = (mensaje: unknown) => {
    logs.push(String(mensaje));
  };
  const deps = {
    responder: vi.fn().mockResolvedValue({
      texto: 'Resumen',
      mostrar: { borradorId: 'b1', version: 2, aprobable: true },
    }),
    aprobar: vi.fn().mockResolvedValue({ texto: '✅ Factura aprobada.' }),
    quitarBoton: vi.fn().mockResolvedValue(undefined),
    marcarMostrada: vi.fn().mockResolvedValue(undefined),
    estadoTrasFallo: vi.fn().mockResolvedValue(null),
    descargarVoz: vi.fn().mockResolvedValue(NOTA),
    transcribir: vi.fn().mockResolvedValue('vinilo 50 mil'),
    enviar: vi.fn().mockResolvedValue(undefined),
    esperar: vi.fn().mockResolvedValue(undefined),
    logger: {
      log: vi.fn(registrar),
      warn: vi.fn(registrar),
      error: vi.fn(registrar),
    },
  } satisfies DependenciasProcesador;
  return { deps, logs };
}

/** Borrador y versión del botón pulsado (uuid ficticio). */
const VISTA = {
  borradorId: '01900000-0000-7000-8000-000000000001',
  version: 1,
};
const texto = () => ({ tipo: 'texto', chatId: CHAT, texto: TEXTO });
const USUARIO = 4243; // usuario ficticio que pulsa el botón
const aprobar = {
  tipo: 'aprobar',
  chatId: CHAT,
  ...VISTA,
  messageId: 77,
  usuarioId: USUARIO,
};

/** El mensaje que se envió al chat, sin mirar el botón. */
function expectEnviado(
  deps: ReturnType<typeof crearDeps>['deps'],
  esperado: string,
) {
  expect(
    deps.enviar.mock.calls.map((c: unknown[]) => [c[0], c[1]]),
  ).toContainEqual([CHAT, esperado]);
}
const voz = { tipo: 'voz', chatId: CHAT, fileId: 'archivo-1' };

describe('procesarMensaje: botón "✅ Aprobar"', () => {
  it('un resumen aprobable se envía con el botón de su borrador y versión', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.enviar).toHaveBeenCalledWith(CHAT, 'Resumen', {
      borradorId: 'b1',
      version: 2,
    });
  });

  it('un resumen no aprobable se envía sin botón, pero se marca como mostrado', async () => {
    const { deps } = crearDeps();
    deps.responder.mockResolvedValueOnce({
      texto: 'Falta el NIT',
      mostrar: { borradorId: 'b1', version: 2, aprobable: false },
    });

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.enviar).toHaveBeenCalledWith(CHAT, 'Falta el NIT', null);
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
  });

  it('trabajo "aprobar": aprueba con el borrador y la versión del botón y le quita el botón', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(aprobar, 'j9', deps);

    expect(deps.aprobar).toHaveBeenCalledWith(CHAT, VISTA, USUARIO);
    expect(deps.quitarBoton).toHaveBeenCalledWith(CHAT, 77);
    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      '✅ Factura aprobada.',
      null,
    );
    expect(deps.quitarBoton.mock.invocationCallOrder[0]).toBeLessThan(
      deps.enviar.mock.invocationCallOrder[0],
    );
    expect(deps.responder).not.toHaveBeenCalled();
    expect(deps.marcarMostrada).not.toHaveBeenCalled();
  });

  it('botón que ya no está vigente: reenvía el resumen actual con un botón nuevo y lo marca', async () => {
    const { deps } = crearDeps();
    deps.aprobar.mockResolvedValueOnce({
      texto: 'Ese resumen ya no está vigente…',
      mostrar: { borradorId: 'b1', version: 3, aprobable: true },
    });

    await procesarMensaje(aprobar, 'j9', deps);

    expect(deps.quitarBoton).toHaveBeenCalledWith(CHAT, 77);
    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      'Ese resumen ya no está vigente…',
      {
        borradorId: 'b1',
        version: 3,
      },
    );
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 3);
  });

  it('si no se puede quitar el botón viejo, solo lo registra y responde igual', async () => {
    const { deps } = crearDeps();
    deps.quitarBoton.mockRejectedValueOnce(
      new Error('message is not modified'),
    );

    await procesarMensaje(aprobar, 'j9', deps);

    expect(deps.logger.warn).toHaveBeenCalled();
    expectEnviado(deps, '✅ Factura aprobada.');
  });

  it('si la aprobación falla (p. ej. base caída), avisa que el borrador sigue igual', async () => {
    const { deps } = crearDeps();
    deps.aprobar.mockRejectedValue(new Error('sin conexión'));

    await procesarMensaje(aprobar, 'j9', deps);

    expectEnviado(deps, MENSAJES_FALLA.aprobar);
  });

  it.each([
    ['borradorId que no es uuid', { ...aprobar, borradorId: 'b1' }],
    ['versión 0', { ...aprobar, version: 0 }],
    [
      'sin messageId',
      { tipo: 'aprobar', chatId: CHAT, ...VISTA, usuarioId: USUARIO },
    ],
    [
      'sin usuarioId',
      { tipo: 'aprobar', chatId: CHAT, ...VISTA, messageId: 77 },
    ],
  ])('trabajo "aprobar" inválido (%s): no se procesa', async (_caso, datos) => {
    const { deps } = crearDeps();

    await procesarMensaje(datos, 'j9', deps);

    expect(deps.aprobar).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });
});

describe('procesarMensaje: texto', () => {
  it('llama a la conversación, envía la respuesta y luego marca la versión mostrada', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledWith(CHAT, TEXTO);
    expectEnviado(deps, 'Resumen');
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
    expect(deps.enviar.mock.invocationCallOrder[0]).toBeLessThan(
      deps.marcarMostrada.mock.invocationCallOrder[0],
    );
  });

  it('sin resumen en la respuesta, no marca nada', async () => {
    const { deps } = crearDeps();
    deps.responder.mockResolvedValueOnce({ texto: '✅ Factura aprobada.' });

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.marcarMostrada).not.toHaveBeenCalled();
  });

  it('Ollama caído: reintenta una vez a los 2 s y, si sigue caído, avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(conexionRechazada());

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(2);
    expect(deps.esperar).toHaveBeenCalledWith(ESPERA_REINTENTO_MS);
    expectEnviado(deps, MENSAJES_FALLA.texto);
  });

  it('Ollama vuelve en el reintento: responde normal', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValueOnce(conexionRechazada());

    await procesarMensaje(texto(), 'j1', deps);

    expectEnviado(deps, 'Resumen');
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
  });

  it('timeout de Ollama: no reintenta (la corrección pudo aplicarse) y avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(timeout());

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(1);
    expect(deps.esperar).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.texto);
  });

  it('Ollama caído envuelto por el intérprete (ollama_red): igual reintenta', async () => {
    const { deps } = crearDeps();
    deps.responder
      .mockRejectedValueOnce(
        new ErrorInterprete('ollama_red', { cause: conexionRechazada() }),
      )
      .mockRejectedValueOnce(
        new ErrorInterprete('ollama_red', { cause: conexionRechazada() }),
      );

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(2);
    expectEnviado(deps, MENSAJES_FALLA.texto);
  });

  it('datos del borrador inválidos en la BD: no reintenta y pide cancelar', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(
      new DatosBorradorInvalidosError(['items.0.valor']),
    );

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(1);
    expectEnviado(deps, MENSAJES_FALLA.datosInvalidos);
  });

  it('otro error (p. ej. JSON inválido de la IA): no reintenta y avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(new SyntaxError('JSON inválido'));

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(1);
    expectEnviado(deps, MENSAJES_FALLA.texto);
  });
});

describe('procesarMensaje: voz', () => {
  it('descarga, transcribe y pasa la transcripción a la conversación, como un texto', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledWith('archivo-1');
    expect(deps.transcribir).toHaveBeenCalledWith(NOTA);
    // Sin vista: un "sí" dictado no aprueba (decisión 1 de la 4.4).
    // El 3.er argumento marca que el texto viene de una nota de voz.
    expect(deps.responder).toHaveBeenCalledWith(CHAT, 'vinilo 50 mil', true);
    expectEnviado(deps, '🎤 Entendí: "vinilo 50 mil"\n\nResumen');
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
  });

  it('duración real de más de 120 s (aunque el cliente declare menos): no transcribe', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockResolvedValueOnce(notaOggSintetica(121));

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.vozLarga);
  });

  it('justo 120 s: se transcribe', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockResolvedValueOnce(notaOggSintetica(120));

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalled();
  });

  it('archivo que no es Ogg Opus: no se transcribe ni se reintenta', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(1);
    expect(deps.transcribir).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.voz);
  });

  it('transcripción de más de 1.000 caracteres: pide dividirla y no la pasa a la IA', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockResolvedValueOnce('a'.repeat(1001));

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.responder).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.transcripcionLarga);
    expect(MENSAJES_FALLA.transcripcionLarga).toContain('1.000');
  });

  it('transcripción de exactamente 1.000 caracteres: sí pasa a la conversación', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockResolvedValueOnce('a'.repeat(1000));

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.responder).toHaveBeenCalled();
  });

  it('Ollama falla después de transcribir: avisa como un texto (el borrador sigue igual)', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(new SyntaxError('JSON inválido'));

    await procesarMensaje(voz, 'j2', deps);

    expectEnviado(deps, MENSAJES_FALLA.texto);
  });

  it('Ollama caído después de transcribir: reintenta la conversación una vez', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValueOnce(conexionRechazada());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalledTimes(1);
    expect(deps.responder).toHaveBeenCalledTimes(2);
    expectEnviado(deps, '🎤 Entendí: "vinilo 50 mil"\n\nResumen');
  });

  it('transcripción vacía: avisa que no escuchó nada', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockResolvedValueOnce('');

    await procesarMensaje(voz, 'j2', deps);

    expectEnviado(deps, '🎤 No escuché nada en la nota.');
  });

  it('Whisper caído: reintenta una vez y avisa con el mensaje de voz', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockRejectedValue(conexionRechazada());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalledTimes(2);
    expectEnviado(deps, MENSAJES_FALLA.voz);
  });

  it('timeout de Whisper: no reintenta', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockRejectedValue(timeout());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalledTimes(1);
    expectEnviado(deps, MENSAJES_FALLA.voz);
  });

  it('falla de descarga: reintenta una vez (es una lectura)', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockRejectedValueOnce(
      new Error('Telegram respondió 502'),
    );

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(2);
    expectEnviado(deps, '🎤 Entendí: "vinilo 50 mil"\n\nResumen');
  });

  it('timeout de descarga: no reintenta', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockRejectedValue(timeout());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(1);
    expect(deps.transcribir).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.voz);
  });

  it('nota demasiado pesada: no reintenta, no transcribe y lo dice claro', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockRejectedValue(new VozDemasiadoPesadaError());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(1);
    expect(deps.transcribir).not.toHaveBeenCalled();
    expectEnviado(deps, MENSAJES_FALLA.vozPesada);
  });
});

describe('procesarMensaje: envío y validación', () => {
  it('falla al enviar por Telegram: no marca como mostrado y lo registra sin datos', async () => {
    const { deps, logs } = crearDeps();
    deps.enviar.mockRejectedValue(new Error('Bad Gateway'));

    await procesarMensaje(texto(), 'j3', deps);

    expect(deps.marcarMostrada).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('j3') && l.includes('enviar'))).toBe(
      true,
    );
  });

  it('falla al marcar: solo deja una advertencia', async () => {
    const { deps } = crearDeps();
    deps.marcarMostrada.mockRejectedValue(new Error('sin conexión'));

    await expect(procesarMensaje(texto(), 'j3', deps)).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it.each([
    ['sin tipo', { chatId: CHAT, texto: TEXTO }],
    ['texto vacío', { ...texto(), texto: '' }],
    [
      'texto de más de 1.000 caracteres',
      { ...texto(), texto: 'a'.repeat(1001) },
    ],
    ['chatId no numérico', { ...texto(), chatId: '4242' }],
    ['voz sin fileId', { tipo: 'voz', chatId: CHAT }],
  ])('datos inválidos (%s): no procesa nada', async (_caso, datos) => {
    const { deps } = crearDeps();

    await procesarMensaje(datos, 'j4', deps);

    expect(deps.responder).not.toHaveBeenCalled();
    expect(deps.descargarVoz).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('los logs nunca llevan el texto, la transcripción ni el chatId', async () => {
    const { deps, logs } = crearDeps();
    deps.responder.mockRejectedValueOnce(conexionRechazada());
    deps.transcribir.mockRejectedValueOnce(
      new Error(`Whisper falló con ${TEXTO}`),
    );

    await procesarMensaje(texto(), 'j5', deps);
    await procesarMensaje(voz, 'j6', deps);
    await procesarMensaje({ ...texto(), chatId: 'x' }, 'j7', deps);

    expect(logs.length).toBeGreaterThan(0);
    for (const linea of logs) {
      expect(linea).not.toContain(TEXTO);
      expect(linea).not.toContain('vinilo');
      expect(linea).not.toContain(String(CHAT));
    }
  });
});

describe('avisarTrabajoFallido', () => {
  const ENCOLADO = Date.UTC(2026, 10, 2, 20, 0, 0);
  const cortado = () =>
    Object.assign(new Error('job stalled more than allowable limit'), {
      name: 'UnrecoverableError',
    });

  it('sin nada que mostrar: pide reenviar el mensaje', async () => {
    const { deps, logs } = crearDeps();

    await avisarTrabajoFallido(texto(), 'j8', ENCOLADO, cortado(), deps);

    expect(deps.estadoTrasFallo).toHaveBeenCalledWith(CHAT, new Date(ENCOLADO));
    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      MENSAJES_FALLA.reinicio,
      null,
    );
    expect(logs.some((l) => l.includes('reinicio'))).toBe(true);
  });

  it('con un borrador pendiente: envía su resumen con el botón y lo marca', async () => {
    const { deps } = crearDeps();
    deps.estadoTrasFallo.mockResolvedValueOnce({
      texto: 'No alcancé a terminar… Resumen',
      mostrar: { borradorId: 'b1', version: 3, aprobable: true },
    });

    await avisarTrabajoFallido(texto(), 'j8', ENCOLADO, cortado(), deps);

    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      'No alcancé a terminar… Resumen',
      { borradorId: 'b1', version: 3 },
    );
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 3);
  });

  it('si la factura alcanzó a aprobarse: lo dice, sin pedir que reenvíe', async () => {
    const { deps } = crearDeps();
    deps.estadoTrasFallo.mockResolvedValueOnce({
      texto: '✅ Tu factura quedó aprobada.',
    });

    await avisarTrabajoFallido(aprobar, 'j8', ENCOLADO, cortado(), deps);

    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      '✅ Tu factura quedó aprobada.',
      null,
    );
    expect(deps.marcarMostrada).not.toHaveBeenCalled();
  });

  it('si no se puede leer el estado, cae al aviso genérico', async () => {
    const { deps } = crearDeps();
    deps.estadoTrasFallo.mockRejectedValueOnce(new Error('sin conexión'));

    await avisarTrabajoFallido(texto(), 'j8', ENCOLADO, cortado(), deps);

    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      MENSAJES_FALLA.reinicio,
      null,
    );
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('sin un chatId válido no envía nada', async () => {
    const { deps } = crearDeps();

    await avisarTrabajoFallido(
      { tipo: 'voz' },
      'j9',
      ENCOLADO,
      new Error('x'),
      deps,
    );

    expect(deps.estadoTrasFallo).not.toHaveBeenCalled();
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it('si el aviso no se puede enviar, solo lo registra', async () => {
    const { deps } = crearDeps();
    deps.enviar.mockRejectedValue(new Error('Bad Gateway'));

    await expect(
      avisarTrabajoFallido(voz, 'j10', ENCOLADO, new Error('x'), deps),
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('procesarMensaje: aviso de demora (4.4 §14.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Una respuesta que llega cuando el test la suelta. */
  function respuestaPendiente() {
    let soltar!: (respuesta: { texto: string }) => void;
    const promesa = new Promise<{ texto: string }>((resolver) => {
      soltar = resolver;
    });
    return { promesa, soltar };
  }

  it('un texto que tarda más de 30 s avisa una vez, antes de la respuesta', async () => {
    const { deps } = crearDeps();
    const lenta = respuestaPendiente();
    deps.responder.mockReturnValueOnce(lenta.promesa);

    const trabajo = procesarMensaje(texto(), 'j1', deps);
    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS);
    expect(deps.enviar).toHaveBeenCalledExactlyOnceWith(
      CHAT,
      AVISO_DEMORA,
      null,
    );

    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS);
    lenta.soltar({ texto: 'Resumen' });
    await trabajo;

    expect(deps.enviar).toHaveBeenCalledTimes(2);
    expect(deps.enviar).toHaveBeenLastCalledWith(CHAT, 'Resumen', null);
  });

  it('si responde antes de 30 s no avisa', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(texto(), 'j2', deps);
    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS * 2);

    expect(deps.enviar).toHaveBeenCalledTimes(1);
    expect(deps.enviar).not.toHaveBeenCalledWith(CHAT, AVISO_DEMORA, null);
  });

  it('una nota de voz lenta también avisa', async () => {
    const { deps } = crearDeps();
    const lenta = respuestaPendiente();
    deps.responder.mockReturnValueOnce(lenta.promesa);

    const trabajo = procesarMensaje(voz, 'j3', deps);
    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS);
    lenta.soltar({ texto: 'Resumen' });
    await trabajo;

    expect(deps.enviar).toHaveBeenNthCalledWith(1, CHAT, AVISO_DEMORA, null);
  });

  it('el botón Aprobar no avisa', async () => {
    const { deps } = crearDeps();
    const lenta = respuestaPendiente();
    deps.aprobar.mockReturnValueOnce(lenta.promesa);

    const trabajo = procesarMensaje(aprobar, 'j4', deps);
    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS);
    lenta.soltar({ texto: '✅ Factura aprobada.' });
    await trabajo;

    expect(deps.enviar).not.toHaveBeenCalledWith(CHAT, AVISO_DEMORA, null);
  });

  it('si el aviso no se puede enviar, la respuesta llega igual', async () => {
    const { deps } = crearDeps();
    const lenta = respuestaPendiente();
    deps.responder.mockReturnValueOnce(lenta.promesa);
    deps.enviar.mockRejectedValueOnce(new Error('Bad Gateway'));

    const trabajo = procesarMensaje(texto(), 'j5', deps);
    await vi.advanceTimersByTimeAsync(AVISO_DEMORA_MS);
    lenta.soltar({ texto: 'Resumen' });
    await trabajo;

    expect(deps.enviar).toHaveBeenLastCalledWith(CHAT, 'Resumen', null);
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});

describe('describirError: diagnóstico sin datos personales (Ley 1581)', () => {
  /** Un error de Prisma como lo lanza un trigger o un CHECK, con datos en el mensaje. */
  const deBase = (mensaje: string) =>
    Object.assign(new Error(mensaje), {
      name: 'PrismaClientUnknownRequestError',
    });

  it('un error propio muestra su categoría', () => {
    expect(describirError(new ErrorInterprete('ollama_http_500'))).toBe(
      'ErrorInterprete [ollama_http_500]',
    );
  });

  it('con categoría y código de sistema, muestra los dos', () => {
    expect(
      describirError(
        new ErrorInterprete('ollama_red', { cause: conexionRechazada() }),
      ),
    ).toBe('ErrorInterprete [ollama_red] (ECONNREFUSED)');
  });

  it('una categoría con otra forma no se imprime tal cual', () => {
    const error = Object.assign(new Error('x'), {
      categoria: 'Ana 52111222', // datos ficticios
    });

    expect(describirError(error)).toBe('Error [categoria_invalida]');
  });

  it('un trigger de la base: solo el nombre de su regla, nunca el resto del mensaje', () => {
    const texto = describirError(
      deBase(
        'ERROR: emisiones_columnas_inmutables: id, borrador_id… DETAIL: Failing row contains (Ana, 52111222)', // ficticios
      ),
    );

    expect(texto).toBe(
      'PrismaClientUnknownRequestError [bd_trigger:emisiones_columnas_inmutables]',
    );
    expect(texto).not.toMatch(/Ana|52111222/);
  });

  it('una restricción de la base: bd_restriccion con su nombre', () => {
    expect(
      describirError(
        deBase('violates check constraint "emisiones_codigo_error_check"'),
      ),
    ).toBe(
      'PrismaClientUnknownRequestError [bd_restriccion:emisiones_codigo_error_check]',
    );
  });

  it('un texto con forma de regla que no está en la lista no se imprime', () => {
    const texto = describirError(
      deBase('Invalid value: { datos: "borradores_de_ana_gomez" }'), // ficticio
    );

    expect(texto).toBe(
      'PrismaClientUnknownRequestError [bd_regla_desconocida]',
    );
  });

  it('un error de validación de Prisma (trae los argumentos) no se revisa', () => {
    const error = Object.assign(
      new Error('emisiones_columnas_inmutables datos: Ana'), // ficticio
      { name: 'PrismaClientValidationError' },
    );

    expect(describirError(error)).toBe('PrismaClientValidationError');
  });

  it('un código de sistema con otra forma no se imprime tal cual', () => {
    const error = Object.assign(new Error('x'), { code: 'Ana 52111222' }); // ficticio

    expect(describirError(error)).toBe('Error (codigo_invalido)');
  });

  it('un error de la base sin regla conocida: solo el nombre', () => {
    expect(describirError(deBase('algo con Ana adentro'))).toBe(
      'PrismaClientUnknownRequestError',
    );
  });

  it('el nombre de una regla no se busca en errores que no son de la base', () => {
    expect(describirError(new Error('emisiones_columnas_inmutables'))).toBe(
      'Error',
    );
  });
});
