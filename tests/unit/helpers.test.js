/**
 * Smoke tests de los helpers de testing.
 * Verifica que la infraestructura funciona antes de añadir goldens reales.
 */
import { describe, it, expect } from 'vitest'
import { sha256, hexHead } from '../helpers/hash.js'
import { decodeDat, indexIsSorted, indexLayoutOK, MAGIC, HEADER_SIZE, INDEX_ENTRY_SIZE } from '../helpers/dat-decode.js'

describe('helpers de hash', () => {
  it('sha256 del buffer vacío coincide con el estándar RFC', () => {
    expect(sha256(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('sha256 de "hello" es determinista', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  it('hexHead devuelve los primeros bytes en hex mayúscula', () => {
    const buf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00])
    expect(hexHead(buf, 4)).toBe('DEADBEEF')
  })
})

describe('helpers de dat-decode', () => {
  it('exporta el magic y los tamaños de AGEMKI_DAT_SPEC', () => {
    expect(MAGIC).toBe('AGMK')
    expect(HEADER_SIZE).toBe(16)
    expect(INDEX_ENTRY_SIZE).toBe(48)
  })

  it('decodeDat rechaza buffers con magic inválido', () => {
    const bad = Buffer.alloc(16, 0)
    expect(() => decodeDat(bad)).toThrow(/Bad magic/)
  })

  it('decodeDat parsea un fichero AGMK mínimo construido a mano', () => {
    const numBlocks  = 1
    const dataOffset = HEADER_SIZE + numBlocks * INDEX_ENTRY_SIZE
    const dataSize   = 4
    const buf        = Buffer.alloc(dataOffset + dataSize)

    buf.write('AGMK', 0, 4, 'ascii')
    buf.writeUInt8(0, 4)                                 // dat_type GFX
    buf.writeUInt8(1, 5)                                 // version
    buf.writeUInt16LE(numBlocks, 6)
    buf.writeUInt32LE(HEADER_SIZE, 8)                    // index_offset
    buf.writeUInt32LE(dataOffset, 12)

    const idxOff = HEADER_SIZE
    Buffer.from('hello\0\0\0\0\0\0\0\0\0\0\0', 'ascii').copy(buf, idxOff)
    buf.writeUInt8(0x01, idxOff + 32)                    // res_type
    buf.writeUInt8(0,    idxOff + 33)                    // flags
    buf.writeUInt16LE(0, idxOff + 34)                    // reserved
    buf.writeUInt32LE(0,         idxOff + 36)            // offset
    buf.writeUInt32LE(dataSize,  idxOff + 40)            // size
    buf.writeUInt32LE(0,         idxOff + 44)            // extra

    Buffer.from([0x01, 0x02, 0x03, 0x04]).copy(buf, dataOffset)

    const dat = decodeDat(buf)
    expect(dat.magic).toBe('AGMK')
    expect(dat.numBlocks).toBe(1)
    expect(dat.index[0].id).toBe('hello')
    expect(dat.index[0].resType).toBe(0x01)
    expect(dat.index[0].size).toBe(4)
    expect(indexIsSorted(dat)).toBe(true)
    expect(indexLayoutOK(dat).ok).toBe(true)
  })
})
