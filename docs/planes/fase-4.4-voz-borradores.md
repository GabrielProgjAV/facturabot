# Plan de la subfase 4.4: voz → borradores, y aprobación con botón

Estado: **aprobado por Gabriel el 2026-10-30, con las decisiones de §12** (algunas ajustadas y una
nueva, la 6).
Rama: `feat/fase-4-voz` (la 4.3 quedó cerrada en `28c4888`). Todos los datos de ejemplo de este
plan son **ficticios**.

Fuentes: §5, §17 y §18 de `docs/planes/fase-4.3-cola.md`, la bitácora de la 4.2 (README.es.md) y
la documentación oficial de la Bot API de Telegram (`InlineKeyboardButton`, `answerCallbackQuery`).

## 1. Objetivo

Que una nota de voz produzca el mismo borrador que un texto, con la misma seguridad, y que aprobar
sea inequívoco: el usuario aprueba **exactamente el resumen que tiene en pantalla**.

Dentro del alcance:
1. Voz → transcripción → conversación (crear o corregir el borrador), con el límite de 1.000
   caracteres también para la transcripción (§5 del plan de la 4.3).
2. Aprobar con un **botón en línea** en cada resumen (§18.2 #5).
3. Tras un reinicio, responder con el **estado real** del borrador (§18.2 #6).
4. **NIT con dígito de verificación:** normalizar y validar con el módulo 11; marcar para revisión
   la identificación que llegó por voz (bitácora 4.2c).
5. **Precios abreviados** y **cantidad × precio unitario:** set de evaluación del intérprete y una
   detección en código que pregunta (§18.2 #7 y §17).
6. Lo que la 4.3 dejó para la 4.4 (§18.4): duración real de la nota y descarga por partes.
7. Título del mensaje de aprobación (§17).

Fuera del alcance (con su fase): deduplicación tras completar (antes de Alegra), límite de frecuencia
por chat (antes de WhatsApp o de un segundo comercio), latencia de Ollama (antes de Alegra) y los
puntos de §18.3 (fase 3.5).

## 2. Diseño general

```
Telegram
 ├─ texto / voz ─────────────► handler (valida, avisa, encola) ─► cola "mensajes"
 └─ botón "✅ Aprobar" ───────► handler: answerCallbackQuery ───► cola "mensajes" (tipo "aprobar")
                                                                       ▼
                                                     worker (concurrencia 1, en orden)
   texto:   conversacion.responder(texto)                        → resumen + botón
   voz:     descargar → duración real → transcribir → responder  → "🎤 Entendí: …" + resumen + botón
   aprobar: conversacion.aprobar(borradorId, version)            → "✅ Factura aprobada" o reenvío
```

**Por qué la pulsación del botón también pasa por la cola.** Si se aprobara en el handler, un
"✅ Aprobar" pulsado justo después de enviar una corrección se adelantaría a ella: aprobaría la v1 y
luego la corrección, sin PENDIENTE, crearía una factura nueva. En la cola se procesa en orden: la
corrección produce la v2 y el botón de la v1 ya no vale (§3.4).

## 3. Aprobación con botón en línea (§18.2 #5)

### 3.1 El botón

- Cada mensaje con resumen aprobable (sin faltantes y con la suma cuadrada) lleva un botón
  **"✅ Aprobar"**. Si el borrador no es aprobable, no lleva botón: el texto dice qué falta.
- `callback_data = "a:<borradorId>:<version>"`. Con el UUID v7 de 36 caracteres y una versión de
  hasta 6 dígitos son como máximo **45 bytes**; la Bot API permite de 1 a 64 bytes. Se valida con
  Zod al recibirlo (`a`, uuid, entero positivo), porque lo envía el cliente y se puede alterar.
- El worker envía el resumen con `reply_markup` (`InlineKeyboard` de grammY). `enviar()` pasa a
  devolver el `message_id`, que se guarda para quitar el botón después.

### 3.2 Al pulsar

1. El handler recibe el `callback_query`, comprueba que el chat esté autorizado y llama de inmediato
   a `answerCallbackQuery` ("Procesando…"). La Bot API dice que el cliente muestra una barra de
   progreso hasta que se responda, así que se responde siempre, aunque después falle algo.
2. Encola `{ tipo: 'aprobar', chatId, borradorId, version, messageId }` con jobId `tg-<update_id>`.
3. El worker llama a `conversacion.aprobar(chatId, borradorId, version)`, que aprueba solo si:
   - el borrador es del chat y está PENDIENTE,
   - `version == versionMostrada == versión del botón`,
   - en el mismo `updateMany` atómico de la 4.3, comprobando `count === 1`.
4. Si aprueba: "✅ Factura aprobada" con el resumen, y se **quita el botón** del mensaje original
   (`editMessageReplyMarkup`) para que no se pulse dos veces.
5. Si no aprueba (versión vieja, borrador cancelado o de otro chat): "Este resumen ya no está
   vigente" y se reenvía el resumen actual con su botón; al mensaje viejo se le quita el botón.

### 3.3 Qué pasa con el "sí" de texto y de voz: **decisión 1**

Hoy el "sí" de texto aprueba con la vista leída al llegar al bot. Con mala señal, esa lectura puede
ser posterior a lo que el usuario veía al escribir.

| Opción | Qué pasa con "sí" | A favor | En contra |
|---|---|---|---|
| **A (recomendada)** | Ni el texto ni la voz aprueban: responden con el resumen vigente y el botón ("Toca ✅ Aprobar para confirmar") | Un solo camino de aprobación, con la versión exacta del mensaje; la voz no necesita vista; se elimina la carrera de raíz | Un toque más; el usuario se acostumbró a "sí" |
| B | El "sí" de texto sigue aprobando como hoy (vista con borradorId); la voz no | Cambia poco la costumbre | Queda la carrera con mala señal; dos caminos de aprobación que probar |
| C | El "sí" de texto aprueba solo si llega pocos segundos después del último resumen mostrado | Cubre el caso rápido | Depende del reloj y de la red; difícil de explicar y de probar |

Recomiendo **A**: aprobar ante la DIAN es la acción más delicada (CLAUDE.md) y el botón es lo único
que lleva, desde el cliente, qué versión vio el usuario. En WhatsApp (fase 10) hay botones de
respuesta con un id propio, así que el mismo diseño se puede trasladar.

### 3.4 Casos que cubren los tests

- Botón de la versión mostrada → aprueba y quita el botón.
- Corrección en cola y luego el botón de la v1 → no aprueba; reenvía la v2 con su botón.
- Botón de un borrador cancelado, aprobado o de otro chat → no aprueba.
- Doble pulsación → la segunda encuentra el borrador aprobado y no hace nada más.
- `callback_data` alterado o con otro formato → se rechaza con Zod y no se encola.
- `answerCallbackQuery` se llama aunque el encolado falle.
- Integración contra PostgreSQL: el `updateMany` con borradorId, versión y chat.

## 4. Voz → borrador

1. Igual que hoy: descarga (30 s, 1 MB), sin guardar el audio en disco.
2. **Duración real** (§18.4): antes de transcribir, leer la *granule position* de la última página
   OggS y dividirla entre 48.000 (Opus). Si pasa de 120 s, se rechaza. La duración que declara el
   cliente puede mentir: con Opus de baja tasa, 1 MB podrían ser ~20 min de CPU de Whisper. Si el
   archivo no se puede leer como Ogg, se rechaza con el mensaje de voz.
3. **Descarga por partes** (§18.4): rechazar si `content-length` supera 1 MB y cortar la lectura al
   pasar el límite, en vez de cargar hasta 20 MB en memoria cuando Telegram no envía `file_size`.
4. Transcribir. Si la transcripción pasa de 1.000 caracteres, se pide resumirla, como con el texto.
5. `conversacion.responder(chatId, transcripcion)`: crea o corrige el borrador igual que un texto.
   Un "sí" o un "cancelar" dictados se tratan según la decisión 1.
6. Respuesta: `🎤 Entendí: "…"` seguido del resumen (y el botón si es aprobable), en **un solo
   mensaje**, para que el usuario compare lo que dijo con lo que se entendió.
7. La transcripción **nunca** va a los logs ni a Redis (el trabajo de voz solo lleva el `file_id`).

## 5. NIT y cédula: normalización y dígito de verificación

**La IA solo extrae; el código normaliza y valida** (CLAUDE.md). Función pura nueva en
`facturacion/identificacion.ts`:

- `normalizarIdentificacion(texto)`: quita puntos, espacios y el prefijo "NIT"/"CC", y separa el
  dígito de verificación si viene tras un guion. Ejemplos ficticios:
  - `"900.000.001-2"` → `{ numero: "900000001", dv: "2" }`
  - `"900000001 - 2"` → igual
  - `"1.000.000.001"` → `{ numero: "1000000001", dv: null }` (cédula: no lleva DV)
- `digitoVerificacion(numero)`: módulo 11 de la DIAN con los primos 3, 7, 13, 17, 19, 23, 29, 37 y 41
  desde el dígito de la derecha (Orden Administrativa 4 de 1989, §5.1); si el residuo es 0 o 1, el DV
  es ese residuo; si no, 11 − residuo. Solo para números de hasta 9 dígitos. Ejemplos ficticios
  calculados: `900000001` → 2, `800000002` → 7.
- Si viene un DV y **no cuadra**, el borrador queda **no aprobable**:
  "El dígito de verificación del NIT 900000001-5 no coincide. Revísalo." No se corrige solo.
- `BorradorFactura.cliente` gana `digitoVerificacion: string | null` (va en el JSON de `datos`: no
  hay migración). El resumen muestra `NIT/CC: 900000001-2`.
- **Identificación dictada por voz:** como Whisper pierde dígitos repetidos (bitácora 4.2b), el
  resumen la marca: "⚠️ Revisa el NIT o la cédula: vino de una nota de voz". **Decisión 3
  (ajustada):** un NIT con DV correcto lleva solo la advertencia; una **cédula** (no tiene DV) que
  llegó por voz deja el borrador **no aprobable** hasta que el usuario la confirme o la corrija por
  texto.
- Tests: tabla de casos ficticios (con y sin DV, puntos, espacios, guion, DV correcto e incorrecto,
  residuo 0 y 1).

**Decisión 2 (aprobada):** la validación del DV se hace aquí para texto **y** voz con la misma
función, y sale de la lista de la 3.5 (que conserva el caso f, total = 0 y el test e2e).

### 5.1 Forma de la identificación (decisión 6) y fuentes oficiales

Regla del proyecto: **solo se codifica lo que confirma una fuente oficial**. Una guía de terceros
(lookuptax.com) sirvió de punto de partida, pero no es fuente.

Confirmado:
- **Registraduría Nacional del Estado Civil**, "Ahora la cédula es de 10 dígitos" (12 de abril de
  2004, https://www.registraduria.gov.co/Ahora-la-cedula-es-de-10-digitos.html): "El NUIP tiene 10
  dígitos y empieza por el rango de mil millones"; "Los ciudadanos con cédula hasta de 8 dígitos NO
  deben cambiar su numeración".
- **DIAN, Orden Administrativa 4 de 1989** (normograma, "sin análisis de vigencia",
  https://normograma.dian.gov.co/dian/compilacion/docs/orden_administrativa_dian_0004_1989.htm):
  - personas jurídicas: "El rango correspondiente al nit … es de 800.000.000 a 999.999.999 y el
    correspondiente dígito de verificación";
  - personas naturales extranjeras y sucesiones: rango de 600.000.000 a 799.999.999;
  - mayores de edad: NIT "con el mismo número de la cédula de ciudadanía y el correspondiente
    dígito de verificación";
  - Anexo 3, "Cálculo del Dígito de Verificación (DV)": cada dígito por un primo según su posición
    (para 9 dígitos, de izquierda a derecha, 41, 37, 29, 23, 19, 17, 13, 7, 3), suma, módulo 11;
    "si este número es igual a uno o cero, el dígito de verificación DV es el mismo valor, de lo
    contrario el DV es igual a once menos este número". El cálculo del código reproduce el ejemplo
    del documento (suma 782, residuo 1, DV 1), sin copiar ese NIT al repo.

**No confirmado, así que no es regla:**
- Que "no existen cédulas de 9 dígitos": ninguna fuente oficial leída lo dice.
- Que las de 10 dígitos empiecen solo por 1: una búsqueda muestra que la Circular Única de la
  Registraduría (Resolución 8937 de 2019) abre un cupo desde 2.000.000.000, pero no se pudo leer el
  documento. Por eso no se restringe el primer dígito de una cédula de 10 dígitos.
- El peso de la décima posición del DV (43 en las guías de terceros): la Orden Administrativa solo
  muestra 9 posiciones. Un DV de un número de 10 dígitos **no se valida**: se guarda como lo
  escribió el usuario y se marca como no verificado.

Reglas que salen de lo confirmado (`identificacion.ts`):

| Número (solo dígitos) | Se interpreta como | DV escrito |
|---|---|---|
| 1 a 8 dígitos | cédula antigua, o NIT de persona natural | se valida |
| 9 dígitos, de 800.000.000 a 999.999.999 | NIT de persona jurídica | se valida |
| 9 dígitos, de 600.000.000 a 799.999.999 | NIT de persona natural extranjera o sucesión | se valida |
| 10 dígitos | cédula con NUIP, o NIT de persona natural | no verificable |
| 9 dígitos por debajo de 600.000.000, u 11 o más | **no coincide con ninguna forma confirmada** | — |

- Si la forma no coincide, o el DV no cuadra: se avisa y se pregunta, por ejemplo "tiene 11
  dígitos; una cédula tiene hasta 10, ¿lo revisas?", y el borrador queda **no aprobable** hasta que
  se corrija o el usuario confirme el número.
- Si el usuario indica cédula de extranjería, pasaporte, PEP o PPT, no se aplican las reglas de
  forma ni de DV (pueden llevar letras).
- Nunca se corrige solo: si falta el DV, se calcula para mostrarlo, pero no reemplaza nada que el
  usuario haya escrito.

## 6. Estado real tras un reinicio (§18.2 #6)

Hoy, si BullMQ falla un trabajo por un reinicio, el usuario recibe "Reenvíalo". Puede ser falso: la
corrección o la aprobación pudieron guardarse antes del corte.

- `avisarTrabajoFallido` recibe también la hora en que se encoló el trabajo (`job.timestamp`).
- `conversacion.estadoTrasFallo(chatId, desde)` mira el borrador más reciente del chat:
  - aprobado después de `desde` → "✅ Tu factura quedó aprobada." con el resumen;
  - cancelado después de `desde` → "Tu borrador quedó cancelado.";
  - hay un PENDIENTE → su resumen vigente, con el botón si es aprobable, y "Si tu último mensaje
    era una corrección y no se ve aquí, reenvíala";
  - nada de lo anterior → el aviso actual ("Reenvíalo, por favor").
- Tests unitarios por caso y uno de integración contra PostgreSQL.

## 7. Intérprete: set de evaluación (§18.2 #7 y §17)

**No existe un set de evaluación en el repo**, aunque CLAUDE.md lo exige antes de cambiar las
instrucciones. Propuesta (**decisión 4**):

- `apps/api/eval/interprete/casos.json`: casos **ficticios**, cada uno con el mensaje y los campos
  esperados.
- `pnpm eval:interprete`: los corre contra Ollama local (no en el CI) y reporta aciertos por campo
  (cliente, identificación, cada ítem, total).
- Primero se mide la **línea base** con las instrucciones actuales; luego se proponen los cambios y
  se aprueban solo si mejoran sin empeorar los demás casos.

Casos iniciales (ficticios):
- Precios abreviados: "pintura azul 192, cinta 5.000" (192 = $192.000).
- Cantidad × precio unitario: "2 galones de esmalte a $50.000 cada uno, total $100.000".
- Los ejemplos que ya funcionan: texto completo, corrección, lista de 9 productos con total por línea.
- **Los 8 casos de la comparación qwen2.5:3b vs 7b del 2026-10-15** (decisión 4), todos ficticios.
  No están en el repo: Gabriel los aporta antes del paso 5.

**Detección en código (no depende de la IA), decisión 5 (ajustada):** **cualquier** ítem con valor
menor a $1.000 se marca como dudoso y el resumen pregunta: "¿$192 es correcto o quisiste decir
$192.000?". **Solo pregunta, no rechaza:** el borrador sigue siendo aprobable.

## 8. Detalles

- **Título tras aprobar** (§17): "🧾 Factura aprobada" en lugar de "🧾 Borrador de factura".
- Los mensajes con botón se envían con `reply_markup`; los demás, igual que hoy.

## 9. Archivos que cambian

- `src/mensajeria/telegram.service.ts`: handler de `callback_query`, `answerCallbackQuery`,
  `enviar()` con botón y `message_id`, quitar el botón, lectura por partes de la descarga.
- `src/mensajeria/procesador-mensajes.ts` (+ spec): tipo de trabajo `aprobar`, voz → conversación,
  duración real, estado tras un fallo.
- **Nuevo** `src/voz/duracion-ogg.ts` (+ spec): duración real desde la última página OggS.
- `src/facturacion/conversacion.service.ts` (+ spec e int-spec): `aprobar(chatId, borradorId,
  version)`, `estadoTrasFallo`, "sí" según la decisión 1.
- **Nuevo** `src/facturacion/identificacion.ts` (+ spec): normalización y módulo 11.
- `src/facturacion/factura.ts` (+ spec): DV en el resumen y en los faltantes, valor dudoso, título.
- **Nuevo** `apps/api/eval/interprete/` y el script `eval:interprete` (decisión 4).
- `README.es.md` y `README.md`: bitácora y estado, al cerrar.

## 10. Orden propuesto para implementar

Cada paso con su verificación (lint, Prettier, tsc, test y test:int), commit y reporte:

1. `identificacion.ts` con sus tests (función pura, sin riesgo).
2. Voz → conversación, con la duración real, la descarga por partes y el límite de 1.000.
3. Botón en línea y tipo de trabajo `aprobar`; el "sí" según la decisión 1.
4. Estado real tras un reinicio.
5. Set de evaluación y línea base del intérprete; detección de valores dudosos en código.
6. Prueba manual en Telegram con un guion de datos ficticios.
7. Subagentes `control-calidad` y `seguridad`, bitácora y README. Después: auditoría externa y PR de
   la fase 4 completa.

## 11. Riesgos

- El botón cambia la costumbre del usuario (decisión 1).
- Leer el Ogg a mano puede fallar con un archivo raro: si no se puede leer, se rechaza (seguro por
  defecto) y se mide con notas reales de prueba antes de cerrar.
- Si `editMessageReplyMarkup` falla (mensaje muy viejo), el botón queda visible, pero pulsarlo no
  aprueba nada: la condición de versión lo impide.
- El set de evaluación necesita casos suficientes para que una mejora no sea casualidad.

## 12. Decisiones de Gabriel (2026-10-30)

1. **A:** el "sí" de texto y de voz no aprueba; muestra el resumen vigente con el botón.
2. **Sí:** el DV va en la 4.4 para texto y voz, y sale de la 3.5.
3. **Ajustada:** NIT con DV correcto → solo la advertencia de voz. Cédula que llegó por voz → no
   aprobable hasta confirmarla o corregirla por texto.
4. **Sí** al set de evaluación, con los 8 casos de la comparación de qwen2.5:3b vs 7b del
   2026-10-15 (ficticios).
5. **Ajustada:** cualquier ítem menor a $1.000 es dudoso; solo pregunta, no rechaza.
6. **Nueva:** validar la forma de la identificación con reglas confirmadas en fuentes oficiales
   (§5.1); si no cuadra, avisar, preguntar y dejar no aprobable hasta corregir o confirmar; sin
   reglas para cédula de extranjería o pasaporte.

### Propuestas originales (para referencia)

1. **"sí" de texto y de voz:** A (no aprueban; muestran el botón), B o C (§3.3). Recomiendo **A**.
2. **Dígito de verificación:** hacerlo en la 4.4 para texto y voz, y sacarlo de la 3.5 (§5).
   Recomiendo: sí.
3. **Identificación por voz:** solo la advertencia, o además bloquear la aprobación hasta
   confirmarla por texto (§5). Recomiendo: solo la advertencia, más el DV cuando sea un NIT.
4. **Set de evaluación** en `apps/api/eval/interprete/` con casos ficticios, corrido localmente
   (§7). Recomiendo: sí.
5. **Umbral de valor dudoso:** $1.000 (§7). Recomiendo: sí.

## 13. Para el plan de la fase 5 (Alegra)

- **Autocompletar el cliente a partir del NIT o la cédula:** nombre y correo desde Alegra (sus
  contactos), y desde el servicio de la DIAN de la Resolución 000202 de 2025 **si Alegra lo
  expone** (a verificar en su documentación oficial). Más una memoria propia de clientes ya
  confirmados por el usuario.
- **Prohibido:** scraping de la DIAN o del RUES, y APIs de terceros que reciban identificaciones
  (Ley 1581 de 2012).

## Para estudiar

- Bot API de Telegram: `InlineKeyboardMarkup`, `CallbackQuery`, `answerCallbackQuery`,
  `editMessageReplyMarkup`.
- grammY: "Inline and Custom Keyboards" y "Filter queries" (`callback_query:data`).
- RFC 7845 (Ogg Opus): *granule position* y la frecuencia de 48 kHz.
- DIAN: cálculo del dígito de verificación del NIT (módulo 11).
- Evaluación de modelos: línea base, aciertos por campo y regresiones.
