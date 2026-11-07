# Reporte «pruebas alegra», versión 2 (fuentes oficiales leídas)

> **Nota de edición (2026-11-04).** Reporte guardado tal como llegó; solo se le dio formato Markdown.
> No contenía datos personales ni NIT de clientes. Único agregado: la aclaración junto al número de
> «Consumidor final», que es el identificador genérico de la DIAN y no corresponde a ninguna persona.
> El texto pegado no traía las URLs completas de la sección final, solo los nombres de las fuentes.

Esta vez sí leí las fuentes oficiales, por curl, porque los agentes de lectura siguen sin resolver los
dominios. No toqué el repo: lo descargado está en el scratchpad de la sesión, fuera del proyecto.

Fuentes leídas:

- Alegra: la documentación de la API, sus páginas de precios y términos, y el centro de ayuda.
- DIAN: el comunicado oficial y el PDF oficial de la Resolución 000202. El PDF es un escaneo, así que
  lo leí página por página como imagen.

Lo que sigue sin confirmar queda en 🔴. Por cada dato indico dónde lo leí, y las URLs completas están
al final.

## Actualización del 2026-11-06: JWT y exploración con la cuenta de prueba

Hecha con `apps/api/scripts/explorar-alegra.ts` contra una **cuenta de prueba no habilitada ante la
DIAN**, creando solo borradores: el script solo usa GET y POST, rechaza `stamp` y `void`, y se detiene
si la cuenta tiene numeración electrónica. Las respuestas crudas
se guardaron fuera del repo y se borraron al terminar. Datos de prueba: ficticios. **Límite general:**
como la cuenta no está habilitada y nada se timbró, nada de esto confirma cómo se comporta una cuenta
real al timbrar.

**Autenticación con JWT**

- 🟢 Alegra ahora recomienda un **JWT** generado en Integraciones. Va en `Authorization: Bearer <JWT>`.
  La página de autenticación de la API de facturas solo documenta Basic; Bearer aparece documentado en
  otras APIs de Alegra (Nómina, servidor MCP). Probado: `api.alegra.com/api/v1` lo acepta (200).
- 🟢 El JWT **vence**: el de la cuenta de prueba, 16 días después de creado. Trae dentro datos del
  usuario (correo y nombre) y un campo `api_key`: hay que tratarlo entero como secreto. Solo se leyó
  el nombre de los campos y `exp`.
- 🔴 No se sabe si hay JWT de vencimiento más largo ni si el token clásico (Basic) sigue vigente.

**Lo probado y lo leído**

| Pregunta | Resultado | Fuente |
|---|---|---|
| ¿Se puede timbrar un borrador ya creado? | 🟢 Sí: `POST /invoices/stamp` con `{"ids": [...]}` timbra hasta 10 facturas en borrador o abiertas. Responde 200 si al menos una salió, con un resultado por id (`success` o `code` + `message`). El código **3226** significa «ya está emitida». | Documentación oficial; **no probado** (no se envía `stamp`) |
| Largo máximo de `description` | 🟡 Un borrador aceptó y devolvió **20.000 caracteres** sin recortar; el esquema no declara máximo. 🔴 No se sabe el límite al timbrar. | Prueba |
| ¿`observations` vuelve y sirve para buscar? | 🟢 Vuelve en el listado y en el detalle. 🔴 Los filtros `observations=` y `query=` **se ignoran** (devolvieron todas las facturas del día, incluida una de control con otra referencia). 🟢 `client_identification` + `date` **sí filtra**. | Prueba con factura de control |
| ¿Un borrador consume consecutivo? | 🟡 En la cuenta de prueba **sí**: cada borrador tomó el siguiente número. Pero esa numeración **no es electrónica** (`isElectronic: false`, sin prefijo); con la numeración DIAN puede ser distinto. | Prueba (limitada) |
| ¿«Consumidor final» sirve en `POST /invoices`? | 🟢 Sí para un borrador. El contacto ya existe en la cuenta: tipo `CC`, número 222222222222 (identificador genérico de la DIAN, no es de ninguna persona), `PERSON_ENTITY`, `SIMPLIFIED_REGIME`, sin dirección. 🔴 No verificado al timbrar. | Prueba |

**Otros hallazgos**

- Sin `status` y sin pagos, `POST /invoices` crea la factura en **borrador** (`draft`).
- Un borrador no trae ningún campo de CUFE, `stamp` ni `emission_status`: el nombre del campo del CUFE
  sigue 🔴.
- `GET /invoices/{id}?fields=pdf` responde **500** sobre un borrador; con `xml` o `events` responde 200
  pero sin esos datos.
- Un contacto con solo nombre, tipo `CC` y número (sin régimen ni dirección) fue aceptado. Como la
  cuenta no está habilitada ante la DIAN, esto **no** resuelve el choque con la Res. 202.
- `POST /contacts` responde **200**, no 201. Los ids siguen siendo números en texto, no UUID.
- Ninguna llamada respondió 403.

**Consecuencia para el diseño:** emisión en dos tiempos (borrador → `POST /invoices/stamp`), aprobada
por Gabriel el 2026-11-06 y descrita en el §4 del plan de la fase 5. Repetir el timbrado del mismo id
no duplica; el riesgo de duplicado queda solo en la creación del borrador, que se reconcilia con
`client_identification` + `date` comparando `observations` de nuestro lado.

## Tus 5 prioridades

### 1. Sandbox o cuenta de prueba que no emita ante la DIAN

🔴 No hay sandbox documentado en la API.

- Los OpenAPI de facturas, notas crédito, contactos y webhooks declaran un solo servidor, «Production
  API server» (`https://api.alegra.com/api/v1`).
- No encontré las palabras sandbox, ambiente de pruebas ni modo de prueba en lo que leí.
- Nada en la API indica si una llamada es de prueba o real.

🟢 La documentación advierte que el explorador de la API usa tu cuenta real: «los request que
realices pueden modificar la información de tu cuenta» (información general).

🟢 Lo que sí existe es el proceso de habilitación ante la DIAN, no un sandbox de la API (ayuda de
Alegra). Sus pasos:

1. Registro en la DIAN.
2. Elegir modo de operación, asociando a Soluciones Alegra S.A.S. como proveedor tecnológico.
3. Enviar en modo de prueba 8 facturas, 1 nota crédito y 1 nota débito (el set de pruebas, que Alegra
   automatiza con el TestSetID).
4. Pedir la numeración electrónica y asociar los prefijos.
5. Indicar la fecha de salida a producción, que agrega la responsabilidad 52 «Facturador
   electrónico» al RUT.

🔴 No encontré si una factura creada por API con `generateStamp` antes de la salida a producción va
a habilitación o a producción. Tampoco encontré si la prueba gratuita de 15 días emite ante la DIAN.

Hasta que soporte lo aclare, hay que asumir que `generateStamp: true` puede ser real.

### 2. Descripción propia por línea e IVA 19 % por línea

🟢 La línea sí admite `description` propia. El esquema de ítems de `POST /invoices` incluye
`description` y `reference`. Los ejemplos oficiales muestran una descripción distinta del nombre del
producto (crear factura).

🔴 No encontré el largo máximo de `description` por línea.

🟢 El precio va sin IVA: «El precio del producto/servicio no debe incluir impuestos ni descuentos».

🟢 El IVA se indica por línea con `tax: [{"id": "<id del impuesto>"}]`.

- El id es propio de cada cuenta. El ejemplo de la documentación usa `"id": "6"` (con un IVA del
  16 %, de un ejemplo viejo), así que no hay que copiarlo.
- Existe `GET /taxes` («Listado de impuestos») para leer el id real del IVA 19 % de tu cuenta
  (índice de la documentación).

🟢 Campos obligatorios del esquema general: `date`, `dueDate`, `client` e `items` (cada ítem con
`id`, `price` y `quantity`).

🟢 Para Colombia, `paymentForm` (`CASH` o `CREDIT`) y `paymentMethod` son obligatorios con
facturación electrónica 2.1.

🟢 Para emitir se envía `stamp: {generateStamp: true}`. `numberTemplate` es opcional: si falta, usa
la numeración preferida de la empresa.

🟢 Si la emisión falla: Alegra deja la factura en borrador, responde HTTP 400 con el error y con la
factura creada.

### 3. Idempotencia o referencia propia buscable

🔴 No hay clave de idempotencia. No aparece «idempot» en ninguna página que leí: facturas, notas
crédito, contactos, errores, webhooks y el índice completo de la documentación.

🟢 `observations` y `anotation` admiten hasta 500 caracteres, pero `GET /invoices` no permite filtrar
por ellos.

🟢 Los filtros de `GET /invoices` son: `ids`, `status` (`open`, `closed`, `draft`, `void`), `date` y
rangos de fechas, `client_id`, `client_name`, `client_identification`, `numberTemplate_fullNumber` e
`item_id`.

Consecuencia para el bot:

- Guardar en nuestra BD el id de Alegra apenas llegue la respuesta.
- Poner nuestro id en `observations` como trazabilidad.
- Antes de reintentar tras un timeout, listar con `client_identification` + `date` y comparar del
  lado nuestro. Esto es una recomendación mía, no de Alegra.

Riesgo adicional: un 400 por fallo de emisión deja un borrador creado. Reintentar el POST crearía un
segundo borrador.

### 4. Plan mínimo con API y precio

🟢 Los términos dicen que la API está disponible «para los planes que ofrezcan Integración con otras
aplicaciones», sin costo adicional al plan. Alegra puede cambiar las tarifas avisando (términos).

🟢 El código 402 significa que «el plan actual de la compañía no permite realizar la acción»
(respuestas de la API).

🟢 En la página de precios (leída hoy, 2026-11-04), la fila «API» de la tabla del producto
Contabilidad marca: Emprendedor ✓, Pyme —, Pro ✓, Plus ✓. La tabla del POS la marca en los cuatro
planes.

🟢 Precios que muestra la página de Contabilidad, mensual de lista (la página no dice si incluyen
IVA):

| Plan | Precio de lista / mes |
|---|---|
| Emprendedor | $74.900 |
| Pyme | $163.900 |

- Además hay «25 % OFF para usuarios nuevos»: Emprendedor queda en $56.175/mes, facturado $674.100
  al año.
- Facturas ilimitadas y prueba gratis de 15 días sin tarjeta.

🔴 Los planes «Solo Facturación» (Emprendedor $17.900, Pyme $49.900) no muestran fila de API en lo
que pude leer. No sé si la incluyen.

🔴 Que Pyme aparezca sin API es raro y hay que confirmarlo. Parece un error de la tabla, pero no lo
puedo afirmar.

El plan mínimo con API que veo confirmado es Contabilidad Emprendedor.

### 5. Artículo exacto de la Resolución 000202 de 2025

🟢 Fuente oficial: PDF en dian.gov.co. Es de fecha 31-mar-2025 y modifica parcialmente la
Resolución 000165 de 2023.

🟢 Artículo 3 de la 202, que reemplaza el artículo 69 de la 165/2023 («Datos exigibles al adquirente
o comprador…»). Texto leído en la página 6:

> «Cuando el adquirente del bien o servicio solicite que la factura electrónica de venta y/o el
> documento equivalente electrónico tiquete de máquina registradora con sistemas P.O.S. sea expedido
> a su nombre, el sujeto obligado a facturar deberá solicitar al comprador o adquirente, únicamente
> los datos que se describen a continuación: 1. Nombre y apellidos o razón social… 2. Tipo y número
> de identificación… 3. Correo electrónico».

- El correo permite enviar la factura por mensaje de datos. A juicio del comprador no es necesario si
  se entrega la representación gráfica impresa (artículo 35 de la 165).
- Parágrafo 1: si el adquirente no pide la factura a su nombre, «no habrá lugar a pedir los datos
  aquí previstos».
- Parágrafo 2: con el servicio de consulta (artículo 70) disponible, «el único dato que se debe
  solicitar al adquirente será el número de identificación». Si no figura en el servicio, se piden
  los demás datos, y el correo solo se pide si quiere recibir la factura en otro correo.

🟢 Artículo 4 de la 202 (nuevo artículo 70 de la 165). El servicio de consulta de la DIAN:

- Se usa «únicamente» para expedir la factura.
- Completa nombre o razón social y correo a partir del tipo y número de identificación.
- Prohíbe en todo caso el uso masivo o la distribución de la información obtenida.
- Su parágrafo condiciona su aplicación a que la DIAN desarrolle y ponga a disposición los medios, y
  a que comunique desde cuándo.

🟢 Artículo 5 renumera los antiguos artículos 69 y 70 como 71 y 72. Artículo 7: rige desde su
publicación en el Diario Oficial.

🟢 El comunicado oficial 026/2025 confirma que no se pueden pedir teléfono, dirección ni RUT, y que
los proveedores deben ajustar sus sistemas para integrar el servicio.

🔴 No pude abrir el normograma de la DIAN (el proxy lo bloquea con 403). Un resultado de búsqueda dice
que la 202 fue modificada por la Resolución 227 de 2025. Eso no lo verifiqué: conviene revisar la
versión vigente de los artículos 69 y 70.

## Resto de los puntos

### Autenticación

- Actualizado el 2026-11-06: el token recomendado ahora es un JWT con `Bearer` (ver la actualización
  al inicio).
- 🟢 Basic con `correo:token` en base64. El token se genera en Configuración → «API - Integraciones
  con otros sistemas», dentro de la app. Si falla, devuelve 401 (autenticación).
- 🟢 El token es «otorgado al usuario registrado» y el límite de peticiones es por usuario.
- 🔴 La página no dice cómo se revoca. La nota de Apideck, de terceros, dice que regenerar el token
  invalida el anterior.

### CUFE y PDF

- 🟢 `GET /invoices/{id}?fields=pdf,xml,events` devuelve la URL del PDF, la del XML de la factura
  timbrada y los eventos (consultar factura).
- 🔴 No encontré el nombre del campo del CUFE. No aparece «cufe» en las páginas que leí. Hay que verlo
  en una respuesta real o preguntar a soporte.

### ¿Síncrona o asíncrona?

- 🟢 El POST con `generateStamp` intenta emitir en la misma petición.
- 🟢 El estado legal puede ser `PENDING`, `ACCEPTED` o `REJECTED`. El `emission_status` puede ser
  `STAMPED_AND_WAITING_RESPONSE`, `STAMPED_AND_ACCEPTED`, `STAMPED_AND_REJECTED` o
  `STAMPED_AND_ACCEPTED_WITH_OBSERVATIONS` (catálogo Colombia).
- La aceptación de la DIAN puede quedar pendiente, así que hay que consultar el estado después de
  crear.
- 🟢 Webhooks (solo los eventos listados): `new-invoice`, `edit-invoice`, `delete-invoice`, más los de
  clientes, ítems y facturas de compra.
  - La entrega es por HTTPS y el endpoint debe responder 2xx en menos de 10 s.
  - Tras 3 fallos seguidos la suscripción se suspende (webhooks).
- 🔴 No hay evento documentado de «aceptada por la DIAN», y no se documentan tiempos.

### Contactos (crear contacto)

- 🟢 Con facturación electrónica en Colombia son obligatorios `identificationObject` (con `type` y
  `number`), `regime` y `kindOfPerson`.
- 🟢 Nombre:
  - Persona jurídica: `name`.
  - Persona natural: `nameObject` con `firstName` y `lastName`.
- 🟢 Tipos de documento: `NIT`, `CC`, `CE`, `TE`, `TI`, `RC`, `PP`, `DIE`, `NUIP`, `FOREIGN_NIT`.
- 🟢 `kindOfPerson`: `LEGAL_ENTITY`, `PERSON_ENTITY`, `OTHER_ENTITY`.
- 🟢 `fiscalResponsabilities`: 114, 5, 7, 12.
- 🟢 Dirección con ciudad y departamento es obligatoria si el documento es nacional. El correo es
  opcional.
- 🟢 Búsqueda con `GET /contacts?identification=…`, que filtra por «contiene», no por coincidencia
  exacta. Existe `ignoreRepeated`.
- 🔴 No se dice si `dv` es obligatorio. Está en el esquema como «Dígito de verificación».
- 🟢 Consumidor final: según la ayuda del POS, Alegra ya trae creado el contacto «Consumidor final»
  (222222222222; identificador genérico de la DIAN para consumidor final, no es de ninguna persona)
  (FAQ POS). No lo verifiqué para la API de facturas.

### Notas crédito (crear nota crédito)

- 🟢 `POST /credit-notes` con `stamp.generateStamp`.
- 🟢 `cause` es obligatorio para emitir.
- 🟢 `type`: `PARTIALL_DEVOLUTION`, `VOID_ELECTRONIC_INVOICE`, `REDUCTION_DISCOUNT_PARTIAL_TOTAL`,
  `PRICE_ADJUSTMENT` u `OTHER`.
- 🟢 Se vincula a la factura con `invoiceCreditAllocations` (id de la factura y `amount`).
- 🔴 No leí si `POST /invoices/{id}/void` sirve para facturas ya emitidas ante la DIAN.

### Límites y errores

- 🟢 150 peticiones por minuto por usuario, con 429 al excederlo y los encabezados
  `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining` y `X-Rate-Limit-Reset`.
- 🟢 Cuerpo de error de ejemplo: `{"code":"901","message":"Esta acción no está permitida para el
  usuario actual."}`.
- 🟢 Códigos HTTP documentados: 200, 201, 400, 401, 402, 403, 404, 405, 500 y 503. Un 404 también
  aparece cuando la cuenta está suspendida.
- 🔴 No leí el catálogo de códigos de negocio.

### Cambio de formato de IDs (aviso)

- 🟢 Los ids ahora son strings, y los registros nuevos pasan gradualmente a UUID. Hay que guardarlos
  como texto.

### Consulta de adquirentes en Alegra (punto 9)

- 🔴 No encontré en fuentes oficiales de Alegra que complete nombre o correo desde la DIAN, ni que lo
  exponga por API. La API de contactos solo ofrece búsqueda dentro de la cuenta.
- 🟢 Del lado de la DIAN, el comunicado dice que el servicio existe y que los proveedores deben
  integrarlo.
- 🔴 No encontré cómo accede un tercero a ese servicio.

### POS electrónico (punto 11)

- 🟢 Alegra lo emite desde su POS, sin costo adicional, y pide una numeración «D.E. POS» propia ante
  la DIAN.
- 🟢 Se puede emitir cualquiera de los dos documentos «desde 1 peso». Alegra recomienda factura
  electrónica cuando el cliente la pida.
- 🟢 Para anular un POS se emite una nota de ajuste.
- 🟢 Según un considerando de la Res. 202 que cita el parágrafo 1 del artículo 19 de la 165, el POS
  emitido a «consumidor final» no sirve como soporte de costos, gastos ni IVA descontable.
- 🔴 No hay endpoint de POS en el índice oficial de la API. Un SDK de terceros lista
  `POST /equivalent-documents/pos`, pero no está en la documentación oficial.

Cuándo conviene: para ventas de mostrador a consumidor final que no piden factura. Si el comprador
quiere soportar gasto, va factura electrónica. Lo más probable es que facturabot siga con factura
electrónica mientras la API no ofrezca POS.

## Qué configurar en Alegra antes de empezar

- Un plan con API: hoy, el Contabilidad Emprendedor es el único que veo confirmado.
- Completar la habilitación DIAN: registro, set de pruebas, numeración electrónica con su prefijo,
  fecha de salida a producción y la numeración de notas crédito.
- El certificado digital. La página de precios dice que se incluye gratis en todos los planes.
- La numeración de facturación (`number-templates`) como preferida y automática, para no enviar
  `numberTemplate`.
- El producto «Pinturas varias» y el id de su IVA 19 % (`GET /taxes`).
- El contacto «Consumidor final».
- El token, solo en `.env`. Nada contra la cuenta real hasta pasar la auditoría externa que pide
  CLAUDE.md.

## Riesgos para facturabot

- No hay sandbox documentado. Una prueba con `generateStamp` podría emitir ante la DIAN.
- Sin idempotencia, y un 400 deja un borrador. El riesgo de factura duplicada es real.
- El CUFE y la aceptación de la DIAN pueden llegar después. Hay que consultar el estado, y no hay
  evento de webhook documentado para eso.
- La búsqueda de contactos es «contiene». Un NIT puede coincidir con otro más largo. Hay que comparar
  el número exacto del lado nuestro.
- Los términos de la API. La distribución o comercialización de un producto hecho sobre ella «debe
  ser autorizada previamente por Alegra». Prohíben también lo que Alegra considere competencia. Esto
  pesa para la fase 12 (multiempresa).
  - Para el piloto, con el token de un solo comercio, el riesgo es bajo. Para la fase 12 es
    bloqueante hasta tener la autorización.
- Res. 202 y el flujo del bot: pedir más que nombre, tipo y número de documento y correo contradice
  el artículo 69. Si el comprador no pide factura a su nombre, no se piden datos y va consumidor
  final.
- La consulta de adquirentes tiene restricciones de uso. No se puede almacenar ni usar en masa, y esto
  choca con guardar datos del cliente.

## Preguntas para soporte de Alegra

1. ¿Existe ambiente de pruebas por API que no emita ante la DIAN? ¿Cómo distingo una llamada de
   prueba de una real, y emite la prueba gratuita de 15 días?
2. ¿Qué plan es el mínimo con API en Colombia? ¿Las tablas de precios son correctas (Pyme sin API) y
   qué pasa con los planes «Solo Facturación»? ¿Los precios incluyen IVA?
3. ¿Hay clave de idempotencia o un campo de referencia propia buscable? ¿Cuál es la forma recomendada
   de evitar duplicados tras un 400 que deja un borrador?
4. ¿Cuál es el nombre del campo del CUFE en la respuesta? ¿Hay evento o webhook de aceptación o
   rechazo de la DIAN, y cuánto tarda normalmente?
5. ¿Cuál es el largo máximo de `description` por línea?
6. ¿Es obligatorio el `dv` en contactos? ¿Cómo se revoca el token?
7. ¿Alegra integra el servicio de consulta de adquirentes (Res. 202) y está disponible por API?
8. ¿Se puede anular por API una factura ya emitida, o solo con nota crédito?
9. ¿El POS electrónico está en la API pública?
10. ¿Qué autorización necesito para un servicio multiempresa construido sobre la API?

## Fuentes consultadas

Alegra, documentación de la API:

- Autenticación, límite de request y respuestas del API
- Crear factura, listar facturas, consultar factura y nota crédito
- Contactos, catálogo Colombia, webhooks, términos y formato de ID

Alegra, comercial y ayuda:

- Precios Colombia
- Habilitación DIAN
- FAQ POS electrónico

DIAN:

- Resolución 000202 (PDF oficial)
- Comunicado 026/2025
