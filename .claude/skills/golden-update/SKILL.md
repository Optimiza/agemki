---
name: golden-update
description: Regenera los goldens del codegen .DAT, muestra el diff resultante y deja todo listo para revisar antes de stagear. Nunca commitea por su cuenta.
---

# Skill `/golden-update`

Cuando el usuario invoca `/golden-update`, sigue estos pasos en orden:

## 1. Verificar working tree

Ejecuta `git status --short` y comprueba que las únicas modificaciones
pendientes son ficheros relacionados con el cambio que justifica regenerar
los goldens (típicamente `src/main/datGenerator.js`, `src/main/sfxGenerator.js`,
`src/main/fontGenerator.js` o `src/main/index.js` y/o algo en `tests/fixtures/`).

Si hay cambios sueltos sin relación, **avisa al usuario** y pregunta si
quiere continuar o stashear primero. No procedas si el árbol está sucio
con cosas no relacionadas.

## 2. Ejecutar codegen y regenerar goldens

```bash
UPDATE_GOLDENS=1 npm test -- tests/golden/
```

Esto:
- Vuelve a invocar `generateDats()` sobre cada fixture en `tests/fixtures/`
- Sobrescribe los `.DAT` y `manifest.json` en `goldens/dat/<fixture>/`
- Actualiza los snapshots de cabecera hex

## 3. Mostrar diff

```bash
git diff --stat -- goldens/
git diff -- goldens/dat/*/manifest.json
```

Resume al usuario los cambios:
- Cuántos `.DAT` cambiaron
- Cuántos bytes ganan/pierden
- Si los SHA-256 del manifest cambiaron, qué chunks se reordenaron o
  resizearon (decoder en `tests/helpers/dat-decode.js` ayuda)

## 4. Verificar que todo el suite pasa con los nuevos goldens

```bash
npm test
```

Si algún test falla tras regenerar, **avisa**: el cambio en el codegen
puede tener efectos colaterales que los goldens enmascaran. Investiga
antes de seguir.

## 5. Esperar confirmación humana antes de stagear

**Nunca** ejecutes `git add goldens/` ni `git commit` por tu cuenta.
Resume el diff, propón un mensaje de commit con el porqué del cambio
(no el qué — el diff lo dice solo) y deja al usuario decidir.

Ejemplo de mensaje propuesto:
```
goldens(dat): regen tras añadir campo X al serializeRoom

El nuevo campo se serializa entre `name` y `backgroundFile`. Los .DAT
crecen 2 bytes por room. Sin impacto en el motor (parsea tamaños
explícitos). Ver F-XX en tests/FINDINGS.md.
```

## 6. Si los goldens no debían cambiar

Si el cambio del usuario en el código fuente *no* debería alterar los
bytes generados, pero los goldens *sí* cambiaron, es señal de:

- Bug nuevo introducido (ej: orden de iteración cambiado).
- Tests semánticos en `tests/golden/dat.test.js` que asumen demasiado.

Para inspeccionar:
```bash
node -e "
const {decodeDat} = require('./tests/helpers/dat-decode.js')
const before = require('fs').readFileSync('/tmp/before.DAT')
const after  = require('fs').readFileSync('goldens/dat/minimal/SCRIPTS.DAT')
console.log('before:', JSON.stringify(decodeDat(before).index, null, 2))
console.log('after:',  JSON.stringify(decodeDat(after).index, null, 2))
"
```

## Reglas absolutas

- **No** modifiques `tests/fixtures/` para hacer pasar los tests. Si los
  goldens fallan por un cambio legítimo en el codegen, regenera los
  goldens. Si fallan por un cambio en los fixtures, regenera **también**
  pero documenta el porqué.
- **No** uses `git add -A` ni `git commit -a`. Stagea sólo los goldens y
  muestra al usuario qué se va a commitear.
- **No** regeneres goldens si el cambio no afecta al codegen (ej: docs,
  tests unitarios de stores). En esos casos, sólo `npm test` debe pasar.
