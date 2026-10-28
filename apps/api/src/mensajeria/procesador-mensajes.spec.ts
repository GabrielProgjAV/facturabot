import {
  avisarTrabajoFallido,
  type DependenciasProcesador,
  ESPERA_REINTENTO_MS,
  MENSAJES_FALLA,
  procesarMensaje,
} from './procesador-mensajes.js';

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
      mostrar: { borradorId: 'b1', version: 2 },
    }),
    marcarMostrada: vi.fn().mockResolvedValue(undefined),
    descargarVoz: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
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

const texto = (versionVista: number | null = null) => ({
  tipo: 'texto',
  chatId: CHAT,
  texto: TEXTO,
  versionVista,
});
const voz = { tipo: 'voz', chatId: CHAT, fileId: 'archivo-1' };

describe('procesarMensaje: texto', () => {
  it('llama a la conversación, envía la respuesta y luego marca la versión mostrada', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(texto(1), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledWith(CHAT, TEXTO, 1);
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, 'Resumen');
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
    expect(deps.enviar.mock.invocationCallOrder[0]).toBeLessThan(
      deps.marcarMostrada.mock.invocationCallOrder[0],
    );
  });

  it('sin resumen en la respuesta, no marca nada', async () => {
    const { deps } = crearDeps();
    deps.responder.mockResolvedValueOnce({ texto: '✅ Factura aprobada.' });

    await procesarMensaje(texto(1), 'j1', deps);

    expect(deps.marcarMostrada).not.toHaveBeenCalled();
  });

  it('Ollama caído: reintenta una vez a los 2 s y, si sigue caído, avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(conexionRechazada());

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(2);
    expect(deps.esperar).toHaveBeenCalledWith(ESPERA_REINTENTO_MS);
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.texto);
  });

  it('Ollama vuelve en el reintento: responde normal', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValueOnce(conexionRechazada());

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.enviar).toHaveBeenCalledWith(CHAT, 'Resumen');
    expect(deps.marcarMostrada).toHaveBeenCalledWith('b1', 2);
  });

  it('timeout de Ollama: no reintenta (la corrección pudo aplicarse) y avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(timeout());

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(1);
    expect(deps.esperar).not.toHaveBeenCalled();
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.texto);
  });

  it('otro error (p. ej. JSON inválido de la IA): no reintenta y avisa', async () => {
    const { deps } = crearDeps();
    deps.responder.mockRejectedValue(new SyntaxError('JSON inválido'));

    await procesarMensaje(texto(), 'j1', deps);

    expect(deps.responder).toHaveBeenCalledTimes(1);
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.texto);
  });
});

describe('procesarMensaje: voz', () => {
  it('descarga, transcribe y envía lo que entendió', async () => {
    const { deps } = crearDeps();

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledWith('archivo-1');
    expect(deps.transcribir).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      '🎤 Entendí: "vinilo 50 mil"',
    );
    expect(deps.responder).not.toHaveBeenCalled();
  });

  it('transcripción vacía: avisa que no escuchó nada', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockResolvedValueOnce('');

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      '🎤 No escuché nada en la nota.',
    );
  });

  it('Whisper caído: reintenta una vez y avisa con el mensaje de voz', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockRejectedValue(conexionRechazada());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalledTimes(2);
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.voz);
  });

  it('timeout de Whisper: no reintenta', async () => {
    const { deps } = crearDeps();
    deps.transcribir.mockRejectedValue(timeout());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.transcribir).toHaveBeenCalledTimes(1);
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.voz);
  });

  it('falla de descarga: reintenta una vez (es una lectura)', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockRejectedValueOnce(
      new Error('Telegram respondió 502'),
    );

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(2);
    expect(deps.enviar).toHaveBeenCalledWith(
      CHAT,
      '🎤 Entendí: "vinilo 50 mil"',
    );
  });

  it('timeout de descarga: no reintenta', async () => {
    const { deps } = crearDeps();
    deps.descargarVoz.mockRejectedValue(timeout());

    await procesarMensaje(voz, 'j2', deps);

    expect(deps.descargarVoz).toHaveBeenCalledTimes(1);
    expect(deps.transcribir).not.toHaveBeenCalled();
    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.voz);
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
  it('reinicio a mitad del trabajo (stalled): pide reenviar el mensaje', async () => {
    const { deps, logs } = crearDeps();
    const err = Object.assign(
      new Error('job stalled more than allowable limit'),
      {
        name: 'UnrecoverableError',
      },
    );

    await avisarTrabajoFallido(texto(), 'j8', err, deps);

    expect(deps.enviar).toHaveBeenCalledWith(CHAT, MENSAJES_FALLA.reinicio);
    expect(logs.some((l) => l.includes('reinicio'))).toBe(true);
  });

  it('sin un chatId válido no envía nada', async () => {
    const { deps } = crearDeps();

    await avisarTrabajoFallido({ tipo: 'voz' }, 'j9', new Error('x'), deps);

    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it('si el aviso no se puede enviar, solo lo registra', async () => {
    const { deps } = crearDeps();
    deps.enviar.mockRejectedValue(new Error('Bad Gateway'));

    await expect(
      avisarTrabajoFallido(voz, 'j10', new Error('x'), deps),
    ).resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });
});
