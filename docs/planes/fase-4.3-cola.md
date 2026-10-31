# Plan de la subfase 4.3: cola BullMQ para texto y voz

Estado: **aprobado por Gabriel el 2026-10-15, con decisiones 1 a 11 y las condiciones de §15.**
No hay código escrito. La implementación se hace en una sesión nueva.
Rama: `feat/fase-4-voz` (rebaseada sobre `main` en `a790f09`; 59 tests en verde).

## 1. Contexto verificado

- **La carrera de hoy está latente.** `bot.start()` de grammY procesa los mensajes uno por uno
  (`node_modules/grammy/out/bot.d.ts`), así que con una sola copia del bot dos mensajes no entran a
  la vez en `ConversacionService`. La carrera aparece en cuanto la 4.3 responda de inmediato y
  procese en segundo plano. Por esa misma razón, hoy una nota de voz de 12 s bloquea a todos los chats.
- **Whisper carga el modelo antes de abrir el puerto** (`/app/app/webservice.py:20` en el
  contenedor), así que si `/docs` responde, el modelo está cargado. La imagen trae `curl`.
  Solo descarga el modelo por inactividad si `MODEL_IDLE_TIMEOUT` > 0 (`/app/app/config.py:39`; por
  defecto es 0, nunca). Corre en CPU con `int8` (`config.py:33`). Usa ~2,7 GiB de RAM.
- **Prisma 7.10** acepta índices parciales como *preview feature* `partialIndexes` con `where: raw(...)`
  (texto del motor de esquema en `node_modules/prisma/build`). Según la documentación oficial de v7:
  - Está en *preview* desde la 7.4.0, sigue sin ser GA, y admite `where` en `@unique`, `@@unique` y
    `@@index` (https://www.prisma.io/docs/orm/v7/prisma-schema/data-model/indexes).
  - Migrate genera el `CREATE UNIQUE INDEX … WHERE` con "Full support" en PostgreSQL.
  - Para índices parciales, la doc de v7 dice que "You no longer need to customize migrations".
  - **No documenta** si violar un índice *parcial* lanza P2002, ni si `meta.target` es fiable en ese
    caso: se comprueba con una prueba manual contra la base local antes de depender de ello.
- **Base local:** 1 borrador PENDIENTE y 0 chats con PENDIENTE duplicados, así que el índice único se
  puede crear sin limpiar datos.
- **Redis:** `appendonly yes`, `auto-aof-rewrite-min-size` = 64 MB, `save 3600 1 300 100 60 10000`.
- **bullmq / ioredis** (documentación oficial de BullMQ, verificada):
  - Desde la 6.0.0, ioredis es una *peer dependency* opcional que hay que instalar a mano: "Redis
    users must install ioredis explicitly"
    (https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/changelog.md).
  - El rango declarado es `ioredis >=5.0.0`. Ninguna página oficial dice que ioredis 6.x esté
    probado; el propio repo de BullMQ prueba con ioredis 5.11.1. **Propuesta: `bullmq@6.3.15` +
    `ioredis@5.11.1`.**
  - `connection: { host, port }` o una instancia de IORedis siguen valiendo
    (https://docs.bullmq.io/guide/connections).
  - El Worker exige `maxRetriesPerRequest: null`. Para la Queue se recomienda
    `enableOfflineQueue: false` (https://docs.bullmq.io/guide/going-to-production).
  - Siguen documentados `attempts`, `removeOnComplete`/`removeOnFail` con `{ age, count }` y el
    evento `failed`. `maxStalledCount` no aparece en las páginas leídas: se confirma en los tipos
    instalados antes de usarlo.
  - Tamaño estimado (suma de `unpackedSize` en npm): **~11 MB** entre bullmq, ioredis y sus
    dependencias nuevas. Lo más grande es `luxon` (4,6 MB, de `cron-parser`). `msgpackr-extract`
    trae un binario precompilado para Windows (0,2 MB): no compila nada. `tslib`, `semver` y
    `debug` ya están en el lockfile. El tamaño exacto en disco lo reporta pnpm al instalar.
- `telegram.service.ts:45` registra el chatId de los chats rechazados (dato personal): se corrige.

## 2. Diseño

```
Telegram ─► TelegramService (handler, responde en < 1 s)
   ├─ voz > 120 s → la rechaza (igual que hoy)
   ├─ texto > 1.000 caracteres → lo rechaza (ver §5)
   ├─ "🎤 Escuchando…" / "✍️ Procesando…"   (no para "sí"/"cancelar": son instantáneos)
   ├─ si es "sí": lee versionVista = version_mostrada del borrador PENDIENTE (ver §3)
   └─ cola.add({ chatId, tipo, texto | fileId, versionVista })
         │  Redis caído → falla en el acto → "⚠️ No pude recibir tu mensaje…"
         ▼
     Redis  (cola "mensajes")
         ▼
     Worker: concurrency 1 · attempts 1 · maxStalledCount 0
       datos del trabajo validados con Zod (vienen de Redis)
       procesarMensaje(datos)
         voz:   descargar(fileId) → transcribir → "🎤 Entendí: …"   (la 4.4 lo pasará a la conversación)
         texto: conversacion.responder(chatId, texto, versionVista) → { texto, mostrar? }
       → TelegramService.enviar(chatId, texto)
           envío confirmado → conversacion.marcarMostrada(borradorId, version)
           envío fallido   → no se marca: ese borrador no se puede aprobar
       error → mensaje al usuario según la etapa + log sin datos personales
```

- **Sin dependencia circular:** `ColaMensajesService` solo crea la `Queue` y el `Worker`;
  `TelegramService` le pasa la función de proceso al arrancar.
- **Orden:** un worker con concurrencia 1, así que el orden es global y, por lo tanto, también por
  chat. El límite (un chat espera al otro) queda en un comentario y se revisa en la fase 12.
- **Reintentos:** BullMQ no reintenta (`attempts: 1`). Un reintento pasa el trabajo a *delayed* y
  el siguiente mensaje se adelanta (se rompe el orden), y reinterpretar "agrega una brocha" agregaría
  dos brochas. Dentro del trabajo hay un solo reintento, a los 2 s, y solo de lo que seguro no se
  aplicó: la descarga de Telegram y un `ECONNREFUSED` a Ollama o Whisper. Los timeouts no se
  reintentan. Los reintentos de BullMQ quedan para la fase 6 (Alegra, con idempotencia).
- **Timeouts:** Whisper 120 s y Ollama 120 s (ya existen); descarga de Telegram 30 s (nuevo).
  Con `maxStalledCount: 0`, un trabajo cortado por un reinicio falla en vez de repetirse.
  La conexión de la `Queue` usa `enableOfflineQueue: false` para fallar rápido si Redis está caído.
- **Envío:** la respuesta llega como mensaje nuevo, no editando el "Procesando…", porque editar un
  mensaje no genera notificación.

### Lo que ve el usuario cuando algo falla

| Falla | Mensaje |
|---|---|
| Redis caído | ⚠️ No pude recibir tu mensaje ahora. Intenta de nuevo en unos minutos. |
| Texto demasiado largo | El mensaje es muy largo (máx. 1.000 caracteres). Divídelo o resúmelo. |
| Whisper caído o timeout | No pude escuchar la nota de voz. Intenta en un rato o escríbela. |
| Ollama caído o timeout | No pude procesar el mensaje. Tu borrador anterior sigue igual. |
| Reinicio a mitad de un trabajo | No alcancé a procesar tu último mensaje. Reenvíalo, por favor. |
| Falla al enviar por Telegram | Solo se registra en el log; el borrador queda sin poder aprobarse (§3) |
| "sí" sobre una versión que no vio | Se reenvía el resumen actual: "Revisa este resumen y responde 'sí' otra vez." |

## 3. Aprobación solo de lo que el usuario vio (corrige la decisión 4)

**Problema.** Si se guarda una corrección y el envío por Telegram falla (o el bot se cae entre
guardar y enviar), con `actualizadoEn` un "sí" aprobaría una versión que el usuario nunca vio.

**Esquema** (misma migración que el índice único de §4):

```prisma
model Borrador {
  // …campos actuales…
  version         Int  @default(1)
  /// Última versión cuyo resumen Telegram confirmó haber recibido. Null = nunca se mostró.
  versionMostrada Int? @map("version_mostrada")
}
```

**Reglas:**

1. Cada escritura de `datos` hace `version: { increment: 1 }`.
2. `responder()` devuelve `{ texto, mostrar?: { borradorId, version } }`.
3. Solo cuando `enviar()` termina sin error (Telegram confirmó el mensaje) se marca, de forma
   condicional:
   `updateMany({ where: { id, version }, data: { versionMostrada: version } })`.
   Si entretanto hubo otra versión, no marca nada.
4. Al llegar un "sí", el handler lee `versionVista = versionMostrada` del PENDIENTE (o `null` si no
   hay borrador) y la manda en el trabajo. Esa es la versión que el usuario tenía en pantalla al
   escribir. **Se toma de `versionMostrada`, nunca de `version`:** `version` puede ir por delante
   con una corrección guardada que el usuario todavía no recibió. Tomarla de ahí equivaldría a
   suponer que la vio.
5. El "sí" aprueba solo si `version == versionMostrada == versionVista`, en una única escritura
   atómica:
   `updateMany({ where: { id, estado: 'PENDIENTE', version: v, versionMostrada: v }, data: { estado: 'APROBADO' } })`
   y comprobando `count === 1`. Si no se cumple, no aprueba: reenvía el resumen actual (que se
   marca como mostrado al confirmarse el envío) y pide "sí" otra vez.

**Por qué hacen falta las dos condiciones:**
- `version == versionMostrada` cubre el envío fallido y el reinicio entre guardar y enviar.
- `== versionVista` cubre el "sí" escrito antes de que llegara la corrección: v1 mostrada →
  corrección en cola → "sí" en cola → se guarda v2, se muestra y se marca → sin `versionVista`, el
  "sí" aprobaría v2, que el usuario no había visto al escribirlo.

**Límite honesto:** Telegram confirma que el mensaje llegó a sus servidores, no que el usuario lo
leyó. Es la mejor señal disponible.

**Datos existentes:** el borrador PENDIENTE de la base local queda con `version 1` y
`versionMostrada null`. Su primer "sí" reenvía el resumen; el segundo aprueba.

**"cancelar"** no exige versión: cancelar nunca es peligroso.

## 4. Índice único parcial y error P2002

**Índice:** a lo sumo un PENDIENTE por chat, garantizado por la base de datos:
`CREATE UNIQUE INDEX … ON borradores (chat_id) WHERE estado = 'PENDIENTE'`. Va en la misma migración
que las columnas de §3. Con la *preview feature*, siguiendo la sintaxis documentada:

```prisma
generator client {
  // …lo actual…
  previewFeatures = ["partialIndexes"]
}

model Borrador {
  // …
  @@unique([chatId], where: raw("estado = 'PENDIENTE'"))
}
```

Antes de aplicarla, se revisa el SQL que genera `prisma migrate dev --create-only`.

**Versión fijada (condición 2 de §15):**
- `prisma`, `@prisma/client` y `@prisma/adapter-pg` ya están en `7.10.0` exacta en `package.json`
  (sin `^`), y el lockfile coincide. Se mantienen así.
- Subir Prisma pasa a ser un cambio deliberado, en su propio PR, que revisa las notas de versión de
  `partialIndexes` y corre la prueba de integración de abajo.
- Se anota en la bitácora y junto al `previewFeatures` del esquema.

**Prueba de integración del índice (condición 2):**
- **Archivo y ejecución:** `src/facturacion/borrador-indice.int-spec.ts`, con una configuración
  propia (`vitest.config.int.ts`) y el script `pnpm test:int`. Usa una base PostgreSQL real con las
  migraciones aplicadas, porque un mock no puede probar un índice.
- **Casos:**
  1. Un segundo PENDIENTE del mismo chat se rechaza con `P2002`, comprobando solo el `code`.
  2. Un PENDIENTE en otro chat se acepta.
  3. Un PENDIENTE más un APROBADO o CANCELADO del mismo chat se aceptan.
- **Datos:** chats ficticios, por ejemplo `chatId 999000001 (ficticio)`, que se borran al terminar.
- **En CI:** decisión 11 (§14).

**P2002 al crear (el índice detecta un PENDIENTE que no vimos):** no se deja que explote. Se trata
como una actualización:

1. Se captura `Prisma.PrismaClientKnownRequestError` con `code === 'P2002'` solo en el `create` del
   borrador. Se mira solo el `code`, no `meta.target`: la doc no garantiza que `target` venga
   relleno en un índice parcial. Una prueba manual contra la base local confirma que el índice
   parcial produce P2002.
2. Se lee el PENDIENTE que ganó la carrera.
3. Se **reinterpreta el mismo mensaje como corrección de ese borrador** (`interpretar(texto, actual)`)
   y se hace `update` con `version: { increment: 1 }`.
4. Log de advertencia con el `jobId` y la etapa, sin datos.

Por qué se reinterpreta en lugar de sobrescribir `datos`: la primera interpretación no conocía el
borrador existente, y sobrescribirlo borraría lo que el otro mensaje guardó. Con la cola serial esto
casi no debería pasar (dos copias del bot, o un cambio manual en la base); es defensa en
profundidad. Si la reinterpretación falla, aplica el mensaje de "Ollama caído".

## 5. Límite de texto: 1.000 caracteres

- Se comprueba en el handler, **antes de encolar**.
- Por qué 1.000:
  - Una factura escrita ocupa entre 80 y 300 caracteres. Una de 10 ítems con cliente y NIT cabe en
    unos 600.
  - Acota el tiempo de Ollama (más texto = prompt más largo = más lento en CPU) y lo que se guarda
    en Redis.
  - Telegram permite 4.096 por mensaje, así que sin límite propio cabrían prompts de 4 K.
- La voz ya está acotada por los 120 s de duración. Cuando la 4.4 pase transcripciones a la
  conversación, se aplica el mismo límite a la transcripción.

## 6. Logs y alertas

- Logger de Nest por consola (la de `pnpm run start:dev`); no se escriben archivos.
- **Se registra:** `jobId`, tipo, etapa, duración en ms, `err.name` y `code`.
- **Nunca se registra:** texto, transcripción, chatId, `file_path`, token ni datos del borrador.
  Los mensajes de error son nuestros, como "Whisper respondió 500".
- Alertas: por ahora, nivel warn/error en el log. El aviso al chat de administrador llega en la fase 6.

## 7. Datos en Redis y riesgo del AOF

- Las notas de voz solo guardan el `file_id`, nunca el audio.
- El texto sí va en el trabajo. Retención: `removeOnComplete: true` y `removeOnFail: true` (cambió el
  2026-10-30, ver §18.4: con `{ age: 24 h }` el borrado era perezoso).
- **Riesgo (punto 5):** con `appendonly yes`, cada `add` queda escrito en el archivo AOF. Borrar el
  trabajo agrega un `DEL`, pero **el texto original sigue en el AOF hasta su reescritura**. Redis
  reescribe solo cuando el AOF duplica su tamaño y pasa de 64 MB (`auto-aof-rewrite-min-size`).
  Con el volumen del piloto, eso puede tardar meses.
- Además, las instantáneas RDB (`save 3600 1 …`) pueden capturar trabajos que estaban en cola en
  ese momento.
- Los archivos viven en el volumen local `redis_data`, en el mismo equipo que PostgreSQL (que ya
  guarda los borradores con datos de clientes). Redis solo escucha en 127.0.0.1.
- Mitigaciones posibles (decisión 10):
  - (a) aceptarlo y documentarlo;
  - (b) `BGREWRITEAOF` manual, documentado en la bitácora, o periódico;
  - (c) desactivar la persistencia: se pierden los trabajos si Redis se reinicia, que es justo lo que
    BullMQ evita.

## 8. Memoria: medición y qué hacer si no cumple

**Medición:**
1. Línea base con `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`,
   `docker stats --no-stream`, `ollama ps`, RAM libre y `Get-Counter '\Memory\Pages/sec'`.
2. Envío un texto (carga qwen2.5:7b) y anoto la división CPU/GPU.
3. Envío una nota de voz y mido el pico.
4. Envío 10 mensajes mezclados, voz y texto.

Referencia hoy: 6,3 GB libres de 23,8 GB con Whisper cargado y qwen descargado. Gabriel ya midió
~3,6 GB libres con el 7B cargado.

**Criterio propuesto (reemplaza "más de 4 GB libres"):** sin paginación sostenida, VRAM < 3,8 GB
y latencia estable (sin crecer mensaje a mensaje). Tener 3,6 GB libres no es un problema si el
sistema no pagina.

### Cómo se mide "no paginar" en este equipo (condición 3 de §15)

Hay dos memorias distintas: la de Windows (donde corre Ollama) y la de la VM de WSL2 (donde corren
los contenedores, entre ellos Whisper). Se miden por separado.

**Por qué no sirve `Pages/sec`:** Ollama mapea el archivo del modelo en memoria, así que al cargarlo
`Pages/sec` se dispara sin que haya falta de RAM. Por eso se mide **después del calentamiento** (los
dos modelos ya cargados) y con `Pages Input/sec`, que cuenta las lecturas reales desde disco.

**1. Windows (Ollama, Node, Docker Desktop)**, en una terminal de PowerShell aparte, mientras se
envían los 10 mensajes:

```powershell
Get-Counter -Counter '\Memory\Pages Input/sec','\Memory\Available MBytes','\Paging File(_Total)\% Usage','\GPU Adapter Memory(*)\Shared Usage' -SampleInterval 2 -MaxSamples 150 |
  ForEach-Object { $_.CounterSamples | Select-Object Path, CookedValue } |
  Export-Csv "$env:TEMP\medicion-memoria.csv" -NoTypeInformation
```

- `Pages Input/sec`: páginas leídas del disco por falta de RAM.
- `Available MBytes`: RAM libre real.
- `Paging File % Usage`: si crece durante la prueba, Windows está mandando memoria al disco.
- `GPU Adapter Memory Shared Usage`: si sube, la VRAM se llenó y el controlador está desbordando a
  la RAM del sistema (esto vuelve lento a Ollama sin que `nvidia-smi` lo muestre como lleno).
- El CSV queda en `%TEMP%`, fuera del repo. A la bitácora solo pasa el resumen.

**2. VM de WSL2 (Whisper, PostgreSQL, Redis).** Contadores de swap de la VM, antes y después de la
prueba. `/proc/vmstat` dentro de un contenedor muestra los de la VM completa:

```powershell
docker exec facturacion-whisper-1 sh -c "grep -E 'pswpin|pswpout' /proc/vmstat; free -m"
docker stats --no-stream
```

Hoy los dos contadores están en 0. Si suben durante la prueba, la VM está usando swap.

**3. GPU**, en otra terminal: `nvidia-smi --query-gpu=memory.used,memory.total --format=csv -l 2`.
Además, `ollama ps` para ver la división CPU/GPU de qwen.

**Criterio de "no pagina":**

| Medida | Cumple si |
|---|---|
| `Pages Input/sec` (tras el calentamiento) | mediana < 10 y ningún tramo > 100 durante más de 10 s |
| `Paging File % Usage` | sube menos de 2 puntos entre el inicio y el fin |
| `GPU Adapter Memory Shared Usage` | no crece durante la prueba |
| `pswpin` / `pswpout` de la VM | diferencia 0 entre antes y después |
| Latencia por mensaje (logs del trabajo) | el último no tarda más de un 25 % que el primero |

Los umbrales son un punto de partida. Si la línea base (sin enviar nada) ya los supera, se ajustan
con esa referencia y se anota por qué.

**Comprobado el 2026-10-15:**
- Los cuatro contadores existen en este equipo con sus nombres en inglés.
- Una sola muestra en reposo dio `Pages Input/sec` ≈ 31, `Available MBytes` ≈ 6.300 y
  `Paging File % Usage` ≈ 4,9 %.
- Una sola muestra no es una línea base, pero ya indica que el umbral de 10 puede quedar corto: la
  línea base de 2 minutos es obligatoria antes de juzgar.

**Si no cumple**, en este orden (de más barato y reversible a menos):

| Opción | Efecto | Costo | ¿Pasa por evaluación? |
|---|---|---|---|
| A. `MODEL_IDLE_TIMEOUT=300` en whisper | Libera ~2,7 GB tras 5 min sin notas | La primera nota tras inactividad recarga el modelo (medir segundos) | No (mismo modelo) |
| B. `OLLAMA_KEEP_ALIVE` más corto (por defecto 5 min) | Libera ~5,1 GB antes | El primer texto tras inactividad recarga qwen | No |
| C. `.wslconfig` con `memory=6GB` (hoy no existe: WSL toma hasta 11,6 GB) | Limita a Docker | Riesgo de OOM en Whisper; afecta a todo WSL | No |
| D. `num_ctx` menor en Ollama | KV cache más pequeña (RAM/VRAM) | Puede truncar prompts largos | **Sí**, set de evaluación y aprobación |
| E. Modelo más pequeño (qwen 3b o Whisper small) | Mucha menos memoria | Peor calidad (Whisper small: 1/6 exactos vs 4/6) | **Sí**; último recurso, no recomendado |

Recomendación: medir con el criterio nuevo; si falla, A; si sigue fallando, B. Las opciones C a E,
solo con tu aprobación.

### Si se aplica `MODEL_IDLE_TIMEOUT` (condición 4 de §15)

Se mide cuánto tarda la primera nota después de que se libera el modelo, comparada con una nota con
el modelo ya cargado:

1. Se usa siempre la misma nota de prueba: ~10 s, con datos ficticios, guardada fuera del repo.
2. **En caliente:** se envía 3 veces seguidas y se anota la duración de la etapa `transcribir` en
   el log del trabajo.
3. Se espera más que el timeout y se confirma la descarga: la RAM del contenedor en
   `docker stats --no-stream` baja de ~2,7 GiB a unos cientos de MB.
4. **En frío:** se envía la nota y se anota la duración de `transcribir` y el tiempo total hasta
   recibir "🎤 Entendí".
5. Se repiten los pasos 3 y 4 tres veces y se registran en la bitácora la mediana en frío, la
   mediana en caliente y la diferencia.

Criterio propuesto: si la primera nota en frío pasa de 30 s en total, se sube el timeout o se
prefiere la opción B, y se decide contigo.

## 9. Tests (Vitest con mocks; el CI no tiene Redis, Ollama ni Whisper)

**`procesarMensaje`:**
- Un texto llama a la conversación, envía y marca como mostrada.
- Una voz descarga, transcribe y envía.
- Whisper caído y Ollama caído producen su mensaje.
- `ECONNREFUSED` se reintenta una vez; un timeout no.
- **Falla al enviar por Telegram:** `marcarMostrada` no se llama y se registra un log sin datos.
- Datos del trabajo inválidos (Zod): no se procesa.

**`ConversacionService`:**
- "sí" con `version == versionMostrada == versionVista` aprueba.
- **Guardado sin envío** (simula un reinicio entre guardar y enviar, o una falla de Telegram):
  `version 2`, `versionMostrada 1` → no aprueba y reenvía el resumen.
- "sí" escrito antes de ver la corrección: `versionVista 1`, `version 2`, `versionMostrada 2` → no
  aprueba.
- **`versionVista` sale de `versionMostrada` (condición 1 de §15):** borrador con `version 2`
  (corrección guardada) y `versionMostrada 1` (aún sin enviar). Llega "sí" y el handler captura
  `versionVista = 1`. Luego se confirma el envío y `versionMostrada` pasa a 2. Al procesar el "sí":
  `version 2 == versionMostrada 2`, pero `versionVista 1 ≠ 2` → **no aprueba** y reenvía el resumen.
  El test cubre las dos mitades:
  - en el handler, que la captura lee `versionMostrada` y no `version`;
  - en `ConversacionService`, que con `versionVista 1` no aprueba aunque las otras dos coincidan.
- Sin borrador al escribir "sí" (`versionVista null`) → no aprueba.
- `updateMany` con `count 0` (carrera en la aprobación) → no aprueba.
- `marcarMostrada` es condicional a la versión.
- **P2002** en `create` → reinterpreta con el PENDIENTE existente y hace `update`.

**Reinicio a mitad de un trabajo:** el manejador de `failed` con un error de *stalled* envía
"Reenvíalo". Junto con el caso "guardado sin envío", queda probado que un reinicio no permite aprobar.

**Handler:**
- Texto de más de 1.000 caracteres → no se encola.
- `add()` falla → mensaje de Redis caído.

El cableado de grammY no se prueba. El Worker se crea al arrancar la app, nunca en los tests
unitarios.

## 10. Healthcheck de whisper

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://localhost:9000/docs"]
  interval: 15s
  timeout: 5s
  retries: 5
  start_period: 10m   # la primera vez descarga el modelo (~1,6 GB)
```

Si se adopta la opción A de §8, "sano" querrá decir que el servicio responde, no que el modelo esté
en RAM.

## 11. Archivos que cambian

- `apps/api/package.json` y `pnpm-lock.yaml`: bullmq e ioredis (decisión 1).
- **Nuevo** `src/mensajeria/cola-mensajes.service.ts`: Queue, Worker y cierre ordenado.
- **Nuevo** `src/mensajeria/procesador-mensajes.ts` y su `.spec.ts`: esquema Zod del trabajo y lógica.
- `src/mensajeria/telegram.service.ts`: encola, límite de texto, `enviar()`, `descargarVoz()`, se
  quita el chatId del log.
- `src/facturacion/conversacion.service.ts` y su `.spec.ts`: versiones, aprobación atómica,
  `marcarMostrada()`, P2002, `esComando()`.
- `src/app.module.ts`: el provider nuevo.
- `prisma/schema.prisma` y una migración: `version`, `version_mostrada` y el índice único parcial.
- `docker-compose.yml`: el healthcheck de whisper.
- `README.es.md` y `README.md`: bitácora, mediciones y el riesgo del AOF, al cerrar la subfase.

## 12. Alternativas descartadas

- **Cadena de promesas en memoria por chat:** sin dependencias, pero pierde los mensajes si el bot
  se reinicia y no sirve para la fase 6.
- **`@grammyjs/runner` con `sequentialize`:** orden por chat, pero sin persistencia.
- **Una cola por chat:** obliga a crear workers dinámicos, y eso es complejo.
- **Grupos de BullMQ Pro:** son de pago.
- **Reintentos de BullMQ con backoff:** rompen el orden y duplican correcciones.
- **`@nestjs/bullmq`:** otra dependencia y otra capa, y no verifiqué su compatibilidad con Nest 12.
- **Guardar el audio en el trabajo:** dejaría datos personales en el disco de Redis.
- **Versión del "sí" con `actualizadoEn`:** permite aprobar una versión guardada pero no mostrada
  (§3).
- **Ante un P2002, sobrescribir `datos`:** borraría lo que guardó el otro mensaje (§4).
- **Editar el "Procesando…" con el resultado:** editar no genera notificación.

## 13. Riesgos

- Con la cola global, un chat espera al otro, hasta ~2 min. Es aceptable en el piloto.
- El texto queda en Redis hasta que el trabajo termina y **en el AOF hasta su reescritura** (§7).
- La versión mostrada depende de la confirmación de Telegram, no de que el usuario lo haya leído.
- La *preview feature* de Prisma puede cambiar de sintaxis en versiones futuras.
- Si el bot pasa un rato caído, el usuario puede reenviar y procesarse dos veces. Nunca se aprueba
  nada solo, y el usuario ve el resumen.
- Ahora los tests e2e locales necesitarán Redis arriba. No corren en el CI.

## 14. Decisiones para Gabriel

1. Instalar **`bullmq@6.3.15` + `ioredis@5.11.1`** (~11 MB, §1), sin `@nestjs/bullmq`.
   Recomiendo: sí.
2. Un worker con **concurrencia 1 global**. Recomiendo: sí.
3. **Sin reintentos de BullMQ;** un reintento interno solo para la descarga y para `ECONNREFUSED`.
   Recomiendo: sí.
4. **`version` + `version_mostrada` + `versionVista`** (§3). Recomiendo: sí.
5. **Índice único parcial** en la misma migración, activando la *preview feature*
   `partialIndexes` en lugar de escribir el SQL a mano. Así lo recomienda la doc de v7, y un índice
   que no esté en el esquema podría eliminarse en un diff futuro. Recomiendo: sí, sabiendo que una
   *preview* puede cambiar.
6. Retención en Redis: `removeOnComplete: true` y fallidos 24 h. Recomiendo: sí.
   **Cambiada el 2026-10-30 (aprobado por Gabriel): fallidos con `removeOnFail: true`** (§18.4).
7. Alertas: solo logs hasta la fase 6. Recomiendo: sí.
8. **Límite de texto de 1.000 caracteres.** Recomiendo: sí.
9. **Criterio de memoria** basado en la paginación, y el orden de opciones A → B (§8).
   Recomiendo: sí.
10. **AOF:** (a) documentarlo, más (b) un `BGREWRITEAOF` manual documentado en la bitácora.
    Recomiendo: sí; el periódico, en la fase 6.

11. **Prueba de integración del índice en CI** (nueva, surge de la condición 2):
    - (a) Agregar un servicio `postgres:18-alpine` al job de `.github/workflows/ci.yml`, aplicar
      las migraciones y correr `pnpm test:int`.
    - (b) Correrla solo en local, como paso obligatorio antes del PR.

    **Decidido por Gabriel el 2026-10-15: (a).** En el job `api` de `ci.yml`:
    - Un servicio `postgres:18-alpine` con healthcheck `pg_isready`, credenciales solo de CI
      (como el `DATABASE_URL` ficticio que ya existe) y el puerto 5432 del runner.
    - `DATABASE_URL` apuntando a ese servicio.
    - Después de los tests unitarios, **aplicar las migraciones** con `pnpm exec prisma migrate deploy`
      (aplica las migraciones existentes sin generar nuevas ni pedir confirmación, que es lo
      correcto en CI) y **luego** correr `pnpm test:int`.
    - Si la migración falla, el job falla antes de llegar a los tests de integración.

## 15. Condiciones de la aprobación (2026-10-15)

1. `versionVista` se toma de `versionMostrada` al recibir el "sí", nunca de `version`, con un test
   para "corrección guardada sin enviar → sí → envío → no aprueba" (§3 y §9).
2. Prisma fijada en `7.10.0` exacta mientras `partialIndexes` siga en *preview*, más una prueba de
   integración que confirme que el índice rechaza un segundo PENDIENTE del mismo chat (§4).
3. Medición concreta de "no paginar" en Windows + WSL (§8).
4. Si se aplica `MODEL_IDLE_TIMEOUT`, medir la primera nota tras la liberación del modelo (§8).

## 16. Orden sugerido para la sesión de implementación

1. Leer `CLAUDE.md`, `CLAUDE.local.md` y este plan.
2. Pedir el OK para instalar `bullmq@6.3.15` e `ioredis@5.11.1`, con el tamaño real que reporte pnpm.
3. Esquema y migración (columnas, `previewFeatures` e índice), con `--create-only` y revisión del SQL.
4. `ConversacionService`: versiones, aprobación atómica, `marcarMostrada` y P2002, con sus tests.
5. `procesador-mensajes.ts` y `cola-mensajes.service.ts`, con sus tests.
6. `telegram.service.ts`: encolado, límite de texto, captura de `versionVista` y log sin chatId.
7. Prueba de integración del índice; en `ci.yml`, el servicio PostgreSQL, `prisma migrate deploy`
   y luego `pnpm test:int` (decisión 11).
8. Healthcheck de whisper; prueba manual en Telegram; mediciones de memoria (§8).
9. Resolver §18.1 (hallazgos de la auditoría para cerrar la 4.3), con su aprobación; luego lint,
   Prettier, tsc y tests; subagentes `control-calidad` y `seguridad`; bitácora y README.

**Avance (2026-10-30):** pasos 1 a 7 hechos. Del 8: healthcheck de whisper hecho, y guion de
prueba manual completo (puntos 0 a 8) con el resultado esperado en todos, incluido el "sí" enviado
justo después de una corrección (no aprobó) y el orden de dos mensajes seguidos. Falta decidir el
criterio de memoria y el `.wslconfig` (§17). Las mediciones están fuera del repo, con su resumen.

## 17. Pendientes detectados durante la implementación

- **Fase 3.5: validar con Zod el JSON de `datos` leído de la BD.** `ConversacionService` lo
  convierte con `as unknown as BorradorFactura` (función `datosDe`), sin validarlo, y CLAUDE.md
  exige validar con Zod el JSON que viene de la base. Ya pasaba antes de la 4.3. Propuesta:
  un esquema Zod de `BorradorFactura` (reusando lo que se pueda de `respuestaIaSchema`) y,
  si la fila no lo cumple, registrar el problema y avisar al usuario en vez de seguir.
- **Revisar antes de la fase 5 (Alegra): deduplicación tras completar.** El jobId
  `tg-<update_id>` solo deduplica mientras el trabajo sigue en la cola: con
  `removeOnComplete: true`, una entrega repetida de Telegram que llegue después de procesar el
  mensaje se procesa otra vez. Hoy el hueco es < 1 s (grammY confirma el `update_id` en cuanto el
  handler termina de encolar). Opción futura: `deduplication: { id, ttl }` de BullMQ, que recuerda
  solo el id durante el ttl, sin guardar el texto.
- **Obligatorio antes de la fase 10 (WhatsApp) o de tener más de un comercio: límite de
  frecuencia por chat** (mensajes por minuto). No está implementado: hoy un chat autorizado puede
  llenar la cola, y con concurrencia 1 global haría esperar a los demás.
- **Pendiente de aprobar: criterio de memoria ajustado (§8).** La línea base del 2026-10-28
  (2 min en reposo, qwen2.5:7b y Whisper cargados, tras cerrar programas) ya supera el umbral de
  `Pages Input/sec`: mediana 61,5 y una racha de 14 s sobre 100/s. Los demás criterios se
  cumplieron: `Paging File % Usage` bajó 0,46 puntos, `GPU Adapter Memory Shared Usage` estable en
  ~2,9 GB, `pswpin`/`pswpout` en 0, VRAM 3,29 GB y RAM disponible ~4,8 GB. Propuesta:
  - Mediana de `Pages Input/sec` durante la prueba ≤ 1,5 × la mediana de la línea base.
  - Rachas sobre 100/s ≤ 20 s.
  - Los otros criterios de §8 sin cambios.

  Se aprueba después de repetir la línea base en la siguiente sesión. En esta medición el primer
  intento de cargar qwen falló con un error de CUDA ("shared object initialization failed") y el
  segundo cargó bien: si se repite, anotarlo.

  **Datos del 2026-10-29 y 2026-10-30:** la mediana de `Pages Input/sec` en reposo varió entre días
  (61,5 → 23,9 → 114,6), y el 30 hubo una racha de 38 s sobre 100/s **sin ningún mensaje**, así que
  un umbral fijo de racha no sirve. En la prueba del 30: mediana 9,4 (≤ 1,5 × base), racha más larga
  26 s (menor que la de la base), `Paging File % Usage` +1,6 puntos de inicio a fin (pico +4,6),
  `GPU Shared Usage` hasta +144 MB sobre el inicio, `pswpin`/`pswpout` en 0 y VRAM máxima 3,44 GB.
  **Aprobado por Gabriel el 2026-10-30:** la base es la del mismo día, tomada justo antes de la
  prueba; mediana de `Pages Input/sec` ≤ 1,5 × la de la base; rachas sobre 100/s no más largas que
  la racha más larga de la base; `GPU Shared Usage` con tolerancia de ±100 MB; el resto de §8 sin
  cambios. **A vigilar:** el 30, `GPU Shared Usage` subió +144 MB, por encima de la tolerancia; se
  revisa en la próxima medición sin cambiar la tolerancia.
- **`.wslconfig` (opción C de §8), aplicado el 2026-10-30:** `memory=6GB` y
  `autoMemoryReclaim=dropCache` (en `[experimental]`, según la doc de Microsoft), en
  `%UserProfile%\.wslconfig`, fuera del repo. Docker lo respeta: `docker info` pasó de 11,6 a
  5,8 GiB. Con una nota de voz de ~2 min: transcribir 36,8 s, pico de Whisper 2,92 GiB, memoria
  usada de la VM máx 3,6 de 5,9 GB, disponible mín 2,3 GB, `pswpin` 0. `pswpout` subió de 0 a 53
  páginas (~0,2 MB) al arrancar y en reposo, no durante la transcripción: se vigila. Antes, con una
  nota de ~10 s y sin límite, el pico de Whisper fue 3,0 GiB.
- **Intérprete: "cantidad × precio unitario" (set de evaluación).** Ejemplo ficticio: "2 galones de
  esmalte a $50.000 cada uno, total $100.000". La IA puso el precio unitario (50.000) como valor de
  la línea; el código lo detectó con el aviso de que los productos no suman. Hay que agregar el caso
  al set de evaluación antes de tocar las instrucciones del intérprete (regla de CLAUDE.md). Una
  lista de 9 productos con el total de cada línea se extrajo bien.
- **Latencia de Ollama.** Trabajos de texto entre 6,5 y 15 s; la lista de 9 productos tardó 44,8 s,
  y un mensaje con qwen descargado, 27,3 s (unos 10 s de recarga). El timeout es de 120 s: una lista
  más larga podría acercarse. Revisar antes de la fase 5 (medir con más ítems; opciones: mantener
  el modelo cargado más tiempo, mensaje de "sigo procesando").
- **4.4 / fase 3.5: NIT dictado por voz con dígito de verificación.** Whisper transcribe el formato
  "número-dígito" (ficticio: `900000001-2`). Ese formato debe normalizarse (quitar puntos, separar
  el dígito) y validarse con el módulo 11 antes de aceptarlo; si no cuadra, preguntar al usuario.
- **Título del mensaje de aprobación.** Después de aprobar, el resumen sigue titulado
  "🧾 Borrador de factura". Debe cambiar (p. ej. "🧾 Factura aprobada") para no confundir.

## 18. Auditoría independiente de la 4.3 (2026-10-30, solo lectura)

Todos los datos de ejemplo de esta sección son ficticios. **Estado: §18.1 aprobado y resuelto el
2026-10-30; §18.2 y §18.3 quedan para la 4.4 y la 3.5.**

### 18.1 Para cerrar la 4.3 (dentro del paso 9, antes de los subagentes)

1. **Orden de apagado.** Confirmado en la doc de NestJS (Lifecycle events): al recibir la señal se
   ejecutan todos los `onModuleDestroy()`, después todos los `beforeApplicationShutdown()`, se
   cierran las conexiones (`app.close()`) y al final los `onApplicationShutdown()`. Cada fase espera
   a que terminen todas las promesas de la anterior. Hoy `PrismaService.$disconnect()` está en
   `onModuleDestroy`, así que la base se desconecta **antes** de que el worker termine su trabajo.
   Propuesta, usando las fases como barreras:
   - `TelegramService.onModuleDestroy`: `bot.stop()` (deja de recibir mensajes).
   - `ColaMensajesService.beforeApplicationShutdown`: cerrar el worker (termina el trabajo en
     curso, que aún puede usar la base y `bot.api`), la cola y las conexiones de Redis.
   - `PrismaService.onApplicationShutdown`: `$disconnect()`.

   Así el orden queda garantizado por Nest y no depende del orden de los providers dentro de una
   misma fase, que la doc no especifica. Nota de la doc: en Windows funciona `SIGINT` (Ctrl+C) y
   `SIGTERM` nunca. Test: un spec por servicio que compruebe en qué hook se cierra cada cosa.
2. **Test faltante.** Ningún test aísla `versionMostrada !== version`: el de "guardado sin envío"
   usa `versionVista 1`, que también difiere. Propuesta:
   - Unitario: `version 2`, `versionMostrada 1`, `versionVista 2` → no aprueba y reenvía.
   - `conversacion.int-spec.ts` contra PostgreSQL real, con el intérprete simulado y chats
     ficticios: aprueba con `v == mostrada == vista`; no aprueba con `v2/m1/vista2` (la fila sigue
     PENDIENTE); `marcarMostrada` con una versión vieja no cambia nada; si la versión cambia entre
     la lectura y el `updateMany`, `count` es 0 y no aprueba.
3. **`telegram.service.ts`, error al iniciar el bot:** usar `describirError(err)` en lugar de
   `err.message`.
4. **Tamaño de las notas de voz.** Hoy solo se valida la duración, que declara el cliente. Según la
   Bot API, `Voice.file_size` es opcional y los bots pueden descargar hasta 20 MB. Propuesta:
   - Primero medir: registrar en el log, al recibir la nota, solo `duration` y `file_size`
     (no son datos personales) y enviar una nota de ~2 min. No hay registro del tamaño de la nota
     de 2 min del 2026-10-30.
   - Fijar el límite con margen sobre lo medido (el valor de ~1 MB se confirma o se ajusta con
     ese dato) y rechazar antes de encolar si `file_size` lo supera.
   - Si `file_size` no viene, comprobar el tamaño real después de descargar y antes de Whisper.

### 18.2 Para el plan de la 4.4

5. **Hallazgo principal: la versión vista se lee cuando el "sí" llega al bot, no cuando el usuario
   lo escribe.** Con mala señal, un "sí" escrito mirando la v1 puede llegar después de que se
   mostró la v2 y aprobarla. Propuesta: aprobar con un **botón en línea** en cada resumen.
   - `callback_data` = `a:<borradorId>:<version>`. Con un UUID de 36 caracteres y una versión de
     hasta 5 dígitos son ~44 bytes; la Bot API permite de 1 a 64 bytes.
   - El botón lleva la versión exacta de ese mensaje: aprueba solo si
     `version == versionMostrada == versión del botón`, con el mismo `updateMany` atómico, y solo
     si el chat está autorizado y el borrador es de ese chat.
   - Siempre se llama a `answerCallbackQuery` (la Bot API lo exige para quitar la barra de
     progreso del cliente). Tras aprobar o si el resumen ya no está vigente, se quita el botón
     del mensaje viejo.
   - El "sí" de texto o de voz ya no aprueba: responde con el resumen vigente y el botón
     ("Toca ✅ Aprobar para confirmar"). Esto también resuelve que el trabajo de voz no lleve
     `versionVista`. La decisión de mantener o no el "sí" de texto es de Gabriel.
6. **El aviso "reenvíalo" tras un reinicio puede ser falso:** la corrección o la aprobación pudieron
   guardarse antes del corte. Propuesta: `avisarTrabajoFallido` consulta el estado real del chat:
   si el último borrador quedó aprobado después de que se encoló el trabajo, "Tu factura quedó
   aprobada"; si hay un PENDIENTE, reenviar su resumen vigente (con el botón); si no hay nada,
   el aviso actual.
7. **Precios abreviados por voz.** En un dictado real apareció un precio dicho en miles sin la
   palabra "mil" junto a otro completo. Ejemplo ficticio: "pintura azul 192, cinta 5.000", donde 192
   quiere decir $192.000. El intérprete debe entenderlo y, si hay duda, **preguntar**. Se agrega al
   set de evaluación con ejemplos ficticios antes de tocar sus instrucciones (regla de CLAUDE.md).
   El código puede marcar como dudoso un valor de línea menor que 1.000 cuando otros están en miles.

### 18.3 Para la fase 3.5

8. `cancelar()` y `corregir()` con `updateMany` condicionado a `estado: 'PENDIENTE'` (y a `version`
   en `corregir`), comprobando `count`.
9. El worker también comprueba `TELEGRAM_CHATS_PERMITIDOS` antes de procesar; Redis con
   `requirepass`.
10. CI: `permissions: contents: read`, acciones fijadas por SHA, Dependabot y un paso de
    `prisma migrate diff --exit-code` (el esquema y las migraciones no se desalinean).
11. `test:int` con una base de pruebas aparte, no la de desarrollo.
12. `app.listen` en `127.0.0.1`; el bot responde solo en chats privados y una sola vez a cada chat
    desconocido.
13. Subir zod a 4.6.6 en un PR aparte: el aviso GHSA-mrhx-c7xc-m3w5 (severidad alta) afecta a
    `< 4.6.6` (agotar memoria validando arreglos grandes sin límite de longitud).
14. Prueba de integración de BullMQ con un Redis real en el CI. **Avance:** el CI ya levanta Redis
    y `cola-fallidos.int-spec.ts` prueba la retención de fallidos (§18.4); falta probar el flujo
    completo de la cola.

15. Subir `@nestjs/*` a 12.3.2, en un PR aparte (de una auditoría del historial).
16. Quitar `@nestjs/mau` y el script `deploy` de `apps/api/package.json`.
17. Ampliar `.gitignore`: audios, PDF, `docker-compose.override.yml` y `settings.local.json`.
18. CI: `timeout-minutes` y `concurrency` (cancela ejecuciones viejas de la misma rama).
19. `env.schema.ts`: los IDs de `TELEGRAM_CHATS_PERMITIDOS` como enteros seguros y distintos de 0, y
    validar las URLs de Ollama y Whisper.

### 18.4 Revisión de `control-calidad` y `seguridad` (2026-10-30)

`control-calidad` respondió "ok". **Resuelto antes de cerrar la 4.3** (aprobado por Gabriel):

- **Un "sí" podía aprobar otro borrador** (seguridad, media). La vista guardaba solo la versión:
  con "cancelar" → factura nueva → "sí" en cola, el "sí" escrito viendo A v1 aprobaba B v1. Ahora el
  trabajo lleva `vista: { borradorId, version }` (validada con Zod) y se exige el mismo borrador.
  Tests unitario y de integración; una prueba de mutación confirmó que, sin la comparación del id,
  el escenario aprueba B contra PostgreSQL real.
- **Fallidos con `removeOnFail: true`** (seguridad, media). Verificado en bullmq 6.3.15: el borrado
  por antigüedad (`removeJobsByMaxAge`) solo corre dentro de `moveToFinished`, es decir, cuando otro
  trabajo termina en ese conjunto, así que un fallido podía quedarse días con el texto del cliente.
  El evento `'failed'` del Worker se emite después de `moveToFailed` con el mismo objeto `job` en
  memoria, también en el camino de un trabajo stalled. `cola-fallidos.int-spec.ts` lo prueba con
  BullMQ y Redis reales en los dos caminos; con `{ age: 24 h }` la prueba falla. Cambia la decisión 6.
- **Apagado:** `beforeApplicationShutdown` con `try/finally` (si el worker falla al cerrar, se
  cierran igual la cola y las conexiones), y `vi.restoreAllMocks()` en `afterEach` de
  `apagado.spec.ts` (control-calidad).
- **Datos ficticios marcados** en las instrucciones del intérprete (comentario fuera del texto, que no
  cambia), `factura.spec.ts` (nombre del cliente cambiado por uno inventado) e
  `interprete-texto.service.spec.ts`.

**Para el plan de la 4.4:**
- Duración real de la nota: la declara el cliente y puede mentir (con Opus de baja tasa, 1 MB son
  hasta ~20 min de CPU de Whisper). Calcularla con la *granule position* de la última página OggS
  (÷ 48.000) antes de transcribir, junto con el límite de frecuencia por chat (§17).
- Descarga por partes: rechazar por `content-length` y cortar la lectura al pasar
  `TAMANO_MAXIMO_VOZ_BYTES`, en vez de cargar hasta 20 MB en memoria cuando no viene `file_size`.

**Para la fase 3.5:**
- Whisper en una red de Docker propia, separada de Redis y PostgreSQL, e imágenes fijadas por
  *digest* (whisper, postgres, redis, también en el CI) con Dependabot para Docker, junto con §18.3
  punto 10. Cambiar la contraseña local de PostgreSQL por una que no esté en el repo (`.env`).
- Validar con Zod las respuestas de Whisper (`{ text }`) y de Ollama (`message.content`), con un
  error propio si no cumplen, junto con la validación de `datos` de §17.

**Aceptado:** el límite de 1.000 caracteres cuenta unidades UTF-16 (un emoji cuenta como 2).

## Para estudiar

- BullMQ: "Going to production", "Stalled jobs", "Retrying failing jobs".
- grammY: "Scaling Up II: Long Polling".
- PostgreSQL: "Partial Indexes". Prisma: "Indexes" y "Preview features".
- Redis: "Persistence" (AOF, reescritura y RDB).
- ioredis: `maxRetriesPerRequest` y `enableOfflineQueue`.
- Concepto: *optimistic concurrency control* (la versión en la fila).
