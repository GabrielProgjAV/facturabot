// Utilidad de pruebas: un servidor HTTP local que hace de Alegra. Ningún test llama a Alegra de
// verdad. Responde según "MÉTODO /ruta" (sin la consulta) y anota cada pedido recibido.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PedidoRecibido {
  metodo: string;
  ruta: string;
  autorizacion: string | undefined;
  cuerpo: unknown;
}

export type RespuestaFalsa = {
  status: number;
  cuerpo?: unknown;
  crudo?: string;
};

export class AlegraFalso {
  readonly pedidos: PedidoRecibido[] = [];
  private respuestas = new Map<string, RespuestaFalsa[]>();
  private servidor?: Server;
  url = '';

  /** Respuesta para "MÉTODO /ruta"; varias seguidas se entregan en orden (la última se repite). */
  responder(clave: string, ...respuestas: RespuestaFalsa[]): this {
    this.respuestas.set(clave, respuestas);
    return this;
  }

  /** La cuenta tiene IVA 19 %, el producto genérico y el contacto "Consumidor final". */
  conRecursos(): this {
    return this.responder('GET /taxes', {
      status: 200,
      cuerpo: [
        { id: '1', type: 'IVA', percentage: '5', status: 'active' },
        { id: '4', type: 'IVA', percentage: '19.00', status: 'active' },
      ],
    })
      .responder('GET /items', {
        status: 200,
        cuerpo: [
          { id: '9', name: 'Pinturas varias especiales' },
          { id: '1', name: 'Pinturas varias' },
        ],
      })
      .responder('GET /contacts', {
        status: 200,
        cuerpo: [
          // La búsqueda de Alegra es "contiene": un número más largo también aparece.
          { id: '5', identificationObject: { number: '2222222222221' } },
          // Identificador genérico de la DIAN para consumidor final: no es de ninguna persona.
          { id: '1', identificationObject: { number: '222222222222' } },
        ],
      });
  }

  /** Pedidos a una ruta (sin la consulta). */
  pedidosA(clave: string): PedidoRecibido[] {
    return this.pedidos.filter((p) => `${p.metodo} ${p.ruta}` === clave);
  }

  async iniciar(): Promise<this> {
    this.servidor = createServer((req, res) => {
      let datos = '';
      req.on('data', (parte: Buffer) => (datos += parte.toString()));
      req.on('end', () => {
        const ruta = (req.url ?? '').split('?')[0].replace(/^\/api\/v1/, '');
        const metodo = req.method ?? '';
        this.pedidos.push({
          metodo,
          ruta,
          autorizacion: req.headers.authorization,
          cuerpo: datos ? (JSON.parse(datos) as unknown) : undefined,
        });
        const lista = this.respuestas.get(`${metodo} ${ruta}`);
        const respuesta =
          lista && lista.length > 1 ? lista.shift() : lista?.[0];
        if (!respuesta) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ code: 404, message: 'sin respuesta falsa' }),
          );
          return;
        }
        res.writeHead(respuesta.status, { 'Content-Type': 'application/json' });
        res.end(respuesta.crudo ?? JSON.stringify(respuesta.cuerpo ?? null));
      });
    });
    await new Promise<void>((listo) =>
      this.servidor!.listen(0, '127.0.0.1', listo),
    );
    const { port } = this.servidor.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/api/v1`;
    return this;
  }

  async detener(): Promise<void> {
    await new Promise<void>((listo) => this.servidor?.close(() => listo()));
  }
}
