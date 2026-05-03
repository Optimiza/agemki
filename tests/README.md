# Suite de tests y golden files

Red de seguridad para AGEMKI: tests unitarios de los stores, golden files
del codegen `.DAT` y, a futuro, captura BMP del motor real ejecutándose en
DOSBox-X. Pensado para que **cualquier cambio que altere bytes generados o
lógica observable rompa al menos un test**.

> Tiempo de lectura estimado de este documento: 10 minutos.
> Tiempo desde clonar el repo hasta ver verde: 30 segundos.

---

## Índice

1. [Estado actual del trabajo](#estado-actual-del-trabajo)
2. [Convención de idioma](#convención-de-idioma-mandatorio)
3. [Quickstart](#quickstart)
4. [Comandos del día a día](#comandos-del-día-a-día)
5. [Layout completo](#layout-completo)
6. [Qué cubre cada fichero de test](#qué-cubre-cada-fichero-de-test)
7. [Cómo funciona el hook PostToolUse](#cómo-funciona-el-hook-posttooluse)
8. [Cómo funciona el skill `/golden-update`](#cómo-funciona-el-skill-golden-update)
9. [Cómo añadir un test nuevo](#cómo-añadir-un-test-nuevo)
10. [Cómo añadir o modificar un fixture](#cómo-añadir-o-modificar-un-fixture)
11. [Cómo regenerar los goldens (workflow seguro)](#cómo-regenerar-los-goldens-workflow-seguro)
12. [Troubleshooting](#troubleshooting)
13. [Por qué este diseño](#por-qué-este-diseño)
14. [Pipeline DOSBox-X (futuro, Phase 3)](#pipeline-dosbox-x-futuro-phase-3)
15. [Referencias](#referencias)

---

## Estado actual del trabajo

Lo que está terminado, lo que viene y por qué — para que sepas dónde
estamos sin tener que leer todo el `git log`.

| Etapa | Qué cubre | Estado |
|-------|-----------|--------|
| Phase 1 — Stores | 10 stores Zustand: state shape + acciones + IPC mocks | ✅ 178 tests |
| Phase 2 — Codegen DAT | `game.json → .DAT` byte-equal contra goldens, validación de cabecera AGMK + orden de chunks | ✅ 26 tests |
| Phase 3a sub 2.1 — CRC32 | Driver de motor host (clang) + `_sfx_crc32` byte-exact JS↔C | ✅ 22 tests |
| Phase 3a sub 2.2 — PCX RLE | `_pcx_decode` (sección RLE, sin VGA) byte-exact JS↔C + 6 PCX golden | ✅ 16 tests |
| Phase 3a sub 2.3 — A* | `engine_astar` + helpers: drift + 50 casos comportamiento + manifest deterministas | ✅ 54 tests |
| Phase 3a sub 2.4 — Lightmap blur | El módulo de lighting del motor (último portable) | 🔜 siguiente |
| Phase 3b — DOSBox-X build | Compilación Watcom autónoma desde Node, captura de logs | ⏳ pendiente |
| Phase 3c — Runtime BMP | Captura de frames en puntos deterministas del game loop | ⏳ pendiente |

**Total ahora mismo**: **311 tests** verde en mac+windows × Node 22+24
(matrix CI). Tiempo total `npm test`: ~10 segundos.

**Hallazgos**: 7 documentados en [`tests/FINDINGS.md`](FINDINGS.md). Cuatro
con fix aplicado en este PR (F-01, F-04, F-05, F-07), dos abiertos
esperando tu decisión (F-03 documentación, F-06 polígonos walkmap), uno
descartado como falso positivo mío (F-02).

**Próximo paso (cuando retome)**: Sub 2.4 (lightmap blur). Una vez
cerrado, pasamos a Phase 3b (DOSBox-X build pipeline) que ya no necesita
clang — ejecuta el motor real con tu Watcom y captura logs.

---

## Cross-platform (macOS y Windows)

La suite está diseñada para correr **idéntica en macOS y Windows 11**.
Cero diferencia funcional, cero ramas en el código.

| Componente | macOS | Windows 11 | Notas |
|---|---|---|---|
| `npm test` | ✓ | ✓ | Vitest puro Node, idéntico en ambos |
| `npm run test:watch` | ✓ | ✓ | igual |
| `npm run goldens:update` | ✓ | ✓ | igual |
| `node tests/fixtures/builder.mjs` | ✓ | ✓ | usa `node:path`, separadores normalizados |
| Hook `PostToolUse` | ✓ | ✓ | escrito en Node (`.mjs`), no bash |
| Skills `/tdd-feature`, `/golden-update` | ✓ | ✓ | comandos universales (`npm`, `git`) |
| Pre-commit hook opcional | ✓ | ✓ | bash en mac/Linux; Git for Windows tiene bash interno |
| GitHub Actions (CI) | ✓ | ✓ | matrix `[macos-latest, windows-latest]` en `.github/workflows/test.yml` |

Lo único platform-specific viene en **Phase 3** (motor C, todavía no
montado): la cadena de build con Open Watcom es nativa en Windows y
envuelta en DOSBox-X en macOS. Detalle en la sección
[Pipeline DOSBox-X](#pipeline-dosbox-x-futuro-phase-3) y en el plan
0001 (`.claude/plans/`).

### `.gitattributes`

Hay un `.gitattributes` en la raíz que normaliza EOL a `LF` para
ficheros de texto (`.js`, `.json`, `.md`, `.snap`...) y marca como
`binary` los assets binarios (`.PCX`, `.MID`, `.WAV`, `.DAT`, `.OBJ`,
`.EXE`, `.BMP`...). Esto evita dos clases de bug:

- Que `core.autocrlf=true` en Windows convierta los snapshots vitest
  a CRLF y los tests fallen al comparar.
- Que Git interprete un `.PCX` como texto y le cambie bytes (corrupting
  el fixture).

Si clonas el repo en Windows con `core.autocrlf=true`, los `.gitattributes`
ganan: los binarios viajan intactos, los textos llegan en LF.

## Convención de idioma (mandatorio)

Todo el contenido que entra al repo está en **español**: README, docs,
comentarios in-source, mensajes de log de scripts y mensajes de commit.

Excepciones que pueden quedar en inglés:

- Identificadores de código (variables, funciones, clases) cuando mantienen
  consistencia con el área editada o son convenciones externas.
- Nombres de comandos shell y herramientas (`npm test`, `wcc386`,
  `vitest`, `Open Watcom`, `DOSBox-X`).
- Mensajes literales de errores de Node/SDK que vienen de upstream.

Acentos permitidos en `.md`/`.js`/`.jsx`/`.json`. Excepción: los `.c`/`.h`/
`.asm` del motor que se compilan para DOS deben permanecer ASCII puro o
CP-850 — eso lo dicta la cadena de build, no esta convención.

---

## Quickstart

```bash
# 1. Instalar deps (vitest entra como devDependency)
npm install

# 2. Correr la suite completa
npm test

# Esperado: 219 passed (219), Duration ~8s
```

Si el output termina con `Tests 219 passed (219)`, todo OK. Si falla
algo tras un cambio tuyo, ve directo a [Troubleshooting](#troubleshooting).

---

## Comandos del día a día

```bash
# Suite completa (modo CI). Sale con código 0 si todo verde.
npm test

# Modo watch: re-corre al guardar. Útil mientras editas un store o un serializer.
npm run test:watch

# Solo un fichero
npm test -- tests/unit/stores/sceneStore.test.js

# Solo los goldens del codegen (rápido, ~2s)
npm test -- tests/golden/

# Solo los stores Zustand (rápido, ~1s)
npm test -- tests/unit/stores/

# Verbose: ver el nombre de cada test individual
npm test -- --reporter=verbose

# Regenerar los goldens tras un cambio intencional en codegen
npm run goldens:update
# (equivalente: UPDATE_GOLDENS=1 npm test -- tests/golden/)

# Regenerar los fixtures binarios (PCX, MIDI, WAV) desde el builder
node tests/fixtures/builder.mjs

# Regenerar los walkmaps binarios para los tests de A* (sub 2.3)
node tests/fixtures/walkmaps-builder.mjs
```

Para entender qué dispara cada cambio automáticamente, ver
[Cómo funciona el hook PostToolUse](#cómo-funciona-el-hook-posttooluse).

---

## Layout completo

```
agemki/
├── tests/
│   ├── README.md           ← este fichero
│   ├── FINDINGS.md         ← bugs detectados durante el montaje (con fixes propuestos)
│   │
│   ├── helpers/            ← utilidades compartidas
│   │   ├── hash.js              SHA-256 + hex helpers
│   │   ├── dat-decode.js        decoder AGMK + asserts estructurales
│   │   └── store-stubs.js       stubs de window.api / localStorage / document / alert
│   │
│   ├── fixtures/           ← inputs deterministas para los tests
│   │   ├── builder.mjs          script que regenera los binarios PCX/MIDI/WAV + JSON
│   │   ├── walkmaps-builder.mjs script que regenera los 5 walkmaps binarios para A* (sub 2.3)
│   │   ├── walkmaps/            5 .bin (room_open, room_with_obstacle, corridor_l, maze_simple, disconnected)
│   │   ├── minimal/             1 room, 1 char, 1 idioma — ejercita cada serializer
│   │   │   ├── game.json
│   │   │   ├── rooms/room_001/room.json
│   │   │   ├── characters/char_hero.json
│   │   │   ├── objects/obj_key.json
│   │   │   ├── verbsets/vs_default.json
│   │   │   ├── dialogues/dlg_intro.json
│   │   │   ├── scripts/scr_use_key.json
│   │   │   ├── sequences/seq_intro.json
│   │   │   ├── locales/{es,en}.json
│   │   │   ├── assets/converted/{backgrounds,sprites,objects}/*.PCX
│   │   │   ├── assets/fonts/{small,medium,large}.PCX
│   │   │   └── audio/{music/MUS_INTRO.MID, sfx/SFX_PICKUP.WAV}
│   │   └── midgame/             (vacío, reservado para Phase 1.5 con instrucciones realistas)
│   │
│   ├── unit/               ← tests unitarios (sin tocar disco real)
│   │   ├── helpers.test.js          smoke de hash + dat-decode
│   │   └── stores/
│   │       ├── all.smoke.test.js    los 10 stores: carga + state keys + acciones
│   │       ├── appStore.test.js
│   │       ├── attributeStore.test.js
│   │       ├── charStore.test.js
│   │       ├── dialogueStore.test.js
│   │       ├── localeStore.test.js
│   │       ├── objectStore.test.js
│   │       ├── sceneStore.test.js
│   │       ├── scriptStore.test.js
│   │       ├── sequenceStore.test.js
│   │       └── verbsetStore.test.js
│   │
│   ├── golden/             ← tests que comparan output con goldens/
│   │   ├── dat.test.js          codegen .DAT byte-equal + estructura semántica
│   │   └── __snapshots__/       snapshots vitest (preview hex de cabeceras)
│   │
│   └── engine_host/        ← Phase 3a — runner C compilado con clang en host
      ├── lib/
      │   ├── crc32.c          copia byte-exact de _sfx_crc32 (sub 2.1)
      │   ├── pcx_decode.c     copia byte-exact de _pcx_decode RLE (sub 2.2)
      │   └── astar.c          copia byte-exact del bloque A* (sub 2.3)
      ├── include/ag_test.h    header compartido del runner
      ├── runner.c             entrypoint con dispatcher de tests
      ├── build.mjs            compila con clang (cross-platform mac/win)
      └── runner / runner.exe  binario generado (gitignored)
│
├── goldens/                ← outputs esperados (entran al repo, !goldens/** en .gitignore)
│   ├── dat/
│   │   └── minimal/
│   │       ├── GRAPHICS.DAT     bytes esperados
│   │       ├── SCRIPTS.DAT
│   │       ├── AUDIO.DAT
│   │       ├── FONTS.DAT
│   │       └── manifest.json    sha256 + size + numBlocks por DAT
│   ├── engine/             outputs binarios de lógica pura del motor host
│   │   ├── pcx/                SHA-256 de cada PCX decodificado (sub 2.2)
│   │   └── astar/              manifest.json con { id, len, sha256 } por caso A* (sub 2.3)
│   └── runtime/            (futuro Phase 3c) BMP frames del motor en DOSBox-X
│                            capturados en puntos deterministas del game loop
│
├── scripts/                ← (futuro Phase 3b) wrappers DOSBox-X
│   ├── dosbox-build.sh
│   ├── dosbox-run.sh
│   ├── collect_goldens.sh
│   └── verify_goldens.sh
│
├── tmp/                    ← working dir, gitignored (logs, builds intermedios)
│
├── vitest.config.js        ← config de vitest (entorno node, setupFiles)
└── .claude/
    ├── settings.json            permissions + hook PostToolUse
    ├── hooks/
    │   └── run-tests-on-edit.mjs hook (Node, cross-platform) que dispara tests del área editada
    └── skills/
        └── golden-update/
            └── SKILL.md          flujo seguro para regenerar goldens
```

---

## Qué cubre cada fichero de test

### `tests/unit/helpers.test.js` (6 tests)

Smoke de los helpers de testing:
- `sha256` reproducible (cases conocidos: empty buffer y `"hello"`).
- `hexHead` mayúscula y longitud correcta.
- `decodeDat` rechaza magic inválido.
- `decodeDat` parsea cabecera + index entry de un fichero AGMK construido a mano.
- Constantes (`MAGIC`, `HEADER_SIZE`, `INDEX_ENTRY_SIZE`) coherentes con la spec.

### `tests/golden/engine-host.test.js` (22 tests, Phase 3a sub 2.1)

Tests del **subset portable del motor C** compilado con clang en host.
Primer módulo: CRC32 (`_sfx_crc32` del motor) — algoritmo crítico
porque el motor lo usa para binary search en el TOC de SFX.DAT. Si
difiere del CRC32 del codegen JS (sfxGenerator.js / datGenerator.js),
los chunks no se encuentran en runtime.

Cubre:
- **Drift detection**: compara byte-a-byte la copia en
  `tests/engine_host/lib/crc32.c` con la función `_sfx_crc32` viva en
  `resources/engine/agemki_audio.c`. Si Javi cambia la del motor, el
  test rojo te avisa para sincronizar.
- **Coherencia con JS**: 16 IDs reales (room_001, char_hero, etc.),
  string vacío, batch de 100 ids, casos con espacios/mayúsculas, y
  todos los chars ASCII imprimibles (cubre la tabla CRC entera, índices
  0x20-0x7E).

Si clang no está disponible (Xcode CLT en mac, LLVM en win, apt en
linux), el bloque de tests dependientes se **skipea** automáticamente
y el suite sigue verde. El drift test SÍ se ejecuta siempre (no
requiere clang).

### `tests/golden/engine-host-pcx.test.js` (16 tests, Phase 3a sub 2.2)

Tests del decoder PCX del motor: la sección RLE de
`_pcx_decode` en `resources/engine/agemki_engine.c:995-1034`. La
parte RLE (decompresión) es 100% portable, lo que toca registros VGA
(`outp(0x3C8/0x3C9)` para cargar la paleta) queda fuera del subset
host por ser HW-only.

Cubre:
- **Drift detection** (sin clang): la copia en
  `tests/engine_host/lib/pcx_decode.c` sigue byte-exact a la sección
  RLE de `_pcx_decode` del motor. Cualquier edit en el motor que altere
  esos bytes se caza con un test rojo y un mensaje claro.
- **Bit-exact motor C ↔ JS**: para los 6 PCX del fixture minimal (BG,
  sprite, objeto, 3 fuentes), el buffer decodificado por el runner C
  coincide al byte con el de `jsPcxDecode` (implementación de
  referencia en JS puro).
- **Goldens binarios**: el SHA-256 del buffer decodificado de cada PCX
  se persiste en `goldens/engine/pcx/<name>.sha256.txt`. Cualquier
  cambio en bytes (por edit del motor, del fixture, o de cualquier
  intermedio) deja el SHA distinto y el test rojo identifica qué PCX
  cambió.
- **Sanity sobre dimensiones**: cada fixture decodifica al `WxH`
  esperado.

Por qué no testear `apply_pal`: usa `outp()` (escritura a registros
DAC de VGA) y `g_pal_raw` (global del motor). En host no tiene sentido,
sería testear el stub.

Por qué hex en stdout y no bytes raw: en Windows, stdout tiene
LF→CRLF translation por defecto que corrompe bytes 0x0A. El runner
C emite el buffer como hex (2 chars por byte) para evitar el issue
sin parches específicos de OS.

### `tests/golden/engine-host-astar.test.js` (54 tests, Phase 3a sub 2.3)

Tests del pathfinding A* del motor: el bloque `_walk_passable` /
`_snap_walkable` / `_heuristic` / `engine_astar` que vive en
`resources/engine/agemki_engine.c:1097-1214`. Las cuatro funciones son
puramente algorítmicas — sin tocar VGA, sin malloc, sin globals del
loop principal — así que la copia portable en
`tests/engine_host/lib/astar.c` es byte-exact con el motor.

Cubre:

- **Drift detection** (sin clang): el bloque A* en `lib/astar.c` sigue
  byte-exact con el del motor. Cualquier cambio (orden de expansión,
  costes 10/14, tie-breaking, radio del snap) se detecta con un solo
  test rojo y un diff legible.
- **Comportamiento sobre 5 walkmaps × 10 casos** (50 cases): los
  walkmaps los genera `tests/fixtures/walkmaps-builder.mjs` y son
  representativos de las situaciones reales en el motor:
  - `room_open` (40×18, todo walkable): rutas directas, diagonales,
    edges, clamping de coords fuera de grid.
  - `room_with_obstacle`: bloque 12×6 en el centro forzando detour
    (skirt-left, skirt-right, start dentro del bloque snapping fuera).
  - `corridor_l`: forma de L (sólo fila inferior + columna derecha
    walkables) — A* debe doblar.
  - `maze_simple`: cuatro pasillos en patrón # con múltiples rutas.
  - `disconnected`: barrera vertical completa — verifica que A*
    devuelve 0 cuando no hay ruta.
- **Goldens deterministas**: cada uno de los 50 casos guarda
  `{ id, walkmap, start, target, reachable, len, sha256 }` en
  `goldens/engine/astar/manifest.json`. El `sha256` es del raw del
  runner (formato `N|x1,y1|…|xN,yN`), así cualquier cambio en el orden
  de waypoints o en la ruta elegida rompe el hash.

Una propiedad importante que también queda anclada: el caso
`corr/snap-radius-cap` documenta que `_snap_walkable` está acotado a
radio 4 celdas. Si un start cae a 7+ celdas del walkable más cercano,
A* devuelve 0. Si Javi amplía el radio en el motor, este caso se pone
en verde de manera "inesperada" y el test rojo de `len/sha256` lo
avisa — un guardarraíl explícito sobre una decisión de diseño que de
otra forma pasaría desapercibida.

Por qué `astar_batch` y no spawn por caso: 50 invocaciones × ~50ms de
spawn en Windows (vs Linux/macOS ~5ms) sumarían ~2.5s sólo en arrancar
el binario. El batch hace una sola spawn, lee 50 líneas de stdin y
emite 50 líneas de stdout, además cacheando el último walkmap_path
para no releer el binario entre casos consecutivos del mismo mapa
(reducción extra ~5×). El test corre en ~150ms en cualquier OS.

### `tests/golden/dat.test.js` (26 tests)

Para cada fixture (`minimal`):
- **Byte-equal**: cada uno de los 4 `.DAT` (GRAPHICS, SCRIPTS, AUDIO, FONTS)
  comparado con el golden binario.
- **Manifest**: SHA-256 + size + numBlocks por DAT en `goldens/dat/<fix>/manifest.json`.
- **Estructura semántica** por DAT (5 checks):
  - `magic = "AGMK"`, `version = 1`
  - Chunks ordenados lex por `(resType, id)` — requisito para binary search del motor.
    *Marcado con `it.fails` para SCRIPTS.DAT por F-05 (ver FINDINGS.md). Cuando se arregle el bug, vitest fallará el test forzando quitar el marker.*
  - Offsets dentro del fichero, sin solapamiento entre data blocks.
  - IDs null-terminados, ASCII imprimible, ≤ 31 chars.
  - `index_offset = 16`, `dataOffset = 16 + N×48`.
- **Snapshot hex** de los primeros 16 bytes de cabecera por DAT.

### `tests/unit/stores/all.smoke.test.js` (30 tests)

Para cada uno de los 10 stores Zustand:
- Se carga sin errores (los stubs globales bastan).
- El estado inicial contiene las claves esperadas.
- Las acciones declaradas son funciones.

Cubre regresiones de bajo nivel (renombre accidental de keys, borrar
acciones por error).

### `tests/unit/stores/sceneStore.test.js` (25 tests)

El más crítico. Cubre los invariantes del Scene Editor:
- Apertura y cierre de room (zoom, pan, herramienta y selecciones se resetean).
- Walkmap: orden de shapes (add/sub) preservado, solo modifica el walkmap activo.
- `deleteWalkmap` respeta el invariante "siempre al menos un walkmap".
- Selecciones mutuamente excluyentes (shape, instance, char, exit, entry, light).
- `pendingPolygon` se descarta al cambiar herramienta.
- `commitPendingPolygon` con < 3 puntos no crea shape.
- Zoom clamped a [1, 8].
- `dirty` marcado en mutaciones del modelo, NO en cambios de vista.
- Instancias (objetos, personajes, exits, entries, lights) con defaults razonables.
- `updateLightFlicker` fusiona patch sin perder otros campos.
- Acciones idempotentes sin `activeRoom` (no lanzan, no mutan).

### `tests/unit/stores/scriptStore.test.js` (19 tests)

- Estado inicial limpio.
- `updateMeta` sin `activeScript` no rompe.
- `addInstruction(type, afterIndex)` posiciona correctamente (null = final, n = después de n).
- Defaults aplicados por tipo (SET_FLAG, WAIT, ...).
- `updateInstruction` fusiona patch en la instrucción correcta.
- `deleteInstruction` elimina solo la indicada.
- `moveInstruction(±1)` reordena y respeta límites.
- `duplicateInstruction` con id nuevo, justo después del original.
- `INSTR` y `TRIGGERS` exportados con shape consistente.

### `tests/unit/stores/sequenceStore.test.js` (14 tests)

Mismo patrón que scriptStore (add/update/delete/move/duplicate steps).
Plus: cada `STEPS[type].cat` está en `STEP_CATS` (coherencia interna).

### `tests/unit/stores/dialogueStore.test.js` (18 tests)

- `addNode` sin parentId no crea conexión.
- `addNode(type, parentId, choiceIndex)` autoconecta con el padre.
- `deleteNode` hace cascade: elimina TODAS las conexiones que referencian al nodo.
- `connectNodes` reemplaza la conexión existente con mismo `(from, choiceIndex)`.
- `connectNodes` con `choiceIndex` distinto coexiste con la anterior.
- `disconnectNode` elimina por `(from, choiceIndex)`.
- `duplicateNode` con id nuevo, desplaza posición visual `+40px`, regenera `textKey`.
- `setNodePosition` actualiza `_x/_y` y marca dirty.
- `NODE_TYPES` tiene los 7 tipos esperados (START, LINE, CHOICE, BRANCH, ACTION, JUMP, END).
- LINE/CHOICE/BRANCH cargan defaults coherentes.

### `tests/unit/stores/charStore.test.js` (17 tests)

- `openChar` clona (no muta el original).
- `addAnimation` inserta al principio (más reciente arriba).
- `updateAnimation` patchea por id, no toca otras animaciones.
- `moveAnimation(±1)` reordena, respeta límites.
- `updateAnimRole(role, animId)` asigna; con `null` limpia el rol.
- `addPatrolPoint` con defaults `waitMs: 0`, `condition: null`.
- `clearPatrol` vacía el array y marca dirty.
- `addInventoryItem` evita duplicados por `objectId`.
- `loadChars` (mock IPC): puebla en éxito, deja vacío + loaded en fallo.

### `tests/unit/stores/objectStore.test.js` (16 tests)

- `openObject` hace deep clone (JSON roundtrip).
- `addState` añade con id `state_*` y nombre coherente.
- `deleteState` respeta invariante "siempre al menos un estado".
- `deleteState` reasigna `activeStateId` si era el borrado.
- `setVerbResponse` crea si no existe, fusiona si existe (no duplica).
- `setInvVerbResponse` opera sobre `invVerbResponses` (separado de room responses).
- `addCombination` / `addFlag` con defaults.
- `saveActiveObject` muestra `alert` si IPC falla (verificado con stub).
- `OBJECT_TYPES` exporta los 4 tipos esperados.

### `tests/unit/stores/localeStore.test.js` (17 tests)

- `setKey` establece valor y marca el lang como dirty (Set, no array).
- `setKeys` aplica varias claves en una sola operación.
- `getKey` devuelve string vacío si no existe.
- `addLang` rechaza si el código ya existe.
- `deleteLang` rechaza el idioma base `es`.
- `deleteLang` con traducciones pide `confirm`; cancelar respeta el estado.
- `saveAll` limpia dirty si todo OK; mantiene dirty si alguna escritura falla.
- `getCoverage` 100% si todos los idiomas tienen las claves del base.
- `getCoverage` cuenta missing por grupo (verbs/objects/rooms/dialogues/other).
- `getCoverage` claves con string vacío o solo espacios cuentan como missing.
- `getOrphans(lang)` devuelve claves que existen en lang pero no en es.

### `tests/unit/stores/verbsetStore.test.js` (12 tests)

- `openVerbset` clona y resetea dirty.
- **Invariante único**: marcar `isMovement: true` en un verbo desmarca los demás.
- **Invariante único**: marcar `isDefault: true` en un verbo desmarca los demás.
- `moveVerb(±1)` reordena y reasigna `order` 0..N.
- `getGameVerbs(game, lang, locales)` filtra `isMovement`, ordena por `order`,
  resuelve labels desde locales.
- `getGameVerbs` cae a `es` si el `lang` pedido no existe.
- `getGameVerbs` devuelve `[]` si el verbset activo no existe.
- `addVerb` es noop intencional (no se permite añadir verbos).

### `tests/unit/stores/appStore.test.js` (11 tests)

Usa `localStorage` stub (memoria). Cada test importa el módulo dinámicamente
con cache buster para reiniciar `loadRecent()`.

- Estado inicial (sin recientes).
- Lee recientes válidos del localStorage.
- localStorage corrupto (JSON inválido) → `recentGames = []`.
- `addRecent` cap a `MAX_RECENT = 10` (FIFO).
- `addRecent` re-añadiendo mismo gameDir → mueve arriba (no duplica).
- `addRecent` persiste a localStorage.
- `removeRecent` y `updateRecentName`.
- `setActiveModule` y `closeGame`.
- `toggleSplit`, `setSecondaryModule`.
- `toggleTheme` alterna dark ↔ light.

### `tests/unit/stores/attributeStore.test.js` (8 tests)

- `DEFAULT_ATTRIBUTES` contiene los 12 atributos esperados; solo 1 con `isDeathAttr: true`.
- `DEFAULT_ATTR_NAMES.es` y `.en` con las mismas 12 claves.
- `setEnabled` marca dirty.
- `updateAttr` fusiona el patch en el atributo indicado.
- `setDeathAttr(id)` marca uno y desmarca el resto (mutuamente excluyente).

---

## Cómo funciona el motor host (Phase 3a)

Los tests `engine-host*.test.js` validan que módulos puros del motor
C (CRC32, decoder PCX, A*, lightmap, ...) producen los mismos bytes
ejecutándose en host con clang que ejecutándose en DOS con Watcom.
La idea es **cazar regresiones del motor sin necesidad de DOSBox-X
ni de bootear el juego**.

### Las 4 piezas que cooperan

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  resources/engine/<file>.c          tests/engine_host/lib/<file>.c      │
│  ┌──────────────────────────┐       ┌────────────────────────────────┐  │
│  │ función real del motor   │ ←══→  │ copia byte-exact de la sección │  │
│  │ (puede tener HW outp/    │ drift │ portable (sin HW)              │  │
│  │  globals/etc.)           │ test  │                                │  │
│  └──────────────────────────┘       └────────────────────────────────┘  │
│           ↑                                       ↓ clang -std=c89      │
│           │                                ┌─────────────────────┐      │
│           │                                │  ./runner <test>    │      │
│           │                                │  emite output hex   │      │
│           │                                └─────────────────────┘      │
│           │                                       ↓ stdout              │
│           │                                ┌─────────────────────┐      │
│           │   función JS de referencia → │ tests/golden/       │      │
│           └─────────────────────────────→ │ engine-host-*.test  │      │
│                                           │ .js                 │      │
│                                           └─────────────────────┘      │
│                                                  ↓                     │
│                                    SHA-256 → goldens/engine/<m>/*.txt  │
└─────────────────────────────────────────────────────────────────────────┘
```

| Pieza | Función | Dónde |
|---|---|---|
| **Motor real** | El código que ejecuta el juego en DOS | `resources/engine/*.c` |
| **Copia portable** | Subset del motor compilable con clang en host | `tests/engine_host/lib/*.c` |
| **Runner C** | Binario host que invoca cada función bajo test y emite output | `tests/engine_host/runner.c` → `runner` (gitignored) |
| **JS reference impl** | Misma lógica reescrita en JS puro, validador independiente | `tests/helpers/engine-host.js` |

### Las 3 garantías (cada una caza un tipo de regresión)

1. **Drift test** — la copia en `lib/` sigue byte-exact al motor real.
   Si Javi edita el motor, te avisa para sincronizar la copia.
   *No requiere clang* — solo lee los `.c` con `fs.readFileSync` y los
   compara con regex extractors.

2. **Bit-exact JS ↔ C** — el output del motor coincide con el de la
   implementación JS de referencia. Si el motor cambia su lógica
   (no solo su sintaxis), te avisa.

3. **Goldens binarios** — el SHA-256 de los outputs reales (`buffer
   decodificado`, `lista de waypoints`, `bitmap lightmap`, ...) se
   persiste en `goldens/engine/<modulo>/`. Cualquier cambio que
   altere bytes deja el SHA distinto y el test rojo identifica qué
   fixture cambió.

### Workflow cuando edites el motor

Si tocas `resources/engine/agemki_audio.c` o `agemki_engine.c`:

1. **Hook automático** dispara `tests/golden/engine-host*.test.js`.
2. Si tu cambio NO toca lógica cubierta → todo verde, sigues.
3. Si tu cambio toca una función cubierta → drift FAIL con mensaje
   tipo "lib/pcx_decode.c y agemki_engine.c divergen". Dos opciones:
   - Cambio intencional: copia el bloque actualizado del motor a
     `tests/engine_host/lib/<file>.c`. Ejecuta `npm run goldens:update`
     si los bytes producidos también cambiaron.
   - Cambio no intencional: revierte.
4. Si tu cambio en el motor produce **bytes distintos** (no solo
   estilo/comments): el drift queda verde tras sincronizar la copia,
   pero los SHA-256 de los goldens fallan. Ahí decides si el cambio
   es legítimo (regenera goldens) o es un bug (revierte).

### Cómo añadir un nuevo módulo (el patrón)

Sub 2.1 (CRC32), 2.2 (PCX) y 2.3 (A*) lo siguen. El patrón:

1. **Localizar la función pura** en el motor. Identifica qué deps HW
   tiene (`outp/inp/int86`, globals, etc.). Si el módulo está
   acoplado a HW de forma que no se puede aislar trivialmente,
   replantea — quizás necesite refactor.
2. **Copiar byte-exact** la sección portable a
   `tests/engine_host/lib/<modulo>.c`. Renombra la función con
   prefijo `ag_test_` para exponerla.
3. **Añadir typedef** si la copia usa tipos del motor (`u8`, `s16`,
   `Point`, ...). Mapear a `<stdint.h>` o equivalentes en host.
4. **Extender el runner** (`runner.c`) con un dispatcher nuevo
   (`./runner <comando> <args>`). Output siempre en formato
   line-based + hex (no binario raw, ver "por qué hex" abajo).
5. **Helper JS en `tests/helpers/engine-host.js`** con:
   - Función `runner<Modulo>(...)` que invoca el binario y parsea
     stdout.
   - Función `js<Modulo>(...)` que reimplementa el algoritmo en JS
     puro, sirve de referencia. **Opcional**: tiene sentido cuando el
     algoritmo es lo bastante mecánico para reescribirlo sin bugs (CRC32,
     RLE de PCX). Para algoritmos con tie-breaking sensible al orden
     (A*), reimplementar JS aporta poco valor — basta drift + goldens.
   - Función `detect<Modulo>Drift()` con la regex que extrae el
     bloque del motor real y lo compara con la copia local.
6. **Test vitest** en `tests/golden/engine-host-<modulo>.test.js`
   con tres bloques:
   - `describe('drift detection (sin clang)', ...)` — independiente.
   - `describe.skipIf(noClang)('bit-exact con JS' / 'comportamiento', ...)`
     — el grueso. "Bit-exact con JS" si hay reimpl JS; "comportamiento"
     si testeamos propiedades observables (ruta existe / no, longitudes
     en rangos, primer y último waypoint coherentes).
   - `describe.skipIf(noClang)('goldens', ...)` — SHA-256 vs
     `goldens/engine/<modulo>/`.
7. **Hook**: el matcher actual ya cubre `resources/engine/*.c|*.h`,
   no hace falta tocar nada.
8. **`tests/README.md`**: añadir sección sobre el nuevo test.

### Por qué hex y no bytes raw en el stdout del runner

Windows hace LF→CRLF translation por defecto en stdout. Cualquier
byte 0x0A en el output binario se convierte a 0x0D 0x0A al salir,
corrompiendo el SHA-256 y rompiendo el test cross-platform.

Solución elegida: el runner emite el buffer como cadena hex (2 chars
por byte). Cero bytes 0x0A en el output, cero translation issue.
Coste: ~2x bytes en stdout, despreciable para fixtures pequeños.

Alternativa con `_setmode(_fileno(stdout), _O_BINARY)` también
funcionaría, pero requiere `#ifdef _WIN32` y headers `<io.h>` en C
— el hex es más simple y portable.

### Skip elegante si clang no está

`tests/engine_host/build.mjs` invoca `clang --version` al arrancar.
Si no está disponible (mac sin Xcode CLT, win sin LLVM, linux sin
apt), el build sale con exit 2 y el helper `ensureRunnerBuilt()`
devuelve `{ status: 'no-clang' }`.

`describe.skipIf(noClang)` skipea automáticamente los bloques que
necesitan el binario, manteniendo el suite verde. **El drift test
NO se skipea** — solo lee `.c` files con `fs`, no requiere clang.

---

## Cómo funciona el hook `PostToolUse`

`.claude/settings.json` registra un hook que se dispara cada vez que
Claude Code modifica un fichero (`Edit`, `Write`, `MultiEdit`):

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write|MultiEdit",
      "hooks": [{
        "type": "command",
        "command": "node .claude/hooks/run-tests-on-edit.mjs"
      }]
    }]
  }
}
```

El hook está escrito en Node puro (no bash), así corre idéntico en
macOS, Linux y Windows sin Git Bash ni WSL. Node es dependencia
obligatoria del proyecto (`engines.node` en `package.json`).

El hook `.claude/hooks/run-tests-on-edit.mjs`:

| Path editado | Tests disparados |
|---|---|
| `src/main/datGenerator.js` | `tests/golden/` |
| `src/main/sfxGenerator.js` | `tests/golden/` |
| `src/main/fontGenerator.js` | `tests/golden/` |
| `src/main/index.js` | `tests/golden/` |
| `src/renderer/src/store/*.js` | `tests/unit/stores/` |
| `tests/fixtures/*` o `tests/helpers/*` | `tests/` (toda la suite) |
| `resources/engine/*.c` o `*.h` | `tests/golden/engine-host*.test.js` (drift + tests del módulo si clang está disponible) |
| Cualquier otro path | noop, sale 0 |

Reglas del hook:
- **Nunca bloquea el edit** (siempre `exit 0`).
- **Solo emite output a stderr si los tests fallan** — no inunda el transcript con OK silenciosos.
- Lee el JSON del hook por stdin con `node` para extraer `tool_input.file_path`.

Si quieres ver lo que vería tu IDE al editar un store:

**macOS / Linux**:
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'$(pwd)'/src/renderer/src/store/sceneStore.js"}}' \
  | node .claude/hooks/run-tests-on-edit.mjs
```

**Windows (PowerShell)**:
```powershell
'{"tool_name":"Edit","tool_input":{"file_path":"' + (Get-Location) + '/src/renderer/src/store/sceneStore.js"}}' `
  | node .claude/hooks/run-tests-on-edit.mjs
```

Sin output = OK. Si hubiera fallo, vería las últimas 20 líneas de vitest en stderr.

---

## Cómo funciona el skill `/tdd-feature`

`.claude/skills/tdd-feature/SKILL.md` es la receta que sigue Claude Code
cuando le pides "añade tal feature en JS". Aplica TDD estricto:

1. Detecta el tipo de feature (serializador / store action / IPC handler / helper).
2. Escribe el test correspondiente con la estructura
   `caso feliz / bordes / invariantes`.
3. Ejecuta los tests y **verifica que fallan en rojo** (no en verde por
   accidente).
4. Implementa el código mínimo para que pasen.
5. Re-ejecuta y confirma verde.
6. Propone un mensaje de commit y espera tu confirmación.

No tienes que invocarlo explícitamente: si pides "añade un campo nuevo
al codegen" o "implementa una acción tal en el sceneStore", el agente
detecta la intención y aplica el playbook adecuado del skill. Si quieres
forzarlo o saber qué hace cada playbook, ábrelo y léelo — es un
documento normal en español.

Reglas absolutas grabadas en el skill:
- Nunca escribir código de producción antes del test.
- Nunca decir "el test pasa" sin haber visto primero "el test falla".
- Nunca commitear automáticamente.
- Nunca implementar más de lo que el test pide.

## Cómo funciona el skill `/golden-update`

`.claude/skills/golden-update/SKILL.md` define el flujo seguro para
regenerar los goldens cuando un cambio en el codegen es **intencional**.

Cuando invocas `/golden-update` en Claude Code, el agente:

1. **Verifica working tree** — si hay cambios sueltos sin relación, avisa antes de continuar.
2. **Regenera con** `UPDATE_GOLDENS=1 npm test -- tests/golden/`.
3. **Muestra `git diff --stat goldens/`** para que veas qué bytes cambiaron.
4. **Verifica que la suite completa pasa** (`npm test`).
5. **Espera tu confirmación antes de stagear** — nunca auto-commit.
6. **Propone un mensaje de commit** con el porqué del cambio.

Reglas absolutas grabadas en el skill:
- Nunca modificar `tests/fixtures/` para hacer pasar los tests.
- Nunca usar `git add -A` ni `git commit -a`.
- Nunca regenerar goldens si el cambio no afecta al codegen.

Si prefieres hacerlo a mano sin el skill:

```bash
git status                     # comprueba que el árbol está como esperas
UPDATE_GOLDENS=1 npm test -- tests/golden/
git diff --stat goldens/       # revisa qué cambió
git add goldens/               # solo cuando estés seguro
git commit -m "goldens(dat): regen tras X — el cambio Y es intencional porque Z"
```

---

## Cómo añadir un test nuevo

### Caso A: tests para un store nuevo

1. Crea `tests/unit/stores/miStore.test.js` siguiendo el patrón de
   `sceneStore.test.js`:

   ```js
   import { describe, it, expect, beforeEach } from 'vitest'
   import { useMiStore } from '../../../src/renderer/src/store/miStore.js'
   import { makeStoreReset, mockApi } from '../../helpers/store-stubs.js'

   const reset = makeStoreReset(useMiStore)
   beforeEach(() => reset())

   describe('miStore — apertura', () => {
     it('estado inicial vacío', () => {
       expect(useMiStore.getState().items).toEqual([])
     })
   })
   ```

2. Si el store usa IPC, sobrescribe respuestas con `mockApi`:

   ```js
   mockApi({ listItems: async () => ({ ok: true, items: [{ id: 'a' }] }) })
   await useMiStore.getState().load('/fake/dir')
   ```

3. Añade el store a `tests/unit/stores/all.smoke.test.js` en `STORE_SPECS`
   con sus `stateKeys` y `actionKeys` esperados.

4. `npm test` debe seguir verde.

### Caso B: cubrir un caso adicional en un store existente

Edita el `*.test.js` del store afectado. Sigue el patrón de `describe`s
agrupados por área del API. Si el caso requiere modificar el state inicial,
hazlo con `useStore.setState({...})` antes de la acción a testear.

### Caso C: nuevo test de golden file

1. Si el codegen genera un nuevo tipo de output (no `.DAT`), añade un fichero
   `tests/golden/<tipo>.test.js` siguiendo el patrón de `dat.test.js`.

2. Si solo es un nuevo fixture, ver siguiente sección.

---

## Cómo añadir o modificar un fixture

Los fixtures viven en `tests/fixtures/<nombre>/` y los binarios PCX/MIDI/WAV
se generan deterministicamente desde `tests/fixtures/builder.mjs`.

### Añadir un fixture nuevo (ej: `complex`)

1. Edita `builder.mjs` y añade una función `buildComplex()` que escriba la
   estructura del fixture en `tests/fixtures/complex/`.
2. Llámala desde el bloque `// ── Main ──` al final del fichero.
3. Ejecuta `node tests/fixtures/builder.mjs` para generar los ficheros.
4. Edita `tests/golden/dat.test.js` y añade `'complex'` a la lista
   `FIXTURE_LIST`.
5. Genera los goldens del fixture nuevo:
   ```bash
   UPDATE_GOLDENS=1 npm test -- tests/golden/
   ```
6. Verifica que todo está verde:
   ```bash
   npm test
   ```
7. Stagea **fixtures + goldens nuevos** en el mismo commit (van juntos).

### Modificar el fixture `minimal`

1. Edita `builder.mjs` con el cambio (ej: añadir un personaje, una
   secuencia, etc.).
2. Ejecuta `node tests/fixtures/builder.mjs`.
3. `npm test` fallará los goldens — esperado.
4. Si el cambio es intencional, regenera goldens:
   ```bash
   UPDATE_GOLDENS=1 npm test -- tests/golden/
   ```
5. Revisa el diff:
   ```bash
   git diff --stat tests/fixtures/minimal/ goldens/dat/minimal/
   ```
6. Commit con razón explícita.

### Modificar los walkmaps (sub 2.3)

Los 5 `.bin` de `tests/fixtures/walkmaps/` los genera
`tests/fixtures/walkmaps-builder.mjs` (40×18 celdas, formato:
`uint16 LE w`, `uint16 LE h`, `w*h bytes` con 1=walkable / 0=block).

1. Edita `walkmaps-builder.mjs` (cambiar geometría, añadir un mapa nuevo).
2. Ejecuta `node tests/fixtures/walkmaps-builder.mjs`.
3. `npm test` fallará los SHA-256 del manifest A* — esperado.
4. Regenera el manifest:
   ```bash
   UPDATE_GOLDENS=1 npm test -- tests/golden/engine-host-astar.test.js
   ```
5. Si añadiste un walkmap, edita `tests/golden/engine-host-astar.test.js`
   y suma sus 10 casos al array `CASES`.
6. Stagea fixtures + manifest + test en el mismo commit.

### Por qué los binarios están commiteados

Los `.PCX`, `.MID`, `.WAV` y los walkmap `.bin` van al repo por dos razones:
- **Reproducibilidad**: cualquier contributor clona y testea sin pasos extra.
- **Determinismo**: cualquier diff binario en estos ficheros es señal de
  algo raro (¿se modificó el builder sin querer?). Git lo detecta.

Los dos `*-builder.mjs` documentan cómo regenerarlos y mantienen la
lógica visible.

---

## Cómo regenerar los goldens (workflow seguro)

Resumen del flujo correcto cuando cambias el codegen y los goldens deben
actualizarse:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Antes de tocar nada: `npm test` debe pasar.               │
│ 2. Cambias `src/main/datGenerator.js` (o similar).           │
│ 3. `npm test` falla los goldens afectados → ESPERADO.        │
│ 4. Decides: ¿el cambio es intencional?                       │
│    SÍ → continúa con 5.                                      │
│    NO → arregla el código hasta que `npm test` vuelva verde. │
│ 5. `git status` — el árbol debe tener solo tus cambios.      │
│ 6. `UPDATE_GOLDENS=1 npm test -- tests/golden/` regenera.    │
│ 7. `git diff --stat goldens/` muestra qué bytes cambiaron.   │
│ 8. `git diff goldens/dat/*/manifest.json` muestra hashes.    │
│ 9. `npm test` (suite completa) debe estar verde.             │
│ 10. Commit en dos partes:                                    │
│     a) `git add src/ tests/`                                 │
│        `git commit -m "feat(dat): añadir campo X"`           │
│     b) `git add goldens/`                                    │
│        `git commit -m "goldens(dat): regen tras feat X"`     │
└──────────────────────────────────────────────────────────────┘
```

Separar el commit del cambio en código del commit de los goldens hace que
el log de git sea legible mirando atrás: primero ves qué cambió en el
código, después qué bytes cambiaron como consecuencia. Esto importa
sobre todo cuando trabajas solo y no hay PR description que documente
el "porqué" — el commit message es la única narrativa posterior.

---

## Troubleshooting

### `npm test` falla tras `git pull`

Los goldens del repo no coinciden con tu codegen actual. Posibles causas:
- Cambiaste algo localmente sin querer → `git status` te lo dice.
- El upstream cambió goldens y los conflicts están sin resolver.
- Cambiaste de Node version (los `.DAT` son deterministas pero el builder
  podría depender de Node).

Diagnóstico rápido:
```bash
node --version              # debe estar en 22 LTS o 24, ver package.json engines
git status
git diff -- src/main/datGenerator.js src/main/sfxGenerator.js src/main/fontGenerator.js
```

### Los tests del hook no se disparan al editar

Verifica que el hook está registrado:
```bash
ls -la .claude/hooks/run-tests-on-edit.mjs   # debe existir
cat .claude/settings.json                     # debe tener el hook PostToolUse
```

Prueba el hook manualmente:

**macOS / Linux**:
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'$(pwd)'/src/renderer/src/store/sceneStore.js"}}' \
  | node .claude/hooks/run-tests-on-edit.mjs
echo "exit: $?"
```

**Windows (PowerShell)**:
```powershell
'{"tool_name":"Edit","tool_input":{"file_path":"' + (Get-Location) + '/src/renderer/src/store/sceneStore.js"}}' `
  | node .claude/hooks/run-tests-on-edit.mjs
$LASTEXITCODE
```

### `RangeError: The value of "offset" is out of range` en `serializeScript`

Bug F-04 documentado en [`FINDINGS.md`](FINDINGS.md). Si tu `script.json`
usa instrucciones con campos `text`, `flag`, `value` (en vez de `p1`-`p4`),
explota. Mientras se arregla, los fixtures usan `instructions: []`.

### Snapshots obsoletos

Si renombras un test `it('...')`, vitest crea snapshot nuevo y deja el
antiguo como obsoleto. Para limpiarlos:
```bash
npm test -- -u
```

### `console.log` ruido en el output

`objectStore.js` tiene `console.log('[objectStore] loadObjects ...')`.
Es del código de producción, no de los tests. Polish a futuro: añadir
`vi.spyOn(console, 'log').mockImplementation(() => {})` en el setup.

### Los tests del hook tardan demasiado en cada Edit

Si edits triviales disparan toda la suite, revisa el matcher en
`run-tests-on-edit.mjs`. El hook está diseñado para correr SOLO los tests
del área editada. Si sale > 3s, algo va mal.

---

## Por qué este diseño

### No mocks del codegen

Los goldens son bytes reales. Mockear el codegen sería testear el mock,
no el codegen. Si los bytes cambian, lo sabremos: el diff queda en el
commit, revisable.

### No snapshot DOM ni tests de componentes React

Los componentes son frágiles a cambios cosméticos (orden de className,
nodos vacíos, atributos opcionales). Los stores Zustand son donde vive
la lógica — los stores se testan. Los componentes se prueban a mano o,
en el futuro, con E2E (Playwright en otra fase).

### No CI con DOSBox-X

Los runners gratis de GitHub Actions no tienen `mpu401=intelligent` ni
VGA. Phase 3c (BMP goldens del motor) queda fuera de CI por diseño. La
parte JS sí va a CI cuando se monte (Phase 4 lo deja preparado).

### Tres niveles de coste

| Nivel | Velocidad | Cubre |
|---|---|---|
| Unit (Phase 2) | < 2s | Stores Zustand, helpers JS puros |
| Golden JS (Phase 1) | < 3s | Codegen `.DAT`, `agemki_dat.h`, `main.c` |
| Engine host (Phase 3a, futuro) | < 5s | Lógica pura del motor (CRC, A*, geom) |
| Attract DOSBox (Phase 3c, futuro) | ~30s | Motor real ejecutando en DOSBox-X |

Los tres primeros corren en cada Edit via hook; el cuarto solo en
ejecución manual antes de commits importantes.

### Hook PostToolUse en cada edit + `npm test` antes de commit

El hook `PostToolUse` corre tras CADA edit del agente, así el feedback
llega en segundos mientras editas. Es la primera red.

La segunda red es manual: **antes de commitear cambios importantes,
ejecuta `npm test`**. Si trabajas solo (sin PRs ni CI), este es el
último checkpoint para mantener `main` verde.

Si quieres automatizarlo aún más, puedes instalar un git hook
pre-commit local (no se commitea):

```bash
cat > .git/hooks/pre-commit <<'EOF'
#!/bin/sh
# Bloquea el commit si la suite de tests falla.
# Saltable con `git commit --no-verify` si necesitas commitear WIP.
npm test --silent
EOF
chmod +x .git/hooks/pre-commit
```

`--no-verify` queda como escape para commits intermedios cuando estés
trabajando en algo a medias.

---

## Pipeline DOSBox-X (futuro, Phase 3)

Estos scripts no existen aún. Cuando se monten:

```bash
./scripts/dosbox-build.sh prod          # compila motor → game/GAME.EXE
./scripts/dosbox-run.sh 30              # ejecuta GAME.EXE 30s, captura log
./scripts/collect_goldens.sh            # captura BMP frames deterministas
./scripts/verify_goldens.sh             # compara con goldens/runtime/
```

Requerirán:
- DOSBox-X instalado (`/Applications/DOSBox-X.app/Contents/MacOS/DOSBox-X`)
- Open Watcom v2 instalado fuera del repo (versión beta Apr 2026 verificada)
- `gtimeout` (coreutils, `brew install coreutils`)

Toolchain de build verificado:
- Mount `C:` = `WATCOM/`, `D:` = repo
- `PATH=C:\BINW`, `INCLUDE=C:\H`, `WATCOM=C:\`
- Flags: `-bt=dos -3 -mf -ox -za99 -w3 -wcd=202 -wcd=102 -dWALKMAP_CELL_SIZE=8`
  *(release; debug usa `-d2` en vez de `-ox`)*
- `memsize=256`, `machine=svga_s3`, `xms+ems+umb=true`

⚠ Atención: el `-O2` actual en `index.js:1645` no es válido en Open Watcom v2.
Ver F-01 en [FINDINGS.md](FINDINGS.md) — fix de 1 línea propuesto.

---

## Referencias

- [`FINDINGS.md`](FINDINGS.md) — bugs y problemas detectados durante el
  montaje de la suite (5 findings con severidad, repro, impacto, fix).
- [`AGEMKI_DAT_SPEC.md`](../src/main/dat/AGEMKI_DAT_SPEC.md) — formato
  binario `.DAT` (referencia normativa).
- [`datGenerator.js`](../src/main/datGenerator.js) — codegen `.DAT`.
- [`index.js`](../src/main/index.js) — codegen `main.c` y `agemki_dat.h`,
  IPC handlers, Makefile generator.
- [`vitest.config.js`](../vitest.config.js) — configuración del runner.

### Lecturas externas

- [Vitest docs](https://vitest.dev/) — framework de tests.
- [Zustand docs](https://github.com/pmndrs/zustand) — para entender los stores.
- [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) — el
  PostToolUse documentation.
