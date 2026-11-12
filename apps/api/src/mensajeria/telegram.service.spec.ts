import type { AvisoTokenService } from '../emision/alegra/aviso-token.service.js';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { ConversacionService } from '../facturacion/conversacion.service.js';
import type { TranscriptorService } from '../voz/transcriptor.service.js';
import {
  type ColaMensajesService,
  EncoladoSinConfirmarError,
} from './cola-mensajes.service.js';
import {
  MENSAJES_FALLA,
  TAMANO_MAXIMO_VOZ_BYTES,
  VozDemasiadoPesadaError,
} from './procesador-mensajes.js';
import {
  autorizado,
  datosBotonAprobar,
  leerBotonAprobar,
  MENSAJES_RECEPCION,
  TelegramService,
} from './telegram.service.js';

const CHAT = 4242; // chat ficticio
const UPDATE = 9001;
/** Borrador y versión del botón (uuid ficticio). */
const VISTA = {
  borradorId: '01900000-0000-7000-8000-000000000001',
  version: 1,
};

/** El cableado de grammY no se prueba: se llama directo a los métodos del handler. */
function crear() {
  const valores: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: '123456:token-ficticio-para-tests-0000000000',
    TELEGRAM_CHATS_PERMITIDOS: [CHAT],
  };
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService<Env, true>;
  const conversacion = {};
  const cola = { encolar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new TelegramService(
    config,
    conversacion as unknown as ConversacionService,
    {} as TranscriptorService,
    cola as unknown as ColaMensajesService,
    { avisoDelDia: () => null } as unknown as AvisoTokenService,
  );
  const responder = vi.fn().mockResolvedValue(undefined);
  return { servicio, conversacion, cola, responder };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  const registrar = (mensaje: unknown) => {
    logs.push(String(mensaje));
  };
  vi.spyOn(Logger.prototype, 'error').mockImplementation(registrar);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(registrar);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(registrar);
});
afterEach(() => vi.restoreAllMocks());

describe('TelegramService: texto', () => {
  it('avisa "Procesando…" y encola con el update_id como jobId', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.procesando);
    expect(cola.encolar).toHaveBeenCalledWith(
      { tipo: 'texto', chatId: CHAT, texto: 'factura a Ana' },
      `tg-${UPDATE}`,
    );
  });

  it('el jobId nunca lleva el chatId', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    const jobId = cola.encolar.mock.calls[0][1] as string;
    expect(jobId).not.toContain(String(CHAT));
  });

  it('un texto de más de 1.000 caracteres no se encola', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'a'.repeat(1001), responder);

    expect(cola.encolar).not.toHaveBeenCalled();
    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.textoLargo);
    expect(MENSAJES_RECEPCION.textoLargo).toContain('1.000');
  });

  it('un texto de exactamente 1.000 caracteres sí se encola', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'a'.repeat(1000), responder);

    expect(cola.encolar).toHaveBeenCalled();
  });

  it.each(['sí', 'cancelar'])(
    '"%s": se encola como texto, sin avisar "Procesando…" (no pasa por la IA)',
    async (texto) => {
      const { servicio, cola, responder } = crear();

      await servicio.recibirTexto(CHAT, UPDATE, texto, responder);

      expect(responder).not.toHaveBeenCalled();
      expect(cola.encolar).toHaveBeenCalledWith(
        { tipo: 'texto', chatId: CHAT, texto },
        `tg-${UPDATE}`,
      );
    },
  );

  it('Redis caído: avisa que no pudo recibir el mensaje', async () => {
    const { servicio, cola, responder } = crear();
    cola.encolar.mockRejectedValueOnce(
      new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      ),
    );

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    expect(responder).toHaveBeenLastCalledWith(MENSAJES_RECEPCION.redisCaido);
  });

  it('Redis no confirma a tiempo: pide esperar y reenviar si no llega el resumen', async () => {
    const { servicio, cola, responder } = crear();
    cola.encolar.mockRejectedValueOnce(new EncoladoSinConfirmarError());

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    expect(responder).toHaveBeenLastCalledWith(
      MENSAJES_FALLA.encoladoSinConfirmar,
    );
  });

  it('si el aviso "Procesando…" falla, el mensaje se encola igual', async () => {
    const { servicio, cola, responder } = crear();
    responder.mockRejectedValueOnce(new Error('Bad Gateway'));

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    expect(cola.encolar).toHaveBeenCalled();
  });

  it('los logs no llevan el chatId ni el texto', async () => {
    const { servicio, cola, responder } = crear();
    cola.encolar.mockRejectedValue(new Error(`falló con ${CHAT}`));
    responder.mockRejectedValueOnce(new Error('Bad Gateway'));

    await servicio.recibirTexto(CHAT, UPDATE, 'sí', responder);
    await servicio.recibirTexto(CHAT, UPDATE + 1, 'factura a Ana', responder);

    expect(logs.length).toBeGreaterThan(0);
    for (const linea of logs) {
      expect(linea).not.toContain(String(CHAT));
      expect(linea).not.toContain('Ana');
    }
  });
});

describe('autorización (por usuario y solo en chats privados)', () => {
  const permitidos = new Set([CHAT]);

  it.each([
    ['usuario autorizado en chat privado', 'private', CHAT, true],
    ['usuario no autorizado en chat privado', 'private', 5555, false],
    ['usuario autorizado en un grupo', 'group', CHAT, false],
    ['usuario autorizado en un supergrupo', 'supergroup', CHAT, false],
    ['usuario autorizado en un canal', 'channel', CHAT, false],
    [
      'sin usuario (p. ej. publicación de un canal)',
      'private',
      undefined,
      false,
    ],
    ['sin chat', undefined, CHAT, false],
  ] as const)('%s → %s', (_caso, tipoChat, usuarioId, esperado) => {
    expect(autorizado(tipoChat, usuarioId, permitidos)).toBe(esperado);
  });
});

describe('TelegramService: botón "✅ Aprobar"', () => {
  it('los datos del botón van y vuelven, y caben en los 64 bytes de la Bot API', () => {
    const datos = datosBotonAprobar(VISTA);

    expect(datos).toBe(`a:${VISTA.borradorId}:1`);
    expect(leerBotonAprobar(datos)).toEqual(VISTA);
    const maximo = datosBotonAprobar({ ...VISTA, version: 999_999 });
    expect(Buffer.byteLength(maximo, 'utf8')).toBeLessThanOrEqual(64);
  });

  it.each([
    ['otro prefijo', `n:${VISTA.borradorId}:1`],
    ['id que no es uuid', 'a:b1:1'],
    ['versión 0', `a:${VISTA.borradorId}:0`],
    ['versión con letras', `a:${VISTA.borradorId}:1x`],
    ['versión de 7 dígitos', `a:${VISTA.borradorId}:1000000`],
    ['vacío', ''],
  ])('rechaza datos alterados (%s)', (_caso, datos) => {
    expect(leerBotonAprobar(datos)).toBeNull();
  });

  it('pulsado: responde enseguida al callback y encola "aprobar" con el mensaje del botón', async () => {
    const { servicio, cola, responder } = crear();
    const responderCallback = vi.fn().mockResolvedValue(true);

    await servicio.recibirBoton(
      CHAT,
      CHAT,
      UPDATE,
      datosBotonAprobar(VISTA),
      77,
      responderCallback,
      responder,
    );

    expect(responderCallback).toHaveBeenCalledWith(
      MENSAJES_RECEPCION.procesandoBoton,
    );
    expect(cola.encolar).toHaveBeenCalledWith(
      {
        tipo: 'aprobar',
        chatId: CHAT,
        ...VISTA,
        messageId: 77,
        usuarioId: CHAT,
      },
      `tg-${UPDATE}`,
    );
    expect(responderCallback.mock.invocationCallOrder[0]).toBeLessThan(
      cola.encolar.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['datos alterados', 'a:b1:1', 77],
    [
      'sin mensaje (botón de un mensaje que ya no existe)',
      `a:${VISTA.borradorId}:1`,
      undefined,
    ],
  ])(
    '%s: responde al callback y no encola',
    async (_caso, datos, messageId) => {
      const { servicio, cola, responder } = crear();
      const responderCallback = vi.fn().mockResolvedValue(true);

      await servicio.recibirBoton(
        CHAT,
        CHAT,
        UPDATE,
        datos,
        messageId,
        responderCallback,
        responder,
      );

      expect(responderCallback).toHaveBeenCalledWith(
        MENSAJES_RECEPCION.botonInvalido,
      );
      expect(cola.encolar).not.toHaveBeenCalled();
    },
  );

  it('si el encolado falla, igual respondió al callback y avisa en el chat', async () => {
    const { servicio, cola, responder } = crear();
    const responderCallback = vi.fn().mockResolvedValue(true);
    cola.encolar.mockRejectedValueOnce(new Error('Redis caído'));

    await servicio.recibirBoton(
      CHAT,
      CHAT,
      UPDATE,
      datosBotonAprobar(VISTA),
      77,
      responderCallback,
      responder,
    );

    expect(responderCallback).toHaveBeenCalled();
    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.redisCaido);
  });

  it('enviar con botón: el mensaje lleva "✅ Aprobar" con los datos del borrador', async () => {
    const { servicio } = crear();
    const api = (
      servicio as unknown as { bot: { api: Record<string, unknown> } }
    ).bot.api;
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    api.sendMessage = sendMessage;

    await servicio.enviar(CHAT, 'Resumen', VISTA);
    await servicio.enviar(CHAT, 'Sin botón', null);

    const markup = sendMessage.mock.calls[0][2].reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard).toEqual([
      [{ text: '✅ Aprobar', callback_data: datosBotonAprobar(VISTA) }],
    ]);
    expect(sendMessage.mock.calls[1][2]).toBeUndefined();
  });

  it('quitarBoton deja el mensaje sin teclado', async () => {
    const { servicio } = crear();
    const api = (
      servicio as unknown as { bot: { api: Record<string, unknown> } }
    ).bot.api;
    const editar = vi.fn().mockResolvedValue(true);
    api.editMessageReplyMarkup = editar;

    await servicio.quitarBoton(CHAT, 77);

    expect(editar).toHaveBeenCalledWith(CHAT, 77, {
      reply_markup: { inline_keyboard: [] },
    });
  });
});

describe('TelegramService: voz', () => {
  it('avisa "Escuchando…" y encola solo el file_id', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirVoz(
      CHAT,
      UPDATE,
      { duration: 12, file_id: 'archivo-1' },
      responder,
    );

    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.escuchando);
    expect(cola.encolar).toHaveBeenCalledWith(
      { tipo: 'voz', chatId: CHAT, fileId: 'archivo-1' },
      `tg-${UPDATE}`,
    );
  });

  it('una nota de más de 120 s no se encola', async () => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirVoz(
      CHAT,
      UPDATE,
      { duration: 121, file_id: 'archivo-1' },
      responder,
    );

    expect(cola.encolar).not.toHaveBeenCalled();
    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.vozLarga);
  });

  it('registra la duración y el tamaño de la nota, sin el chatId', async () => {
    const { servicio, responder } = crear();

    await servicio.recibirVoz(
      CHAT,
      UPDATE,
      { duration: 118, file_id: 'archivo-1', file_size: 412000 },
      responder,
    );
    await servicio.recibirVoz(
      CHAT,
      UPDATE + 1,
      { duration: 10, file_id: 'archivo-2' },
      responder,
    );

    expect(logs).toContain(`tg-${UPDATE} voz: 118 s, 412000 bytes`);
    expect(logs).toContain(`tg-${UPDATE + 1} voz: 10 s, sin bytes`);
    for (const linea of logs) expect(linea).not.toContain(String(CHAT));
  });

  it.each([
    ['justo en el límite (1 MB)', TAMANO_MAXIMO_VOZ_BYTES, true],
    ['sin file_size (se comprueba al descargar)', undefined, true],
    ['un byte por encima del límite', TAMANO_MAXIMO_VOZ_BYTES + 1, false],
  ])('nota %s: se encola = %s', async (_caso, fileSize, encola) => {
    const { servicio, cola, responder } = crear();

    await servicio.recibirVoz(
      CHAT,
      UPDATE,
      { duration: 60, file_id: 'archivo-1', file_size: fileSize },
      responder,
    );

    expect(cola.encolar).toHaveBeenCalledTimes(encola ? 1 : 0);
    if (!encola) {
      expect(responder).toHaveBeenCalledWith(MENSAJES_FALLA.vozPesada);
      expect(MENSAJES_FALLA.vozPesada).toBe(
        'La nota de voz es muy pesada. Envíala más corta o escríbela.',
      );
    }
  });
});

describe('TelegramService: descargarVoz', () => {
  it('pide el archivo a Telegram y lo descarga a memoria', async () => {
    const { servicio } = crear();
    const api = (servicio as unknown as { bot: { api: { getFile: unknown } } })
      .bot.api;
    api.getFile = vi.fn().mockResolvedValue({ file_path: 'voice/file_1.oga' });
    const fetchFalso = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchFalso);
    try {
      const audio = await servicio.descargarVoz('archivo-1');

      expect(api.getFile).toHaveBeenCalledWith(
        'archivo-1',
        expect.any(AbortSignal),
      );
      expect(Array.from(audio)).toEqual([1, 2, 3]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('si Telegram responde con error, lanza sin incluir la URL (lleva el token)', async () => {
    const { servicio } = crear();
    const api = (servicio as unknown as { bot: { api: { getFile: unknown } } })
      .bot.api;
    api.getFile = vi.fn().mockResolvedValue({ file_path: 'voice/file_1.oga' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    try {
      const error = await servicio
        .descargarVoz('archivo-1')
        .catch((e: Error) => e);

      expect((error as Error).message).toBe('Telegram respondió 404');
      expect((error as Error).message).not.toContain('token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('límite de tamaño', () => {
    function conDescarga(fileSize: number | undefined, bytes: number) {
      const { servicio } = crear();
      const api = (
        servicio as unknown as { bot: { api: { getFile: unknown } } }
      ).bot.api;
      api.getFile = vi.fn().mockResolvedValue({
        file_path: 'voice/file_1.oga',
        file_size: fileSize,
      });
      const fetchFalso = vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(bytes), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchFalso);
      return { servicio, fetchFalso };
    }
    afterEach(() => vi.unstubAllGlobals());

    it('si getFile informa más de 1 MB, no descarga', async () => {
      const { servicio, fetchFalso } = conDescarga(
        TAMANO_MAXIMO_VOZ_BYTES + 1,
        10,
      );

      await expect(servicio.descargarVoz('archivo-1')).rejects.toBeInstanceOf(
        VozDemasiadoPesadaError,
      );
      expect(fetchFalso).not.toHaveBeenCalled();
    });

    it('sin file_size y una descarga de más de 1 MB: la rechaza', async () => {
      const { servicio } = conDescarga(undefined, TAMANO_MAXIMO_VOZ_BYTES + 1);

      await expect(servicio.descargarVoz('archivo-1')).rejects.toBeInstanceOf(
        VozDemasiadoPesadaError,
      );
    });

    it('sin file_size y una descarga de exactamente 1 MB: la acepta', async () => {
      const { servicio } = conDescarga(undefined, TAMANO_MAXIMO_VOZ_BYTES);

      const audio = await servicio.descargarVoz('archivo-1');

      expect(audio.byteLength).toBe(TAMANO_MAXIMO_VOZ_BYTES);
    });

    it('si content-length supera 1 MB, rechaza sin leer el cuerpo', async () => {
      const { servicio, fetchFalso } = conDescarga(undefined, 10);
      const leido = vi.fn();
      // highWaterMark 0: el stream no pide datos por adelantado, solo cuando alguien lee.
      const cuerpo = new ReadableStream<Uint8Array>(
        {
          pull(controlador) {
            leido();
            controlador.enqueue(new Uint8Array(10));
            controlador.close();
          },
        },
        { highWaterMark: 0 },
      );
      fetchFalso.mockResolvedValueOnce(
        new Response(cuerpo, {
          status: 200,
          headers: { 'content-length': String(TAMANO_MAXIMO_VOZ_BYTES + 1) },
        }),
      );

      await expect(servicio.descargarVoz('archivo-1')).rejects.toBeInstanceOf(
        VozDemasiadoPesadaError,
      );
      expect(leido).not.toHaveBeenCalled();
    });

    it('cuerpo por partes que pasa de 1 MB: corta la lectura sin leer el resto', async () => {
      const { servicio, fetchFalso } = conDescarga(undefined, 10);
      const parte = 256 * 1024;
      let enviadas = 0;
      const cuerpo = new ReadableStream<Uint8Array>({
        pull(controlador) {
          enviadas += 1;
          controlador.enqueue(new Uint8Array(parte)); // nunca termina: 20 MB o más
        },
      });
      fetchFalso.mockResolvedValueOnce(new Response(cuerpo, { status: 200 }));

      await expect(servicio.descargarVoz('archivo-1')).rejects.toBeInstanceOf(
        VozDemasiadoPesadaError,
      );
      // 1 MB son 4 partes de 256 KB: se detiene en la quinta, no lee las ochenta.
      expect(enviadas).toBeLessThanOrEqual(6);
    });
  });
});
