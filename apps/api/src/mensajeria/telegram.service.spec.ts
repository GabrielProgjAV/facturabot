import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import type { ConversacionService } from '../facturacion/conversacion.service.js';
import type { TranscriptorService } from '../voz/transcriptor.service.js';
import {
  type ColaMensajesService,
  EncoladoSinConfirmarError,
} from './cola-mensajes.service.js';
import { MENSAJES_FALLA } from './procesador-mensajes.js';
import { MENSAJES_RECEPCION, TelegramService } from './telegram.service.js';

const CHAT = 4242; // chat ficticio
const UPDATE = 9001;

/** El cableado de grammY no se prueba: se llama directo a los métodos del handler. */
function crear() {
  const valores: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: '123456:token-ficticio-para-tests-0000000000',
    TELEGRAM_CHATS_PERMITIDOS: [CHAT],
  };
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService<Env, true>;
  const conversacion = { versionMostrada: vi.fn().mockResolvedValue(1) };
  const cola = { encolar: vi.fn().mockResolvedValue(undefined) };
  const servicio = new TelegramService(
    config,
    conversacion as unknown as ConversacionService,
    {} as TranscriptorService,
    cola as unknown as ColaMensajesService,
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
    const { servicio, cola, responder, conversacion } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'factura a Ana', responder);

    expect(responder).toHaveBeenCalledWith(MENSAJES_RECEPCION.procesando);
    expect(cola.encolar).toHaveBeenCalledWith(
      {
        tipo: 'texto',
        chatId: CHAT,
        texto: 'factura a Ana',
        versionVista: null,
      },
      `tg-${UPDATE}`,
    );
    expect(conversacion.versionMostrada).not.toHaveBeenCalled();
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

  it('"sí": captura versionVista de versionMostrada y no avisa "Procesando…"', async () => {
    // Condición 1 de §15, mitad del handler: se lee versionMostrada (1), no version (2, una
    // corrección guardada que el usuario aún no recibió). La otra mitad está en
    // conversacion.service.spec.ts.
    const { servicio, cola, responder, conversacion } = crear();
    conversacion.versionMostrada.mockResolvedValueOnce(1);

    await servicio.recibirTexto(CHAT, UPDATE, 'sí', responder);

    expect(conversacion.versionMostrada).toHaveBeenCalledWith(CHAT);
    expect(cola.encolar).toHaveBeenCalledWith(
      { tipo: 'texto', chatId: CHAT, texto: 'sí', versionVista: 1 },
      `tg-${UPDATE}`,
    );
    expect(responder).not.toHaveBeenCalled();
  });

  it('"cancelar": no lee la versión ni avisa "Procesando…"', async () => {
    const { servicio, cola, responder, conversacion } = crear();

    await servicio.recibirTexto(CHAT, UPDATE, 'cancelar', responder);

    expect(conversacion.versionMostrada).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled();
    expect(cola.encolar).toHaveBeenCalledWith(
      expect.objectContaining({ texto: 'cancelar', versionVista: null }),
      `tg-${UPDATE}`,
    );
  });

  it('si no puede leer la versión, encola el "sí" con versionVista null (no aprobará)', async () => {
    const { servicio, cola, responder, conversacion } = crear();
    conversacion.versionMostrada.mockRejectedValueOnce(
      new Error('sin conexión'),
    );

    await servicio.recibirTexto(CHAT, UPDATE, 'sí', responder);

    expect(cola.encolar).toHaveBeenCalledWith(
      expect.objectContaining({ versionVista: null }),
      `tg-${UPDATE}`,
    );
  });

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
    const { servicio, cola, responder, conversacion } = crear();
    conversacion.versionMostrada.mockRejectedValueOnce(new Error('x'));
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
});
