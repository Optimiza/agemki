/**
 * @fileoverview Decoder minimal para .DAT format AGMK.
 *
 * Solo cabecera + index. Los chunks no se decodifican aqui -- los tests
 * semanticos usan este decoder para asserts estructurales (ordenacion,
 * offsets dentro del fichero, no solapamiento), no para reconstruir
 * contenido.
 *
 * Spec referencia: src/main/dat/AGEMKI_DAT_SPEC.md y datGenerator.js.
 *
 * Layout:
 *   HEADER (16B):
 *     char[4]    magic         "AGMK"
 *     uint8      dat_type      0=GFX 1=SCRIPTS 2=AUDIO 3=FONTS
 *     uint8      version       1
 *     uint16_le  num_blocks
 *     uint32_le  index_offset  siempre 16
 *     uint32_le  data_offset
 *   INDEX ENTRY (48B):
 *     char[32]   id            null-padded
 *     uint8      res_type
 *     uint8      flags
 *     uint16_le  reserved
 *     uint32_le  offset        relativo a data_offset
 *     uint32_le  size
 *     uint32_le  extra
 */

export const HEADER_SIZE      = 16
export const INDEX_ENTRY_SIZE = 48
export const MAGIC            = 'AGMK'

/**
 * @param {Buffer} buf
 * @returns {{
 *   magic: string,
 *   datType: number,
 *   version: number,
 *   numBlocks: number,
 *   indexOffset: number,
 *   dataOffset: number,
 *   index: Array<{id:string, resType:number, flags:number, offset:number, size:number, extra:number}>,
 *   totalSize: number
 * }}
 */
export function decodeDat(buf) {
  if (buf.length < HEADER_SIZE) {
    throw new Error(`DAT too short: ${buf.length} < ${HEADER_SIZE}`)
  }
  const magic = buf.subarray(0, 4).toString('ascii')
  if (magic !== MAGIC) throw new Error(`Bad magic: ${magic}`)

  const datType     = buf.readUInt8(4)
  const version     = buf.readUInt8(5)
  const numBlocks   = buf.readUInt16LE(6)
  const indexOffset = buf.readUInt32LE(8)
  const dataOffset  = buf.readUInt32LE(12)

  const index = []
  for (let i = 0; i < numBlocks; i++) {
    const off = indexOffset + i * INDEX_ENTRY_SIZE
    const id  = buf.subarray(off, off + 32).toString('ascii').replace(/\0+$/, '')
    index.push({
      id,
      resType: buf.readUInt8(off + 32),
      flags:   buf.readUInt8(off + 33),
      offset:  buf.readUInt32LE(off + 36),
      size:    buf.readUInt32LE(off + 40),
      extra:   buf.readUInt32LE(off + 44),
    })
  }

  return { magic, datType, version, numBlocks, indexOffset, dataOffset, index, totalSize: buf.length }
}

/**
 * Verifica que los chunks del index esten ordenados lexicograficamente
 * por (resType, id). El motor depende de ello para binary search.
 * @param {ReturnType<typeof decodeDat>} dat
 * @returns {boolean}
 */
export function indexIsSorted(dat) {
  for (let i = 1; i < dat.index.length; i++) {
    const a = dat.index[i - 1], b = dat.index[i]
    if (a.resType > b.resType) return false
    if (a.resType === b.resType && a.id > b.id) return false
  }
  return true
}

/**
 * Verifica que los offsets de los chunks no solapen y caigan dentro del fichero.
 * @param {ReturnType<typeof decodeDat>} dat
 * @returns {{ok:boolean, errors:string[]}}
 */
export function indexLayoutOK(dat) {
  const errors = []
  const sorted = [...dat.index].sort((a, b) => a.offset - b.offset)
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    const absOff = dat.dataOffset + c.offset
    if (absOff + c.size > dat.totalSize) {
      errors.push(`chunk ${c.id} (off=${c.offset}, size=${c.size}) excede el fichero`)
    }
    if (i > 0) {
      const prev = sorted[i - 1]
      if (c.offset < prev.offset + prev.size) {
        errors.push(`chunk ${c.id} solapa con ${prev.id}`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}
