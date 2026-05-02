#!/bin/sh
# Hook PostToolUse: ejecuta los tests del área editada cuando Claude Code
# modifica un fichero. Reporta resultado a stderr (visible como tool feedback).
#
# Reglas:
#   - Edición en src/main/(datGenerator|sfxGenerator|fontGenerator|index).js
#       → npm test -- tests/golden/
#   - Edición en src/renderer/src/store/*.js
#       → npm test -- tests/unit/stores/
#   - Edición en resources/engine/*.c|*.h
#       → make -C tests/engine_host run     (sólo si existe — Phase 3a)
#   - Cualquier otro fichero → noop (exit 0).
#
# Diseño:
#   - Nunca bloquea el edit (exit 0 siempre).
#   - Sólo emite output a stderr si los tests fallan, para no inundar el
#     transcript con OK silenciosos.
#   - Lee el JSON del hook por stdin (Claude Code envía
#     { tool_name, tool_input: { file_path, ... }, ... }).
#   - Si node no está disponible o el fichero no encaja en las reglas, sale
#     limpio sin tocar nada.

# Sin `set -e`: necesitamos capturar el exit code de npm test sin que el
# script aborte al primer fallo.

# Leer stdin del hook
JSON=$(cat 2>/dev/null || true)
if [ -z "$JSON" ]; then exit 0; fi

# Extraer file_path con node (más robusto que grep/sed)
PATH_EDITED=$(printf '%s' "$JSON" | node -e '
let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
  try { const d = JSON.parse(s); console.log((d.tool_input || {}).file_path || ""); }
  catch { console.log(""); }
})' 2>/dev/null || echo "")

if [ -z "$PATH_EDITED" ]; then exit 0; fi

# Ir a la raíz del proyecto
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

# Decidir filtro según el área
case "$PATH_EDITED" in
  */src/main/datGenerator.js|*/src/main/sfxGenerator.js|*/src/main/fontGenerator.js|*/src/main/index.js)
    AREA="codegen"
    FILTER="tests/golden/"
    ;;
  */src/renderer/src/store/*.js)
    AREA="stores"
    FILTER="tests/unit/stores/"
    ;;
  */tests/fixtures/*|*/tests/helpers/*)
    AREA="fixtures+helpers"
    FILTER="tests/"
    ;;
  */resources/engine/*.c|*/resources/engine/*.h)
    AREA="engine"
    if [ -f tests/engine_host/Makefile ]; then
      OUT=$(make -C tests/engine_host run 2>&1)
      EXIT=$?
      if [ $EXIT -ne 0 ]; then
        echo "[hook] engine host tests FAIL:" >&2
        echo "$OUT" | tail -20 >&2
      fi
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac

# Ejecutar vitest sobre el filtro elegido
OUT=$(npm test -- "$FILTER" 2>&1)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "[hook] tests $AREA FAIL — $PATH_EDITED" >&2
  echo "$OUT" | tail -20 >&2
fi

exit 0
