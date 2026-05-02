---
name: tdd-feature
description: Implementa una feature nueva en modo Test-Driven Development. Detecta el tipo (serializador del codegen, acción de store Zustand, handler IPC, o helper puro) y aplica el playbook adecuado: escribe tests primero (rojo), implementa el mínimo para que pasen (verde), refactor. Usar siempre que el usuario pida añadir una capacidad nueva al lado JS del proyecto.
---

# Skill `/tdd-feature`

Cuando el usuario pide una feature nueva en el lado JS de AGEMKI (codegen,
store, IPC handler o helper), aplicas TDD estricto: tests primero,
implementación mínima, refactor con confianza.

## Cuándo invocar este skill

Detecta cualquiera de estas señales en el mensaje del usuario:

- "Añade…" / "Quiero meter…" / "Implementa…" + algo del lado JS.
- Mención explícita de TDD ("hazlo en TDD", "test-first", "modo TDD").
- Cambios en `src/main/datGenerator.js` o `src/main/index.js` que añadan
  funcionalidad (no fixes ni refactor menor).
- Acciones nuevas en stores Zustand (`src/renderer/src/store/*.js`).

**No** apliques este skill si:

- Es un fix de bug ya documentado en `tests/FINDINGS.md`.
- Es un refactor sin cambio funcional (no hay nada nuevo que testear).
- El cambio es en motor C, scripts shell, configuración o documentación.

## Disciplina TDD (regla absoluta)

1. **Rojo primero, siempre.** El test se escribe ANTES del código. Tras
   escribirlo, ejecútalo y verifica que **falla** por la razón esperada
   (no por sintaxis, no por imports rotos). Si pasa en verde antes de
   implementar, el test está roto — arréglalo o re-escríbelo.
2. **Verde mínimo.** Implementa lo justo para hacer pasar el test. No
   adelantes funcionalidad no testeada. "Lo justo" puede ser tan tonto
   como `return 42` si el test sólo pide eso. El siguiente test te
   forzará a generalizar.
3. **Refactor con red.** Una vez en verde, puedes refactorizar el código
   con la garantía de que el test te avisa si rompes algo.
4. **Una assertion por test** cuando se pueda. Cinco `expect()` juntos
   = probablemente cinco tests con `beforeEach` compartido.
5. **Reset de stores en `beforeEach`** con `makeStoreReset(useStore)`
   de [tests/helpers/store-stubs.js](../../../tests/helpers/store-stubs.js).
6. **Mock IPC con `mockApi({ ... })`** sólo en los métodos que el test
   necesita. El resto sigue devolviendo `{ ok: true }` por defecto.
7. **Tests deterministas**: si el código usa `Date.now()` o `Math.random()`,
   no hagas `expect(id).toBe('foo_1234567890')`. Usa
   `expect(id).toMatch(/^foo_\d+$/)`.
8. **Convención de idioma** — todo el contenido en español
   (descripciones de `describe`/`it`, comentarios, mensajes de error).
   Identificadores de código pueden quedar en inglés (`describe`,
   `expect`, nombres de funciones del propio API).

## Detección del tipo de feature

Antes de escribir nada, identifica qué tipo de feature es preguntando al
usuario o deduciéndolo del contexto:

| Síntoma en el pedido | Tipo | Playbook |
|---|---|---|
| "Nuevo serializador" / "añade tipo X al .DAT" | **codegen serializer** | [§ playbook-serializer](#playbook-serializer) |
| "Nueva acción en sceneStore/scriptStore/..." | **store action** | [§ playbook-store-action](#playbook-store-action) |
| "Handler IPC nuevo" / "que el editor pueda Y" | **IPC handler** | [§ playbook-ipc-handler](#playbook-ipc-handler) |
| Función pura, sin estado ni I/O | **helper** | [§ playbook-helper](#playbook-helper) |

Si dudas entre dos, pregunta al usuario en una línea. No empieces a
escribir tests al tuntún.

---

## Playbook serializer

**Ejemplo de uso:** "Añade un campo `notes` a object.json y serialízalo
en el codegen."

### Pasos

1. **Crea fixture** — añade un fragmento JSON mínimo en
   `tests/fixtures/minimal/<carpeta>/<feature>.json` (o extiende uno
   existente) con el nuevo campo. Si toca el `builder.mjs`, regenera con
   `node tests/fixtures/builder.mjs`.

2. **Crea el test golden** en `tests/golden/<feature>.test.js` con esta
   estructura:

   ```js
   import { describe, it, expect, beforeAll } from 'vitest'
   import { readFileSync } from 'node:fs'
   import { join } from 'node:path'
   import { generateDats } from '../../src/main/datGenerator.js'
   import { decodeDat } from '../helpers/dat-decode.js'
   import { sha256 } from '../helpers/hash.js'

   const FIXTURE = join(__dirname, '../../tests/fixtures/minimal')
   const TMP     = join(__dirname, '../../tmp/<feature>-test')

   let dat
   beforeAll(async () => {
     await generateDats(FIXTURE, TMP, () => {})
     dat = decodeDat(readFileSync(join(TMP, 'SCRIPTS.DAT')))
   })

   describe('serialize<Cosa> — caso feliz', () => {
     it('genera un chunk con resType nuevo', () => {
       const chunk = dat.index.find(c => c.resType === 0x<NUEVO>)
       expect(chunk).toBeDefined()
       expect(chunk.id).toBe('<id_esperado>')
     })

     it('determinismo: dos generaciones consecutivas → mismos bytes', async () => {
       await generateDats(FIXTURE, TMP, () => {})
       const a = readFileSync(join(TMP, 'SCRIPTS.DAT'))
       await generateDats(FIXTURE, TMP, () => {})
       const b = readFileSync(join(TMP, 'SCRIPTS.DAT'))
       expect(sha256(a)).toBe(sha256(b))
     })
   })

   describe('serialize<Cosa> — bordes', () => {
     it('campo opcional ausente → default sin lanzar', () => {
       // ...
     })
   })

   describe('serialize<Cosa> — invariantes', () => {
     it('si elimino el chunk del fixture, el .DAT no lo contiene', () => {
       // ...
     })
   })
   ```

3. **Ejecuta `npm test -- tests/golden/<feature>.test.js`** — debe
   fallar (rojo). Confirma que el error es "chunk no existe", no error
   de sintaxis.

4. **Implementa `serialize<Cosa>`** en `src/main/datGenerator.js`
   siguiendo el patrón de los serializers existentes:
   - `sizeStr8(...)` para pre-calcular el tamaño total
   - `Buffer.alloc(size)` con el tamaño exacto
   - `writeStr8 / writeStr16 / writeBool` para los campos
   - Devuelve `buf.slice(0, off)` para descartar padding

5. **Registra el chunk en `generateDats`** en la sección que toque
   (SCRIPTS.DAT, GRAPHICS.DAT, etc.) usando el nuevo `RES_TYPE.<COSA>`.

6. **Re-ejecuta los tests** — debe pasar (verde).

7. **Regenera goldens existentes** que se hayan visto afectados:
   ```
   UPDATE_GOLDENS=1 npm test -- tests/golden/
   ```
   Revisa el diff con `git diff --stat goldens/` antes de stagear.

8. **Verifica el suite completo**: `npm test`.

### Aviso importante

Si el feature toca `serializeScript` o `buildDat`, ojo con los bugs
documentados en F-04 y F-05 ([tests/FINDINGS.md](../../../tests/FINDINGS.md)).
Si tu feature ejercita un camino que esos bugs cubren, arréglalos primero
o usa workaround temporal en el fixture.

---

## Playbook store-action

**Ejemplo de uso:** "Añade `setRoomTransition(type)` al `sceneStore`
que permita 'fade' / 'wipe' / 'cut'."

### Pasos

1. **Identifica el store afectado** y abre el fichero de tests
   correspondiente: `tests/unit/stores/<store>.test.js`.

2. **Añade un nuevo `describe` block** al final del fichero con la
   acción:

   ```js
   describe('sceneStore — setRoomTransition', () => {
     it('setea el tipo en activeRoom y marca dirty', () => {
       useSceneStore.setState({ activeRoom: sampleRoom(), dirty: false })
       useSceneStore.getState().setRoomTransition('fade')
       const st = useSceneStore.getState()
       expect(st.activeRoom.roomTransition).toBe('fade')
       expect(st.dirty).toBe(true)
     })

     it('rechaza tipos no válidos (mantiene el anterior)', () => {
       useSceneStore.setState({
         activeRoom: { ...sampleRoom(), roomTransition: 'fade' },
       })
       useSceneStore.getState().setRoomTransition('invalid')
       expect(useSceneStore.getState().activeRoom.roomTransition).toBe('fade')
     })

     it('sin activeRoom: no lanza, no muta', () => {
       useSceneStore.getState().setRoomTransition('fade')
       expect(useSceneStore.getState().activeRoom).toBeNull()
     })
   })
   ```

3. **Añade el nombre de la acción** a `tests/unit/stores/all.smoke.test.js`
   en la `actionKeys` del store correspondiente. Si no lo haces, el
   smoke test no detectará si borras la acción por error.

4. **Ejecuta `npm test -- tests/unit/stores/<store>.test.js`** — debe
   fallar (rojo).

5. **Implementa la acción** en `src/renderer/src/store/<store>.js`
   siguiendo el patrón existente:

   ```js
   setRoomTransition: (type) => set(state => {
     if (!state.activeRoom) return {}
     const VALID = ['fade', 'wipe', 'cut']
     if (!VALID.includes(type)) return {}
     return {
       activeRoom: { ...state.activeRoom, roomTransition: type },
       dirty: true,
     }
   }),
   ```

6. **Re-ejecuta los tests** — verde.

7. **Verifica suite completo**: `npm test`.

### Aviso

Si la acción interactúa con otros stores (importa dinámicamente
`localeStore`, etc.), mockea el otro store en el test:

```js
import { useLocaleStore } from '../../../src/renderer/src/store/localeStore.js'
// ...
useLocaleStore.setState({ locales: { es: { ... } } })
```

---

## Playbook ipc-handler

**Ejemplo de uso:** "Quiero un IPC `room:duplicate` que copie una room
con todas sus dependencias."

### Pasos

1. **Refactor previo** (si no existe): los handlers actualmente viven
   inline en `src/main/index.js` con `ipcMain.handle(channel, async fn)`.
   Para testarlos necesitamos extraerlos a un fichero aparte.

   Crea `src/main/handlers/<feature>.js`:

   ```js
   /**
    * Handler IPC <channel>.
    * Recibe { gameDir, ... } y devuelve { ok, ... }.
    *
    * Side effects: filesystem en gameDir.
    * No-throw: errores siempre vuelven en { ok: false, error }.
    */
   import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
   import { join } from 'node:path'

   export async function <feature>Handler(_event, args) {
     // ... lógica
     return { ok: true, /* ... */ }
   }
   ```

   En `src/main/index.js`:

   ```js
   import { <feature>Handler } from './handlers/<feature>.js'
   ipcMain.handle('<channel>', <feature>Handler)
   ```

2. **Crea fichero de tests** en `tests/unit/handlers/<feature>.test.js`
   (crea `tests/unit/handlers/` si no existe):

   ```js
   import { describe, it, expect, beforeEach } from 'vitest'
   import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
   import { join } from 'node:path'
   import { tmpdir } from 'node:os'
   import { <feature>Handler } from '../../../src/main/handlers/<feature>.js'

   let TMP_DIR
   beforeEach(() => {
     TMP_DIR = join(tmpdir(), 'agemki-test-' + Date.now())
     mkdirSync(TMP_DIR, { recursive: true })
   })

   describe('<feature>Handler — caso feliz', () => {
     it('devuelve { ok: true } para input válido', async () => {
       // Arrange: prepara filesystem en TMP_DIR
       const r = await <feature>Handler(null, { gameDir: TMP_DIR, /* ... */ })
       expect(r.ok).toBe(true)
     })

     it('crea los ficheros esperados en disco', async () => {
       await <feature>Handler(null, { gameDir: TMP_DIR, /* ... */ })
       expect(existsSync(join(TMP_DIR, 'expected/file.json'))).toBe(true)
     })
   })

   describe('<feature>Handler — bordes', () => {
     it('gameDir inexistente → { ok: false, error }', async () => {
       const r = await <feature>Handler(null, { gameDir: '/nonexistent/path' })
       expect(r.ok).toBe(false)
       expect(r.error).toBeTruthy()
     })

     it('input inválido → no lanza, devuelve error', async () => {
       const r = await <feature>Handler(null, { gameDir: TMP_DIR })
       expect(r.ok).toBe(false)
     })
   })
   ```

3. **Ejecuta los tests** — debe fallar (rojo).

4. **Implementa el handler**. Usa `node:fs/promises` o sincrónos según el
   estilo del proyecto. Recuerda: **nunca lances**, devuelve siempre
   `{ ok: false, error: '...' }`.

5. **Verde**. `npm test`.

### Aviso

- No registres el handler en `index.js` antes de tener el handler en
  verde. Si lo haces, el editor podría ejecutar código a medias.
- Limpia `TMP_DIR` en `afterEach` con `rmSync(TMP_DIR, { recursive: true, force: true })`.

---

## Playbook helper

**Ejemplo de uso:** "Una función que valide nombres de room
(alfanumérico, 3-32 chars, no empieza por número)."

### Pasos

1. **Crea el fichero del test** en `tests/unit/<area>/<helper>.test.js`:

   ```js
   import { describe, it, expect } from 'vitest'
   import { isValidRoomName } from '../../../src/main/helpers/roomName.js'

   describe('isValidRoomName — caso feliz', () => {
     it.each([
       ['taberna', true],
       ['room_001', true],
       ['Habitación01', true],   // si admites unicode
     ])('%s → %s', (input, expected) => {
       expect(isValidRoomName(input)).toBe(expected)
     })
   })

   describe('isValidRoomName — bordes', () => {
     it.each([
       ['',           false, 'string vacío'],
       ['ab',         false, 'menos de 3 chars'],
       ['1room',      false, 'empieza por número'],
       [null,         false, 'null'],
       [undefined,    false, 'undefined'],
       ['a'.repeat(33), false, 'más de 32 chars'],
     ])('%s → %s (%s)', (input, expected) => {
       expect(isValidRoomName(input)).toBe(expected)
     })
   })

   describe('isValidRoomName — invariantes', () => {
     it('idempotencia: misma input → mismo output', () => {
       const r1 = isValidRoomName('taberna')
       const r2 = isValidRoomName('taberna')
       expect(r1).toBe(r2)
     })

     it('puro: no muta el input', () => {
       const input = { value: 'taberna' }
       isValidRoomName(input.value)
       expect(input.value).toBe('taberna')
     })
   })
   ```

2. **Ejecuta los tests** — debe fallar (rojo, módulo no existe).

3. **Implementa el helper** en `src/main/helpers/<helper>.js`:

   ```js
   /**
    * @param {string} name
    * @returns {boolean}
    */
   export function isValidRoomName(name) {
     if (typeof name !== 'string') return false
     if (name.length < 3 || name.length > 32) return false
     if (/^\d/.test(name)) return false
     return /^[\wÀ-ſ]+$/.test(name)
   }
   ```

4. **Verde**. `npm test`.

5. **Si el helper se usa desde varios sitios**, considera moverlo a
   `tests/helpers/` para que esté disponible también en tests de otros
   stores/serializers.

---

## Cierre del workflow (todos los playbooks)

Después de verde:

1. **Mensaje de commit** — propón uno conciso al usuario:

   ```
   feat(<área>): añade <feature>

   <razón corta>. Tests en tests/<path>/<feature>.test.js cubren
   caso feliz, bordes (X, Y, Z) e invariantes.
   ```

2. **No commitees por tu cuenta**. Muestra el diff con
   `git diff --stat` y deja al usuario confirmar.

3. **Si la feature genera bytes nuevos en `.DAT`** o cambia el shape
   del output del codegen, ejecuta `/golden-update` después.

## Reglas que NO puedes saltarte

- Nunca escribas el código de producción antes que el test.
- Nunca digas "el test pasa" sin haber visto primero "el test falla".
- Nunca uses `expect(true).toBe(true)` como guarda — es un anti-pattern
  que enmascara la ausencia de assertion real.
- Nunca commitees automáticamente — siempre confirmación humana.
- Nunca implementes más de lo que el test pide. Si el usuario quiere
  más capacidades, son tests adicionales.
