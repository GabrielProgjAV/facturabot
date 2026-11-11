# Plan de la fase 5: factura electrónica con Alegra

Estado: **aprobado por Gabriel el 2026-11-06, con ajustes** (estado PENDIENTE en `Emision`, primeras
facturas reales solo a consumidor final, pregunta del plan respondida y decisiones del §12). El mismo
día, tras el script exploratorio, aprobó la **emisión en dos tiempos** (§4).
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
- Credenciales solo en `.env`: **`ALEGRA_TOKEN`**, un JWT de Integraciones que va en
  `Authorization: Bearer` (probado el 2026-11-06 contra `api.alegra.com/api/v1`; no hace falta
  `ALEGRA_USUARIO`). El JWT **vence** (el de prueba, a los 16 días) y trae dentro datos del usuario y
  una `api_key`: se trata entero como secreto y nunca se decodifica en los logs.
- **Vencimiento:** al arrancar, el código lee solo el campo `exp` del token (sin imprimir nada más).
  Si faltan menos de 5 días, el log lo avisa y el bot se lo dice al usuario autorizado una vez al día;
  si ya venció, la emisión queda apagada con un aviso claro (los borradores siguen funcionando). Un
  401 de Alegra se trata como NO_CREADA "token vencido o revocado".
- La cuenta real de la tienda y su token
  **no se usan** hasta pasar la auditoría externa (2) de CLAUDE.md. Ningún test ni CI llama a Alegra.
- **Requisito antes de la primera factura real:** el token de la cuenta real se crea con **permisos
  mínimos**: facturas, contactos, ítems, impuestos y numeraciones. Sin eliminar, anular, bancos ni POS.

## 3. Script exploratorio (hecho el 2026-11-06, cuenta de prueba)

Resultado en la "Actualización del 2026-11-06" del reporte; el script es `apps/api/scripts/explorar-alegra.ts`. Lo que pedía:

Un script manual (fuera de CI, con `fetch` de Node 24: sin dependencias nuevas) que, en orden:
`GET /taxes` (id del IVA 19 %), `GET /number-templates`, crear el ítem "Pinturas varias", buscar el
contacto "Consumidor final", crear un contacto ficticio, `POST /invoices` **sin stamp** con
descripción propia, `paymentForm` y `paymentMethod`, y `GET /invoices/{id}?fields=pdf,xml,events`.
Prueba además el largo máximo de `description`, el filtro `client_identification + date`, si
`observations` vuelve en el listado, y si existe una forma de **timbrar un borrador ya creado**
(existe: por eso el §4 es en dos tiempos). Las respuestas
se guardan fuera del repo; lo aprendido se agrega al reporte. **Límite:** sin timbrar no se verán el
CUFE ni los estados DIAN; esos nombres quedan para soporte (§10).

## 4. Tabla `Emision` e idempotencia: emisión en dos tiempos

Diseño aprobado por Gabriel el 2026-11-06: **(1)** `POST /invoices` **sin** `stamp` (crea un
borrador en Alegra) → se guarda su id → **(2)** `POST /invoices/stamp` con `{"ids": [ese id]}`.
Repetir el paso 2 sobre el mismo id no duplica: Alegra responde el código **3226** ("ya está
emitida"). El riesgo de duplicado queda solo en el paso 1.

Campos: `borradorId` **único** (un borrador, una emisión), `proveedor`, `estado`, `idExterno`
(texto), `numero`, `cufe`, `estadoDian` (PENDIENTE / ACEPTADA / RECHAZADA, nuestro, no el de
Alegra), `codigoError` (sin texto con datos personales) y fechas.
Estados: `PENDIENTE` → `CREANDO_BORRADOR` → `BORRADOR_CREADO` (con `idExterno`) → `TIMBRANDO` →
`EMITIDA` | `RECHAZADA`, más `DESCONOCIDO` (solo timeout al crear el borrador) y `NO_CREADA` (error
definitivo al crearlo).

- **El borrador en Alegra se crea solo dentro del trabajo de emisión**, justo antes de timbrar;
  nunca mientras el borrador del bot está en corrección. Así cada borrador de Alegra se timbra
  enseguida y se minimizan los huecos de numeración.
- **Bandeja de salida (*transactional outbox*):** en **una transacción**, el borrador del bot pasa a
  APROBADO y `Emision` nace en PENDIENTE, con la `date` que se enviará, el modo (`ALEGRA_EMITIR`) y
  la cuenta de Alegra. Después se encola `emitir` (BullMQ, `jobId = emitir-<emisionId>`,
  `attempts: 1`, `maxStalledCount: 0`, `concurrency: 1`).
- **`fecha_factura` en hora de Colombia** (precisión de Gabriel, 2026-11-10; se implementa en el
  paso 5): el día se calcula en `America/Bogota`, nunca en UTC. Una venta a las 9 p. m. en Colombia
  ya es el día siguiente en UTC. Se guarda como `DATE` y se envía tal cual a Alegra; test con una
  hora de las 7 p. m. a la medianoche de Colombia.
- **Paso a CREANDO_BORRADOR atómico y guardado antes del POST:** `UPDATE … WHERE estado =
  'PENDIENTE'`; si no cambia ninguna fila, el trabajo se aborta. `observations =
  "facturabot:<emisionId>"`. Al arrancar, un candado de una sola instancia (`pg_try_advisory_lock`)
  impide que dos copias del bot recuperen o emitan a la vez.
- **Paso 1, cualquier 2xx con id válido (Zod), o 400 que trae la factura creada** → BORRADOR_CREADO y
  se guarda `idExterno` de inmediato. Con `ALEGRA_EMITIR` apagada (desarrollo), la emisión **termina
  aquí** y esa fila nunca se timbra, aunque después se encienda la bandera o cambie el token.
- **Paso 1, 400 sin factura, 401, 402, 403 o 429** → NO_CREADA; se informa y reintentar es una acción
  explícita del usuario.
- **Paso 1, timeout, error de red, 5xx, otro código o 2xx que no pasa Zod** → DESCONOCIDO, y se
  **reconcilia** a 1 y 5 min: se lista por `client_identification` + la `date` guardada, recorriendo
  todas las páginas, y se compara `observations` de nuestro lado (el filtro de Alegra por
  `observations` no funciona). Si aparece → BORRADOR_CREADO con ese id; si no, el humano revisa
  Alegra. El reintento manual vuelve a reconciliar y pide confirmar con botón. **Nunca** se repite el
  paso 1 automáticamente.
- **Antes de cada paso 2:** `GET /invoices/{id}` y se exige `observations == facturabot:<emisionId>`
  (y misma cuenta y modo). Si no coincide → DESCONOCIDO y aviso: nunca se timbra una factura que no
  creamos.
- **Paso 2:** TIMBRANDO → resultado validado con Zod **para nuestro id** → `success` → EMITIDA; luego
  se consulta el estado DIAN con trabajos diferidos (por ejemplo a 1, 5 y 30 min) y se avisa al
  usuario. Error de validación de esa factura → RECHAZADA **con** `idExterno` (el humano la resuelve
  en la web de Alegra; nunca otro paso 1).
- **Paso 2, timeout, red o 5xx** → se **repite el stamp del mismo id** (hasta 3 veces, con espera).
  **3226** = ya estaba emitida → se consulta y queda EMITIDA. Si los intentos se acaban (o hay 401),
  queda en TIMBRANDO con aviso y se reintenta al arrancar.
- **Al arrancar** (con el candado): PENDIENTE se reencola, salvo si lleva más de 2 h, que se pregunta
  con botones "Emitir / Ya la facturé a mano" (plan B del §9; una PENDIENTE se puede cancelar);
  CREANDO_BORRADOR pasa a DESCONOCIDO y se reconcilia; BORRADOR_CREADO (solo modo real) y TIMBRANDO
  repiten el paso 2; EMITIDA con estado DIAN pendiente y RECHAZADA se vuelven a consultar.

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

**Hecho el 2026-11-06 (paso 3, PR #9)**; los nombres de negocio sin tipo de sociedad solo advierten,
porque una persona natural comerciante factura con su cédula. Antes de la primera factura real, porque cambian lo que llega a la DIAN: cédula de menos de 4 dígitos
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
  prueba; si algún día corre en horario de tienda, ese horario); sesión del sistema operativo con
  clave, y disco cifrado si el equipo lo permite. Y un **procedimiento de restauración**: con los
  workers apagados, comparar las facturas de Alegra con `observations` `facturabot:` desde la fecha
  del respaldo contra `Emision`, y corregir antes de arrancar (si no, se reemitiría lo ya emitido).
- **Plan B ante una caída:** facturar a mano en la web de Alegra, como hoy. Al volver, el borrador de
  esa venta se cancela en el bot para no emitirla dos veces.

## 10. Preguntas para soporte de Alegra (antes de emitir de verdad)

1. ¿Hay ambiente de pruebas por API? ¿Qué pasa con `generateStamp` en una cuenta no habilitada o en
   la prueba de 15 días?
2. ¿Hay clave de idempotencia o referencia buscable? (El filtro por `observations` se ignora.)
   ¿`POST /invoices/stamp` sobre un borrador se comporta igual en una cuenta habilitada?
3. ¿Cómo se llama el campo del CUFE? ¿Hay webhook de aceptación o rechazo de la DIAN y cuánto tarda?
4. ¿Largo máximo de `description` por línea **al timbrar**? (Un borrador acepta 20.000 caracteres.)
5. Res. 202: ¿qué enviar en `regime`, `kindOfPerson` y dirección cuando no se pueden pedir? ¿Es
   obligatorio el `dv`? ¿Cómo separar nombre y apellidos?
6. ¿El contacto "Consumidor final" sirve al **timbrar** por API? (Para un borrador sí sirve.)
7. ¿Un borrador que nunca se timbra deja un hueco en la numeración electrónica de la DIAN, y eso es
   un problema? ¿Cómo se anula o descarta ese borrador? (En la cuenta de prueba, con numeración no
   electrónica, cada borrador consumió un número.)
8. ¿Integran la consulta de adquirentes de la DIAN, y por API?
9. ¿Se anula por API una factura emitida o solo con nota crédito? ¿Cómo se revoca el token? ¿Se puede
   emitir un JWT de Integraciones con vencimiento más largo, o el token clásico (Basic) sigue
   vigente y sin vencimiento? (La página de autenticación de la API solo documenta Basic.)
10. (Para la fase 12, no urge) ¿Qué autorización exige un servicio multiempresa sobre la API?

Ya respondida (2026-11-06): la tienda tiene el plan **Contabilidad Emprendedor**, que según la tabla
de precios incluye la API. Si aun así Alegra responde 402, se pregunta a soporte.

## 11. Pasos (en orden, commit y CI por paso)

1. PR del reporte. 2. Script exploratorio y reporte actualizado. 3. Pendientes del §8. 4. Esquema
`Emision` y migración. 5. Puerto y adaptador con Zod y tests. 6. Servicio de emisión, cola,
reconciliación, recuperación al arrancar y test de integración. 7. Consumidor final y cliente
identificado. 8. Mensajes al usuario. 9. Procedimiento de nota crédito. 10. Prueba manual en la cuenta
de prueba y cierre (bitácora, READMEs, CLAUDE.md, tag `v0.5.0`). La primera factura real queda
**fuera** de la fase: necesita la auditoría (2), las respuestas de soporte que la afectan, los
requisitos del PC (§9), el token real con permisos mínimos (§2) y el OK explícito de Gabriel; y será
a consumidor final (§6).

## 12. Decisiones

**De Gabriel (2026-11-06):** D1 sí, campos y estados de `Emision` con PENDIENTE (§4). D2 sí,
`ALEGRA_EMITIR` apagada por defecto y sin reintento automático de la creación del borrador
(DESCONOCIDO lo resuelve un humano; repetir el stamp del mismo id sí es automático, porque no duplica).
D3 sí, token de la cuenta de prueba en `.env`; el de producción, solo tras la auditoría. D4 contactos
de Alegra, sin tabla propia (§7). D5 todo en el PC de Gabriel (§9). D6 consumidor final por defecto,
visible en el resumen, y las primeras facturas reales solo a consumidor final. D7 emisión en dos
tiempos, con el borrador de Alegra creado solo dentro del trabajo de emisión (§4).
**De Gabriel (2026-11-06, tras la revisión de seguridad del PR #8):** sí a los ajustes del §4; D8
estado `NO_CREADA`; D9 `Emision` guarda la `date` enviada, el modo y la cuenta de Alegra; D10 repetir
el stamp hasta 3 veces con espera.
**Las decide el agente y las reporta:** nombres de módulos y variables, textos al usuario, intervalos de
consulta del estado DIAN, formato de `observations`, envío del PDF por Telegram.

**Riesgos:** duplicado solo si falla la creación del borrador por timeout (mitigado con la
reconciliación del §4; el timbrado repetido no duplica); huecos de numeración por borradores que no
se timbran (pregunta 7); CUFE y estados sin confirmar hasta hablar con soporte; choque Res. 202 frente a los
contactos de Alegra (mitigado: solo consumidor final al principio); un solo PC sin respaldo
(mitigado con los requisitos del §9 y el plan B manual).
