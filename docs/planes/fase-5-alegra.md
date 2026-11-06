# Plan de la fase 5: factura electrónica con Alegra

Estado: **aprobado por Gabriel el 2026-11-06, con ajustes** (estado PENDIENTE en `Emision`, primeras
facturas reales solo a consumidor final, pregunta del plan respondida y decisiones del §12).
Fuentes: `docs/investigacion/alegra-api-2026-11-04.md` (el reporte; 🔴 = sin confirmar), CLAUDE.md y
los ajustes del 2026-10-28 de `docs/prompts/pivote-formalizacion.md` (fase 5 = Alegra, fase 6 = libro
de movimientos; el "Estado y plan" de CLAUDE.md todavía dice "6 Alegra" y se corrige al cerrar). Datos
de ejemplo: ficticios. Siigo **no** se construye.

## 1. Objetivo

Un borrador aprobado con el botón produce **como máximo una** factura en Alegra, y el usuario recibe
número, CUFE y PDF. En desarrollo solo se crean **borradores** en la cuenta de prueba de Gabriel.

## 2. Entorno de desarrollo seguro

- No hay sandbox y `generateStamp: true` puede ser real (🔴). Se desarrolla contra la **cuenta de
  prueba propia de Gabriel** (no habilitada ante la DIAN), creando facturas **sin** `stamp`: quedan
  en borrador en Alegra.
- La emisión real queda detrás de `ALEGRA_EMITIR` (Zod, `false` por defecto). Con `false` el
  adaptador nunca envía `stamp`, aunque el borrador esté aprobado. Al arrancar, el log dice en qué modo
  está (sin el token ni el correo).
- Credenciales solo en `.env`: `ALEGRA_USUARIO` y `ALEGRA_TOKEN`. La cuenta real de la tienda y su token
  **no se usan** hasta pasar la auditoría externa (2) de CLAUDE.md. Ningún test ni CI llama a Alegra.

## 3. Script exploratorio (1 o 2 días, cuenta de prueba)

Un script manual (fuera de CI, con `fetch` de Node 24: sin dependencias nuevas) que, en orden:
`GET /taxes` (id del IVA 19 %), `GET /number-templates`, crear el ítem "Pinturas varias", buscar el
contacto "Consumidor final", crear un contacto ficticio, `POST /invoices` **sin stamp** con
descripción propia, `paymentForm` y `paymentMethod`, y `GET /invoices/{id}?fields=pdf,xml,events`.
Prueba además el largo máximo de `description`, el filtro `client_identification + date`, si
`observations` vuelve en el listado, y si existe una forma de **timbrar un borrador ya creado** (si
existe, cambia el diseño del §4 a dos tiempos y casi elimina el riesgo de duplicado). Las respuestas
se guardan fuera del repo; lo aprendido se agrega al reporte. **Límite:** sin timbrar no se verán el
CUFE ni los estados DIAN; esos nombres quedan para soporte (§10).

## 4. Tabla `Emision` e idempotencia

Campos: `borradorId` **único** (un borrador, una emisión), `proveedor`, `estado`, `idExterno` (texto:
los ids de Alegra pasan a UUID), `numero`, `cufe`, `estadoDian` (PENDIENTE / ACEPTADA / RECHAZADA,
nuestro, no el de Alegra), `codigoError` (sin texto con datos personales) y fechas.
Estados: `PENDIENTE` → `ENVIANDO` → `CREADA_SIN_EMITIR` (modo desarrollo) | `EMITIDA` |
`RECHAZADA` | `NO_CREADA` | `DESCONOCIDO`.

- **Bandeja de salida (*transactional outbox*):** en **una transacción**, el borrador pasa a APROBADO
  y `Emision` nace en PENDIENTE. Después se encola el trabajo `emitir` (BullMQ, `attempts: 1`: nunca
  reintento automático). El worker la pasa a ENVIANDO **justo antes** de la llamada HTTP, con
  `observations = "facturabot:<emisionId>"`.
- **Al arrancar:** toda PENDIENTE se reencola (nunca tocó Alegra, así que es seguro); solo ENVIANDO
  pasa a DESCONOCIDO.
- **201** → se guarda `idExterno` de inmediato; luego se consulta el estado DIAN con trabajos
  diferidos (por ejemplo a 1, 5 y 30 min) y se avisa al usuario.
- **400 con factura creada** (el timbrado falló): RECHAZADA **con** `idExterno`. Ese borrador ya
  existe en Alegra: nunca otro POST; el humano lo resuelve en la web de Alegra.
- **400 sin factura, 401, 402, 403, 429**: NO_CREADA. Se informa; reintentar es una acción explícita
  del usuario.
- **Timeout, error de red, 500, 503 o caída del proceso con la emisión en ENVIANDO**: se
  **reconcilia una vez** listando por `client_identification + date` y buscando
  nuestro id en `observations` (comparación exacta de nuestro lado). Si aparece, se adopta. Si no,
  queda DESCONOCIDO y se le pide al humano revisar Alegra antes de cualquier reintento.

## 5. Puerto `ProveedorFacturacion` y adaptador de Alegra

Interfaz con tres operaciones en términos nuestros: **emitir** (factura con referencia, fecha,
cliente, líneas sin IVA y tasa 19 %, forma de pago), **consultar** (por id externo) y **buscar por
referencia** (para reconciliar). Todo lo de Alegra (ids de impuesto e ítem, `paymentMethod`, forma
del contacto, códigos HTTP, nombres de estados) vive dentro de `alegra/`, con **Zod en cada
respuesta**. Módulo nuevo `emision/`. Ya existe un enum de Prisma con el mismo nombre: se importa con
alias. No se escribe nada genérico para Siigo más allá de esta interfaz.

## 6. Cliente según la Resolución DIAN 000202 de 2025 (art. 3)

- Hoy `camposFaltantes` exige nombre e identificación: contradice el parágrafo 1. Cambio: sin datos
  del comprador, el resumen dice **"Cliente: consumidor final"** antes del botón (nunca en silencio:
  rehacer una factura a nombre equivocado exige nota crédito).
- Si el comprador la pide a su nombre: solo nombre o razón social, tipo y número de documento y correo
  opcional. El bot **nunca pide** teléfono, dirección ni RUT.
- **Choque con Alegra:** sus contactos exigen `regime`, `kindOfPerson` y **dirección con ciudad y
  departamento** para documentos nacionales, y persona natural con nombre y apellido separados. La
  Res. 202 no permite pedir la dirección y no menciona el régimen. No se inventa un valor: es pregunta
  para soporte (§10). **Las primeras facturas reales serán solo a consumidor final** (decisión de
  Gabriel, 2026-11-06), hasta que soporte responda lo de régimen, tipo de persona y dirección; con
  `ALEGRA_EMITIR` encendida, un borrador a nombre de alguien no se emite y se le explica al usuario.
- Verificar si la Res. 227 de 2025 modificó estos artículos (🔴).

## 7. Memoria de clientes

Solo con datos que dio el comprador, **nunca** con datos de la consulta de adquirentes de la DIAN.
Decidido (D4): **sin tabla `Cliente`**; la memoria son los contactos de Alegra, buscados por número
y comparados exactos de nuestro lado (la búsqueda de Alegra es "contiene"). Así no se duplican datos
personales (Ley 1581) ni se copia lo que Alegra haya completado desde la DIAN. Una tabla `Cliente`
propia queda para cuando la pidan Siigo o el panel (fase 7).

## 8. Pendientes de CLAUDE.md que entran en esta fase

Antes de la primera factura real, porque cambian lo que llega a la DIAN: cédula de menos de 4 dígitos
no aprobable; Zod sobre el JSON de `datos` leído de la BD (la emisión lo lee); identificación o total
que cambian en una corrección deben aparecer en el mensaje; "quitamanchas" no cuenta como "quita";
suma parcial mayor que el total con ítems sin valor; ítem reemplazado (caso f); nombres de empresa sin
tipo de sociedad. Quedan fuera (siguen anotados): Zod en Whisper, aviso "no lo reenvíes", advertencia
de voz para valores, el PR de `OLLAMA_MODELO_TEXTO`, y "sí sobre un borrador quieto", que ya no aplica
porque "sí" no aprueba (se borra de CLAUDE.md). En vez del e2e: test de integración de la emisión con
un proveedor falso (201, 400 con y sin factura, timeout, reinicio).

## 9. Fuera del código

- **Notas crédito:** manuales en la web de Alegra, con un procedimiento corto en
  `docs/procedimientos/nota-credito-alegra.md` probado en la cuenta de prueba.
- **Dónde corre el bot (D5, decidido):** todo en el PC de Gabriel, también las primeras facturas
  reales. Durante el piloto el PC **no** trabaja en horario de tienda: el bot se enciende solo en las
  sesiones de prueba. Un servidor, solo si llega un segundo comercio o la disponibilidad se vuelve un
  problema. Con el PC apagado, una aprobación espera en Redis como PENDIENTE y sale al encenderlo.
- **Requisitos del PC antes de la primera factura real:** respaldo diario **cifrado** de PostgreSQL
  guardado fuera del PC; suspensión desactivada mientras el bot esté en uso (hoy, las sesiones de
  prueba; si algún día corre en horario de tienda, ese horario); cuenta de Windows con clave, y
  BitLocker si la edición lo trae (Windows 11 Home suele traer solo el "cifrado de dispositivo": se
  verifica).
- **Plan B ante una caída:** facturar a mano en la web de Alegra, como hoy. Al volver, el borrador de
  esa venta se cancela en el bot para no emitirla dos veces.

## 10. Preguntas para soporte de Alegra (antes de emitir de verdad)

1. ¿Hay ambiente de pruebas por API? ¿Qué pasa con `generateStamp` en una cuenta no habilitada o en
   la prueba de 15 días?
2. ¿Hay clave de idempotencia o referencia buscable? ¿Se puede timbrar un borrador ya creado? ¿Cómo
   evitan duplicados tras un 400?
3. ¿Cómo se llama el campo del CUFE? ¿Hay webhook de aceptación o rechazo de la DIAN y cuánto tarda?
4. ¿Largo máximo de `description` por línea? ¿Un borrador consume consecutivo?
5. Res. 202: ¿qué enviar en `regime`, `kindOfPerson` y dirección cuando no se pueden pedir? ¿Es
   obligatorio el `dv`? ¿Cómo separar nombre y apellidos?
6. ¿El contacto "Consumidor final" sirve en `POST /invoices` por API?
7. ¿Integran la consulta de adquirentes de la DIAN, y por API?
8. ¿Se anula por API una factura emitida o solo con nota crédito? ¿Cómo se revoca el token?
9. (Para la fase 12, no urge) ¿Qué autorización exige un servicio multiempresa sobre la API?

Ya respondida (2026-11-06): la tienda tiene el plan **Contabilidad Emprendedor**, que según la tabla
de precios incluye la API. Si aun así Alegra responde 402, se pregunta a soporte.

## 11. Pasos (en orden, commit y CI por paso)

1. PR del reporte. 2. Script exploratorio y reporte actualizado. 3. Pendientes del §8. 4. Esquema
`Emision` y migración. 5. Puerto y adaptador con Zod y tests. 6. Servicio de emisión, cola,
reconciliación, recuperación al arrancar y test de integración. 7. Consumidor final y cliente
identificado. 8. Mensajes al usuario. 9. Procedimiento de nota crédito. 10. Prueba manual en la cuenta
de prueba y cierre (bitácora, READMEs, CLAUDE.md, tag `v0.5.0`). La primera factura real queda
**fuera** de la fase: necesita la auditoría (2), las respuestas de soporte que la afectan, los
requisitos del PC (§9) y el OK explícito de Gabriel; y será a consumidor final (§6).

## 12. Decisiones

**De Gabriel (2026-11-06):** D1 sí, campos y estados de `Emision` con PENDIENTE (§4). D2 sí,
`ALEGRA_EMITIR` apagada por defecto y sin reintento automático (DESCONOCIDO lo resuelve un humano).
D3 sí, token de la cuenta de prueba en `.env`; el de producción, solo tras la auditoría. D4 contactos
de Alegra, sin tabla propia (§7). D5 todo en el PC de Gabriel (§9). D6 consumidor final por defecto,
visible en el resumen, y las primeras facturas reales solo a consumidor final.
**Las decide el agente y las reporta:** nombres de módulos y variables, textos al usuario, intervalos de
consulta del estado DIAN, formato de `observations`, envío del PDF por Telegram.

**Riesgos:** duplicado por falta de idempotencia (mitigado con el §4; resuelto si existe el timbrado
de un borrador); CUFE y estados sin confirmar hasta hablar con soporte; choque Res. 202 frente a los
contactos de Alegra (mitigado: solo consumidor final al principio); un solo PC sin respaldo
(mitigado con los requisitos del §9 y el plan B manual).
