/**
 * build.mjs — compila el runner host de tests con clang, cross-platform.
 *
 * Por qué Node y no Make: Windows no tiene make nativo y queremos que el
 * suite corra idéntico en mac/win sin instalar MSYS2. clang sí está
 * disponible cross-platform (LLVM oficial).
 *
 * Uso:
 *   node tests/engine_host/build.mjs        # compila si fuente cambió
 *   node tests/engine_host/build.mjs --force # recompila siempre
 *   node tests/engine_host/build.mjs --check # solo verifica clang disponible
 *
 * Output: tests/engine_host/runner (mac/linux) o runner.exe (win).
 *
 * Salidas:
 *   exit 0  → compilado, listo para ejecutar
 *   exit 2  → clang no disponible (skipear los tests engine_host)
 *   exit 1  → error de compilación (test FAIL)
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HERE = __dirname

// ── Detectar clang (mac, win, linux) ──────────────────────────────────────
function findClang() {
  // Probar simplemente "clang" en PATH (más portable)
  const r = spawnSync('clang', ['--version'], { encoding: 'utf8' })
  if (r.status === 0) return 'clang'
  return null
}

const clang = findClang()
if (process.argv.includes('--check')) {
  if (clang) { console.log('clang OK:', clang); process.exit(0) }
  else      { console.error('clang no disponible en PATH');   process.exit(2) }
}

if (!clang) {
  console.error('build.mjs: clang no disponible. Salta tests engine_host.')
  console.error('  macOS:   instala Xcode Command Line Tools (xcode-select --install)')
  console.error('  Windows: instala LLVM (https://releases.llvm.org/) o MSYS2')
  console.error('  Linux:   apt/yum install clang')
  process.exit(2)
}

// ── Recolectar fuentes ────────────────────────────────────────────────────
const sources = []
for (const f of readdirSync(join(HERE, 'lib'))) {
  if (f.endsWith('.c')) sources.push(join(HERE, 'lib', f))
}
sources.push(join(HERE, 'runner.c'))

// ── Output binary (con extensión adecuada al OS) ──────────────────────────
const exe = process.platform === 'win32' ? 'runner.exe' : 'runner'
const exePath = join(HERE, exe)

// ── Decisión rebuild ──────────────────────────────────────────────────────
const force = process.argv.includes('--force')
let needsRebuild = force || !existsSync(exePath)
if (!needsRebuild) {
  const exeMtime = statSync(exePath).mtimeMs
  for (const s of sources) {
    if (statSync(s).mtimeMs > exeMtime) { needsRebuild = true; break }
  }
}

if (!needsRebuild) {
  // Ya estamos al día.
  process.exit(0)
}

// ── Compilar y enlazar de un golpe ────────────────────────────────────────
// Flags conservadores: c89 (alineado con el motor), warnings altos pero sin
// -Werror (algún warning legítimo en el motor portado no debería bloquear).
const flags = [
  '-std=c89', '-O0', '-g',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  '-DAGEMKI_HOST_TEST',
  '-I', join(HERE, 'include'),
]

try {
  execFileSync(clang, [...flags, ...sources, '-o', exePath], { stdio: 'inherit' })
} catch (err) {
  console.error('build.mjs: clang falló')
  process.exit(1)
}

console.log('build.mjs: ok →', exePath)
process.exit(0)
