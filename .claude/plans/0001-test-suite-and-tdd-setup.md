# PLAN 0001 — Test suite, golden files, TDD harness

```
Status:        in-progress (etapa 2 sub 2.1 completada)
Owner:         marcos
Branch:        marcos/test-suite-tdd
Started:       2026-05-02
Last update:   2026-05-03
Tests verde:   241 / 241 (~7s en mac, mac+win en CI)
Commits:       8 sobre `e11ff84` (commit base de Javi)
PR upstream:   https://github.com/kalzakath1/agemki/pull/1 (OPEN)
```

---

## Goal

Red de seguridad para evolucionar AGEMKI sin romperlo. Tres pilares:

1. Tests deterministas del codegen (`game.json` -> C, `game.json` -> .DAT).
2. Golden files binarios + semanticos en cada frontera de transformacion.
3. Workflow TDD automatizado para Claude Code (CLAUDE.md + hooks + skill).
4. Cross-platform: idéntico funcionamiento en Windows 11 (Javi) y macOS (Marcos).

Primero red, despues maniobra. Cero refactor en este plan.

---

## Reglas aprendidas (heuristicas obligatorias)

### Regla 1 — No declarar bug sin verificar fuera del sandbox

Aprendida en F-02 (falso positivo). Si veo un fallo solo desde la tool
Bash de Claude Code, **no es un bug confirmado**. Verificar en al menos
uno de:
- Terminal nativa del usuario (preguntar y esperar respuesta)
- CI matrix mac+win con runners limpios
- Otro entorno aislado (Docker, otra mac)

Antes de meter algo en `tests/FINDINGS.md` con severidad >= Media,
exigirme mismo este check. Si no se verifica, marcarlo "sospechoso —
pendiente verificación externa".

### Regla 2 — Cada cambio en codigo de Javi documenta su porque

Mensajes de commit completos. F-02 enseno que el "fix" puede ser
cosmetico; el porque tiene que justificarse para que un revisor pueda
detectar fixes fantasma.

### Regla 3 — Idioma del repo: español

Mandatorio. Comentarios in-source, READMEs, mensajes commit, diff de PR.
Excepciones documentadas en `tests/README.md`.

### Regla 4 — TDD estricto en sub-etapas que tocan motor C

Para cada sub-etapa de Phase 3a:
1. Escribir test primero, ejecutar para confirmar rojo.
2. Anadir copia minima del modulo del motor a `tests/engine_host/lib/`.
3. Drift test obligatorio (compare la copia con el original byte-exact).
4. Test bit-exact contra implementacion JS de referencia (cuando exista).
5. Re-ejecutar, confirmar verde.

### Regla 5 — Cross-platform por construccion

- Hooks Node, no bash.
- Build orquestador Node, no Make.
- `process.platform` solo para detectar paths externos (DOSBox-X.app,
  C:\WATCOM\). El resto de la logica es identica.
- CI matrix mac+win valida cada commit.

### Regla 6 — `.gitattributes` enforcing

Texto LF, binarios marcados explicitos. Cualquier extension nueva de
fichero binario que aparezca (ej: `.PAL`, `.OP2`) se anade al
`.gitattributes` antes de commitear.

---

## Estado actual (al 2026-05-03)

### Commits aplicados (8 sobre e11ff84)

| # | SHA | Mensaje | Tipo |
|---|---|---|---|
| 1 | 6813fd9 | fix(dat,build): tres bugs descubiertos al ejercitar el codegen (F-01, F-04, F-05) | fix |
| 2 | bb779ab | feat: suite de tests + golden files + workflow TDD para Claude Code | feat |
| 3 | a218759 | chore: portabilidad cross-platform Windows 11 / macOS (hook .sh→.mjs, .gitattributes, GH Actions matrix) | chore |
| 4 | 385bba7 | chore: alinear con Node LTS 2026 (drop Node 20, opt-in Node 24 en actions) | chore |
| 5 | 0c08883 | docs: cross-platform Windows 11 / macOS coherente en toda la documentación | docs |
| 6 | 27e3cc0 | feat(engine-host): primer test del subset portable — CRC32 (sub-etapa 2.1) | feat |
| 7 | 85dc2ce | chore: gitignore artefactos de debug del motor host (dSYM, pdb, ilk) | chore |
| 8 | 8a02962 | docs(findings): F-02 descartado — falso positivo de mi entorno (Claude Code sandbox) | docs |

### Tests por fichero

```
tests/unit/helpers.test.js                  6 tests
tests/golden/dat.test.js                   26 tests
tests/golden/engine-host.test.js           22 tests  ← Phase 3a sub 2.1
tests/unit/stores/all.smoke.test.js        30 tests
tests/unit/stores/sceneStore.test.js       25 tests
tests/unit/stores/scriptStore.test.js      19 tests
tests/unit/stores/dialogueStore.test.js    18 tests
tests/unit/stores/charStore.test.js        17 tests
tests/unit/stores/objectStore.test.js      16 tests
tests/unit/stores/localeStore.test.js      17 tests
tests/unit/stores/sequenceStore.test.js    14 tests
tests/unit/stores/verbsetStore.test.js     12 tests
tests/unit/stores/appStore.test.js         11 tests
tests/unit/stores/attributeStore.test.js    8 tests

Total                                     241 tests / ~7s en mac
```

### Findings

| ID | Severidad | Estado |
|----|-----------|--------|
| F-01 | Alta | ✅ aplicado (commit 1) |
| F-02 | ~~Media~~ | ❌ falso positivo descartado (commit 8) |
| F-03 | Media | ⏸ en pausa, esperando documentation/ de Javi |
| F-04 | Alta | ✅ aplicado (commit 1) |
| F-05 | Crítica | ✅ aplicado (commit 1) |

### CI

- Workflow `.github/workflows/test.yml` con matrix `[macos-latest, windows-latest] x Node [22, 24]`.
- 4 jobs por run, todos verde tras cada push.
- Smoke test del hook PostToolUse incluido en el workflow.
- LLVM (clang) instalado en runner Windows (preinstalado o `choco install`).
- `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` para silenciar deprecation
  warnings (Node 20 actions deprecated junio 2026).

### Skills disponibles

- `/tdd-feature` — implementa features nuevas en TDD automatico
  (serializador, store action, IPC handler, helper).
- `/golden-update` — regenera goldens con confirmacion humana cuando un
  cambio en codegen es intencional. Nunca auto-commitea.

### Hook PostToolUse

`.claude/hooks/run-tests-on-edit.mjs` (Node, cross-platform):

| Path editado | Tests disparados |
|---|---|
| `src/main/(dat|sfx|font)Generator.js` | `tests/golden/dat.test.js` |
| `src/main/index.js` | `tests/golden/dat.test.js` |
| `src/renderer/src/store/*.js` | `tests/unit/stores/` |
| `tests/fixtures/` o `tests/helpers/*` | `tests/` (toda la suite) |
| `resources/engine/*.c` o `*.h` | `tests/golden/engine-host.test.js` |

---

## Architecture map (con estado real)

```
   editor (React)         build (Node)            engine (C, DOS)
   src/renderer/          src/main/               resources/engine/
        |                     |                          |
        v                     v                          v
   stores Zustand   ✅   codegen JS    ✅          modulos puros  🟡 (sub 2.1 done)
   componentes UI         datGenerator              (pathfind, geom,
   (no test, ok)          fontGenerator              LUTs, CRC32, PCX,
                          sfxGenerator              lightmap)
                              |                          |
                              v                          v
                       goldens/dat/  ✅          goldens/engine/  🟡
                         (binarios)              (CRC32 done; PCX,
                                                  geom, A*, lightmap pendientes)
                                  |
                                  v
                           GAME.EXE (DOS)  ❌ (etapa 3 pendiente)
                                  |
                                  v
                           DOSBox-X runtime
                                  |
                                  v
                           goldens/runtime/  ❌ (etapa 4 pendiente)
                              (BMP frames)
```

Leyenda: ✅ completo · 🟡 en progreso · ❌ pendiente · 🔵 fuera de scope

---

## Resto de comprobaciones — ROADMAP DETALLADO

### Etapa 2 (Phase 3a) — Subset portable del motor con clang en host

**Sub 2.1 — CRC32** ✅ HECHO

- `tests/engine_host/lib/crc32.c` (copia byte-exact de `_sfx_crc32`)
- `tests/engine_host/runner.c` con dispatcher `crc32 / crc32_batch`
- `tests/engine_host/build.mjs` cross-platform (clang detect + compile)
- 22 tests: drift + bit-exact contra JS + 16 IDs reales + 100 batch + ASCII full
- CI clang en mac (Xcode CLT) y win (LLVM)

**Sub 2.2 — PCX decode + geometría 2D** 🟡 PRÓXIMA

#### Deliverables

- `tests/engine_host/lib/pcx_decode.c` — copia minima del decoder PCX
  RLE del motor (sin VGA, sin paleta-set; solo bytes RLE -> buffer de
  pixels indexados).
- `tests/engine_host/lib/geom.c` — funciones puras de geometria:
  - `point_in_polygon(x, y, points[], n)` -> 0/1
  - `line_rect_intersect(...)` -> 0/1
  - `point_in_rect(...)` -> 0/1
  (extraidas de `agemki_engine.c`, copia byte-exact con drift test).
- Runner extendido con dispatchers nuevos: `pcx_decode`, `point_in_poly`,
  `line_rect`, etc.
- Test `tests/golden/engine-host-pcx.test.js`:
  - Decodifica los 3 PCX del fixture minimal (BG, sprite, obj).
  - Hash SHA-256 del buffer decodificado por cada uno.
  - Goldens en `goldens/engine/pcx/<name>.sha256.txt`.
  - Drift test del decoder.
- Test `tests/golden/engine-host-geom.test.js`:
  - 50 cases de point-in-polygon (convex, concave, edge cases).
  - 30 cases de line-rect.
  - Goldens en `goldens/engine/geom/<funcion>.cases.json`.
  - Drift test de cada funcion.

#### Comprobaciones

- ✅ Drift test pasa: copia idéntica byte-a-byte al motor.
- ✅ Decodificacion PCX en host coincide con la del motor (bit-exact).
- ✅ Geometria respeta los invariantes (point en vertice cuenta, point
  en arista cuenta, etc.) consistente con motor.
- ✅ CI mac+win verde.
- ✅ Hook ejecuta el nuevo test si se edita motor.

#### Riesgos

- PCX decode puede tener dependencias internas en el motor (paleta
  global, framebuffer compartido). Si las hay, hay que aislar la funcion
  pura — quitar el codigo de blit y dejar solo decompress.
- Geometria 2D del motor puede usar tipos especiales (`s16`, `u16`).
  Forzar `<stdint.h>` mappings en host build (`int16_t`, `uint16_t`).
- Si el motor usa SSE/MMX para geometria optimizada, no compila en host
  generico. Excluir y hacer fallback a referencia escalar.

#### Coste estimado

1 sesion larga.

#### Smoke al terminar

- `npm test` verde en mac local.
- `git push` -> CI verde.
- Hook funciona: editar `agemki_engine.c` dispara nuevos tests.

---

**Sub 2.3 — Pathfinding A***

#### Deliverables

- `tests/engine_host/lib/astar.c` con copia de `engine_astar` y sus
  helpers (`_heuristic`, manejo del walkmap grid, bitmap de transitable).
- Stubs HW: cualquier dependencia de filesystem o VGA que `engine_astar`
  toque, se stub-ea.
- Runner: `astar <walkmap_file> <sx> <sy> <tx> <ty>` -> dump de
  waypoints en stdout (CSV o JSON).
- 5 walkmaps fixture en `tests/fixtures/walkmaps/` (formato del motor:
  bitmap o lista de shapes).
- 50 casos de test (5 walkmaps × 10 origen-destino cada uno).
- Goldens en `goldens/engine/astar/<walkmap>_<origin>_<dest>.json` con
  la lista de waypoints esperada.

#### Comprobaciones

- ✅ Determinismo: misma entrada → misma ruta exacta (mismo orden de
  waypoints, mismas coordenadas).
- ✅ Drift test de `engine_astar`.
- ✅ Caso "no hay ruta": devuelve longitud 0, no crashea.
- ✅ Casos extremos: origen == destino (longitud 1), pared completa
  (longitud 0), camino diagonal vs ortogonal.

#### Riesgos

- `engine_astar` en el motor (línea 1124 de `agemki_engine.c`) puede
  depender de globals o estado compartido (g_walkmap_cur, etc.).
  Aislar el estado en parametros o en una struct opaca.
- Walkmap real del motor es complejo (multi-shape, add/sub modes).
  Para fixture simplificado, definir formato puro grid bitmap y un
  shim del motor que use ese formato directamente.
- Tie-breaking: si A* tiene varias rutas optimas equivalentes, el
  motor escoge una determinista (por orden de exploracion). Verificar
  que en host hace lo mismo.

#### Coste estimado

1-2 sesiones largas. Fricción real: aislar `engine_astar` del estado
global del motor.

---

**Sub 2.4 — Lightmap blur**

#### Deliverables

- `tests/engine_host/lib/lightmap.c` — copia del blur 80×50 (`_lmap_blur`
  o equivalente) + computo de luces (`_render_room_lighting` o nombre
  similar).
- Fixture: definicion de luces fija (8 luces con posiciones, radii,
  intensities, flicker = 0 para determinismo).
- Runner: `lightmap <fixture.json>` -> dump del buffer 80×50 en stdout
  o fichero binario.
- Test golden `tests/golden/engine-host-lightmap.test.js`.

#### Comprobaciones

- ✅ Determinismo: mismas luces → mismo buffer 80×50.
- ✅ Drift test.
- ✅ Caso 0 luces: buffer todo 0 (oscuro total).
- ✅ Caso 1 luz centrada: simetrico.
- ✅ Flicker = 0 produce salida estable (sin variacion entre runs).

#### Riesgos

- Lightmap blur puede usar tablas precomputadas (`shade_lut`) que se
  inicializan en `engine_init`. Stub o forzar init en el runner.
- Si el blur usa float (no probable, pero posible), forzar precision
  determinista entre clang y Watcom (revisar que los typecasts coinciden).

#### Coste estimado

1 sesion.

---

### Etapa 2 — Cierre: hook + CI + docs

Tras 2.1, 2.2, 2.3, 2.4 completas:

- ✅ Hook PostToolUse ya dispara `engine-host.test.js` para edits en motor.
- ✅ CI matrix sigue verde (mac+win × Node 22+24, todos los tests host).
- 🟡 Update `tests/README.md` con tabla de modulos del motor cubiertos.
- 🟡 Update body del PR con seccion "Etapa 2 lista para merge".

---

### Etapa 3 (Phase 3b) — Pipeline DOSBox-X autonomous (build + run)

#### Deliverables

```
scripts/
  build.mjs        compila el motor cross-platform
                   (Win: Watcom v2 nativo en C:\WATCOM\)
                   (Mac: DOSBox-X envolviendo Watcom v2 en
                         /Users/marcos/SynologyDrive/Code/dosbox-agemki/WATCOM)
  run.mjs          ejecuta game/GAME.EXE en DOSBox-X con timeout y log
  configs/
    dosbox-x-build.conf   conf DOSBox-X para mac (build via Watcom)
    dosbox-x-run.conf     conf DOSBox-X (mac+win) para ejecutar GAME.EXE
                          con bochs debug port e9 = true, mpu401=intelligent
```

#### Detalle tecnico

- `build.mjs` detecta `process.platform`:
  - Windows: invoca `wcc386.exe` y `wlink.exe` directamente desde
    `C:\WATCOM\BINW\` (o ruta configurable). Mucho mas rapido que mac.
  - macOS: arranca DOSBox-X con conf que monta WATCOM y AGEMKI, ejecuta
    `wmake -f Makefile`, captura output. ~30s por build.
  - Cero diferencia en flags de compile (mismos `-3 -mf -ox -za99 ...`).
- `run.mjs` corre identical en mac+win: solo cambia el path al
  ejecutable DOSBox-X.
- Logs:
  - `tmp/build.log` — stdout de wcc386/wlink
  - `tmp/ENGINE.LOG` — bochs E9 del juego, filtrado por `[INF]/[DBG]`
  - `tmp/AUDIO.LOG` — mididrv si DBG activa

#### Comprobaciones

- ✅ `node scripts/build.mjs prod` produce `game/GAME.EXE` no vacio en
  ambas plataformas.
- ✅ `node scripts/run.mjs 30` arranca, captura log E9, sale en 30s.
- ✅ El `GAME.EXE` producido en mac y en win son **bit-exact** (mismo
  Watcom, mismos flags, mismo source). Test que valida con SHA-256.
- ✅ Cero GUI manual en build/run.

#### Riesgos

- Watcom v2 nativo en Win y Watcom v2 dentro de DOSBox-X en mac PUEDEN
  producir bytes ligeramente distintos por:
  - Filesystem case sensitivity (DOSBox-X maneja conversiones).
  - Orden de procesamiento de archivos por wmake (depende de readdir).
  - Versiones exactas del compilador (Win puede ser version mas reciente
    que la del DOS installer).
- Si difieren, validar **comportamiento** (BMP runtime) en lugar de
  bytes del .EXE.

#### Coste estimado

1 sesion (toolchain ya validado).

---

### Etapa 4 (Phase 3c) — Goldens BMP del motor real

#### Deliverables

- Macro `CAP_FRAMES_ON` en `agemki_engine.h`. Compila zero-cost en `prod`.
- Disparadores deterministas en codigo, NO en ISR:
  - Entrada a cada room (`engine_on_enter_room` hook)
  - Tras N ticks fijos del game loop
  - Al completar un dialogo
  - Al ejecutar un verbo concreto
- Captura: dump back buffer 320×200 + paleta -> BMP 8-bit indexado ->
  `tmp/CAPnnnn.BMP`.
- Funcion nueva `engine_dump_frame_bmp()` solo activa en build `cap`.

#### Workflow

- `node scripts/collect_goldens.mjs` — build `cap` + ejecuta hasta N
  segundos + copia `tmp/CAP*.BMP` a `goldens/runtime/G_*.BMP` con
  nombres semanticos.
- `node scripts/verify_goldens.mjs` — rebuild `cap` + ejecuta + `cmp -s`
  con cada golden. PASS / FAIL / MISSING. Genera diff PNGs con `sips`
  (mac) o ImageMagick (win) en `tmp/agemki_diff/`.

#### Determinismo

- PIT chained pero captura solo entre frames del game loop.
- Cero entrada de teclado: scriptar la escena con fixture `attract.json`
  que define eventos sinteticos.
- Cero RNG no-seeded.

#### Comprobaciones

- ✅ 5-10 goldens iniciales (no aspirar a coverage exhaustivo).
- ✅ Dos runs consecutivos sin cambios -> `verify_goldens.mjs` exit 0.
- ✅ Bit-exactitud entre mac (DOSBox-X) y win (Watcom nativo) para los
  mismos goldens — valida que el bug F-05 (sort) si rompe en runtime
  es detectable visualmente.

#### Riesgos

- Determinismo bit-exact entre runs en DOSBox-X requiere que el
  emulador no introduzca jitter (memoria sin inicializar, RNG del kernel
  DOS, etc.). Documentado en LINEUP project.
- Capturas pueden cambiar bit por compresion BMP (RLE o no). Forzar
  formato uncompressed.

#### Coste estimado

2 sesiones largas. Friccion principal: lograr determinismo entre runs.

---

### Etapa 5 — Decisión F-03 (cuando llegue documentation/)

Cuando Javi pase la `documentation/` y `mcp-servers/`:

- Decidir entre las 3 opciones de F-03 (commitear, quitar refs, o mezcla).
- Aplicar la decision en commit suelto sobre `main`.
- Cerrar F-03 en findings.

Sin coste estimado (depende de Javi).

---

## Cross-cutting

### Tools host (estado verificado)

| Tool | Status | Path |
|---|---|---|
| Node 22 LTS / 24 | ✓ | nvm + Node 22.22.2 instalado |
| clang 16 | ✓ | `/usr/bin/clang` (Xcode CLT en mac) |
| DOSBox-X | ✓ | `/Applications/DOSBox-X.app/Contents/MacOS/DOSBox-X` |
| Open Watcom v2 | ✓ | `/Users/marcos/SynologyDrive/Code/dosbox-agemki/WATCOM/` |
| gtimeout | ✓ | `/usr/local/bin/gtimeout` (coreutils) |
| ts | ✓ | `/usr/local/bin/ts` (moreutils) |
| 7zz | ✓ | `/usr/local/bin/7zz` |
| gh CLI | ✓ | v2.92.0, autenticado como Optimiza |
| nvm | ✓ | brew, en `/usr/local/opt/nvm/` |

### Estructura del repo (estado actual)

```
agemki/
  .claude/
    settings.json                ✅ commiteado
    settings.local.json          (gitignored)
    hooks/
      run-tests-on-edit.mjs      ✅ commiteado, cross-platform
    skills/
      golden-update/SKILL.md     ✅ commiteado
      tdd-feature/SKILL.md       ✅ commiteado
    plans/
      0001-test-suite-...md      ← este fichero (gitignored)
  .github/
    workflows/test.yml           ✅ matrix mac+win Node 22/24
  goldens/
    dat/{minimal,midgame}/       ✅ minimal lleno, midgame placeholder
    engine/                      🟡 vacio (sub 2.2+ lo llenara)
    runtime/                     ❌ vacio (etapa 4)
  scripts/                       ❌ vacio (etapa 3)
  tests/
    README.md                    ✅ ~750 lineas, cross-platform
    FINDINGS.md                  ✅ 5 findings (4 reales + 1 falso positivo)
    helpers/
      hash.js, dat-decode.js
      store-stubs.js
      engine-host.js             ✅ sub 2.1
    fixtures/
      builder.mjs
      minimal/                   ✅ lleno
      midgame/                   🟡 placeholder
    unit/
      helpers.test.js
      stores/{10 stores}.test.js
    golden/
      dat.test.js
      engine-host.test.js        ✅ sub 2.1
    engine_host/                 ✅ sub 2.1
      build.mjs
      include/ag_test.h
      lib/crc32.c
      runner.c
  tmp/                           (gitignored, working dir)
  tools/
    dev-renderer-only.mjs        ✅ commiteado, util para inspeccion sin Electron
  vitest.config.js
  .gitattributes                 ✅
  package.json                   ✅ engines.node >=22, vitest, scripts test
```

---

## Order of execution

```
✅ Etapa 1 (Phase 0+1+2+4): tests JS + skills + hook + CI
                  |
                  v
🟡 Etapa 2 (Phase 3a): subset portable motor C
   ✅ 2.1 CRC32
   🟡 2.2 PCX + geom            ← AHORA
   2.3 A*
   2.4 Lightmap
                  |
                  v
❌ Etapa 3 (Phase 3b): pipeline DOSBox-X autonomous
                  |
                  v
❌ Etapa 4 (Phase 3c): goldens BMP runtime
                  |
                  v
⏸ Etapa 5 (F-03): cuando llegue documentation/ de Javi
```

---

## Open questions

1. **Bit-exactitud Watcom v2 nativo vs Watcom v2 dentro de DOSBox-X**.
   Aun por validar (Etapa 3). Si difieren, validar comportamiento en
   lugar de bytes.
2. **Phase 3 cross-platform: ¿clang en host para 3a basta o tambien
   queremos compilar el motor en host con clang completo?**. Decision:
   solo el subset portable. El motor entero requiere Watcom para `int86`,
   `_dos_setvect`, etc.
3. **GitHub Actions para Phase 3?**. Probable que no — DOSBox-X y
   Watcom no estan en runners gratis. Phase 3 queda fuera de CI por
   diseno; verificacion manual o en el mac de Marcos.

---

## Out of scope (followups posibles)

- Refactor de `src/main/index.js` (4067 LoC).
- Refactor de `agemki_engine.c` (9182 LoC) en submodulos.
- TypeScript en el editor.
- Tests de componentes React (snapshot DOM).
- Vitest browser mode para tests de canvas.
- E2E de la UI Electron con Playwright.
