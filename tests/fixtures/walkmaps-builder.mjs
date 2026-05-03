/**
 * @fileoverview Builder de fixtures walkmap para los tests de A*.
 *
 * Genera 5 walkmaps deterministas en `tests/fixtures/walkmaps/<name>.bin`
 * con formato binario simple:
 *
 *   bytes 0-1   : w (uint16 LE, max 200 = WM_MAX_W)
 *   bytes 2-3   : h (uint16 LE, max  20 = WM_MAX_H)
 *   bytes 4+    : w*h bytes  (1 = walkable, 0 = block)
 *
 * Run:
 *   node tests/fixtures/walkmaps-builder.mjs
 *
 * Los 5 walkmaps cubren los casos típicos:
 *   - room_open:           40x18 todo walkable (ruta directa)
 *   - room_with_obstacle:  40x18 con un rect bloqueando el centro
 *   - corridor_l:          40x18 con forma de L
 *   - maze_simple:         40x18 con dos pasillos paralelos y un cruce
 *   - disconnected:        40x18 con barrera vertical completa (sin ruta posible)
 *
 * Total ~50 casos de A* (10 por walkmap) generan goldens en
 * `goldens/engine/astar/manifest.json`.
 */
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR   = join(__dirname, 'walkmaps')

const W = 40, H = 18  // 320x144 / 8

function emptyMap() {
  return new Uint8Array(W * H).fill(1)  // todo walkable
}

function blockRect(map, x, y, w, h) {
  for (let gy = y; gy < y + h && gy < H; gy++) {
    for (let gx = x; gx < x + w && gx < W; gx++) {
      map[gy * W + gx] = 0
    }
  }
}

function blockCol(map, x, y0 = 0, y1 = H) {
  for (let gy = y0; gy < y1; gy++) map[gy * W + x] = 0
}

function blockRow(map, y, x0 = 0, x1 = W) {
  for (let gx = x0; gx < x1; gx++) map[y * W + gx] = 0
}

function serialize(name, map) {
  const buf = Buffer.alloc(4 + map.length)
  buf.writeUInt16LE(W, 0)
  buf.writeUInt16LE(H, 2)
  Buffer.from(map.buffer).copy(buf, 4)
  writeFileSync(join(OUT_DIR, name + '.bin'), buf)
  return { name, w: W, h: H, walkable: map.filter(v => v).length, blocked: map.filter(v => !v).length }
}

// ── Generación ────────────────────────────────────────────────────────────

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const built = []

// 1. Room totalmente abierta (ruta directa siempre).
{
  const m = emptyMap()
  built.push(serialize('room_open', m))
}

// 2. Room con un obstáculo rectangular en el centro (12x6).
{
  const m = emptyMap()
  blockRect(m, 14, 6, 12, 6)   // bloque centrado
  built.push(serialize('room_with_obstacle', m))
}

// 3. Pasillo en forma de L: solo se camina por la fila inferior + columna
//    derecha (resto bloqueado). Forzosamente A* tiene que doblar.
{
  const m = new Uint8Array(W * H).fill(0)  // todo bloqueado por defecto
  // Fila inferior caminable (y = H-2)
  for (let gx = 0; gx < W; gx++) m[(H - 2) * W + gx] = 1
  // Columna derecha (x = W-2)
  for (let gy = 0; gy < H; gy++) m[gy * W + (W - 2)] = 1
  built.push(serialize('corridor_l', m))
}

// 4. Maze simple: dos pasillos horizontales + dos verticales que conectan
//    en un patrón #-shape. Múltiples rutas posibles.
{
  const m = new Uint8Array(W * H).fill(0)  // todo bloqueado
  // Pasillo horizontal superior (y = 4) e inferior (y = 13)
  for (let gx = 0; gx < W; gx++) {
    m[4 * W + gx]  = 1
    m[13 * W + gx] = 1
  }
  // Pasillo vertical izquierdo (x = 8) y derecho (x = 30)
  for (let gy = 0; gy < H; gy++) {
    m[gy * W + 8]  = 1
    m[gy * W + 30] = 1
  }
  built.push(serialize('maze_simple', m))
}

// 5. Walkmap desconectado: barrera vertical completa en x=20.
//    Caminos entre el lado izquierdo y derecho son imposibles.
{
  const m = emptyMap()
  blockCol(m, 20)  // pared entera
  built.push(serialize('disconnected', m))
}

// ── Resumen ──────────────────────────────────────────────────────────────
console.log(`walkmaps generados en ${OUT_DIR}:`)
for (const w of built) {
  console.log(`  ${w.name.padEnd(20)} ${w.w}x${w.h}  walkable=${w.walkable.toString().padStart(4)}  blocked=${w.blocked.toString().padStart(4)}`)
}
