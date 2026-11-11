// Regresión de la prueba manual del 2026-11-10 contra PostgreSQL real: la conversación y el
// intérprete son los de verdad; solo se simula la respuesta HTTP de Ollama, con lo que devolvería
// qwen2.5:7b (incluido el texto "null" en lugar de null). Correr con `pnpm test:int`.
// Todos los nombres, NIT y cédulas son ficticios.
import 'dotenv/config';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversacionService } from './conversacion.service.js';
import {
  InterpreteTextoService,
  type RespuestaIa,
} from './interprete-texto.service.js';

const CHAT = 999000201; // chat ficticio

const VINILO = { descripcion: 'vinilo', valor: '50000' };
const FERRETERIA = 'Ferretería Ejemplo SAS';

/** Lo que devolvería la IA para cada mensaje (el último que aparece en el pedido). */
const RESPUESTAS_IA: [mensaje: string, respuesta: RespuestaIa][] = [
  [
    'factura a Ferretería Ejemplo SAS, vinilo 50 mil',
    {
      cliente_nombre: FERRETERIA,
      cliente_identificacion: 'null', // así lo devolvió el modelo en la prueba manual
      items: [{ descripcion: 'vinilo', valor: '50 mil' }],
      total: null,
    },
  ],
  [
    'el nit es 900000001-2', // NIT ficticio (DV 2)
    {
      cliente_nombre: FERRETERIA,
      cliente_identificacion: '900000001-2',
      items: [VINILO],
      total: null,
    },
  ],
  [
    'el nit es 900000001', // NIT ficticio, sin DV
    {
      cliente_nombre: FERRETERIA,
      cliente_identificacion: '900000001',
      items: [VINILO],
      total: null,
    },
  ],
  [
    'factura a Juan, cédula 123, brocha 10 mil', // cédula ficticia
    {
      cliente_nombre: 'Juan',
      cliente_identificacion: '123',
      items: [{ descripcion: 'brocha', valor: '10 mil' }],
      total: null,
    },
  ],
];

/** Simula /api/chat de Ollama: responde según el mensaje del usuario que trae el pedido. */
function ollamaSimulado(
  _url: unknown,
  opciones: RequestInit,
): Promise<Response> {
  const pedido = JSON.parse(String(opciones.body)) as {
    messages: { role: string; content: string }[];
  };
  const usuario = pedido.messages.find((m) => m.role === 'user')?.content ?? '';
  const encontrada = RESPUESTAS_IA.find(([mensaje]) =>
    usuario.endsWith(mensaje),
  );
  if (!encontrada) throw new Error('Mensaje sin respuesta simulada');
  return Promise.resolve(
    new Response(
      JSON.stringify({ message: { content: JSON.stringify(encontrada[1]) } }),
    ),
  );
}

const config = {
  get: (clave: string) =>
    clave === 'DATABASE_URL'
      ? process.env.DATABASE_URL
      : clave === 'OLLAMA_URL'
        ? 'http://ollama.simulado'
        : 'qwen2.5:7b',
} as unknown as ConfigService<Env, true>;
const db = new PrismaService(config);
const servicio = new ConversacionService(
  db,
  new InterpreteTextoService(config),
);

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(ollamaSimulado));
  const pendientes = await db.borrador.count({
    where: { chatId: BigInt(CHAT), estado: 'PENDIENTE' },
  });
  if (pendientes > 0) {
    throw new Error(
      'El chat ficticio de la prueba ya tiene un PENDIENTE: revisar la base antes de seguir',
    );
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.borrador.deleteMany({ where: { chatId: BigInt(CHAT) } });
  await db.$disconnect();
});

describe('regresión de la prueba manual del 2026-11-10', () => {
  it('cancelar, crear sin NIT, NIT sin DV, NIT completo, cancelar, cédula corta, cancelar', async () => {
    // 1. "cancelar" sin nada en curso: limpia.
    expect((await servicio.responder(CHAT, 'cancelar')).texto).toBe(
      'No hay ninguna factura en curso.',
    );

    // 2. Primer mensaje sin NIT: resumen sin botón, falta el NIT y SIN el aviso de "null".
    const creada = await servicio.responder(
      CHAT,
      'factura a Ferretería Ejemplo SAS, vinilo 50 mil',
    );
    expect(creada.mostrar?.aprobable).toBe(false);
    expect(creada.texto).toContain('Falta: NIT o cédula del cliente.');
    expect(creada.texto).not.toContain('Entendí datos');
    expect(creada.texto).not.toMatch(/null/i);
    expect(creada.texto).toContain('vinilo: $ 50.000');

    // 3. NIT sin dígito de verificación: lo pide, sigue sin botón.
    const sinDv = await servicio.responder(CHAT, 'el nit es 900000001');
    expect(sinDv.mostrar?.aprobable).toBe(false);
    expect(sinDv.texto).toContain(
      'Falta el dígito de verificación del NIT 900000001.',
    );

    // 4. NIT completo: aparece el botón ✅ Aprobar.
    const completo = await servicio.responder(CHAT, 'el nit es 900000001-2');
    expect(completo.mostrar).toMatchObject({ aprobable: true, version: 3 });
    expect(completo.texto).toContain('Toca ✅ Aprobar');
    expect(completo.texto).toContain('NIT/CC: 900000001-2');

    // 5. "cancelar": borrador cancelado.
    expect((await servicio.responder(CHAT, 'cancelar')).texto).toContain(
      'Borrador cancelado',
    );
    expect(
      await db.borrador.findUnique({
        where: { id: completo.mostrar!.borradorId },
      }),
    ).toMatchObject({ estado: 'CANCELADO' });

    // 6. Cédula de 3 dígitos: no deja aprobar.
    const corta = await servicio.responder(
      CHAT,
      'factura a Juan, cédula 123, brocha 10 mil',
    );
    expect(corta.mostrar?.aprobable).toBe(false);
    expect(corta.texto).toContain(
      'Tiene 3 dígitos: es muy corto para una cédula o un NIT.',
    );
    expect(corta.texto).not.toContain('Toca ✅ Aprobar');

    // 7. "cancelar": limpia.
    expect((await servicio.responder(CHAT, 'cancelar')).texto).toContain(
      'Borrador cancelado',
    );
    expect(
      await db.borrador.count({
        where: { chatId: BigInt(CHAT), estado: 'PENDIENTE' },
      }),
    ).toBe(0);
  });
});
