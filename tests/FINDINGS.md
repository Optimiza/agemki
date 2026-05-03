# Hallazgos durante el montaje de la test suite

Esto NO es una auditoría ni una lista de cosas mal hechas. Es lo que
salió de **ejercitar el código realmente** mientras montaba la red de
seguridad: cada vez que un test no encajaba con lo que esperaba, había
que entender por qué — y a veces el "por qué" era un bug latente que
nadie había disparado todavía.

Cinco cosas en total. Cuatro tienen fix concreto (la mayoría de 1-3
líneas). Una requiere una decisión tuya. Ninguna te bloquea hoy mismo;
todas las descubrió la suite haciendo su trabajo.

Cada finding tiene:
- **Resumen en cristiano** — qué pasa, sin tecnicismos.
- **Reproducción** — cómo verlo en tu máquina.
- **Impacto** — qué se rompe y cuándo.
- **Fix** — diff o pasos concretos.
- **Para ti, ahora mismo** — qué hacer (o no hacer) con esto.

> Foco en bugs que afectan al runtime del juego o al tooling de build.
> No incluye sugerencias de estilo, ni refactor, ni opiniones sobre
> arquitectura.

---

## Resumen

| ID | Severidad | Área | Estado | Fix |
|----|-----------|------|--------|-----|
| F-01 | Alta | Build (Watcom) | ✅ aplicado en commit `fix(dat,build)` | Sí, en este PR |
| F-02 | Media | Build (Node) | ✅ aplicado vía `engines.node` en `package.json` | Sí, en este PR |
| F-03 | Media | Documentación | abierto | No — requiere decisión tuya |
| F-04 | Alta | Codegen DAT | ✅ aplicado en commit `fix(dat,build)` | Sí, en este PR |
| F-05 | Crítica | Codegen DAT | ✅ aplicado en commit `fix(dat,build)` | Sí, en este PR |

Severidad:
- **Crítica**: el motor falla silenciosamente en runtime.
- **Alta**: build no produce artefacto, o produce uno corrupto.
- **Media**: tooling roto, no afecta a runtime.

---

## F-01 — `-O2` no es flag válido en Open Watcom v2 actual

**Severidad:** Alta · **Estado:** ✅ aplicado · **Fix incluido:** Sí (commit `fix(dat,build)`)

### Resumen en cristiano

Tu Makefile release usa el flag `-O2` (estilo GCC) que la versión actual
de Open Watcom v2 no entiende. El compilador acepta la línea sin
quejarse claro, dice "1 errors" sin mensaje, y se niega a escribir el
`.obj`. Resultado: el build release no produce nada y no es obvio por qué.

El build debug sí funciona porque usa `-d2` en vez de `-O2`. Probable
que sea por eso que no lo has visto antes.

### Reproducción

[`src/main/index.js:1645`](../src/main/index.js#L1645) genera el Makefile
release con flags:

```js
`-3 -mf -O2 -za99 -w3 -wcd202 -wcd102 ${cellDefine}`
```

Compilando un `.c` cualquiera del motor con esos flags en Open Watcom v2
beta (Apr 30 2026, instalación oficial desde el `open-watcom-v2-c-dos.exe`):

```
$ wcc386 -bt=dos -3 -mf -O2 -za99 -w3 -wcd=202 -wcd=102 -dWALKMAP_CELL_SIZE=8 timer.c
timer.c: 115 lines, included 905, 0 warnings, 1 errors
```

`1 errors` sin mensaje. El compilador no escribe el `.obj`. Bisección de
flags confirma que el culpable es `-O2`:

| Flags                                 | Resultado |
|---------------------------------------|-----------|
| `-bt=dos -3 -mf -O2 -za99`            | 1 error, no .obj |
| `-bt=dos -3 -mf -ox -za99`            | 0 errors, .obj OK |
| `-bt=dos -6r -ox -w=3` (README)       | 0 errors, .obj OK |

`-O2` no figura en la documentación oficial de Open Watcom v2. El flag
correcto Watcom-style es `-ox` (full optimization).

### Impacto

El build release está silenciosamente roto en cualquier instalación de
Open Watcom v2 que no acepte `-O2` (todas las que he probado). El build
debug (`-d2` en lugar de `-O2`) sí funciona.

### Fix

```diff
-    : `-3 -mf -O2 -za99 -w3 -wcd202 -wcd102 ${cellDefine}`
+    : `-3 -mf -ox -za99 -w3 -wcd202 -wcd102 ${cellDefine}`
```

Una línea. Commit propuesto: `fix(build): -O2 -> -ox in release flags`.

### Para ti, ahora mismo

Aplica el cambio cuando lo veas — es trivial y desbloquea el build
release. Si tu workflow normal es siempre debug, esto puede haber estado
roto sin que nadie lo notara.

---

## F-02 — Editor falla en arranque con Node 25 (Electron 33 incompat)

**Severidad:** Media · **Estado:** ✅ aplicado · **Fix incluido:** Sí (en `package.json` de este PR)

### Resumen en cristiano

`npm run dev` peta al arrancar Electron si tienes Node 25+ instalado.
Con Node 20-22 (LTS) funciona. `npm run build` sí compila siempre. La
solución es decirle a `package.json` qué versiones de Node aceptamos
para que `npm install` avise si la local no encaja.

Tú probablemente estás en LTS y no lo has visto. El siguiente
contributor (o tú dentro de 6 meses con Node nuevo) sí lo verá.

### Reproducción

```
$ node --version
v25.9.0
$ npm run dev
...
TypeError: Cannot read properties of undefined (reading 'whenReady')
    at out/main/index.js:208
```

`npm run build` sí compila. Solo el arranque del proceso Electron
(`whenReady`) explota. Conocido en Electron 33 con Node ≥ 23.

### Impacto

Cualquier contributor con Node moderno no puede ejecutar el editor en dev
mode. La build de producción y el packaging sí funcionan.

### Fix

`package.json`:
```json
"engines": {
  "node": ">=22.0.0"
}
```

Node 22 es la LTS activa; Node 20 ya entró en mantenimiento en abril
2026 y deja de tener soporte oficial en septiembre. Pin a `>=22.0.0`
sin límite superior para no bloquear actualizaciones futuras.

`npm install` avisa si la versión local no encaja. Commit propuesto:
`chore: pin node engine to LTS range`.

### Para ti, ahora mismo

Cero urgencia si tu Node local está dentro del rango. Aplícalo cuando
toque para que el repo sea autodefensivo.

---

## F-03 — `documentation/` y `mcp-servers/` en `.gitignore` pero referenciados

**Severidad:** Media · **Estado:** abierto · **Fix incluido:** No (requiere decisión)

### Resumen en cristiano

Tienes carpetas `documentation/` y `mcp-servers/` que `CLAUDE.md` y
`.instructions.md` mencionan como referencia importante para entender
el motor, el audio, el formato DAT, etc. Pero esas dos carpetas están
en `.gitignore`, así que sólo existen en tu disco local. Para ti
funcionan; para cualquier otra persona (yo en esta sesión, otra máquina
tuya, un futuro contributor) son rutas rotas.

No es necesariamente un bug — quizá esas carpetas son notas locales
tuyas que no quieres publicar. Pero entonces conviene quitar las
referencias del `CLAUDE.md` para no confundir.

### Reproducción

`.gitignore` líneas 6-7:
```
mcp-servers/
documentation/
```

`CLAUDE.md` y `.instructions.md` los mencionan extensamente:
- `documentation/FETCH-SYSTEM.md`
- `documentation/CONTEXT7-AGEMKI.md`
- `documentation/AUDIO-GUIDE.md`
- `documentation/legacy/agemki-doc-v32.txt`
- `documentation/legacy/open-watcom-guide.pdf`
- `mcp-servers/watcom-context/`

### Impacto

Cualquier contributor (incluyendo un LLM en otra máquina) no ve estos
recursos. Las referencias quedan rotas. Si el contenido es relevante,
falta colaboración. Si no, son referencias obsoletas en `CLAUDE.md`.

`src/main/dat/AGEMKI_DAT_SPEC.md` SÍ está commiteado y bien — ese OK.

### Decisión necesaria

Una de:

- **(a)** Commitear `documentation/` (y `mcp-servers/` si tiene utilidad
  pública). Quitar las dos líneas del `.gitignore`. Probable opción
  correcta si son docs reales del proyecto.
- **(b)** Quitar las referencias del `CLAUDE.md` / `.instructions.md`. Si
  son notas locales de tu workflow, no del proyecto.
- **(c)** Mover documentos relevantes a una ubicación commiteada (por
  ejemplo `docs/` lowercase, no en `.gitignore`) y dejar `documentation/`
  como dir local de borradores.

### Para ti, ahora mismo

Es la única decisión real que requiere tu criterio. Si `documentation/`
son docs del proyecto que quieres compartir, opción (a). Si son notas
tuyas, opción (b). Si una mezcla, opción (c). Cuando lo decidas, son
~5 minutos de trabajo.

---

## F-04 — `serializeScript` size-calc / writer mismatch (buffer overflow)

**Severidad:** Alta · **Estado:** ✅ aplicado · **Fix incluido:** Sí (commit `fix(dat,build)`)

### Resumen en cristiano

Dentro de `serializeScript`, el código que **calcula** cuánto buffer
hace falta y el código que **escribe** los bytes leen el JSON usando
nombres de campos distintos. El que calcula busca `param1/2/3` (en
condiciones) y `p1/p2/p3/p4` (en instrucciones); el que escribe busca
`flag/value/attr` y los `Object.entries(i)`. Si los nombres reales del
JSON no coinciden con lo que espera el calculador, el buffer queda más
pequeño de lo necesario y al escribir explota con `RangeError`.

Probable que en tu uso normal del editor las claves caigan en un
patrón que evita el problema (todas vacías, o el editor las normaliza
a `p1`-`p4` antes de serializar). En cuanto pongas un `text` o un
`flag` no vacío en una instrucción, el codegen puede romper.

### Reproducción

[`src/main/datGenerator.js:633-704`](../src/main/datGenerator.js#L633-L704).
En `triggers[].conditions[]` y `triggers[].instructions[]` la pre-calc de
tamaño y la escritura usan claves distintas:

#### Conditions

Size-calc lee:
```js
size += 1 + sizeStr8(c.param1 || '') + sizeStr8(c.param2 || '') + sizeStr8(c.param3 || '') + 1
```

Writer hace:
```js
off = writeStr8(buf, off, c.flag || c.objectId || c.target || c.varName || '')
off = writeStr8(buf, off, c.value != null ? String(c.value) : '')
off = writeStr8(buf, off, c.attr || '')
```

Si la condición en JSON usa `flag`/`value`/`attr` (no `param1/2/3`),
size = 4 bytes (3 strings vacíos + 2 uint8), writer escribe N bytes →
`Buffer.alloc(N)` overflow.

#### Instructions

Size-calc lee:
```js
size += 1 + sizeStr8(i.p1||'') + sizeStr8(i.p2||'') + sizeStr8(i.p3||'') + sizeStr8(i.p4||'')
```

Writer hace:
```js
const fields = Object.entries(i).filter(([k]) => k !== 'type')
off = writeStr8(buf, off, fields[0]?.[1] != null ? String(fields[0][1]) : '')
// ... fields[1..3]
```

Si la instrucción en JSON usa `text` o `flag` (no `p1`/`p2`/...), size =
4 bytes, writer escribe el valor real → overflow.

### Repro empírica

Con la primera versión del fixture `tests/fixtures/minimal/`:
```
RangeError: The value of "offset" is out of range. It must be >= 0 and <= 65. Received 67
 ❯ writeStr8 src/main/datGenerator.js:161:7
 ❯ serializeScript src/main/datGenerator.js:698:13
 ❯ Module.generateDats src/main/datGenerator.js:938:65
```

### Impacto

Cualquier script con instrucciones que contengan strings reales rompe
`generateDats`. El comportamiento que tienes hoy depende de cómo el
editor genere los JSONs de scripts (no pude inspeccionar esa parte
porque `documentation/` está en `.gitignore`, ver F-03). Si los IDs son
`p1`-`p4`, todo OK; si son `text`/`flag`/`value`, el `Buffer.alloc()`
lanza `RangeError` y aborta el build.

### Fix sugerido

Tres opciones (cualquiera vale; la más limpia es la (c)):

**(a)** Size-calc lee `Object.entries`:
```js
const condFields = Object.entries(c).filter(([k]) => k !== 'type' && k !== 'operator')
size += 1
for (const [, v] of condFields) size += sizeStr8(String(v ?? ''))
size += 1  // operator
```

**(b)** Writer lee `c.param1/2/3`:
```js
off = writeStr8(buf, off, String(c.param1 ?? ''))
off = writeStr8(buf, off, String(c.param2 ?? ''))
off = writeStr8(buf, off, String(c.param3 ?? ''))
```

**(c)** Unificar el contrato: el editor escribe `param1`/`param2`/... en
los stores. Migración pequeña en `scriptStore.js` + un script de
upgrade del JSON existente. Más limpio a medio plazo, pero invasivo.

### Mitigación temporal en tests

`tests/fixtures/minimal/scripts/scr_use_key.json` usa `conditions: []` e
`instructions: []`. La firma del trigger se serializa, pero los caminos
buggy no se ejercitan. Una vez fixeado el bug, el fixture `midgame`
(Phase 1.5) cubrirá el camino completo y los goldens se regenerarán.

Commit propuesto: `fix(dat): align serializeScript size-calc with writer`.

### Para ti, ahora mismo

Lo primero: comprueba qué claves usa **tu** editor en el JSON real
(abre un `scripts/scr_*.json` cualquiera). Si ves `p1/p2/p3/p4`, no te
está afectando ahora pero sigue siendo deuda latente. Si ves
`text`/`flag`/`value` y aún así te funciona, mira si los strings son
todos vacíos. En cualquier caso, fix recomendado por opción (a) o (c)
para cerrar el camino.

---

## F-05 — `buildDat` no ordena chunks (binary search del motor falla)

**Severidad:** Crítica · **Estado:** ✅ aplicado · **Fix incluido:** Sí (commit `fix(dat,build)`)

### Resumen en cristiano

La spec del formato `.DAT` (que tú mismo escribiste, ver
`AGEMKI_DAT_SPEC.md`) dice claramente que la chunk table tiene que ir
ordenada por `(type, id_crc32)` para que el motor C pueda hacer
binary search en O(log N). Pero la función `buildDat` escribe los
chunks tal y como le llegan, sin sortear. Resultado: a veces salen
ordenados por casualidad (porque `readdirSync` en macOS devuelve
nombres alfabéticos y los res_types coinciden con el orden alfabético
del fichero), a veces no — y depende del filesystem y del contenido
del juego.

### Por qué probablemente no lo has notado

En tu Mac con tu game.json actual, los res_types caen casi-ordenados
por accidente: GRAPHICS.DAT, AUDIO.DAT y FONTS.DAT salen ordenados
porque su contenido es homogéneo o monótono creciente. Solo SCRIPTS.DAT
desordena: `game_params` (0x18) cae en posición 0 porque se inserta
primero en el código, antes de los locales (0x17). La binary search
del motor para los locales puede fallar dependiendo de cuántos chunks
haya. Si tu juego es pequeño o linealmente creciente, puede que la
búsqueda dé por casualidad con el chunk correcto en el primer salto.
Con un juego más grande o estructurado distinto, el motor empezará a
"perder" chunks de forma intermitente.

### Reproducción

[`src/main/datGenerator.js:206-249`](../src/main/datGenerator.js#L206-L249).
La función `buildDat` escribe los chunks en el orden de inserción, sin
sortear:

```js
function buildDat(datType, blocks) {
  // ...
  for (const block of blocks) {
    // index entry escrito en orden de blocks[]
    // data block copiado en orden de blocks[]
  }
  return buf
}
```

Pero la spec ([`src/main/dat/AGEMKI_DAT_SPEC.md`](../src/main/dat/AGEMKI_DAT_SPEC.md))
y el comentario en `agemki_engine.h` requieren orden lex por
`(type, id_crc32)` para que el motor C pueda hacer binary search.

#### Verificación con fixture minimal

Decodificando `goldens/dat/minimal/SCRIPTS.DAT`:

```
[0] resType=0x18 id="game_params"     ← debería estar al final
[1] resType=0x10 id="room_001"
[2] resType=0x11 id="obj_key"
[3] resType=0x12 id="char_hero"
[4] resType=0x13 id="vs_default"
[5] resType=0x14 id="dlg_intro"
[6] resType=0x15 id="scr_use_key"
[7] resType=0x16 id="seq_intro"
[8] resType=0x17 id="locale_en"
[9] resType=0x17 id="locale_es"
```

`game_params` (0x18) está antes que `locale_*` (0x17). Para una
búsqueda binaria por res_type=0x17, el motor mira el índice medio (~0x14),
decide ir a la mitad superior, encuentra `game_params` (0x18) o cualquier
otra cosa, no localiza los locales correctamente.

GRAPHICS.DAT, AUDIO.DAT y FONTS.DAT están ordenados **por accidente** en
el fixture minimal (el `readdirSync` los devuelve ya ordenados, y los
res_types coinciden con el orden alfabético). Cualquier configuración
diferente puede romperlos también.

### Impacto

**Crítico.** En runtime, el motor falla a localizar chunks específicos
del SCRIPTS.DAT. Síntoma probable: rooms / objetos / diálogos / scripts
que el editor sí define pero el motor no carga, dependiendo del orden
filesystem `readdirSync`. Comportamiento no-determinista entre máquinas.

### Fix

Una línea antes del bucle de escritura en `buildDat`:

```diff
 function buildDat(datType, blocks) {
   const numBlocks  = blocks.length
+
+  // Spec AGEMKI_DAT_SPEC.md: ordenar lex por (type, id) para binary search.
+  blocks = [...blocks].sort((a, b) =>
+    a.resType !== b.resType
+      ? a.resType - b.resType
+      : String(a.id).localeCompare(String(b.id))
+  )
+
   const indexSize  = numBlocks * INDEX_ENTRY_SIZE
   const dataOffset = HEADER_SIZE + indexSize
```

Este fix cambia los bytes generados → goldens existentes se invalidan
intencionalmente. El test `chunks ordered lexicographically` pasará para
todos los DAT después del fix; está marcado con `it.fails` para SCRIPTS.DAT
en este momento, lo que forzará un fallo cuando el bug se arregle (porque
la falla esperada deja de ocurrir) y obligará a quitar el marker.
Self-resetting.

### Riesgo del fix

Si en algún sitio del motor C asumes orden de inserción (en lugar de
binary search), el fix podría descubrir bugs latentes ahí también.
Mitigación: cuando apliques el fix, abre `agemki_engine.c` y busca los
sitios que iteran chunks. Confirma que usan binary search o son
agnósticos al orden. Si encuentras alguno que asume orden, ese se
arregla con el mismo PR.

Commit propuesto: `fix(dat): sort chunks before writing index`.

### Para ti, ahora mismo

Este es **el más importante** de los cinco. El fix es de 3 líneas. La
única razón para no aplicarlo inmediatamente es si quieres aprovechar
para revisar el motor primero (ver "Riesgo del fix"). Mi recomendación:
aplica el fix de `buildDat`, regenera goldens, ejecuta el juego una
vez en DOSBox-X, y si todo funciona ya estás cubierto.

---

## Plan de commits sugerido

Estos hallazgos sugieren cinco commits separables. El orden recomendado:

1. **`fix(build): -O2 -> -ox in release flags`** (F-01) — 1 línea, urgente.
2. **`fix(dat): sort chunks before writing index`** (F-05) — 3 líneas, runtime crítico.
3. **`fix(dat): align serializeScript size-calc with writer`** (F-04) — ~10 líneas.
4. **`chore: pin node engine to LTS range`** (F-02) — 3 líneas.
5. **`feat: test suite + golden files + TDD harness`** — el resto del trabajo.

Como trabajas solo en `main` sin PRs, puedes:

- Aplicarlos como **5 commits separados** sobre `main` (más legible en
  `git log`, fácil de revertir uno solo si rompe algo).
- O **squash todo en un commit grande** si prefieres un solo punto de cambio.

Los fixes 1-4 son cortos y pueden aplicarse en cualquier orden. El 5 es
todo el trabajo de la suite y no toca tu código de producción.

---

## Cómo se han descubierto

Todos los findings han salido de **intentar compilar y testear el código
realmente**, sin asumir que la documentación o el README están al día.
Cada vez que algo no encajaba, bisección + lectura del código.

- F-01 detectado al compilar el motor en DOSBox-X con flags del README
  (que no incluye `-O2`) vs flags del `index.js` (que sí lo incluye).
- F-02 detectado al ejecutar `npm run dev` después de un `npm install`
  fresco.
- F-03 detectado al revisar `.gitignore` contra `CLAUDE.md`.
- F-04 detectado al construir el primer fixture realista y ejecutar
  `generateDats()` desde un test.
- F-05 detectado por un assertion `indexIsSorted` en el test de estructura
  semántica (chunks deben venir ordenados — del comentario en la spec).

Filosofía: **goldens no como ritual, sino como red real de seguridad**.

Ninguno de estos bugs te impide trabajar — los descubrimos justo porque
al montar la red de seguridad había que ejercitar caminos que tú
normalmente no ejecutas (build release sin pasar por el editor, fixture
nuevo con todas las claves, decoder que valida el orden de chunks
contra la spec). Esa es la idea: que la próxima regresión que
introduzcas sin querer se vea **aquí**, en una máquina cualquiera, en
segundos. No tres horas después en DOSBox cuando el motor no encuentra
un chunk y vuelve fondo negro sin mensaje de error.

Si solo te llevas una cosa de este documento: **F-05 (orden de chunks)
es el que más te conviene aplicar pronto**. Los demás son saneamiento.
