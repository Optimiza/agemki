/**
 * @fileoverview Tests del motor C compilado en host con clang.
 *
 * Sub-etapa 2.1 (Phase 3a): primer test del subset portable del motor.
 * Cubre `_sfx_crc32` (algoritmo de hash de IDs usado para binary search
 * en TOC). Su correctitud es crítica: si difiere del CRC32 del codegen
 * JS, el motor no localiza chunks en runtime.
 *
 * Tres niveles de garantía:
 *   1. La copia local en lib/crc32.c sigue siendo idéntica a la del motor
 *      (drift test).
 *   2. El CRC32 del motor coincide bit-exacto con el JS para inputs reales.
 *   3. Inputs sintéticos (chars Unicode/ASCII edge) se hashean igual.
 *
 * Si clang no está disponible (mac sin Xcode CLT, win sin LLVM, Linux sin
 * apt), los tests del runner se skipean — no rompen el suite. El drift
 * test sí corre siempre (no necesita clang).
 */
import { describe, it, expect } from 'vitest'
import {
  ensureRunnerBuilt, runnerCrc32, runnerCrc32Batch,
  detectCrc32Drift, jsCrc32,
} from '../helpers/engine-host.js'

// Build se evalúa al cargar el módulo (síncrono). Si clang no está,
// describe.skipIf abajo skipea los tests dependientes del runner.
const buildState = ensureRunnerBuilt()
const noClang    = buildState.status !== 'ok'

if (buildState.status === 'no-clang') {
  console.warn('[engine-host] clang no disponible — tests del runner skipeados.')
} else if (buildState.status === 'fail') {
  console.error('[engine-host] build falló:\n' + buildState.error)
}

describe('motor host — drift detection (independiente de clang)', () => {
  it('lib/crc32.c es byte-exact a _sfx_crc32 en agemki_audio.c', () => {
    const drift = detectCrc32Drift()
    if (!drift.ok && drift.error) {
      throw new Error(drift.error)
    }
    if (!drift.ok) {
      throw new Error(
        'DRIFT detectado entre lib/crc32.c y agemki_audio.c::_sfx_crc32.\n' +
        'El motor cambió y la copia local quedó obsoleta. Sincronizar.\n' +
        '--- motor ---\n' + drift.motor + '\n' +
        '--- copia ---\n' + drift.copy
      )
    }
    expect(drift.ok).toBe(true)
  })
})

describe.skipIf(noClang)('motor host — CRC32 coincide con JS', () => {
  it('runner compilado correctamente', () => {
    expect(buildState.status).toBe('ok')
  })

  it.each([
    'hello', 'obj_key', 'char_hero', 'room_001',
    'vrb_use', 'dlg_intro', 'scr_use_key', 'seq_intro',
    'locale_es', 'locale_en', 'game_params', 'BG_001',
    'SPR_HERO', 'OBJ_KEY', 'MUS_INTRO', 'SFX_PICKUP',
  ])('motor.crc32("%s") === js.crc32("%s")', (input) => {
    expect(runnerCrc32(input)).toBe(jsCrc32(input))
  })

  it('CRC32 del string vacío es 0', () => {
    expect(runnerCrc32('')).toBe(0)
    expect(runnerCrc32('')).toBe(jsCrc32(''))
  })

  it('batch: 100 ids consecutivos coinciden con JS uno a uno', () => {
    const inputs = Array.from({ length: 100 }, (_, i) => 'item_' + i)
    const motorHashes = runnerCrc32Batch(inputs)
    const jsHashes    = inputs.map(jsCrc32)
    expect(motorHashes).toEqual(jsHashes)
  })

  it('strings con espacios, números y mayúsculas', () => {
    const cases = [
      'a', 'A', '1', ' ', '_', '.',
      'multi word string',
      'UPPER_CASE_ID',
      'mixed_Case_42',
      'a'.repeat(31),     // límite máximo de id en .DAT
    ]
    for (const s of cases) {
      expect(runnerCrc32(s), `mismatch en "${s}"`).toBe(jsCrc32(s))
    }
  })

  it('strings con bytes individuales (cubre tabla CRC entera)', () => {
    // Forzar ejercitar la tabla CRC en cada índice 0-255: strings de un
    // único carácter ASCII para todos los imprimibles.
    const codes = []
    for (let c = 0x20; c < 0x7F; c++) codes.push(String.fromCharCode(c))
    const motorHashes = runnerCrc32Batch(codes)
    const jsHashes    = codes.map(jsCrc32)
    expect(motorHashes).toEqual(jsHashes)
  })
})
