# Plan de la fase 5: factura electrónica con Alegra

Estado: **aprobado por Gabriel el 2026-11-06, con ajustes** (estado PENDIENTE en `Emision`, primeras
facturas reales solo a consumidor final, pregunta del plan respondida y decisiones del §12). El mismo
día, tras el script exploratorio, aprobó la **emisión en dos tiempos** (§4).
Fuentes: `docs/investigacion/alegra-api-2026-11-04.md` (el reporte; 🔴 = sin confirmar), CLAUDE.md y
los ajustes del 2026-10-28 de `docs/prompts/pivote-formalizacion.md` (fase 5 = Alegra, fase 6 = libro
de movimientos; el "Estado y plan" de CLAUDE.md todavía dice "6 Alegra" y se corrige al cerrar). Datos
de ejemplo: ficticios. Siigo **no** se construye.

**Cambio de contexto (Gabriel, 2026-11-12):** la tienda va a cancelar Alegra y **el proveedor final
del piloto será probablemente Siigo**. Se sigue con Alegra para construir y probar la emisión contra
una API real (la cuenta de prueba vence alrededor del 21 de noviembre). Por eso el adaptador de
Alegra es **mínimo** (consumidor final, crear borrador, timbrar y consultar); todo lo genérico
(puerto, estados, reconciliación, cola) se separa para reusarlo con Siigo; y la prioridad es llegar
al paso 6.

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
- **Cuenta (`emisiones.cuenta_proveedor`)** (decisión de Gabriel, 2026-11-12): el campo `org` del
  JWT, un UUID por organización. `GET /company` no trae un id, solo el NIT de la empresa, que podría
  coincidir entre la cuenta de prueba y la real. **`org` no está documentado por Alegra** (pregunta
  11 del §10). Si el token no trae `org` o no tiene forma de UUID, el bot se niega a emitir. Nunca se
  registra completo: al arrancar, el log muestra solo sus últimos 4 caracteres.
- **Vencimiento:** al arrancar, el código lee solo los campos `exp` y `org` del token (sin imprimir nada más).
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
  hora de las 7 p. m. a la medianoche de Colombia. Solo se puede actualizar mientras la emisión
  esté en PENDIENTE y sin `id_externo` (si el PC estuvo apagado días, sale con la fecha del día en
  que se emite).
- **Protecciones en la base** (migración `proteger_emisiones`, revisión de seguridad del PR #10):
  triggers y CHECK hacen que borrador, proveedor, cuenta y modo no cambien, que el `id_externo` se
  guarde una sola vez, que EMITIDA y CANCELADA sean finales, que la emisión solo nazca de un
  borrador APROBADO y que un borrador que ya no está PENDIENTE no cambie.
- **Para los pasos 5 y 6** (de la misma revisión, aprobado por Gabriel el 2026-11-10):
  - Leer `fecha_factura` siempre en UTC (`toISOString().slice(0, 10)`): Prisma devuelve un `DATE`
    como medianoche UTC, y formateado en hora de Bogotá daría el día anterior. Con test.
  - Filtrar por proveedor, cuenta y modo **en la consulta**, antes de cualquier llamada a Alegra:
    una fila de otra cuenta se reporta y nunca causa ni un `GET`.
  - Pasar `id_externo` y la cuenta por Zod a una forma canónica antes de guardarlos o compararlos.
  - **Obligatorio antes de usar datos reales:** base aparte para `test:int` (nombre terminado en
    `_test`) y una guarda que se niegue a correr en otra base.
  - Supresión de datos (Ley 1581): se anonimiza `borradores.datos`; la fila y la factura se
    conservan.
  - **Pendiente obligatorio antes de tener datos reales** (Gabriel, 2026-11-10): el trigger
    `borradores_proteger_no_pendientes` impide anonimizar `datos` de un borrador APROBADO, y eso
    choca con la supresión anterior. Hay que definir una excepción controlada (por ejemplo,
    permitir solo el cambio a una forma anonimizada fija). Sin resolver todavía.
- **Pendiente obligatorio antes del código de emisión (paso 6)**: segunda revisión de seguridad del
  PR #10, del 2026-11-10. Cambia el esquema, así que lo decide Gabriel.
  - **Alta:** `DELETE` de una emisión no está protegido. El borrador sigue APROBADO, se puede
    insertar otra emisión y repetir el paso 1, lo que duplica la factura. Propuesta: `BEFORE DELETE`
    que siempre rechace. Los tests limpian con transacción revertida o sobre la base `_test`.
  - `TRUNCATE` no dispara los triggers por fila. Propuesta: `BEFORE TRUNCATE` en `emisiones` y
    `borradores` que siempre rechace.
  - Un `INSERT` puede nacer en un estado avanzado (BORRADOR_CREADO, EMITIDA…). Propuesta: exigir
    PENDIENTE y sin `id_externo`, número, CUFE ni código de error al nacer; los tests recorren las
    transiciones con UPDATE.
  - Transiciones como lista de **permitidas** (no de prohibidas), por ejemplo: PENDIENTE →
    CREANDO_BORRADOR o CANCELADA; CREANDO_BORRADOR → BORRADOR_CREADO, NO_CREADA o DESCONOCIDO;
    DESCONOCIDO → BORRADOR_CREADO o PENDIENTE; BORRADOR_CREADO → TIMBRANDO o DESCONOCIDO;
    TIMBRANDO → EMITIDA o RECHAZADA; RECHAZADA → TIMBRANDO o EMITIDA; NO_CREADA → PENDIENTE.
    Gabriel confirma la tabla.
  - La fecha se puede cambiar tras DESCONOCIDO → PENDIENTE, y entonces la reconciliación buscaría
    por otra fecha. Opciones: marca de "ya salió de PENDIENTE", o pasar por NO_CREADA (humano
    confirma que no existe) antes de volver a PENDIENTE. Decide Gabriel.
  - Aprobación coherente en `borradores`: APROBADO exige `aprobado_por` y `aprobado_en` (CHECK), y
    PENDIENTE → APROBADO no puede cambiar `datos` ni `version`, y exige `version_mostrada =
    version`.
  - Bajas: `numero`, `cufe` y `emitida_en` se escriben una vez; `estado_dian` no sale de ACEPTADA o
    RECHAZADA; SOLO_BORRADOR sin `estado_dian`; `codigo_error` con prefijo conocido
    (`http_`, `alegra_`…); `SET search_path` en las funciones; textos sin espacios al inicio o al
    final.
  - **Antes del token de producción:** la app se conecta con el usuario dueño de las tablas
    (superusuario en la imagen oficial), que puede apagar los triggers. Separar un rol para
    migraciones y otro para la app, sin DELETE ni TRUNCATE. Decide Gabriel.
  - Prueba de integración del paso 6: nunca se timbra una fila de otra cuenta ni de otro modo.
- **Para el paso 6, de la revisión de seguridad del paso 5 (PR del adaptador):**
  - `ErrorProveedor.definitivo` vale **solo en `crearBorrador`**. Ningún error de `timbrar` o
    `consultar` devuelve una emisión con `id_externo` a PENDIENTE ni a NO_CREADA.
  - Agregar al puerto `buscarPorReferencia` (todas las páginas, Zod, comparar `observations` de
    nuestro lado) para reconciliar DESCONOCIDO, y reconciliar también antes de un reintento manual
    del paso 1.
  - Registrar los errores solo con `describirError` (nunca el objeto entero, que trae `cause`).
- **Antes del token de producción:** comprobar que el `org` del token de prueba y el de la cuenta
  real son distintos (comparando solo sus sufijos), y que en producción `ALEGRA_URL` sea
  `api.alegra.com`.
- **Límite conocido:** el aviso diario del token se marca antes de enviar; si ese envío falla, ese
  día no se repite.
- **Decisiones de Gabriel para el paso 6 (2026-11-12):**
  - **Tercera migración** en el mismo PR, antes del servicio: `DELETE` y `TRUNCATE` bloqueados en
    `emisiones` y `borradores`; una emisión solo nace en PENDIENTE y sin id externo; transiciones
    como lista de **permitidas**; un APROBADO exige quién y cuándo, y aprobar no cambia `datos` ni
    `version`. **Nunca se desactivan los triggers**, ni en la base de desarrollo ni en la real.
    Borrar datos personales (Ley 1581) será por **anonimización**, nunca con `DELETE`, y necesita
    la excepción controlada pendiente.
  - **DESCONOCIDO no vuelve directo a PENDIENTE.** Antes de pedirle nada al usuario, búsqueda
    automática con la fecha **original** y el día siguiente; si aparece `facturabot:<emisionId>` en
    `observations`, se reconcilia sola. Si no, el bot dice qué buscar en Alegra (fecha original,
    cliente y `facturabot:<emisionId>`) y ofrece el botón "No existe en Alegra": solo el usuario
    autorizado puede tocarlo, y queda registrado quién y cuándo. Con eso pasa a NO_CREADA, y desde
    ahí se puede reintentar (NO_CREADA → PENDIENTE).
  - **Cliente (adelanto del paso 7):** sin nombre ni identificación es "consumidor final" y se
    emite. Con NIT o cédula **no** se ofrece el "✅ Aprobar" normal: antes del botón se avisa que
    esa venta no se facturará y no se crea emisión. A medias (nombre sin identificación o al revés)
    el bot pide el dato o que diga "consumidor final". Los datos que vació `sinDatosNoDichos` no
    cuentan como consumidor final.
  - **Sin token válido** (falta, venció o no trae cuenta): no se crea emisión, el aviso sale
    **antes** del botón de aprobar, y ese borrador queda marcado **para siempre** como "facturar a
    mano": nunca se emite después, aunque vuelva el token (sería un duplicado).
  - **NO_CREADA → CANCELADA** (Gabriel, 2026-11-12), con el mismo quién y cuándo de "Ya la facturé
    a mano": si se facturó a mano, no puede quedar abierta la opción de reintentar.
- **Cómo quedó en la migración `cerrar_emisiones`** (paso 6):
  - `borradores.destino_factura` (`PROVEEDOR` / `MANUAL` / `SIN_FACTURA`) se fija al aprobar y
    nunca cambia; solo `PROVEEDOR` puede tener emisión. `MANUAL` = "facturar a mano" (sin token
    válido); `SIN_FACTURA` = borrador con NIT o cédula. Los 7 APROBADO viejos de la base de
    desarrollo quedaron `MANUAL`.
  - `emisiones.no_existe_confirmado_por/_en` ("No existe en Alegra") y `cancelada_por/_en` ("Ya la
    facturé a mano"); sin ellos la base rechaza DESCONOCIDO → NO_CREADA y todo paso a CANCELADA.
  - Transiciones permitidas: PENDIENTE → CREANDO_BORRADOR o CANCELADA; CREANDO_BORRADOR →
    BORRADOR_CREADO, NO_CREADA o DESCONOCIDO; DESCONOCIDO → BORRADOR_CREADO o NO_CREADA;
    BORRADOR_CREADO → TIMBRANDO o DESCONOCIDO; TIMBRANDO → EMITIDA o RECHAZADA; RECHAZADA →
    TIMBRANDO o EMITIDA; NO_CREADA → PENDIENTE o CANCELADA. Quedarse en el mismo estado (para
    completar número, CUFE o contar intentos) no es una transición.
- **Borrador con NIT o cédula (propuesta del agente, reversible: textos y botones):** el resumen
  dice antes de los botones que esa venta no se facturará desde el bot (por ahora solo consumidor
  final) y que, si el cliente la necesita, se factura a mano. En lugar de "✅ Aprobar" lleva
  "📝 Registrar sin factura", que cierra el borrador como APROBADO con destino `SIN_FACTURA` y sin
  emisión. Nunca queda colgado bloqueando el chat: se cierra con ese botón, con "cancelar", o
  corrigiéndolo a consumidor final (vuelve el "✅ Aprobar" normal); y si queda quieto más de 2 h, el
  siguiente mensaje lo cancela (regla de la 4.4). El mismo botón con otro texto sirve para "facturar
  a mano" (destino `MANUAL`).
- **RECHAZADA → EMITIDA:** cuando una consulta (al arrancar o en los trabajos diferidos) encuentra
  timbrada esa factura sin que el bot la haya vuelto a timbrar; por ejemplo, el humano corrigió el
  dato en la web de Alegra y la timbró allí. Si es el bot el que reintenta, pasa por TIMBRANDO.
- **TIMBRANDO tras un timeout:** la fila se queda en TIMBRANDO (no tiene salida a PENDIENTE,
  NO_CREADA, DESCONOCIDO ni CANCELADA, porque ya tiene `id_externo` y puede estar timbrada). La
  recupera el propio trabajo, que repite el paso 2 sobre el **mismo id** hasta 3 veces, y si se
  acaban, el arranque siguiente. Cada intento hace primero `GET`: si ya está timbrada → EMITIDA; si
  sigue en borrador → `stamp` otra vez (3226 = ya emitida → EMITIDA); un rechazo explícito →
  RECHAZADA. Nunca vuelve al paso 1.
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
  con botones "Emitir / Ya la facturé a mano" (plan B del §9; una PENDIENTE o NO_CREADA se puede
  cancelar);
  CREANDO_BORRADOR pasa a DESCONOCIDO y se reconcilia; BORRADOR_CREADO (solo modo real) y TIMBRANDO
  repiten el paso 2; EMITIDA con estado DIAN pendiente y RECHAZADA se vuelven a consultar.
- **Pendiente (Gabriel, 2026-11-12): intentos agotados → aviso por el chat.** Si una emisión queda
  en TIMBRANDO o DESCONOCIDO después de agotar los intentos automáticos (los 3 del paso 2, o la
  reconciliación a 1 y 5 min), el bot le avisa al usuario autorizado por el chat. No se reintenta en
  silencio en cada arranque: lo que haga el arranque con esa fila queda visible en el chat.
  Decidido por Gabriel (2026-11-12): **reintenta y avisa**, con dos condiciones:
  1. El reintento respeta el **modo guardado en la fila**: una emisión SOLO_BORRADOR nunca se
     timbra, ni al arrancar ni en ningún reintento. En desarrollo no se manda `stamp`, punto.
  2. **Un intento por arranque**, no un bucle. Si tras ese intento sigue sin resolverse, el aviso
     dice qué revisar en Alegra: número o id externo, fecha de la factura y
     `facturabot:<emisionId>`.

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

**Para cuando se haga la excepción de anonimización (Ley 1581, §4):** la regla
`borradores_aprobacion_completa_check` (todo APROBADO con quién y cuándo) quedó `NOT VALID`, porque
6 borradores APROBADO viejos de la base de desarrollo no tienen `aprobado_por`. PostgreSQL revisa
una regla `NOT VALID` en toda fila que se inserte **o se actualice**: anonimizar `datos` de esos 6
es un `UPDATE` y lo va a rechazar, además del trigger que ya impide cambiar `datos` fuera de
PENDIENTE. Se resuelve en ese momento (por ejemplo, completar quién y cuándo con un valor marcado
como "anterior a la regla" y luego `VALIDATE CONSTRAINT`). Esos 6 son de pruebas con datos ficticios.

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
11. ¿Cuál es el identificador estable de la cuenta o empresa para la API? (Hoy se usa el campo
    `org` del JWT, que no está documentado.)
12. ¿Hay un monto máximo para facturar a consumidor final (sin identificar al comprador)? No está
    en la investigación; no se aplica ningún tope hasta saberlo.

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

## 13. Bitácora de fricción

Mediciones de las pruebas manuales que no se arreglan en esta fase. La optimización de latencia
(opción D de la 4.4 §14.2: la IA devuelve solo los cambios) va **después de Alegra** (Gabriel,
2026-11-11).

**2026-11-11, prueba manual en `main` (con los PR #10 y #11), 7 mensajes de texto.** Datos
ficticios. El modelo estaba precargado (`qwen2.5:7b`, `keep_alive` de 30 min, 12 de 29 capas en la
GPU, contexto de 4096) y no hubo recarga entre mensajes. Durante la prueba no corría ningún test ni
otro proceso del agente.

| # | Mensaje | Trabajo | De eso, Ollama (`/api/chat`) | Tokens del pedido |
|---|---|---|---|---|
| 1 | cancelar | 0,4 s | — | — |
| 2 | primer borrador (sin NIT) | **77,6 s** | **70 s** | 450 |
| 3 | NIT sin DV | 9,6 s | 9,2 s | 656 |
| 4 | NIT completo | 8,4 s | 8,0 s | 666 |
| 5 | cancelar | 0,3 s | — | — |
| 6 | cédula de 3 dígitos | 6,6 s | 6,1 s | 452 |
| 7 | cancelar | 0,3 s | — | — |

- Lo lento fue el **primer** pedido de la sesión: 70 s en Ollama, frente a 6 a 9 s de los
  siguientes, con un pedido de tamaño parecido (450 frente a 452 tokens del mensaje 6). La
  precarga solo carga los pesos; la primera inferencia real paga además el arranque del cálculo en
  la GPU y la preparación de la gramática del formato JSON. Es una hipótesis: no se midió por
  separado.
- Fuera de Ollama, el primer trabajo tardó unos 7,6 s más (los demás, menos de 0,5 s): primera
  conexión a la base y primer envío a Telegram de la sesión. También hipótesis.
- Mitigación posible, sin cambiar código del bot: que la precarga del arranque diario haga una
  inferencia corta de verdad con el mismo formato, no solo la carga. Se decide junto con la
  opción D.

### Traspaso del 2026-11-12 (paso 6, para la siguiente sesión)

**Rama:** `feat/servicio-emision` (desde `main` con el PR #12), subida. Sin PR todavía.

**Hecho (commits de la rama):**

- `17edd7e` decisiones de Gabriel para el paso 6 (§4).
- `b082cb2` base aparte para `pnpm test:int` (`facturacion_test`, recreada en cada corrida; la
  guarda exige que el nombre termine en `_test`). Las pruebas ya no borran filas.
- `cb82412` migración `cerrar_emisiones`, **aplicada a la base de desarrollo** con
  `prisma migrate deploy` (7 migraciones; 7 APROBADO → `MANUAL`, 15 CANCELADO). Qué contiene: §4,
  "Cómo quedó en la migración". 101 de 104 tests de integración en verde; `pnpm test`, lint,
  Prettier y tipos en verde.
- Este commit: plan con NO_CREADA → CANCELADA, el borrador con NIT, RECHAZADA → EMITIDA, la
  recuperación de TIMBRANDO (§4) y el choque `NOT VALID` / anonimización (§8).

**En rojo a propósito:** 3 tests de `conversacion.int-spec.ts` (aprobación por versión). Aprueban sin
`destino_factura`; se arreglan con el punto 2 de abajo. El CI de un PR de esta rama fallará en
`test:int` hasta entonces.

**Falta del paso 6, en este orden (commit y push por cada cambio en verde):**

1. Agregar a `REGLAS_BD` (`mensajeria/procesador-mensajes.ts`) las reglas nuevas:
   `borradores_nacer_pendiente`, `borradores_aprobacion_coherente`,
   `borradores_destino_solo_aprobado_check`, `borradores_aprobacion_completa_check`,
   `emisiones_nacer_pendiente`, `emisiones_transicion_no_permitida`,
   `emisiones_no_existe_sin_confirmar`, `emisiones_cancelada_sin_quien`, `emisiones_sin_borrado`,
   `borradores_sin_borrado` (y las de `_sin_truncate` si salen con ese nombre).
2. **Aprobación con destino** (`facturacion/conversacion.service.ts`): consumidor final (sin nombre
   ni identificación, y nada vaciado por `sinDatosNoDichos`) con token válido → `PROVEEDOR`; con NIT
   o cédula → botón "📝 Registrar sin factura" → `SIN_FACTURA`; sin token válido → aviso antes del
   botón → `MANUAL`; a medias → pedir el dato o "consumidor final". Los avisos van **antes** del
   botón. En una transacción: el borrador pasa a APROBADO con `destino_factura` y, solo si es
   `PROVEEDOR`, nace la `Emision` PENDIENTE (cuenta de `adaptador.cuenta()`, modo de
   `ALEGRA_EMITIR`, `fecha_factura` = día de Bogotá guardado como `new Date('AAAA-MM-DDT00:00:00Z')`
   y leído con `toISOString().slice(0, 10)`). Arregla los 3 tests en rojo.
3. `buscarPorReferencia` en el puerto y en el adaptador de Alegra: `client_identification` + fecha,
   todas las páginas, Zod, `observations` comparado de nuestro lado; con la fecha original y el día
   siguiente.
4. Trabajo `emitir` en BullMQ (`jobId emitir-<id>`, `attempts: 1`, `maxStalledCount: 0`,
   `concurrency: 1`): `UPDATE … WHERE estado = 'PENDIENTE'` a CREANDO_BORRADOR antes del POST;
   paso 1 → BORRADOR_CREADO / NO_CREADA (solo con `definitivo`) / DESCONOCIDO; con modo
   SOLO_BORRADOR termina ahí; paso 2 con hasta 3 intentos, 3226 y RECHAZADA; ningún error de
   `timbrar` o `consultar` devuelve una fila con `id_externo` a PENDIENTE ni a NO_CREADA. Consultas
   diferidas del estado DIAN. Errores solo con `describirError`.
5. Recuperación al arrancar con `pg_try_advisory_lock`, filtrando por proveedor, cuenta y modo **en
   la consulta**: PENDIENTE se reencola (más de 2 h → botones "Emitir / Ya la facturé a mano");
   CREANDO_BORRADOR → DESCONOCIDO y se reconcilia; BORRADOR_CREADO (modo real) y TIMBRANDO repiten
   el paso 2; EMITIDA con DIAN pendiente y RECHAZADA se consultan.
6. DESCONOCIDO: reconciliación automática (a 1 y 5 min) y, si no aparece, el mensaje de qué buscar
   y el botón "No existe en Alegra" (solo el usuario autorizado; guarda quién y cuándo) →
   NO_CREADA; desde ahí, reintentar (→ PENDIENTE, reconciliando antes) o "Ya la facturé a mano"
   (→ CANCELADA).
7. Tests de integración con el proveedor falso: 201, 400 con y sin factura, timeout al crear,
   timeout al timbrar, 3226, reinicio a mitad. Mutaciones en: no duplicar, no timbrar
   SOLO_BORRADOR, no cruzar cuentas.
8. Subagentes `control-calidad` y `seguridad`, PR y mostrarle la descripción a Gabriel, con los
   textos de "no se facturará" y "facturar a mano".

**Pendiente agregado (Gabriel, 2026-11-12), entra en los puntos 4 a 6:** una emisión que queda en
TIMBRANDO o DESCONOCIDO tras agotar los intentos avisa por el chat; nunca se reintenta en silencio
en cada arranque (§4). Decidido: reintenta y avisa, respetando el modo de la fila (SOLO_BORRADOR
nunca se timbra) y con un solo intento por arranque; si no se resuelve, el aviso dice qué revisar en
Alegra. Con test de integración.

**Decisiones del 2026-11-12** (detalle en §4): tercera migración en este PR; nunca desactivar
triggers; supresión por Ley 1581 por anonimización (excepción pendiente, §8); DESCONOCIDO pasa por
NO_CREADA con búsqueda automática previa y botón con quién y cuándo; NO_CREADA → CANCELADA; cliente:
consumidor final se emite, con NIT o cédula no hay "✅ Aprobar" ni emisión, a medias se pregunta, lo
vaciado no cuenta; sin tope de monto para consumidor final (pregunta 12); sin token válido →
"facturar a mano" para siempre; `status: 'draft'` no se envía; los textos los decide el agente y se
muestran en el PR.
