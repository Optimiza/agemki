/**
 * @fileoverview Tests del pathfinding A* del motor compilado en host (Sub 2.3).
 *
 * El motor resuelve A* en `agemki_engine.c::engine_astar` (líneas 1124-1214)
 * más tres helpers contiguos (_walk_passable, _snap_walkable, _heuristic).
 * Las cuatro viven en `tests/engine_host/lib/astar.c` como copia byte-exact.
 *
 * Tres niveles de garantía (mismo patrón que Sub 2.2 PCX):
 *   1. Drift: el bloque A* en lib/astar.c sigue byte-exact con el del motor.
 *   2. Comportamiento: ~50 casos sintéticos verifican propiedades obvias
 *      (ruta existe / no existe, longitud razonable, primer y último
 *      waypoint coherentes con start/target tras snap).
 *   3. Goldens deterministas: cada caso guarda { len, sha256 } del raw del
 *      runner. Cualquier cambio en el algoritmo (orden de expansión, tie
 *      breaking, costos) altera el SHA-256 y rompe el test inmediatamente.
 *
 * Los walkmaps los genera `tests/fixtures/walkmaps-builder.mjs` (5 mapas
 * de 40x18 celdas con WALKMAP_CELL_SIZE=8 → 320x144 pixeles, exactamente
 * la dimensión del viewport del motor).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureRunnerBuilt, runnerAstarBatch, detectAstarDrift,
} from '../helpers/engine-host.js'
import { sha256 } from '../helpers/hash.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const WM_DIR    = join(REPO_ROOT, 'tests', 'fixtures', 'walkmaps')
const GOLDEN_DIR = join(REPO_ROOT, 'goldens', 'engine', 'astar')
const MANIFEST_PATH = join(GOLDEN_DIR, 'manifest.json')

const buildState = ensureRunnerBuilt()
const noClang    = buildState.status !== 'ok'
const UPDATE     = process.env.UPDATE_GOLDENS === '1'

const wm = (name) => join(WM_DIR, `${name}.bin`)

/* 50 casos agrupados por walkmap. Las propiedades de cada uno (`reachable`,
 * `lenMin`/`lenMax`) son afirmaciones independientes del algoritmo: sirven
 * para que los tests fallen con un error LEGIBLE si el motor pierde la
 * capacidad de encontrar rutas, no solo si cambia el SHA. */
const CASES = [
  // ── room_open: 40x18 todo walkable ──────────────────────────────────────
  { id: 'room_open/diag-tl-br',   walkmap: 'room_open', sx:   4, sy:   4, tx: 316, ty: 140, reachable: true,  lenMin: 18, lenMax: 60 },
  { id: 'room_open/horiz',        walkmap: 'room_open', sx:   4, sy:  72, tx: 316, ty:  72, reachable: true,  lenMin: 30, lenMax: 50 },
  { id: 'room_open/vert',         walkmap: 'room_open', sx: 160, sy:   4, tx: 160, ty: 140, reachable: true,  lenMin: 14, lenMax: 25 },
  { id: 'room_open/short-step',   walkmap: 'room_open', sx:   4, sy:   4, tx:  12, ty:   4, reachable: true,  lenMin:  2, lenMax:  3 },
  { id: 'room_open/degenerate',   walkmap: 'room_open', sx:  40, sy:  40, tx:  40, ty:  40, reachable: true,  lenMin:  1, lenMax:  1 },
  { id: 'room_open/quarter-q',    walkmap: 'room_open', sx:  80, sy:  36, tx: 240, ty: 108, reachable: true,  lenMin: 18, lenMax: 30 },
  { id: 'room_open/anti-diag',    walkmap: 'room_open', sx: 316, sy:   4, tx:   4, ty: 140, reachable: true,  lenMin: 30, lenMax: 50 },
  { id: 'room_open/mid-tiny',     walkmap: 'room_open', sx: 152, sy:  68, tx: 168, ty:  76, reachable: true,  lenMin:  2, lenMax:  4 },
  { id: 'room_open/clamp-oob',    walkmap: 'room_open', sx: -100, sy:  72, tx: 1000, ty:  72, reachable: true, lenMin: 30, lenMax: 50 },
  { id: 'room_open/half-diag',    walkmap: 'room_open', sx:  60, sy:  60, tx: 260, ty: 100, reachable: true,  lenMin: 18, lenMax: 30 },

  // ── room_with_obstacle: bloque 12x6 cells (pixels 112..208 × 48..96) ────
  { id: 'obs/around-h',           walkmap: 'room_with_obstacle', sx:  40, sy:  72, tx: 280, ty:  72, reachable: true, lenMin: 28, lenMax: 50 },
  { id: 'obs/diag-through',       walkmap: 'room_with_obstacle', sx:  40, sy:  40, tx: 280, ty: 108, reachable: true, lenMin: 24, lenMax: 50 },
  { id: 'obs/above-block',        walkmap: 'room_with_obstacle', sx:  40, sy:  20, tx: 280, ty:  20, reachable: true, lenMin: 28, lenMax: 40 },
  { id: 'obs/below-block',        walkmap: 'room_with_obstacle', sx:  40, sy: 120, tx: 280, ty: 120, reachable: true, lenMin: 28, lenMax: 40 },
  { id: 'obs/start-in-block',     walkmap: 'room_with_obstacle', sx: 160, sy:  76, tx:  40, ty:  40, reachable: true, lenMin: 12, lenMax: 30 },
  { id: 'obs/corner-detour',      walkmap: 'room_with_obstacle', sx:   4, sy:  40, tx: 316, ty: 108, reachable: true, lenMin: 38, lenMax: 60 },
  { id: 'obs/skirt-left',         walkmap: 'room_with_obstacle', sx:  60, sy:  72, tx: 200, ty:  72, reachable: true, lenMin: 16, lenMax: 30 },
  { id: 'obs/skirt-right',        walkmap: 'room_with_obstacle', sx:  60, sy:  72, tx: 260, ty:  72, reachable: true, lenMin: 24, lenMax: 40 },
  { id: 'obs/squeeze',            walkmap: 'room_with_obstacle', sx:  96, sy:  52, tx: 224, ty:  92, reachable: true, lenMin: 14, lenMax: 30 },
  { id: 'obs/target-in-block',    walkmap: 'room_with_obstacle', sx:   4, sy:   4, tx: 160, ty:  76, reachable: true, lenMin: 18, lenMax: 35 },

  // ── corridor_l: solo y=16 (bottom row) y x=38 (right col) caminables ────
  { id: 'corr/start-elbow',       walkmap: 'corridor_l', sx:   4, sy: 128, tx: 308, ty: 128, reachable: true,  lenMin: 38, lenMax: 50 },
  { id: 'corr/elbow-top',         walkmap: 'corridor_l', sx: 308, sy: 128, tx: 308, ty:   4, reachable: true,  lenMin: 16, lenMax: 22 },
  { id: 'corr/full-l',            walkmap: 'corridor_l', sx:   4, sy: 128, tx: 308, ty:   4, reachable: true,  lenMin: 50, lenMax: 70 },
  // Documenta una propiedad importante del motor: _snap_walkable está acotado
  // a radio 4 celdas. (160,72) → cell (20,9) está a 7 celdas del corredor más
  // cercano (y=16) y a 18 del lateral (x=38). El snap falla → A* arranca en
  // celda no caminable → ningún vecino expandible → devuelve 0. Si Javi
  // amplía el radio, este test rojo lo avisa.
  { id: 'corr/snap-radius-cap',   walkmap: 'corridor_l', sx: 160, sy:  72, tx: 308, ty:   4, reachable: false },
  { id: 'corr/degenerate',        walkmap: 'corridor_l', sx:   4, sy: 128, tx:   4, ty: 128, reachable: true,  lenMin:  1, lenMax:  1 },
  { id: 'corr/mid-bot-right-mid', walkmap: 'corridor_l', sx: 160, sy: 128, tx: 308, ty:  72, reachable: true,  lenMin: 24, lenMax: 40 },
  { id: 'corr/end-to-start',      walkmap: 'corridor_l', sx: 308, sy:   4, tx:   4, ty: 128, reachable: true,  lenMin: 50, lenMax: 70 },
  { id: 'corr/small-step-row',    walkmap: 'corridor_l', sx:   4, sy: 128, tx:  12, ty: 128, reachable: true,  lenMin:  2, lenMax:  3 },
  { id: 'corr/small-step-col',    walkmap: 'corridor_l', sx: 308, sy:   4, tx: 308, ty:  12, reachable: true,  lenMin:  2, lenMax:  3 },
  { id: 'corr/far-row',           walkmap: 'corridor_l', sx:   4, sy: 128, tx: 308, ty: 140, reachable: true,  lenMin: 38, lenMax: 50 },

  // ── maze_simple: pasillos #-shape (y=4, y=13, x=8, x=30) ────────────────
  { id: 'maze/across-top',        walkmap: 'maze_simple', sx:   4, sy:  36, tx: 316, ty:  36, reachable: true, lenMin: 38, lenMax: 50 },
  { id: 'maze/across-bot',        walkmap: 'maze_simple', sx:   4, sy: 108, tx: 316, ty: 108, reachable: true, lenMin: 38, lenMax: 50 },
  { id: 'maze/left-vert',         walkmap: 'maze_simple', sx:  68, sy:   4, tx:  68, ty: 140, reachable: true, lenMin: 16, lenMax: 25 },
  { id: 'maze/right-vert',        walkmap: 'maze_simple', sx: 244, sy:   4, tx: 244, ty: 140, reachable: true, lenMin: 16, lenMax: 25 },
  { id: 'maze/tl-to-br-cross',    walkmap: 'maze_simple', sx:  68, sy:  36, tx: 244, ty: 108, reachable: true, lenMin: 28, lenMax: 45 },
  { id: 'maze/cross-cross',       walkmap: 'maze_simple', sx:  68, sy: 108, tx: 244, ty:  36, reachable: true, lenMin: 28, lenMax: 45 },
  { id: 'maze/snap-from-block',   walkmap: 'maze_simple', sx: 160, sy:  72, tx: 244, ty: 108, reachable: true, lenMin: 14, lenMax: 30 },
  { id: 'maze/mid-corr-corner',   walkmap: 'maze_simple', sx: 160, sy:  36, tx:  68, ty: 108, reachable: true, lenMin: 18, lenMax: 35 },
  { id: 'maze/corner-corner',     walkmap: 'maze_simple', sx:  68, sy:  36, tx: 244, ty: 108, reachable: true, lenMin: 28, lenMax: 45 },
  { id: 'maze/degenerate',        walkmap: 'maze_simple', sx:  68, sy:  36, tx:  68, ty:  36, reachable: true, lenMin:  1, lenMax:  1 },

  // ── disconnected: barrera vertical en gx=20 (pixels 160..167) ───────────
  { id: 'disc/lr-no-path',        walkmap: 'disconnected', sx:   4, sy:  72, tx: 316, ty:  72, reachable: false },
  { id: 'disc/rl-no-path',        walkmap: 'disconnected', sx: 316, sy:  72, tx:   4, ty:  72, reachable: false },
  { id: 'disc/left-to-left',      walkmap: 'disconnected', sx:   4, sy:   4, tx: 140, ty: 140, reachable: true, lenMin: 14, lenMax: 30 },
  { id: 'disc/right-to-right',    walkmap: 'disconnected', sx: 180, sy:   4, tx: 316, ty: 140, reachable: true, lenMin: 14, lenMax: 30 },
  { id: 'disc/left-corners',      walkmap: 'disconnected', sx:   4, sy:   4, tx:   4, ty: 140, reachable: true, lenMin: 16, lenMax: 25 },
  { id: 'disc/right-corners',     walkmap: 'disconnected', sx: 316, sy:   4, tx: 316, ty: 140, reachable: true, lenMin: 16, lenMax: 25 },
  { id: 'disc/near-wall-no-path', walkmap: 'disconnected', sx: 152, sy:  72, tx: 180, ty:  72, reachable: false },
  { id: 'disc/left-mid-far',      walkmap: 'disconnected', sx:  40, sy:  72, tx: 140, ty:  40, reachable: true, lenMin:  8, lenMax: 20 },
  { id: 'disc/right-mid-far',     walkmap: 'disconnected', sx: 180, sy:  72, tx: 300, ty: 108, reachable: true, lenMin: 12, lenMax: 25 },
  { id: 'disc/snap-into-wall',    walkmap: 'disconnected', sx: 164, sy:  72, tx:   4, ty:  72, reachable: true, lenMin: 16, lenMax: 30 },
]

let _results = null   // calculado una sola vez, reusado por todos los tests

beforeAll(() => {
  if (noClang) return
  // Una sola invocación batch al runner para los 50 casos. ~5x más rápido
  // que spawn-por-caso al reusar el walkmap cargado.
  _results = runnerAstarBatch(CASES.map(c => ({
    walkmap: wm(c.walkmap), sx: c.sx, sy: c.sy, tx: c.tx, ty: c.ty,
  })))
})

describe('motor host — drift detection A* (sin clang)', () => {
  it('lib/astar.c bloque A* byte-exact con engine_astar+helpers en agemki_engine.c', () => {
    const drift = detectAstarDrift()
    if (drift.error) throw new Error(drift.error)
    if (!drift.ok) {
      throw new Error(
        'DRIFT detectado en bloque A* del motor.\n' +
        'El motor cambió y la copia local quedó obsoleta. Sincronizar.\n' +
        '--- motor (head) ---\n' + drift.motor.slice(0, 600) +
        '\n\n--- copia (head) ---\n' + drift.copy.slice(0, 600)
      )
    }
    expect(drift.ok).toBe(true)
  })
})

describe.skipIf(noClang)('motor host — A* comportamiento sobre 5 walkmaps', () => {
  it('runner compilado correctamente', () => {
    expect(buildState.status).toBe('ok')
  })

  it.each(CASES)('$id → reachable=$reachable', (c) => {
    const r = _results[CASES.indexOf(c)]
    if (!c.reachable) {
      // Sin ruta: el motor devuelve 0.
      expect(r.len).toBe(0)
      expect(r.points).toEqual([])
      return
    }
    expect(r.len).toBeGreaterThanOrEqual(c.lenMin)
    expect(r.len).toBeLessThanOrEqual(c.lenMax)
    expect(r.points.length).toBe(r.len)
    // Primer y último waypoint deben caer en celdas (centradas en +4).
    for (const [x, y] of r.points) {
      expect(x % 4).toBe(0)   // múltiplo de WALKMAP_CELL_SIZE/2
      expect(y % 4).toBe(0)
    }
  })
})

describe.skipIf(noClang)('motor host — A* goldens deterministas', () => {
  it('manifest.json existe (o se genera con UPDATE_GOLDENS=1)', () => {
    if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true })
    if (!existsSync(MANIFEST_PATH) || UPDATE) {
      const manifest = {
        schema: 'engine-astar/v1',
        wmCellSize: 8,
        note: 'SHA-256 del raw del runner (formato N|x,y|x,y|…). Cambiar el algoritmo (orden de expansión, costes, tie-break) altera el hash.',
        cases: CASES.map((c, i) => ({
          id: c.id,
          walkmap: c.walkmap,
          start: [c.sx, c.sy],
          target: [c.tx, c.ty],
          reachable: c.reachable,
          len: _results[i].len,
          sha256: sha256(_results[i].raw),
        })),
      }
      writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
    }
    expect(existsSync(MANIFEST_PATH)).toBe(true)
  })

  it('cada caso match con su entry del manifest (len + sha256)', () => {
    if (!existsSync(MANIFEST_PATH)) {
      throw new Error(`manifest no existe: ${MANIFEST_PATH}. Corre con UPDATE_GOLDENS=1 para generarlo.`)
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    const byId = new Map(manifest.cases.map(c => [c.id, c]))
    expect(manifest.cases.length).toBe(CASES.length)
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i]
      const expected = byId.get(c.id)
      expect(expected, `caso "${c.id}" no está en el manifest`).toBeDefined()
      const actualLen = _results[i].len
      const actualSha = sha256(_results[i].raw)
      expect({ id: c.id, len: actualLen, sha256: actualSha })
        .toEqual({ id: c.id, len: expected.len, sha256: expected.sha256 })
    }
  })
})
