#!/usr/bin/env node
/**
 * Hook PostToolUse cross-platform (macOS / Windows / Linux).
 *
 * Ejecuta los tests del área editada cuando Claude Code modifica un fichero.
 * Reporta a stderr solo si los tests fallan (cero ruido en éxito).
 *
 * Reglas (path matching es agnóstico al separador de OS):
 *   - src/main/(datGenerator|sfxGenerator|fontGenerator|index).js
 *       → npm test -- tests/golden/
 *   - src/renderer/src/store/*.js
 *       → npm test -- tests/unit/stores/
 *   - tests/fixtures/* o tests/helpers/*
 *       → npm test (toda la suite, los helpers afectan a varias áreas)
 *   - resources/engine/*.c|*.h
 *       → reservado para Phase 3a (motor host con clang)
 *   - Cualquier otro fichero → noop, exit 0.
 *
 * Diseño:
 *   - Nunca bloquea el edit (siempre exit 0).
 *   - Lee el JSON del hook por stdin: { tool_name, tool_input: { file_path } }.
 *   - Detecta plataforma vía process.platform si hace falta (no hace falta
 *     en este hook: npm y node funcionan idénticos en mac/win/linux).
 *
 * Por qué Node y no bash: para que funcione en Windows sin Git Bash. Node es
 * dependencia obligatoria del proyecto (engines.node en package.json), así que
 * no añade requisito nuevo.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Leer stdin (JSON del hook) ────────────────────────────────────────────────
let raw = ''
try {
  // readFileSync('/dev/stdin') no funciona en Windows. Usamos lectura síncrona
  // del fd 0 con buffer fijo (suficiente: el JSON del hook nunca pasa de unos KB).
  const chunk = Buffer.alloc(64 * 1024)
  let total = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let read
    try { read = readFileSync(0, { length: chunk.length - total, encoding: null }) }
    catch { break }
    if (!read || read.length === 0) break
    raw = read.toString('utf8')
    break  // readFileSync(0) lee todo de golpe en una sola llamada en práctica
  }
} catch { /* sin stdin → noop */ }

if (!raw.trim()) process.exit(0)

let payload
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const filePath = payload?.tool_input?.file_path || ''
if (!filePath) process.exit(0)

// ── Localizar la raíz del repo (relativo al hook) ─────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

// ── Normalizar el path para que el matcher sea OS-agnóstico ───────────────────
// En Windows los paths llegan con \. Convertimos a / para usar regex sencillas.
const norm = filePath.replace(/\\/g, '/')

// ── Decidir filtro por área ───────────────────────────────────────────────────
let area = null
let filter = null

if (/\/src\/main\/(datGenerator|sfxGenerator|fontGenerator|index)\.js$/.test(norm)) {
  area = 'codegen'
  filter = 'tests/golden/'
} else if (/\/src\/renderer\/src\/store\/[^/]+\.js$/.test(norm)) {
  area = 'stores'
  filter = 'tests/unit/stores/'
} else if (/\/tests\/(fixtures|helpers)\//.test(norm)) {
  area = 'fixtures+helpers'
  filter = 'tests/'
} else if (/\/resources\/engine\/[^/]+\.[ch]$/.test(norm)) {
  // Phase 3a: motor host. No implementado todavía.
  const makefile = join(REPO_ROOT, 'tests', 'engine_host', 'Makefile')
  if (existsSync(makefile)) {
    runEngineHost()
  }
  process.exit(0)
} else {
  // Path no relevante para tests
  process.exit(0)
}

// ── Ejecutar npm test con el filtro ───────────────────────────────────────────
// `npm test --` pasa los argumentos siguientes a vitest. El comportamiento es
// idéntico en Windows y Unix (npm normaliza el shell).
try {
  execSync(`npm test -- ${filter}`, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  // Tests pasaron. No emitimos nada (cero ruido en éxito).
} catch (err) {
  const stdout = err.stdout?.toString('utf8') || ''
  const stderr = err.stderr?.toString('utf8') || ''
  const combined = (stdout + stderr).split('\n').slice(-25).join('\n')
  process.stderr.write(`[hook] tests ${area} FAIL — ${filePath}\n`)
  process.stderr.write(combined + '\n')
}

process.exit(0)

// ── Phase 3a placeholder ──────────────────────────────────────────────────────
function runEngineHost() {
  try {
    execSync('make -C tests/engine_host run', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
  } catch (err) {
    const stdout = err.stdout?.toString('utf8') || ''
    const stderr = err.stderr?.toString('utf8') || ''
    const combined = (stdout + stderr).split('\n').slice(-20).join('\n')
    process.stderr.write('[hook] engine host tests FAIL:\n')
    process.stderr.write(combined + '\n')
  }
}
