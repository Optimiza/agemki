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
 * Ejecuta `runner pcx_decode <pcxFile>` y devuelve la imagen decodificada.
 * @param {string} pcxFile  ruta absoluta al fichero .PCX
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function runnerPcxDecode(pcxFile) {
  // El runner emite "W H N\n" + N bytes raw del buffer.
  const out = execFileSync(RUNNER_PATH, ['pcx_decode', pcxFile], { encoding: null })
  // Buscar el primer \n para separar header del payload.
  const nlIdx = out.indexOf(0x0A)
  if (nlIdx < 0) throw new Error('runner pcx_decode: stdout sin newline')
  const header = out.slice(0, nlIdx).toString('ascii')
  const [w, h, n] = header.trim().split(/\s+/).map(Number)
  const pixels = out.slice(nlIdx + 1, nlIdx + 1 + n)
  if (pixels.length !== n) {
    throw new Error(`runner pcx_decode: payload corto (got ${pixels.length}, expected ${n})`)
  }
  return { width: w, height: h, pixels: Buffer.from(pixels) }
}

/**
 * Drift detection genérico: extrae una función del motor real y la
 * compara byte-a-byte con la copia local. Soporta múltiples funciones
 * pasando regex distintas.
 *
 * @param {string} motorPath   ruta absoluta al .c del motor
 * @param {string} copyPath    ruta absoluta al .c del subset host
 * @param {RegExp} fnRegex     regex que captura el cuerpo de la función
 * @returns {{ ok: boolean, motor?: string, copy?: string, error?: string }}
 */
function detectFunctionDrift(motorPath, copyPath, fnRegex) {
  if (!existsSync(motorPath) || !existsSync(copyPath)) {
    return { ok: false, error: `falta ${motorPath} o ${copyPath}` }
  }
  const motorSrc = readFileSync(motorPath, 'utf8')
  const copySrc  = readFileSync(copyPath, 'utf8')

  const motorMatch = motorSrc.match(fnRegex)
  if (!motorMatch) return { ok: false, error: `no encontré la función en ${motorPath}` }
  const copyMatch = copySrc.match(fnRegex)
  if (!copyMatch) return { ok: false, error: `no encontré la función en ${copyPath}` }

  return { ok: motorMatch[0] === copyMatch[0], motor: motorMatch[0], copy: copyMatch[0] }
}

/**
 * Drift detection: extrae la función `_sfx_crc32` del motor real y la
 * compara con la copia que vive en `tests/engine_host/lib/crc32.c`.
 *
 * Si Javi cambia el motor, este test rojo nos avisa y forzamos sincronizar
 * la copia. Sin esto, podríamos testear un CRC32 que difiere del que el
 * motor usa en runtime.
 *
 * @returns {{ ok: boolean, motor?: string, copy?: string, error?: string }}
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

/**
 * Drift detection: extrae la sección RLE de `_pcx_decode` del motor y la
 * compara con la sección RLE de `ag_test_pcx_decode` en lib/pcx_decode.c.
 *
 * Comparamos solo la lógica RLE (líneas 995-1034 del motor / equivalente
 * en la copia), no la sección de paleta VGA que está intencionalmente
 * fuera del subset host (toca `outp` y globals).
 *
 * @returns {{ ok: boolean, motor?: string, copy?: string, error?: string }}
 */
export function detectPcxDecodeDrift() {
  const motorPath = join(REPO_ROOT, 'resources', 'engine', 'agemki_engine.c')
  const copyPath  = join(ENGINE_HOST_DIR, 'lib', 'pcx_decode.c')
  if (!existsSync(motorPath) || !existsSync(copyPath)) {
    return { ok: false, error: 'falta agemki_engine.c o lib/pcx_decode.c' }
  }
  const motorSrc = readFileSync(motorPath, 'utf8')
  const copySrc  = readFileSync(copyPath, 'utf8')

  // Sección RLE del motor: empieza en "/* Decodificar RLE con stride = w real"
  // y acaba antes del "/* Aplicar paleta EGA" (la parte que NO copiamos).
  const motorRleRe = /\/\* Decodificar RLE con stride = w real[\s\S]*?dst_pos = row_start \+ w;\s*\}/
  const motorMatch = motorSrc.match(motorRleRe)
  if (!motorMatch) return { ok: false, error: 'no encontré sección RLE en motor' }
  const copyMatch = copySrc.match(motorRleRe)
  if (!copyMatch) return { ok: false, error: 'no encontré sección RLE en copia' }

  return { ok: motorMatch[0] === copyMatch[0], motor: motorMatch[0], copy: copyMatch[0] }
}

/**
 * Decodifica un PCX en JS puro (referencia para validar la del motor).
 * Implementa el mismo algoritmo RLE que `_pcx_decode`.
 * @param {Buffer} src
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function jsPcxDecode(src) {
  if (src[0] !== 0x0A) throw new Error('PCX magic inválido')
  const xmin = src.readUInt16LE(4),  ymin = src.readUInt16LE(6)
  const xmax = src.readUInt16LE(8),  ymax = src.readUInt16LE(10)
  const w   = xmax - xmin + 1
  const h   = ymax - ymin + 1
  const bpl = src.readUInt16LE(66)
  const dst = Buffer.alloc(w * h)

  let rlePos = 128
  let dstPos = 0
  for (let row = 0; row < h; row++) {
    const rowStart = dstPos
    let col = 0
    while (col < bpl) {
      if (rlePos >= src.length) break
      let b = src[rlePos++]
      let count
      if ((b & 0xC0) === 0xC0) {
        count = b & 0x3F
        if (rlePos >= src.length) break
        b = src[rlePos++]
      } else {
        count = 1
      }
      while (count-- > 0 && col < bpl) {
        if (col < w) dst[dstPos++] = b
        col++
      }
    }
    dstPos = rowStart + w
  }
  return { width: w, height: h, pixels: dst }
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
