# Suite de tests y golden files

Red de seguridad para AGEMKI: tests unitarios de los stores, golden files
del codegen `.DAT` y, a futuro, captura BMP del motor real ejecutándose en
DOSBox-X. Pensado para que **cualquier cambio que altere bytes generados o
lógica observable rompa al menos un test**.

> Tiempo de lectura estimado de este documento: 10 minutos.
> Tiempo desde clonar el repo hasta ver verde: 30 segundos.

---

## Índice

1. [Convención de idioma](#convención-de-idioma-mandatorio)
2. [Quickstart](#quickstart)
3. [Comandos del día a día](#comandos-del-día-a-día)
4. [Layout completo](#layout-completo)
5. [Qué cubre cada fichero de test](#qué-cubre-cada-fichero-de-test)
6. [Cómo funciona el hook PostToolUse](#cómo-funciona-el-hook-posttooluse)
7. [Cómo funciona el skill `/golden-update`](#cómo-funciona-el-skill-golden-update)
8. [Cómo añadir un test nuevo](#cómo-añadir-un-test-nuevo)
9. [Cómo añadir o modificar un fixture](#cómo-añadir-o-modificar-un-fixture)
10. [Cómo regenerar los goldens (workflow seguro)](#cómo-regenerar-los-goldens-workflow-seguro)
11. [Troubleshooting](#troubleshooting)
12. [Por qué este diseño](#por-qué-este-diseño)
13. [Pipeline DOSBox-X (futuro, Phase 3)](#pipeline-dosbox-x-futuro-phase-3)
14. [Referencias](#referencias)

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
│   └── engine_host/        ← (futuro Phase 3a) Makefile + runner C compilado con clang
│
├── goldens/                ← outputs esperados (entran al repo, !goldens/** en .gitignore)
│   ├── dat/
│   │   └── minimal/
│   │       ├── GRAPHICS.DAT     bytes esperados
│   │       ├── SCRIPTS.DAT
│   │       ├── AUDIO.DAT
│   │       ├── FONTS.DAT
│   │       └── manifest.json    sha256 + size + numBlocks por DAT
│   ├── engine/             (futuro Phase 3a) outputs binarios de lógica pura
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
    │   └── run-tests-on-edit.sh hook que dispara tests del área editada
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
| `resources/engine/*.c` o `*.h` | `tests/engine_host/` (Phase 3a) |
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

### Por qué los binarios están commiteados

Los `.PCX`, `.MID`, `.WAV` van al repo por dos razones:
- **Reproducibilidad**: cualquier contributor clona y testea sin pasos extra.
- **Determinismo**: cualquier diff binario en estos ficheros es señal de
  algo raro (¿se modificó el builder sin querer?). Git lo detecta.

El `builder.mjs` documenta cómo regenerarlos y mantiene la lógica visible.

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
node --version              # debe estar en 20-22 LTS, ver package.json engines
git status
git diff -- src/main/datGenerator.js src/main/sfxGenerator.js src/main/fontGenerator.js
```

### Los tests del hook no se disparan al editar

Verifica que el hook está registrado y es ejecutable:
```bash
ls -la .claude/hooks/run-tests-on-edit.sh   # debe tener +x
cat .claude/settings.json                    # debe tener el hook PostToolUse
```

Prueba el hook manualmente:
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"'$(pwd)'/src/renderer/src/store/sceneStore.js"}}' \
  | .claude/hooks/run-tests-on-edit.sh
echo "exit: $?"
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
`run-tests-on-edit.sh`. El hook está diseñado para correr SOLO los tests
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
