// Todos los NIT y cédulas de este archivo son ficticios.
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import {
  aBorrador,
  ErrorInterprete,
  InterpreteTextoService,
  textoONull,
  totalSegunMensaje,
} from './interprete-texto.service.js';

describe('totalSegunMensaje', () => {
  it('ignora un total que la IA inventó si el mensaje no dice "total"', () => {
    expect(
      totalSegunMensaje('factura a pedro por laca a 78.000', 78000, null),
    ).toBeNull();
  });

  it('acepta el total si el mensaje lo menciona', () => {
    expect(totalSegunMensaje('el total es 100 mil', 100000, null)).toBe(100000);
  });

  it('al corregir sin mencionar el total, conserva el anterior', () => {
    expect(
      totalSegunMensaje('agrega una brocha de 12 mil', 90000, 100000),
    ).toBe(100000);
  });
});

describe('aBorrador', () => {
  it('normaliza los pesos y limpia los textos', () => {
    const borrador = aBorrador({
      cliente_nombre: ' Juan Pérez ',
      cliente_identificacion: '1020304050',
      items: [
        { descripcion: '2 galones vinilo blanco', valor: '80 mil' },
        { descripcion: '1/4 esmalte rojo', valor: '$25.000' },
      ],
      total: '105.000',
    });

    expect(borrador).toEqual({
      cliente: { nombre: 'Juan Pérez', identificacion: '1020304050' },
      items: [
        { descripcion: '2 galones vinilo blanco', valor: 80000 },
        { descripcion: '1/4 esmalte rojo', valor: 25000 },
      ],
      totalEscrito: 105000,
    });
  });

  it('convierte textos vacíos y valores ilegibles en null', () => {
    const borrador = aBorrador({
      cliente_nombre: '',
      cliente_identificacion: null,
      items: [{ descripcion: 'laca', valor: 'no sé' }],
      total: null,
    });

    expect(borrador.cliente).toEqual({ nombre: null, identificacion: null });
    expect(borrador.items[0].valor).toBeNull();
    expect(borrador.totalEscrito).toBeNull();
  });
});

describe('textoONull: la IA dice "no hay dato" con texto', () => {
  it.each(['null', 'NULL', ' None ', 'n/a', 'N/A', 'undefined', '', '   '])(
    '"%s" es ausencia de dato',
    (texto) => {
      expect(textoONull(texto)).toBeNull();
    },
  );

  it.each([
    ['900000001-2', '900000001-2'], // NIT ficticio
    [' Nala ', 'Nala'],
    ['Na', 'Na'], // puede ser un apellido
    ['Nil', 'Nil'], // puede ser un nombre
    ['Nulla SAS', 'Nulla SAS'],
  ])('"%s" es un dato', (texto, esperado) => {
    expect(textoONull(texto)).toBe(esperado);
  });

  it('aBorrador convierte "null" en null para el nombre y la identificación', () => {
    const borrador = aBorrador({
      cliente_nombre: 'Ferretería Ejemplo SAS',
      cliente_identificacion: 'null',
      items: [{ descripcion: 'vinilo', valor: '50 mil' }],
      total: 'null',
    });

    expect(borrador.cliente).toEqual({
      nombre: 'Ferretería Ejemplo SAS',
      identificacion: null,
    });
    expect(borrador.totalEscrito).toBeNull();
  });
});

describe('InterpreteTextoService: errores con categoría segura', () => {
  const config = {
    get: (clave: string) =>
      clave === 'OLLAMA_URL' ? 'http://ollama.invalid' : 'qwen2.5:7b',
  } as unknown as ConfigService<Env, true>;
  const interprete = new InterpreteTextoService(config);
  const MENSAJE = 'factura a Ana cc 52111222, vinilo 50 mil'; // cédula ficticia

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ollamaResponde(respuesta: Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(respuesta));
  }
  const conContenido = (contenido: string) =>
    new Response(JSON.stringify({ message: { content: contenido } }));

  async function categoriaDe(): Promise<{ categoria: string; error: unknown }> {
    const error = await interprete
      .interpretar(MENSAJE)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorInterprete);
    return { categoria: (error as ErrorInterprete).categoria, error };
  }

  it.each([500, 404, 503])('HTTP %i → ollama_http_%i', async (status) => {
    ollamaResponde(new Response('error', { status }));

    expect((await categoriaDe()).categoria).toBe(`ollama_http_${status}`);
  });

  it('timeout → ollama_timeout', async () => {
    ollamaResponde(
      Promise.reject(
        new DOMException('The operation timed out.', 'TimeoutError'),
      ),
    );

    expect((await categoriaDe()).categoria).toBe('ollama_timeout');
  });

  it('red caída → ollama_red, con el error original en cause (para el reintento)', async () => {
    const original = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    ollamaResponde(Promise.reject(original));

    const { categoria, error } = await categoriaDe();

    expect(categoria).toBe('ollama_red');
    expect((error as Error).cause).toBe(original);
  });

  it('respuesta que no es el sobre de Ollama → ollama_respuesta_invalida', async () => {
    ollamaResponde(new Response('<html>'));

    expect((await categoriaDe()).categoria).toBe('ollama_respuesta_invalida');
  });

  it('contenido que no es JSON → ia_json_invalido', async () => {
    ollamaResponde(conContenido('no es json'));

    expect((await categoriaDe()).categoria).toBe('ia_json_invalido');
  });

  it('JSON sin la forma pedida → ia_esquema_invalido', async () => {
    ollamaResponde(conContenido(JSON.stringify({ cliente: 'Ana' })));

    expect((await categoriaDe()).categoria).toBe('ia_esquema_invalido');
  });

  it('el mensaje del error es solo la categoría: nunca el texto ni la respuesta', async () => {
    ollamaResponde(conContenido('Ana 52111222'));

    const { error } = await categoriaDe();

    expect((error as Error).message).toBe('ia_json_invalido');
  });
});
