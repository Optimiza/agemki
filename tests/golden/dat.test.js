/**
 * @fileoverview Tests de golden files del codegen `.DAT`.
 *
 * Para cada fixture en `tests/fixtures/`, invoca `generateDats(fixtureDir, tmpDir)`
 * y compara los 4 ficheros `.DAT` con los goldens en `goldens/dat/<fixture>/`.
 *
 * Workflow para actualizar:
 *   npm run goldens:update   (vitest run -u)
 *
 * Si `UPDATE_GOLDENS=1` está activo, los goldens se sobrescriben con la salida
 * actual y los tests pasan. Sin la flag, se compara byte a byte.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateDats } from '../../src/main/datGenerator.js'
import { sha256, hexHead } from '../helpers/hash.js'
import {
  decodeDat, indexIsSorted, indexLayoutOK, MAGIC, INDEX_ENTRY_SIZE,
} from '../helpers/dat-decode.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const FIXTURES  = join(REPO_ROOT, 'tests', 'fixtures')
const GOLDENS   = join(REPO_ROOT, 'goldens', 'dat')
const TMP       = join(REPO_ROOT, 'tmp', 'dat-tests')

const UPDATE = process.env.UPDATE_GOLDENS === '1'
const DAT_NAMES = ['SCRIPTS.DAT', 'GRAPHICS.DAT', 'AUDIO.DAT', 'FONTS.DAT']

const FIXTURE_LIST = ['minimal']

/** Limpia y re-crea un directorio. */
function freshDir(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  mkdirSync(p, { recursive: true })
}

/**
 * Lee un golden binario, o (en modo update) lo escribe con el contenido actual.
 * Devuelve el buffer esperado para asserts.
 */
function readOrWriteGolden(goldenPath, actual) {
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true })
    writeFileSync(goldenPath, actual)
    return actual
  }
  return readFileSync(goldenPath)
}

beforeAll(() => {
  // Asegura que el fixture existe (lanza un error útil en CI fresca si no se generó).
  for (const fx of FIXTURE_LIST) {
    if (!existsSync(join(FIXTURES, fx, 'game.json'))) {
      throw new Error(
        `Fixture '${fx}' no encontrado. Ejecuta:\n  node tests/fixtures/builder.mjs`
      )
    }
  }
})

describe.each(FIXTURE_LIST)('codegen .DAT golden — fixture "%s"', (fixture) => {
  const fixtureDir = join(FIXTURES, fixture)
  const buildDir   = join(TMP, fixture)
  const goldensDir = join(GOLDENS, fixture)

  let dats = {}        // { 'GRAPHICS.DAT': Buffer, ... }
  let manifest = {}    // sha256 + size por dat

  beforeAll(async () => {
    freshDir(buildDir)
    const result = await generateDats(fixtureDir, buildDir, () => {})
    if (!result.ok) {
      throw new Error('generateDats falló: ' + (result.errors?.[0] || 'desconocido'))
    }
    for (const name of DAT_NAMES) {
      const p = join(buildDir, name)
      if (!existsSync(p)) throw new Error(`generateDats no escribió ${name}`)
      const buf = readFileSync(p)
      dats[name] = buf
      const decoded = decodeDat(buf)
      manifest[name] = {
        sha256:    sha256(buf),
        size:      buf.length,
        numBlocks: decoded.numBlocks,
        magic:     decoded.magic,
        version:   decoded.version,
      }
    }
  })

  it.each(DAT_NAMES)('%s — idéntico byte a byte al golden', (name) => {
    const goldenPath = join(goldensDir, name)
    const expected   = readOrWriteGolden(goldenPath, dats[name])
    expect(dats[name].equals(expected)).toBe(true)
  })

  it('manifest.json — sha256 y tamaño coinciden con el golden', () => {
    const manifestPath = join(goldensDir, 'manifest.json')
    const actual       = JSON.stringify(manifest, null, 2) + '\n'
    const expected     = readOrWriteGolden(manifestPath, Buffer.from(actual, 'utf8')).toString('utf8')
    expect(actual).toBe(expected)
  })

  describe.each(DAT_NAMES)('estructura semántica — %s', (name) => {
    let dat
    beforeAll(() => { dat = decodeDat(dats[name]) })

    it('cabecera magic = "AGMK" y versión = 1', () => {
      expect(dat.magic).toBe(MAGIC)
      expect(dat.version).toBe(1)
    })

    it('chunks ordenados lexicográficamente por (resType, id)', () => {
      // Requisito crítico: el motor C usa binary search sobre el índice.
      // Garantizado por el sort en buildDat (ver F-05 en tests/FINDINGS.md).
      expect(indexIsSorted(dat)).toBe(true)
    })

    it('todos los offsets dentro del fichero, sin solapamiento', () => {
      const layout = indexLayoutOK(dat)
      if (!layout.ok) {
        throw new Error('violaciones de layout:\n  ' + layout.errors.join('\n  '))
      }
      expect(layout.ok).toBe(true)
    })

    it('los ids son null-terminados, ASCII imprimible y < 32 bytes', () => {
      for (const entry of dat.index) {
        expect(entry.id.length).toBeLessThanOrEqual(31)
        // Si el id no es ASCII imprimible está corrupto.
        expect(entry.id).toMatch(/^[\x20-\x7E]*$/)
      }
    })

    it('index_offset = HEADER_SIZE (16) y dataOffset = 16 + N*48', () => {
      expect(dat.indexOffset).toBe(16)
      expect(dat.dataOffset).toBe(16 + dat.numBlocks * INDEX_ENTRY_SIZE)
    })
  })

  it('preview hex de la cabecera estable (primeros 16 bytes)', () => {
    // Cualquier cambio en magic, dat_type, version, num_blocks o los offsets
    // queda capturado en el snapshot.
    for (const name of DAT_NAMES) {
      const head = hexHead(dats[name], 16)
      expect(head).toMatchSnapshot(`${name}:header`)
    }
  })
})
