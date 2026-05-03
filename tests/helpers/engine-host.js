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
 *
 * El runner emite "W H N\n<hex de N bytes>\n". El hex es para evitar
 * la translation LF→CRLF de stdout en Windows que corrompía bytes 0x0A.
 *
 * @param {string} pcxFile  ruta absoluta al fichero .PCX
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function runnerPcxDecode(pcxFile) {
  const out = execFileSync(RUNNER_PATH, ['pcx_decode', pcxFile], { encoding: 'utf8' })
  const lines = out.split('\n')
  if (lines.length < 2) throw new Error('runner pcx_decode: salida con menos de 2 líneas')
  const [w, h, n] = lines[0].trim().split(/\s+/).map(Number)
  const hex = lines[1].trim()
  if (hex.length !== n * 2) {
    throw new Error(`runner pcx_decode: hex length ${hex.length} != 2*N (${2*n})`)
  }
  const pixels = Buffer.from(hex, 'hex')
  if (pixels.length !== n) {
    throw new Error(`runner pcx_decode: pixels decoded ${pixels.length} != ${n}`)
  }
  return { width: w, height: h, pixels }
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
 * Drift detection del bloque A*: extrae las 4 funciones del motor
 * (`_walk_passable`, `_snap_walkable`, `_heuristic`, `engine_astar`)
 * desde `agemki_engine.c` y las compara byte-a-byte con la copia local
 * en `tests/engine_host/lib/astar.c`.
 *
 * Por qué bloque y no función a función: las cuatro viven contiguas en
 * el motor (líneas 1097-1214) y se copiaron juntas. Comparar el bloque
 * entero detecta cualquier reordenamiento o cambio interno con un solo
 * regex y un solo error legible.
 *
 * @returns {{ ok: boolean, motor?: string, copy?: string, error?: string }}
 */
export function detectAstarDrift() {
  const motorPath = join(REPO_ROOT, 'resources', 'engine', 'agemki_engine.c')
  const copyPath  = join(ENGINE_HOST_DIR, 'lib', 'astar.c')
  // Bloque desde la firma de _walk_passable hasta el cierre de engine_astar
  // (línea con un único "}" que cierra el último return). Usamos un regex
  // codicioso pero acotado a la firma final para no engullir nada más.
  const re = /static int _walk_passable\(int gx, int gy\) \{[\s\S]*?\n\}\s*\n(?=\/\* ── Wrappers|\/\* =====|$)/
  return detectFunctionDrift(motorPath, copyPath, re)
}

/**
 * Ejecuta `runner astar <walkmap> <sx> <sy> <tx> <ty>` y devuelve la ruta
 * cruda parseada. Si no hay ruta devuelve { len: 0, points: [], raw: '0' }.
 *
 * Formato del runner: una sola línea `N|x1,y1|x2,y2|…|xN,yN\n`.
 * El campo `raw` es la stdout sin newline final — útil para hashearla
 * directamente (los goldens guardan SHA-256 de `raw` para detectar
 * cualquier desviación, incluyendo orden de waypoints).
 *
 * @param {string} walkmapFile  ruta absoluta al .bin
 * @param {number} sx @param {number} sy @param {number} tx @param {number} ty
 * @returns {{ len: number, points: Array<[number, number]>, raw: string }}
 */
export function runnerAstar(walkmapFile, sx, sy, tx, ty) {
  const out = execFileSync(RUNNER_PATH,
    ['astar', walkmapFile, String(sx), String(sy), String(tx), String(ty)],
    { encoding: 'utf8' })
  return parseAstarLine(out.trim())
}

/**
 * Versión batch: pasa N casos por stdin como `<walkmap> <sx> <sy> <tx> <ty>`
 * (uno por línea). Recibe N rutas en el mismo orden. El runner cachea el
 * último walkmap_path para no recargar el binario entre casos consecutivos
 * con el mismo mapa, lo que reduce ~5x el coste sobre 50 casos.
 *
 * @param {Array<{ walkmap: string, sx: number, sy: number, tx: number, ty: number }>} cases
 * @returns {Array<{ len: number, points: Array<[number, number]>, raw: string }>}
 */
export function runnerAstarBatch(cases) {
  const stdin = cases.map(c =>
    `${c.walkmap} ${c.sx} ${c.sy} ${c.tx} ${c.ty}`
  ).join('\n') + '\n'
  const out = execFileSync(RUNNER_PATH, ['astar_batch'], { input: stdin, encoding: 'utf8' })
  const lines = out.split('\n').filter(l => l.length > 0)
  if (lines.length !== cases.length) {
    throw new Error(`runner astar_batch: esperaba ${cases.length} líneas, recibí ${lines.length}`)
  }
  return lines.map(parseAstarLine)
}

function parseAstarLine(raw) {
  // raw = "N|x1,y1|x2,y2|…|xN,yN" o "0"
  const parts = raw.split('|')
  const len = Number.parseInt(parts[0], 10)
  if (!Number.isFinite(len)) throw new Error(`runner astar: línea malformada: ${raw}`)
  const points = parts.slice(1).map(p => {
    const [x, y] = p.split(',').map(n => Number.parseInt(n, 10))
    return [x, y]
  })
  if (points.length !== len) {
    throw new Error(`runner astar: len=${len} pero parseé ${points.length} waypoints (raw=${raw})`)
  }
  return { len, points, raw }
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
