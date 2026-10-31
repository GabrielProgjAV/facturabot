# facturabot

**🌐 Idioma:** [English](README.md) · Español

> Facturación electrónica para pequeños comercios en Colombia, directamente desde WhatsApp:
> envía una foto de la factura escrita a mano, revisa el borrador y apruébalo.

⚠️ **Estado: en desarrollo temprano.** Todavía no está listo para usarse en producción.

## 1. Descripción

Muchos pequeños comercios en Colombia siguen facturando en papel, aunque la ley exige factura
electrónica ante la DIAN. Hoy, cada vez que un cliente la pide, alguien tiene que digitar a mano los
datos del cliente (RUT) y la factura en un software de facturación.

**facturabot** es un bot de WhatsApp que automatiza ese proceso:

1. El comerciante envía al bot una **foto** de la factura escrita a mano (o un **texto**, o una
   **nota de voz**).
2. Una IA extrae los datos: cliente, ítems y total.
3. El bot busca al cliente en el software de facturación y, si no existe, **pide por chat** los datos
   que falten y lo crea.
4. El bot muestra un **borrador** (subtotal, IVA y total). El comerciante lo **aprueba** o lo
   **corrige con texto sencillo** ("el vinilo son 3 galones").
5. Solo después de la aprobación se emite la factura electrónica mediante un **proveedor autorizado
   por la DIAN** (Alegra, luego Siigo) y el PDF vuelve por WhatsApp.

También: crear clientes sin facturar, notas crédito y reportes ("¿cuánto vendí esta semana?").

**Piloto:** un pequeño comercio de pinturas.

## 2. Estado actual

| Fase | Descripción | Estado |
|---|---|---|
| 0 | Validación sin código (IA, Alegra, bot de Telegram) | 🟡 En curso |
| 1 | Base del proyecto (NestJS, Docker, configuración, base de datos) | ✅ Hecha |
| 2 | Bot eco en **Telegram** | ✅ Hecha |
| 3 | **Factura por texto:** la IA entiende el mensaje, pide lo que falta, muestra el borrador y espera la aprobación humana | ✅ Hecha |
| 4 | **Factura por voz:** nota de voz → texto (Whisper) → mismo flujo de la fase 3 | 🟡 En curso (4.1–4.3 hechas; sigue 4.4) |
| 5 | **Facturas de compra en PDF → base de inventario:** leer pedidos de proveedores y registrar las entradas de productos (todavía sin descontar ventas) | ⚪ Pendiente |
| 6 | Conexión con Alegra y emisión real tras la aprobación | ⚪ Pendiente |
| 7 | Clientes sin factura y notas crédito | ⚪ Pendiente |
| 8 | Reportes (ventas e inventario) y **descuento del inventario por ventas** | ⚪ Pendiente |
| 9 | Lectura de **fotos** de facturas manuscritas (con un modelo de visión mejor) | ⚪ Pendiente |
| 10 | Adaptador **WhatsApp** (Meta Cloud API o Twilio), antes del piloto real | ⚪ Pendiente |
| 11 | Adaptador Siigo | ⚪ Pendiente |
| 12 | Multiempresa y panel web | ⚪ Pendiente |

## 3. Decisiones de arquitectura

| Decisión | Elección | Motivo | Alternativa considerada |
|---|---|---|---|
| Canal (desarrollo) | **Telegram** (grammY, *long polling*) detrás del puerto `CanalMensajeria` | Sin trámites ni datos de empresa; acepta fotos, texto y voz; no necesita exponer el PC a internet | Simulador local, Twilio sandbox |
| Canal (producción) | WhatsApp Business Cloud API (número propio del bot) o Twilio, como un adaptador más (fase 10) | Es lo que usan los comercios; las librerías no oficiales arriesgan el bloqueo del número. Meta exige datos de empresa, por eso se pospone | Baileys / whatsapp-web.js |
| Emisión DIAN | Vía proveedor (Alegra → Siigo) | Ellos asumen la habilitación, firma digital y UBL 2.1 | Software propio ante la DIAN (futuro) |
| Backend | TypeScript + NestJS | Módulos + inyección de dependencias; mismo lenguaje que el futuro panel web | Python + FastAPI, Kotlin + Spring |
| Base de datos | PostgreSQL + Prisma | Datos relacionales y contables; ORM tipado | MySQL, TypeORM, Drizzle |
| Validación | Zod | Valida la salida de la IA y la configuración, y genera tipos | class-validator |
| Cola | Redis + BullMQ | La IA tarda; el webhook debe responder rápido | — |
| IA | Local (Ollama `qwen2.5vl:3b`) intercambiable por nube | Costo $0 para pruebas | Gemini, Groq, OpenRouter |
| Arquitectura | Puertos y adaptadores (`CanalMensajeria`, `ProveedorFacturacion`, `LectorDeFacturas`, `Transcriptor`) | Cambiar de proveedor o de IA es configuración, no reescribir | Llamar a las APIs directamente |
| Principio | Humano en el ciclo | Nada se emite sin aprobación explícita | — |
| Entradas | Foto, texto y voz → un mismo `BorradorFactura` | La letra manuscrita es difícil; voz y texto son alternativas más fiables | Solo foto |
| Voz → texto | Whisper (whisper.cpp local) + FFmpeg | Gratis; WhatsApp envía audio `.ogg` | API de Groq (Whisper en la nube) |
| Cálculos | El código recalcula totales; la IA solo extrae | Si la suma de ítems no cuadra con el total escrito, hay un dato mal leído y el bot pregunta | — |
| Líneas de factura | **Modo simple** (por defecto): 1 línea, cantidad 1, precio = total escrito, con un producto genérico existente ("Pinturas varias"). Configurable por empresa a **modo detallado** (catálogo) | Los precios varían por cliente y momento, y muchas presentaciones (galón, 1/2, 1/4, 1/8) no están en el catálogo | Siempre catálogo detallado |
| Descripción de la línea | Lo que se alcance a leer ("Galón de esmalte, colores varios") o "Pinturas varias" | Más claro para el cliente sin llenar el catálogo de productos de un solo uso | Crear un producto nuevo por factura |
| Detalle de ítems | Se guarda en nuestra BD (no se envía al proveedor) | Conservar datos para reportes e inventario futuros | Descartarlo |
| IVA | El total escrito no incluye IVA: se envía como base con IVA 19 % y el proveedor calcula el impuesto. El borrador muestra subtotal, IVA y total | Que quien aprueba vea el valor final antes de emitir | Calcular el IVA en el código y enviarlo ya sumado |
| Datos personales | Fotos y datos de clientes nunca van a git; tratamiento conforme a la Ley 1581 de 2012 (Habeas Data) | Obligación legal y confianza | — |

## 4. Bitácora

### Fase 0 — Validación
- **0.1** Revisión del entorno de desarrollo (Node, Git, Docker, VS Code).
- **0.2** Se reunieron 20 fotos de facturas de muestra (fuera del repositorio). Hallazgo: la letra
  manuscrita difícil es un riesgo alto → se aceptará también **voz** y **texto**.
- **0.2b** Una GPU de pocos recursos (4 GB) produce salida corrupta (`@@@@`) con `qwen2.5vl:3b` →
  se usa **CPU** (`num_gpu: 0`); ~3 min por foto. La salida tenía la estructura correcta, pero los
  precios en formato colombiano (`78.000`) llegaban como decimales → hay que normalizar el formato
  de pesos en el código.
- **0.2c** Comparación con la factura real: cliente ❌, precios 2/3 ✓, descripciones y presentaciones
  ❌, total ✓. Aprendizajes:
  - El modelo 3B local sirve para desarrollar, no para producción → comparar luego con un modelo
    mayor o en la nube.
  - En pinturas la cantidad es una **presentación** (galón, 1/2, 1/4, 1/8).
  - Si la suma de ítems ≠ total escrito → hay un dato mal leído → el bot pregunta.
- **0.2d** Reglas de negocio confirmadas para el piloto: total escrito sin IVA, una sola línea con un
  producto genérico, descripción genérica válida (confirmado con un contador).

- **0.4 (cambio de plan)** Crear la app de WhatsApp en Meta exige datos de empresa y un dominio web.
  Para no frenar el desarrollo, el canal se abstrae con el puerto `CanalMensajeria`: se desarrolla con
  **Telegram** (bot creado con @BotFather) y WhatsApp se agrega como adaptador antes del piloto
  (fase 10). Si Meta pide un sitio web, se puede usar una página gratuita en GitHub Pages.
- **Replanificación (después de la fase 2):** como la IA, local o en la nube, lee mal las fotos de
  facturas manuscritas, se priorizan las entradas más fiables: **texto** (fase 3), **voz** (fase 4) y
  **PDF de facturas de compra**, que traen texto digital legible, para llevar el **inventario**
  (fase 5). Las fotos pasan a la fase 9, con un modelo de visión mejor.

### Fase 1 — Base del proyecto
- **1.1** Repositorio git, `.gitignore` (excluye secretos, `node_modules` y fotos con datos reales).
- **1.2** Node **24 LTS** gestionado con **fnm** (fijado en `.nvmrc`), porque el CLI de NestJS 12 falla
  en Node 22.14 (`ERR_REQUIRE_CYCLE_MODULE`). pnpm 12. Esqueleto **NestJS 12** en `apps/api`
  (TypeScript estricto, Vitest, Oxlint + Prettier).
- **1.3** `docker-compose.yml` con **PostgreSQL 18** y **Redis 8** (Alpine), con *healthcheck* y
  volúmenes con nombre. Decisiones:
  - PostgreSQL en el puerto **5433** del equipo, para no chocar con un PostgreSQL local en el 5432.
  - Puertos ligados a `127.0.0.1`: la base y la cola solo son accesibles desde el propio equipo.
  - Redis con `--maxmemory-policy noeviction` (BullMQ lo exige: si Redis borrara claves por falta de
    memoria, se perderían trabajos de la cola) y `--appendonly yes` (persistencia en disco).
  - Credenciales solo de desarrollo, sobrescribibles con variables de entorno o `.env`.
- **1.4a** Configuración validada al arrancar: `@nestjs/config` + esquema **Zod** en
  `apps/api/src/config/env.schema.ts` (`NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`). Si falta una
  variable o tiene un formato inválido, la app no arranca y dice cuál (*fail fast*). `ConfigService`
  tipado. `.env.example` versionado; `.env` ignorado. `.gitattributes` con finales de línea LF.
- **Publicación:** el repositorio se hizo público en GitHub con documentación bilingüe.
- **1.4b** Base de datos con **Prisma 7**:
  - `prisma/schema.prisma` con el primer modelo, **`Empresa`** (nombre, NIT único, proveedor
    `ALEGRA`/`SIIGO`, modo de líneas `SIMPLE`/`DETALLADO`, fechas). Es la raíz de la multiempresa.
  - Convenciones: IDs **UUID v7** (únicos y ordenables por fecha), tablas y columnas en *snake_case*
    en PostgreSQL (`@map`) y *camelCase* en TypeScript, fechas `timestamptz`.
  - Primera migración `crear_empresas` aplicada. `prisma.config.ts` para el CLI.
  - Desde Prisma 7 la conexión va por un **adaptador** (`@prisma/adapter-pg`) y el cliente se genera
    en `src/generated/prisma` (ignorado por git; se regenera al instalar).
  - `PrismaService` global e inyectable que toma `DATABASE_URL` de la configuración validada y cierra
    la conexión al apagar la app.
  - pnpm bloquea por seguridad los scripts de instalación; solo se autorizaron `prisma` y
    `@prisma/engines` (`allowBuilds` en `apps/api/pnpm-workspace.yaml`).
  - Verificado: build, lint y tests ✅; la app arranca con Prisma y una prueba de crear, leer y borrar
    una empresa funcionó contra PostgreSQL.

### Fase 2 — Bot eco en Telegram
- **2.1** Bot creado con @BotFather. `TELEGRAM_BOT_TOKEN` es obligatorio y se valida al arrancar
  (formato `<id>:<secreto>`); con el token vacío la app no arranca y lo indica.
- **2.2** **grammY** + `src/mensajeria/`:
  - `mensaje.ts`: tipo `MensajeEntrante` (texto, imagen, audio, otro) y `responderEco()`, lógica
    **independiente del canal** (WhatsApp la reutilizará). 4 tests.
  - `telegram.service.ts`: adaptador que traduce mensajes de Telegram a `MensajeEntrante` y responde.
    *Long polling*: no requiere ngrok ni exponer el equipo.
  - `enableShutdownHooks()`: al apagar la app se detienen el bot y la conexión a la base de datos.
  - La interfaz formal `CanalMensajeria` se escribirá cuando llegue el segundo canal (WhatsApp); hoy
    con un solo canal sería una abstracción sin uso.
- **2.3** Probado desde Telegram: texto, foto, nota de voz y sticker responden correctamente.

### Fase 3 — Factura por texto
- **3.1** El bot solo atiende **chats autorizados** (`TELEGRAM_CHATS_PERMITIDOS`, IDs separados por
  comas). Vacío = nadie: seguro por defecto. A un chat no autorizado no se le procesa nada; se le
  responde su ID de chat para poder autorizarlo. Se filtra por ID numérico (fijo) y no por *username*
  (que se puede cambiar). 3 tests nuevos (14/14 ✅). Lección: Vitest no revisa tipos, por eso también
  se corre `tsc --noEmit`.
- **3.2** Lógica de la factura sin IA en `src/facturacion/factura.ts` (funciones puras):
  - `parsePesos`: `"78.000"`, `"$78.000"`, `"78 mil"`, `"12,5 mil"` → número (punto = miles, coma =
    decimales).
  - `camposFaltantes`: nombre del cliente, NIT o cédula, total (el total puede salir de la suma de
    ítems).
  - `sumaNoCuadra`: detecta si los ítems no suman el total escrito (un dato mal leído).
  - `calcularTotales`: subtotal + IVA 19 % redondeado a pesos = total a pagar.
  - 23 tests nuevos (37/37 ✅), incluido el caso real de la fase 0 (13.000 leído en vez de 18.000).
- **3.3** La IA entiende el texto: `InterpreteTextoService` envía el mensaje a **Ollama `qwen2.5:3b`**
  con un **esquema JSON generado desde Zod** (*structured outputs*), así el modelo responde siempre
  con la misma forma. Los valores se piden **como texto** y los convierte `parsePesos`. La respuesta se
  valida otra vez con Zod. `resumenBorrador` arma el mensaje: cliente, ítems, subtotal, IVA, total, lo
  que falta y la alerta de suma. El bot ya responde con el borrador a los mensajes de texto.
  Medido: ~10 s la primera vez (carga del modelo), ~1,5 s después. 4 tests nuevos (41/41 ✅).
- **3.3b** Error encontrado al probar: con "factura a Ana NIT 123 …" el modelo no detectaba el cliente
  (4/7 aciertos en una prueba con mensajes de ejemplo); fallaba sobre todo cuando el NIT va justo
  después del nombre. Solución: **few-shot prompting** (ejemplos dentro de las instrucciones) y la regla
  de que el nombre nunca lleva "NIT", "CC" ni números. Resultado: 11/11, incluidos 4 mensajes distintos
  de los ejemplos (para no medir con los mismos datos con que se "enseñó"). Igual, el usuario podrá
  corregir cualquier dato en texto libre antes de aprobar (paso 3.4).
- **3.4a** Tabla `borradores` (migración `crear_borradores`): el bot recuerda la factura en curso de
  cada chat aunque la app se reinicie. Estado `PENDIENTE`/`APROBADO`/`CANCELADO`, datos en `JSONB`
  (la forma del borrador aún cambia), `chat_id` como `BIGINT` (los IDs de Telegram superan el rango
  de un entero de 32 bits) e índice por chat y estado. Sin `empresaId` hasta que exista la relación
  chat → empresa.
- **3.4b** Conversación: `ConversacionService` (en `facturacion/`, independiente del canal) decide
  qué hacer con cada mensaje. Sin borrador pendiente crea uno; con borrador pendiente, la IA recibe el
  **borrador actual + el mensaje** y devuelve el borrador completo corregido ("el NIT es…", "agrega…",
  "quita…", "la laca vale…"). "cancelar" lo descarta (sin esto el usuario no podría empezar otra
  factura). Se eligió corregir con la IA y no combinando campos en código porque entiende quitar o
  cambiar ítems; el humano revisa antes de aprobar. 4 tests con dobles de prueba de Prisma y de la IA
  (45/45 ✅). Prueba con el modelo real: 6/6 correcciones bien aplicadas, ~1–3 s cada una.
- **3.4b-fix** Error encontrado al probar: al agregar un ítem, el IVA y el total no cambiaban. Causa:
  la IA había puesto por su cuenta un "total" igual al primer ítem, aunque el usuario nunca escribió un
  total; ese valor quedaba fijo como base. Solución en código (no en el prompt): `totalSegunMensaje`
  solo acepta el total de la IA si el mensaje dice "total"; si no, conserva el anterior o suma los
  ítems. 3 tests nuevos (48/48 ✅); la conversación del usuario reproducida con el modelo real ahora da
  subtotal 90.000, IVA 17.100 y total 107.100.
- **3.4c** Aprobación humana: "sí" (o "ok", "dale", "listo", "apruebo"…) aprueba el borrador
  (estado `APROBADO`) **solo si está completo**: `motivoNoAprobable` lo impide si falta un dato o la
  suma no cuadra, y dice por qué. Las palabras de aprobación se reconocen **con código, no con IA**, y
  solo si el mensaje es únicamente esa palabra ("sí, pero el NIT es…" se trata como corrección). El
  mensaje de ayuda cambia según el caso (pedir datos u ofrecer "sí"). La emisión real llega en la
  fase 6. 11 tests nuevos (59/59 ✅).

### Flujo de trabajo con ramas (después de la fase 3)
- Se adopta **GitHub Flow**: `main` siempre estable y protegida en GitHub (exige Pull Request y CI en
  verde, también para administradores; sin *force push*). Cada paso va en su rama (`feat/`, `fix/`,
  `docs/`, `chore/`) y entra a `main` por PR con *squash*.
- **CI** con GitHub Actions (`.github/workflows/ci.yml`): instalación, Oxlint, Prettier, `tsc` y tests
  en cada PR. Primer PR: #1.
- **Tags** por fase como puntos seguros para volver: `v0.1.0`, `v0.2.0`, `v0.3.0`.

### Fase 4 — Factura por voz
- **4.1** Servicio de transcripción en Docker: `onerahmet/openai-whisper-asr-webservice:v1.10.0`
  (faster-whisper en CPU, modelo `small`, FFmpeg incluido, puerto `127.0.0.1:9000`, modelo guardado en
  el volumen `whisper_cache`). Se eligió Docker para no instalar nada en Windows. La imagen ocupa
  ~8,2 GB en disco (~2,6 GB de descarga). Prueba con una nota de voz sintética de ~10 s: **~5 s** de
  transcripción, texto correcto salvo "la canegra" (laca negra) y la cédula escrita como
  "1-0-2-0-3-0-4-0-5-0" (ficticia) → se normalizará en código.
- **4.2** El bot recibe notas de voz: las descarga de Telegram **en memoria** (no se guardan en disco,
  pueden tener datos de clientes), las envía a Whisper con `TranscriptorService`
  (`src/voz/`, independiente del canal; `WHISPER_URL` con valor por defecto) y responde
  "🎤 Entendí: …". Límite de **2 minutos** por nota para no bloquear la CPU. La URL de descarga lleva
  el token del bot, por eso nunca se registra en los logs. Sin dependencias nuevas (`fetch`,
  `FormData` y `Blob` vienen con Node 24).
- **4.2b** Precisión de la transcripción. Problema real: "NIT 900111222" (ficticio) se transcribió
  "knit 90011122". Se midieron configuraciones con 6 audios de prueba (2 voces sintéticas, 3 frases
  con NIT o cédula): con `small`, solo 1 de 6 identificaciones salió exacta; el modelo **pierde dígitos
  repetidos** (111 → 11, 999 → 99). Se agregó un **contexto del negocio** (`initial_prompt`) y el
  **filtro de voz** (`vad_filter`): mejora las palabras ("laca negra", "El Tornillo", "80 mil") pero
  **no** los números (siguió 1/6). Lección: en una primera medición el contexto incluía el mismo NIT
  de la prueba y daba 3/6; sin ese dato de prueba el resultado real era 1/6.
- **4.2c** Modelo **`large-v3-turbo`** (~1,6 GB): con los mismos 6 audios, **4/6** identificaciones
  exactas (vs 1/6) y "NIT" reconocido 6/6, a cambio de ~12 s por nota (vs ~3 s). Se adopta como modelo
  por defecto. Sigue fallando con secuencias como 800999000 (ficticio), por eso el borrador marcará
  para revisión el NIT o la cédula que vengan de una nota de voz (paso 4.4).
- **4.3** Cola **Redis + BullMQ** para texto y voz (plan: `docs/planes/fase-4.3-cola.md`). El
  handler de Telegram solo valida, avisa ("✍️ Procesando…" / "🎤 Escuchando…") y encola en menos de
  1 s; un worker con **concurrencia 1** procesa los mensajes en orden. Así una nota de voz larga ya no
  bloquea a los demás chats. Dependencias nuevas: `bullmq` 6.3.15 e `ioredis` 5.11.1, en versión
  exacta (~12 MB en disco).
  - **Sin reintentos de BullMQ:** un reintento pone el trabajo detrás de los siguientes (rompe el
    orden) y reinterpretar "agrega una brocha" agregaría dos. Solo hay un reintento interno a los 2 s
    para la descarga de Telegram y para `ECONNREFUSED` a Ollama o Whisper; los timeouts no se
    reintentan. Con `maxStalledCount: 0`, un trabajo cortado por un reinicio falla y se le avisa al
    usuario en vez de repetirse.
  - **Aprobación solo de lo que el usuario vio:** columnas `version` y `version_mostrada`. Al
    recibir un "sí" se guarda qué borrador y qué versión tenía el usuario en pantalla; aprueba solo si
    es el mismo borrador y `version == versionMostrada ==` la versión vista, en una sola escritura
    atómica (`updateMany` + `count`). `versionMostrada` se marca solo cuando Telegram confirma el
    envío.
  - **Índice único parcial** en PostgreSQL: a lo sumo un borrador PENDIENTE por chat (*preview
    feature* `partialIndexes`; Prisma queda fijado en 7.10.0 mientras siga en *preview*). Comprobado
    contra la base: violar el índice da `P2002`, pero sin `meta.target`, así que el código mira solo
    el `code`. El CI ahora levanta PostgreSQL, aplica las migraciones y corre `pnpm test:int`.
  - **Límites:** texto de 1.000 caracteres; voz de 120 s y **1 MB** (una nota de 87 s pesó 344 KB,
    ~4 KB/s); descarga de 30 s. El jobId es `tg-<update_id>` (BullMQ no acepta enteros como id) e
    ignora una entrega repetida mientras el trabajo sigue en la cola. Los logs llevan jobId, etapa y
    duración; nunca el texto, la transcripción ni el chatId.
  - **Prueba manual (2026-10-30):** el guion completo salió como se esperaba, incluido el "sí" enviado
    justo después de una corrección (no aprobó) y el orden de dos mensajes seguidos. Latencia por
    trabajo: texto 6,5–15 s; lista de 9 productos 44,8 s; ~10 s extra cuando qwen se había
    descargado; nota de voz de ~10 s → 13 s, de 87 s → 39 s; "sí" y "cancelar" ~0,3 s.
  - **Memoria:** la línea base en reposo cambia mucho de un día a otro, así que el criterio se compara
    con la base del mismo día. Para que WSL no retenga RAM se configuró `%UserProfile%\.wslconfig`
    (fuera del repo) con `memory=6GB` y `autoMemoryReclaim=dropCache`; con una nota de ~2 min, Whisper
    llegó a 2,92 GiB y la VM a 3,6 de 5,9 GB.
  - **Retención en Redis:** los trabajos terminados y los fallidos se borran al instante
    (`removeOnFail: true`). Con la retención de 24 h, BullMQ solo limpiaba por antigüedad cuando
    otro trabajo terminaba, así que un fallido podía quedarse días; se comprobó con una prueba
    contra Redis real, que ahora también corre en el CI.
  - **Riesgo de Redis (AOF):** el texto de un trabajo queda en el archivo AOF hasta que Redis lo
    reescribe, aunque el trabajo se borre. Mientras no haya reescritura periódica (antes de conectar
    Alegra), se puede forzar a mano: `docker compose exec redis redis-cli BGREWRITEAOF`.
  - **Lección:** una auditoría independiente y los subagentes `control-calidad` y `seguridad`
    encontraron, antes de cerrar la subfase, que Prisma se desconectaba antes de que el worker
    terminara su trabajo (orden de los hooks de apagado de Nest), un caso de aprobación sin test, que
    un "sí" en cola podía aprobar **otro** borrador en la misma versión, y la retención perezosa de
    los fallidos. Todo se corrigió con tests (y pruebas de mutación que confirman que los tests lo
    detectan); lo que va para la 4.4 y la 3.5 quedó en §18 del plan.

## 5. Cómo ejecutar

Requisitos: [fnm](https://github.com/Schniz/fnm) (Node 24 según `.nvmrc`), [pnpm](https://pnpm.io) y
[Docker Desktop](https://www.docker.com/products/docker-desktop/) encendido.

```bash
docker compose up -d --wait   # PostgreSQL (localhost:5433), Redis (localhost:6379) y Whisper (localhost:9000)
fnm use                       # activa la versión de Node de .nvmrc
cd apps/api
pnpm install
cp .env.example .env          # solo la primera vez; ajusta valores si hace falta
pnpm run db:migrate           # crea/actualiza las tablas en PostgreSQL
pnpm run start:dev            # servidor en http://localhost:3000 con recarga automática
pnpm test                     # tests unitarios
pnpm test:int                 # pruebas de integración (PostgreSQL con las migraciones y Redis)
```

Para apagar la infraestructura: `docker compose down` (conserva los datos). `docker compose down -v`
además **borra** los volúmenes con los datos.

## 6. Licencia

Todos los derechos reservados. El código es visible públicamente, pero no se concede licencia de
uso, copia ni distribución sin autorización del autor.
