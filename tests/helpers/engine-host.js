/**
 * @fileoverview Helpers para los tests del motor host.
 *
 * Compila el runner C con clang via build.mjs e invoca tests específicos
 * leyendo stdout. Si clang no está disponible, los tests se skipean (no
 * fallan) — útil para máquinas sin Xcode CLT / LLVM.
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const ENGINE_HOST_DIR = join(REPO_ROOT, 'tests', 'engine_host')
const RUNNER_NAME = process.platform === 'win32' ? 'runner.exe' : 'runner'
const RUNNER_PATH = join(ENGINE_HOST_DIR, RUNNER_NAME)
const BUILD_MJS = join(ENGINE_HOST_DIR, 'build.mjs')

let _buildState = null   // null = no probado; 'ok' | 'no-clang' | 'fail'

/**
 * Asegura que el runner está compilado. Llamar al inicio del test suite
 * (en `beforeAll`) para no recompilar en cada test.
 *
 * @returns {{ status: 'ok' | 'no-clang' | 'fail', error?: string }}
 */
export function ensureRunnerBuilt() {
  if (_buildState !== null) return _buildState

  const r = spawnSync('node', [BUILD_MJS], { encoding: 'utf8', cwd: REPO_ROOT })
  if (r.status === 0) {
    _buildState = { status: 'ok' }
  } else if (r.status === 2) {
    _buildState = { status: 'no-clang', error: r.stderr }
  } else {
    _buildState = { status: 'fail', error: r.stderr || r.stdout }
  }
  return _buildState
}

/**
 * Ejecuta `runner crc32 <string>` y devuelve el hash como BigInt-safe number.
 * @param {string} input
 * @returns {number} CRC32 unsigned 32-bit
 */
export function runnerCrc32(input) {
  const out = execFileSync(RUNNER_PATH, ['crc32', input], { encoding: 'utf8' })
  return Number.parseInt(out.trim(), 16) >>> 0
}

/**
 * Versión batch: pasa N strings por stdin, recibe N hashes.
 * Mucho más rápida que llamar runnerCrc32 N veces (un solo proceso).
 * @param {string[]} inputs
 * @returns {number[]}
 */
export function runnerCrc32Batch(inputs) {
  const stdin = inputs.join('\n') + '\n'
  const out = execFileSync(RUNNER_PATH, ['crc32_batch'], { input: stdin, encoding: 'utf8' })
  return out.trim().split('\n').map(line => Number.parseInt(line, 16) >>> 0)
}

/**
 * Drift detection: extrae la función `_sfx_crc32` del motor real y la
 * compara con la copia que vive en `tests/engine_host/lib/crc32.c`.
 *
 * Si Javi cambia el motor, este test rojo nos avisa y forzamos sincronizar
 * la copia. Sin esto, podríamos testear un CRC32 que difiere del que el
 * motor usa en runtime.
 *
 * @returns {{ ok: boolean, motor?: string, copy?: string }}
 */
export function detectCrc32Drift() {
  const motorPath = join(REPO_ROOT, 'resources', 'engine', 'agemki_audio.c')
  const copyPath  = join(ENGINE_HOST_DIR, 'lib', 'crc32.c')
  if (!existsSync(motorPath) || !existsSync(copyPath)) {
    return { ok: false, error: 'falta agemki_audio.c o lib/crc32.c' }
  }
  const motorSrc = readFileSync(motorPath, 'utf8')
  const copySrc  = readFileSync(copyPath, 'utf8')

  // Extraer la función del motor: desde "static unsigned long _sfx_crc32"
  // hasta el primer "}" en columna 0 que cierra la función.
  const motorMatch = motorSrc.match(/static unsigned long _sfx_crc32\(const char\* s\) \{[\s\S]*?\n\}/)
  if (!motorMatch) {
    return { ok: false, error: 'no encontré _sfx_crc32 en agemki_audio.c' }
  }
  const motorFn = motorMatch[0]

  // Misma extracción en la copia
  const copyMatch = copySrc.match(/static unsigned long _sfx_crc32\(const char\* s\) \{[\s\S]*?\n\}/)
  if (!copyMatch) {
    return { ok: false, error: 'no encontré _sfx_crc32 en lib/crc32.c' }
  }
  const copyFn = copyMatch[0]

  return { ok: motorFn === copyFn, motor: motorFn, copy: copyFn }
}

// JS reference impl (copiada de sfxGenerator.js para usar como golden)
const _JS_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

/**
 * Implementación CRC32 en JS (algoritmo idéntico a sfxGenerator.js y
 * datGenerator.js). Sirve como golden para validar la del motor.
 * @param {string} str
 * @returns {number}
 */
export function jsCrc32(str) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < str.length; i++)
    c = _JS_TABLE[(c ^ str.charCodeAt(i)) & 0xFF] ^ (c >>> 8)
  return ((c ^ 0xFFFFFFFF) >>> 0)
}
