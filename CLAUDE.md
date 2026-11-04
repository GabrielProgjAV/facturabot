# CLAUDE.md

Reglas y contexto de **facturabot** para agentes de IA (Claude Code y otros). La bitácora detallada
vive en `README.es.md`. Lo personal o propio de un equipo va en `CLAUDE.local.md` (ignorado por git;
Claude Code lo carga automáticamente después de este archivo).

## Qué es

Bot de mensajería para pequeños comercios en Colombia: un texto, una nota de voz o (más adelante) una
foto de factura se convierte en un **borrador**; el usuario lo corrige en texto libre y lo aprueba; y
solo entonces se emite la **factura electrónica ante la DIAN** a través de un proveedor autorizado
(Alegra, luego Siigo). También lleva una base de inventario a partir de los PDF de facturas de compra.
Piloto: un pequeño comercio de pinturas. Meta: producto multiempresa con panel web.

## Quién decide

Gabriel decide. Los agentes proponen, ejecutan lo aprobado y reportan. Nada de arquitectura,
dependencias nuevas, cambios de esquema, cambios de modelo de IA ni cambios de alcance sin aprobación
explícita.

## Flujo por tarea

1. **PLAN** antes de tocar código, de 1 o 2 páginas: objetivo, decisiones con recomendación y riesgos.
   Esperar un "aprobado". Mediciones y relevos van en la bitácora, no en el plan. Antes de proponer
   algo: "si no lo hago, ¿qué le pasa al piloto con un solo usuario de confianza?"; si es "nada
   grave", se anota como pendiente para antes de tener más usuarios y no se implementa.
   - **Decisiones irreversibles** (esquema, emisión, dependencias, modelo de IA, seguridad): se le
     preguntan a Gabriel. **Reversibles** (textos, mensajes, umbrales): las decide el agente y las
     reporta.
   - Con un alcance aprobado, los pasos se hacen en orden, con commit y CI en verde por paso, sin
     detenerse: se reporta al final o cuando aparezca una decisión irreversible.
2. **Rama** `tipo/descripcion` (`feat/`, `fix/`, `docs/`, `chore/`) creada desde `main` actualizada.
   Nunca commits directos a `main` (está protegida: exige PR y CI en verde). Commits con prefijos de
   Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`). Integración por **squash**.
3. **Antes del PR**, en `apps/api`: `pnpm run lint`, `pnpm exec prettier --check src test`,
   `pnpm exec tsc --noEmit -p tsconfig.json` y `pnpm test` en verde; migración de Prisma si cambia el
   esquema. Revisar el diff completo en busca de secretos y datos reales. Correr los subagentes
   `control-calidad` y `seguridad` (`.claude/agents/`). Pruebas de mutación solo en predicados
   críticos (aprobar, emitir, DV, totales).
4. **Reporte del PR:** qué se hizo (archivo por archivo), por qué, cómo probarlo, riesgos y decisiones
   pendientes para Gabriel.
5. Al cerrar una subfase: actualizar la bitácora (`README.es.md`, solo en español) y el estado del
   roadmap en los dos README (el inglés es un resumen corto). Al cerrar cada subfase, actualizar también **Estado y plan** del
   CLAUDE.md.
6. Cada fase terminada recibe un tag anotado `vX.Y.0` (hechos: `v0.1.0`, `v0.2.0`, `v0.3.0`).

## IA

- **Modelo de texto oficial: `qwen2.5:7b`** (Ollama). Whisper: `large-v3-turbo`. Ningún agente cambia
  `OLLAMA_MODELO_TEXTO`, las instrucciones del intérprete ni el modelo de Whisper sin pasar por el set
  de evaluación y sin aprobación.
- **La IA solo extrae.** Los cálculos, la aprobación y las validaciones los hace el código.
- Cuando el código detecte algo raro (un valor que no aparece en el mensaje, un ítem que desaparece,
  JSON inválido, timeout, NIT con dígito de verificación incorrecto): lo registra y le pregunta al
  usuario. Nunca lo corrige ni lo deja pasar en silencio.

## Seguridad y datos (no negociables)

- Nada se emite ante la DIAN sin aprobación humana explícita, reconocida por código.
- Toda emisión es idempotente: un borrador produce como máximo una factura.
- El repo es **PÚBLICO**. Secretos solo en `.env`. Nunca subir audios, fotos, transcripciones ni datos
  reales. Revisar el diff antes de cada push. Nunca `git push --all`.
- **Todo NIT o cédula en código, tests, docs o commits debe ir marcado como ficticio** (p. ej.
  `900000001 (ficticio)` o en un comentario junto al dato).
- Nunca imprimir en los logs tokens, NIT, nombres ni el texto de los mensajes (Ley 1581 de 2012).
- Validar con Zod todo lo que entra: salida de la IA, JSON leído de la BD y respuestas externas.
- Antes de instalar o descargar cualquier cosa, pedir OK e indicar el tamaño real en disco.
- Pruebas contra Alegra solo en una cuenta de prueba, nunca en la real (emitiría ante la DIAN).

## Comunicación

- Responder en **español**. Gabriel está aprendiendo: explicar el porqué de cada decisión, qué
  alternativa también era buena y qué estudiar (documentación oficial, términos de búsqueda).
- Pasos pequeños, narrando qué se hace, sin ir demasiado lento.
- Mejores prácticas, sin abstracciones que hoy no se usan.

## Stack

| Pieza | Elección |
|---|---|
| Canal (desarrollo) | Telegram con **grammY**, *long polling* (sin ngrok). Solo usuarios (`ctx.from.id`) en `TELEGRAM_CHATS_PERMITIDOS` y solo en chats privados |
| Canal (producción, fase 10) | WhatsApp Cloud API de Meta o Twilio, como otro adaptador. Nunca librerías no oficiales |
| Emisión DIAN | Vía proveedor: Alegra → Siigo |
| Backend | TypeScript + **NestJS 12** en `apps/api` (TS estricto, Vitest, Oxlint, Prettier) |
| Runtime | **Node 24 LTS** (`.nvmrc`, gestionado con fnm), **pnpm 12** |
| Base de datos | **PostgreSQL 18 + Prisma 7** (cliente generado en `src/generated/prisma`, ignorado por git) |
| Validación | **Zod** (configuración, salida de la IA) |
| IA texto | Ollama, **`qwen2.5:7b`** (oficial) |
| Voz | Contenedor `whisper` (`onerahmet/openai-whisper-asr-webservice`, faster-whisper en CPU, **`large-v3-turbo`**) |
| Cola | Redis + **BullMQ** (desde la fase 4.3; clave en la fase 6 por reintentos e idempotencia) |
| Infra local | Docker Compose: PostgreSQL `localhost:5433`, Redis `localhost:6379`, Whisper `localhost:9000` |
| CI | GitHub Actions (`.github/workflows/ci.yml`): lint, Prettier, tipos y tests en cada PR |

## Arquitectura (`apps/api/src`)

- `config/env.schema.ts`: variables de entorno validadas con Zod al arrancar (falla rápido).
- `mensajeria/`: `mensaje.ts` (independiente del canal), `telegram.service.ts` (adaptador grammY: valida
  y encola), `cola-mensajes.service.ts` (Queue y Worker de BullMQ) y `procesador-mensajes.ts` (lógica de
  cada trabajo, esquema Zod de los datos que vienen de Redis).
  La interfaz formal `CanalMensajeria` se escribe cuando llegue el segundo canal.
- `facturacion/`: `factura.ts` (funciones puras: pesos, faltantes, suma, IVA, resumen,
  `motivoNoAprobable`, nombre de empresa, ítems que desaparecen sin nombrarlos y valores cambiados
  sin aparecer en el mensaje), `identificacion.ts` (NIT y cédula: forma y DV),
  `interprete-texto.service.ts` (Ollama + esquema Zod), `conversacion.service.ts` (borradores: crear,
  corregir, cancelar y aprobar **solo con el botón "✅ Aprobar"** (`a:<borradorId>:<versión>`), si es
  el mismo borrador y `version == versionMostrada ==` la del botón; "sí" ya no aprueba. Un PENDIENTE
  quieto más de 2 h se cancela con el siguiente mensaje, y su botón pide confirmar otra vez).
- `voz/`: `transcriptor.service.ts` (audio → texto con Whisper) y `duracion-ogg.ts` (duración real
  de la nota).
- `prisma/`: `PrismaService` global. Esquema en `apps/api/prisma/schema.prisma`.

## Decisiones de negocio

- **Modo simple** (por defecto): a Alegra va 1 línea, cantidad 1, precio = total escrito, con el
  producto existente "Pinturas varias"; la descripción lleva lo que se alcance a leer. El detalle se
  guarda en nuestra BD. Configurable por empresa a modo detallado.
- **IVA:** el total escrito no incluye IVA; se envía como base con IVA 19 % y el proveedor lo calcula.
- **Pesos colombianos:** `78.000` = 78 mil; lo normaliza `parsePesos`.
- **Total:** solo se acepta un total que el usuario escribió (`totalSegunMensaje`); si no, se suman
  los ítems.
- **Inventario:** en la fase 5 solo entradas desde PDF de compra; descontar ventas, en la fase 8.

## Comandos

```bash
docker compose up -d --wait   # PostgreSQL, Redis y Whisper
cd apps/api
pnpm install
pnpm run db:migrate           # migraciones de Prisma
pnpm run start:dev            # API + bot (EADDRINUSE en :3000 = ya hay una copia corriendo)
pnpm test                     # tests unitarios
```

Ollama debe estar corriendo con el modelo oficial descargado.

## Estado y plan

- ✅ Fases 0–3: validación, base, bot eco en Telegram y factura por texto (tags `v0.1.0`–`v0.3.0`).
- ✅ Fase 4 voz (`feat/fase-4-voz`, PR #3 listo para revisión, auditoría externa hecha; tag `v0.4.0` tras integrarlo): 4.1 Whisper,
  4.2 transcripción, 4.3 cola BullMQ, 4.4 voz → borradores con aprobación solo con botón. Alcance y
  pendientes en §0 de `docs/planes/fase-4.4-voz-borradores.md`; bitácora en `README.es.md`.
- **Auditoría externa independiente** (`docs/prompts/auditoria-seguridad.md`), obligatoria en dos
  momentos: (1) antes de integrar el PR #3 de la fase 4 (hecha el 2026-11-04: recomienda integrar, sin bloqueantes) y (2) **antes de usar
  el token de producción de Alegra** (no antes de empezar la fase 6: se puede desarrollar contra la
  cuenta de prueba). Hasta que la (2) pase, ningún agente configura ni usa ese token.
- **Obligatorio antes de emitir la primera factura real (Alegra)**: los 5 hallazgos medios de la
  auditoría del PR #3 (`docs/auditorias/2026-11-04-pr3.md`) están corregidos en el PR #5
  (`fix/validacion-datos`, integrado en `main`). Queda como límite conocido: un NIT de 8 dígitos sin DV y con nombre de
  persona pasa como cédula (solo una consulta al RUT lo detectaría). Pendientes de su revisión de
  seguridad, antes de Alegra: exigir que una identificación o un total que cambian en una corrección
  aparezcan en el mensaje; "quitamanchas" cuenta como "quita"; nombres de empresa sin tipo de
  sociedad; y una cédula de menos de 4 dígitos no es aprobable (decidido por Gabriel el 2026-11-04,
  reversible; se implementa en la fase de Alegra).
- **Antes de Alegra** (no obligatorio para la primera prueba): suma parcial mayor que el total con
  ítems sin valor; advertencia de voz también para valores y total; Zod en la respuesta de Whisper;
  "sí" sobre un borrador quieto sin aviso de fecha; el aviso "no lo reenvíes" junto al "⏳ Sigo
  procesando…"; validar con Zod el JSON de `datos` leído de la BD; detectar un ítem reemplazado (caso f
  del set de evaluación); PR aparte: `OLLAMA_MODELO_TEXTO` por defecto a `qwen2.5:7b`; test e2e.
- **Antes de más usuarios:** `app.listen` en `127.0.0.1`; límite de respuestas a no autorizados; un PR
  aparte para actualizar `prisma` y `@nestjs/platform-express`; bloquear la aprobación si la
  identificación vino de voz (hoy solo advierte); preguntar con botones ante un borrador quieto;
  límites de longitud en la salida de la IA; y el resto de pendientes de §0 del plan de la 4.4.
- **Proceso vigente (desde 2026-11-02):** planes cortos; las decisiones irreversibles se preguntan y las
  reversibles se deciden y se reportan; con un alcance aprobado los pasos van en orden con commit y CI
  por paso; mutaciones solo en predicados críticos; bitácora solo en español.
- Después: 5 PDF → inventario · 6 Alegra · 7 clientes y notas crédito · 8 reportes · 9 fotos · 10 WhatsApp · 11 Siigo · 12 multiempresa.

## Preguntas abiertas

- Alegra: ¿la línea de factura admite descripción propia? ¿cómo se indica el IVA 19 % por línea?
- Fase 8: cómo descontar inventario si a Alegra va una línea genérica.
