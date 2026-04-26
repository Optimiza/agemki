/**
 * @fileoverview datGenerator.js — Generador de ficheros DAT para AGEMKI
 *
 * Serializa todos los assets y datos del juego a 4 ficheros binarios
 * que el motor DOS puede cargar en runtime sin depender de JSON ni del
 * sistema de ficheros del host.
 *
 * FICHEROS GENERADOS:
 *   GRAPHICS.DAT  — sprites PCX, backgrounds, fuentes de imagen
 *   SCRIPTS.DAT   — rooms, objetos, personajes, diálogos, scripts, secuencias, locales
 *   AUDIO.DAT     — ficheros MIDI y WAV/SFX
 *   FONTS.DAT     — fuentes bitmap (PCX monocromo con mapa de caracteres)
 *
 * FORMATO GENERAL DE CADA DAT:
 *   [HEADER 16 bytes]
 *   [INDEX TABLE: N × INDEX_ENTRY]
 *   [DATA BLOCKS: N bloques de tamaño variable]
 *
 * HEADER (16 bytes):
 *   char[4]   magic      "AGMK"
 *   uint8     dat_type   0=GRAPHICS 1=SCRIPTS 2=AUDIO 3=FONTS
 *   uint8     version    formato = 1
 *   uint16    num_blocks número de entradas en el índice
 *   uint32    index_offset offset al inicio de la tabla de índices (siempre 16)
 *   uint32    data_offset offset al inicio del área de datos
 *
 * INDEX ENTRY (32 bytes):
 *   char[16]  id         identificador del recurso (null-padded)
 *   uint8     res_type   tipo de recurso (ver RES_TYPE_*)
 *   uint8     flags      0=normal 1=compressed (reservado, siempre 0 ahora)
 *   uint16    reserved   padding
 *   uint32    offset     offset al bloque de datos (relativo al inicio del fichero)
 *   uint32    size       tamaño del bloque en bytes
 *   uint32    extra      dato extra dependiente del tipo (ej: ancho sprite)
 *
 * TIPOS DE RECURSO (res_type):
 *   0x01  BACKGROUND   imagen PCX de fondo (320×144 o 320×200)
 *   0x02  SPRITE       spritesheet PCX (una animación)
 *   0x03  OBJECT_PCX   imagen de objeto de inventario
 *   0x04  FONT_PCX     fuente bitmap
 *   0x10  ROOM         estructura de room serializada
 *   0x11  OBJECT       objeto de juego (propiedades + inventario)
 *   0x12  CHARACTER    personaje (animaciones + stats + diálogos)
 *   0x13  VERBSET      conjunto de verbos
 *   0x14  DIALOGUE     árbol de diálogo (nodos + conexiones)
 *   0x15  SCRIPT       script de eventos (triggers + instrucciones)
 *   0x16  SEQUENCE     secuencia de pasos
 *   0x17  LOCALE       tabla de strings de un idioma
 *   0x18  GAME_PARAMS  parámetros globales del juego
 *   0x20  MIDI         fichero MIDI completo
 *   0x21  SFX          sample de audio WAV/SFX
 *
 * ENDIANNESS: little-endian (x86 DOS nativo)
 * STRINGS en estructuras: uint8 longitud + bytes (máx 255 chars, sin null terminator)
 * STRINGS largos (textos de diálogo): uint16 longitud + bytes
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { ensureBaseFonts } from './fontGenerator.js'

// ── PCX flip utility ─────────────────────────────────────────────────────────
// Decodifica un PCX, espeja los pixels (H, V, o ambos) y re-encodifica a PCX.
// Solo manipula el área de pixels — cabecera y paleta se copian intactas.
function flipPcxBuffer(buf, flipH, flipV) {
  if (!flipH && !flipV) return buf
  try {
    const dv       = new DataView(buf.buffer, buf.byteOffset)
    const totalW   = dv.getUint16(8,  true) + 1
    const totalH   = dv.getUint16(10, true) + 1
    const bpl      = dv.getUint16(66, true)  // bytes per line (puede ser > totalW)

    // Decodificar RLE → pixels[y * bpl + x]
    const pixels = new Uint8Array(bpl * totalH)
    let pos = 128, out = 0
    while (out < pixels.length && pos < buf.length - 769) {
      const b = buf[pos++]
      if ((b & 0xC0) === 0xC0) {
        const run = b & 0x3F, val = buf[pos++]
        for (let i = 0; i < run && out < pixels.length; i++) pixels[out++] = val
      } else { pixels[out++] = b }
    }

    // Espejar
    if (flipH) {
      for (let y = 0; y < totalH; y++) {
        let l = y * bpl, r = y * bpl + totalW - 1
        while (l < r) { const t = pixels[l]; pixels[l++] = pixels[r]; pixels[r--] = t }
      }
    }
    if (flipV) {
      for (let t = 0, b2 = totalH - 1; t < b2; t++, b2--) {
        const rowT = pixels.slice(t  * bpl, t  * bpl + bpl)
        const rowB = pixels.slice(b2 * bpl, b2 * bpl + bpl)
        pixels.set(rowB, t  * bpl)
        pixels.set(rowT, b2 * bpl)
      }
    }

    // Re-encodificar RLE
    const encoded = []
    for (let y = 0; y < totalH; y++) {
      let x = 0
      while (x < bpl) {
        const v = pixels[y * bpl + x]
        let run = 1
        while (run < 63 && x + run < bpl && pixels[y * bpl + x + run] === v) run++
        if (run > 1 || (v & 0xC0) === 0xC0) {
          encoded.push(0xC0 | run, v)
        } else {
          encoded.push(v)
        }
        x += run
      }
    }

    // Reconstruir buffer: cabecera (128 bytes) + RLE + paleta (769 bytes)
    const header  = Buffer.from(buf).slice(0, 128)
    const palette = Buffer.from(buf).slice(buf.length - 769)
    const rleData = Buffer.from(encoded)
    return Buffer.concat([header, rleData, palette])
  } catch (e) {
    console.error('flipPcxBuffer error:', e)
    return buf  // fallback: devolver original
  }
}

// ── Constantes ────────────────────────────────────────────────────────────────

const MAGIC         = Buffer.from('AGMK')
const FORMAT_VERSION = 1

const DAT_TYPE = { GRAPHICS: 0, SCRIPTS: 1, AUDIO: 2, FONTS: 3 }

const RES_TYPE = {
  BACKGROUND:  0x01,
  SPRITE:      0x02,
  OBJECT_PCX:  0x03,
  FONT_PCX:    0x04,
  ROOM:        0x10,
  OBJECT:      0x11,
  CHARACTER:   0x12,
  VERBSET:     0x13,
  DIALOGUE:    0x14,
  SCRIPT:      0x15,
  SEQUENCE:    0x16,
  LOCALE:      0x17,
  GAME_PARAMS: 0x18,
  MIDI:        0x20,
  SFX:         0x21,
}

const HEADER_SIZE      = 16
const INDEX_ENTRY_SIZE = 48   /* id[32] + res_type(1) + flags(1) + reserved(2) + offset(4) + size(4) + extra(4) */
// ── Utilidades de serialización ───────────────────────────────────────────────

/** Escribe un string corto (uint8 longitud + bytes, máx 255). */
function writeStr8(buf, offset, str) {
  const s = String(str || '').slice(0, 255)
  const bytes = Buffer.from(s, 'utf8')
  buf.writeUInt8(bytes.length, offset)
  bytes.copy(buf, offset + 1)
  return offset + 1 + bytes.length
}

/** Calcula el tamaño de un string corto serializado. */
function sizeStr8(str) {
  return 1 + Buffer.byteLength(String(str || ''), 'utf8')
}

/** Escribe un string largo (uint16 longitud + bytes, máx 65535). */
function writeStr16(buf, offset, str) {
  const s = String(str || '').slice(0, 65535)
  const bytes = Buffer.from(s, 'utf8')
  buf.writeUInt16LE(bytes.length, offset)
  bytes.copy(buf, offset + 2)
  return offset + 2 + bytes.length
}

function sizeStr16(str) {
  return 2 + Buffer.byteLength(String(str || ''), 'utf8')
}

/** Escribe un ID en campo char[16] (null-padded). */
function writeId16(buf, offset, id) {
  const bytes = Buffer.alloc(16, 0)
  Buffer.from(String(id || '').slice(0, 15), 'ascii').copy(bytes)
  bytes.copy(buf, offset)
  return offset + 16
}

/** Escribe un bool como uint8. */
function writeBool(buf, offset, v) {
  buf.writeUInt8(v ? 1 : 0, offset)
  return offset + 1
}

// ── Ensamblador de DAT ────────────────────────────────────────────────────────

/**
 * Construye un buffer DAT completo a partir de una lista de bloques.
 * @param {number} datType
 * @param {Array<{id:string, resType:number, data:Buffer, extra?:number}>} blocks
 * @returns {Buffer}
 */
function buildDat(datType, blocks) {
  const numBlocks  = blocks.length
  const indexSize  = numBlocks * INDEX_ENTRY_SIZE
  const dataOffset = HEADER_SIZE + indexSize

  // Calcular tamaño total
  const totalSize = dataOffset + blocks.reduce((s, b) => s + b.data.length, 0)
  const buf = Buffer.alloc(totalSize, 0)

  // ── Header ─────────────────────────────────────────────────────────────────
  MAGIC.copy(buf, 0)
  buf.writeUInt8(datType,       4)
  buf.writeUInt8(FORMAT_VERSION, 5)
  buf.writeUInt16LE(numBlocks,  6)
  buf.writeUInt32LE(HEADER_SIZE, 8)
  buf.writeUInt32LE(dataOffset, 12)

  // ── Index + Data ────────────────────────────────────────────────────────────
  let idxOff  = HEADER_SIZE
  let dataOff = dataOffset   /* posición absoluta en el buffer */
  let relOff  = 0            /* offset relativo al inicio del área de datos */

  for (const block of blocks) {
    // Index entry (48 bytes): id[32] + res_type(1) + flags(1) + reserved(2) + offset(4) + size(4) + extra(4)
    const idBytes = Buffer.alloc(32, 0)
    Buffer.from(String(block.id || '').slice(0, 31), 'ascii').copy(idBytes)
    idBytes.copy(buf, idxOff)                           //  0..31  id[32]
    buf.writeUInt8(block.resType, idxOff + 32)          // 32      res_type
    buf.writeUInt8(0,             idxOff + 33)          // 33      flags
    buf.writeUInt16LE(0,          idxOff + 34)          // 34..35  reserved
    buf.writeUInt32LE(relOff,     idxOff + 36)          // 36..39  offset (relativo a data_offset)
    buf.writeUInt32LE(block.data.length, idxOff + 40)  // 40..43  size
    buf.writeUInt32LE(block.extra || 0,  idxOff + 44)  // 44..47  extra

    // Data block
    block.data.copy(buf, dataOff)

    idxOff  += INDEX_ENTRY_SIZE
    dataOff += block.data.length
    relOff  += block.data.length
  }

  return buf
}

// ── Serializers por tipo de recurso ───────────────────────────────────────────

/**
 * Serializa una room.json a binario.
 *
 * ROOM BLOCK:
 *   str8    id
 *   str8    name
 *   uint16  bgW, bgH           tamaño del fondo
 *   str8    backgroundFile     nombre del PCX de fondo (sin ruta)
 *   uint8   scrollEnabled
 *   uint16  scrollTotalW, scrollTotalH
 *   uint8   numExits
 *   EXIT[] exits:
 *     str8    exitId
 *     int16   x, y, w, h      rectángulo en píxeles
 *     str8    targetRoomId
 *     str8    targetEntryId
 *   uint8   numEntries
 *   ENTRY[] entries:
 *     str8    entryId
 *     int16   x, y
 *   uint8   numObjects        objetos instanciados en la room
 *   ROOM_OBJ[] objects:
 *     str8    objectId
 *     int16   x, y
 *   uint8   numChars          personajes iniciales en la room
 *   ROOM_CHAR[] chars:
 *     str8    charId
 *     int16   x, y
 *   uint8   numWalkmaps
 *   WALKMAP[] walkmaps:
 *     str8    walkmapId
 *     uint8   numShapes
 *     SHAPE[] shapes:
 *       uint8   type           0=rect 1=polygon
 *       uint8   numPoints
 *       POINT[] points:
 *         int16 x, y
 *   str8    midiId             MIDI de esta room (vacío = silencio)
 */
function serializeRoom(room) {
  // Pre-calculate size
  let size = 0
  size += sizeStr8(room.id)
  size += sizeStr8(room.name)
  size += 4   // bgW, bgH
  size += sizeStr8(room.backgroundFilePath ? basename(room.backgroundFilePath) : '')
  size += 1   // scrollEnabled
  size += 4   // scrollTotalW, scrollTotalH
  size += 1   // numExits
  const exits = room.exits || []
  for (const e of exits) {
    size += sizeStr8(e.id) + sizeStr8(e.targetRoom || '') + sizeStr8(e.targetEntry || '')
    size += 8   // x,y,w,h int16×4
  }
  size += 1   // numEntries
  const entries = room.entries || []
  for (const e of entries) {
    size += sizeStr8(e.id) + 4  // x,y int16×2
  }
  size += 1   // numObjects
  const roomObjs = room.objects || []
  for (const o of roomObjs) {
    size += sizeStr8(o.id || o.objectId || '') + 4
  }
  size += 1   // numChars
  const roomChars = room.characters || []
  for (const c of roomChars) {
    size += sizeStr8(c.id || c.charId || '') + 4
  }
  size += 1   // numWalkmaps
  const walkmaps = room.walkmaps || []
  for (const wm of walkmaps) {
    size += sizeStr8(wm.id)
    size += 1  // numShapes
    for (const sh of (wm.shapes || [])) {
      size += 2  // type + numPoints
      size += ((sh.points || []).length) * 4  // x,y int16 per point
    }
  }
  size += sizeStr8((room.audio || {}).midi || '')

  const buf = Buffer.alloc(size)
  let off = 0

  off = writeStr8(buf, off, room.id)
  off = writeStr8(buf, off, room.name)
  buf.writeUInt16LE(room.backgroundSize?.w || 320, off); off += 2
  buf.writeUInt16LE(room.backgroundSize?.h || 144, off); off += 2
  off = writeStr8(buf, off, room.backgroundFilePath ? basename(room.backgroundFilePath) : '')
  off = writeBool(buf, off, room.scroll?.enabled || false)
  buf.writeUInt16LE(room.scroll?.totalW || room.backgroundSize?.w || 320, off); off += 2
  buf.writeUInt16LE(room.scroll?.totalH || room.backgroundSize?.h || 144, off); off += 2

  buf.writeUInt8(exits.length, off); off += 1
  for (const e of exits) {
    off = writeStr8(buf, off, e.id)
    buf.writeInt16LE(Math.round(e.x || 0), off); off += 2
    buf.writeInt16LE(Math.round(e.y || 0), off); off += 2
    buf.writeInt16LE(Math.round(e.w || 32), off); off += 2
    buf.writeInt16LE(Math.round(e.h || 32), off); off += 2
    off = writeStr8(buf, off, e.targetRoom || '')
    off = writeStr8(buf, off, e.targetEntry || 'entry_default')
  }

  buf.writeUInt8(entries.length, off); off += 1
  for (const e of entries) {
    off = writeStr8(buf, off, e.id)
    buf.writeInt16LE(Math.round(e.x || 0), off); off += 2
    buf.writeInt16LE(Math.round(e.y || 0), off); off += 2
  }

  buf.writeUInt8(roomObjs.length, off); off += 1
  for (const o of roomObjs) {
    off = writeStr8(buf, off, o.id || o.objectId || '')
    buf.writeInt16LE(Math.round(o.x || 0), off); off += 2
    buf.writeInt16LE(Math.round(o.y || 0), off); off += 2
  }

  buf.writeUInt8(roomChars.length, off); off += 1
  for (const c of roomChars) {
    off = writeStr8(buf, off, c.id || c.charId || '')
    buf.writeInt16LE(Math.round(c.x || 0), off); off += 2
    buf.writeInt16LE(Math.round(c.y || 0), off); off += 2
  }

  buf.writeUInt8(walkmaps.length, off); off += 1
  for (const wm of walkmaps) {
    off = writeStr8(buf, off, wm.id)
    const shapes = wm.shapes || []
    buf.writeUInt8(shapes.length, off); off += 1
    for (const sh of shapes) {
      buf.writeUInt8(sh.type === 'polygon' ? 1 : 0, off); off += 1
      const pts = sh.points || []
      buf.writeUInt8(pts.length, off); off += 1
      for (const pt of pts) {
        buf.writeInt16LE(Math.round(pt.x || 0), off); off += 2
        buf.writeInt16LE(Math.round(pt.y || 0), off); off += 2
      }
    }
  }

  off = writeStr8(buf, off, (room.audio || {}).midi || '')
  return buf.slice(0, off)
}

/**
 * Serializa un objeto (object.json).
 *
 * OBJECT BLOCK:
 *   str8    id, name, description
 *   uint8   isPickable, isUsable, isVisible
 *   str8    spriteFile         PCX del sprite de inventario
 *   uint8   numVerbs           verbos personalizados
 *   VERB_OVERRIDE[]:
 *     str8  verbId
 *     str8  scriptId
 *   str8    defaultScript      script por defecto al interactuar
 */
function serializeObject(obj) {
  const verbs = obj.verbOverrides || []
  let size = sizeStr8(obj.id) + sizeStr8(obj.name) + sizeStr8(obj.description || '')
  size += 3  // isPickable, isUsable, isVisible
  size += sizeStr8(obj.spriteFile || '')
  size += 1  // numVerbs
  for (const v of verbs) size += sizeStr8(v.verbId) + sizeStr8(v.scriptId || '')
  size += sizeStr8(obj.defaultScript || '')

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, obj.id)
  off = writeStr8(buf, off, obj.name)
  off = writeStr8(buf, off, obj.description || '')
  off = writeBool(buf, off, obj.isPickable !== false)
  off = writeBool(buf, off, obj.isUsable !== false)
  off = writeBool(buf, off, obj.isVisible !== false)
  off = writeStr8(buf, off, obj.spriteFile || '')
  buf.writeUInt8(verbs.length, off); off += 1
  for (const v of verbs) {
    off = writeStr8(buf, off, v.verbId)
    off = writeStr8(buf, off, v.scriptId || '')
  }
  off = writeStr8(buf, off, obj.defaultScript || '')
  return buf.slice(0, off)
}

/**
 * Serializa un personaje (char.json).
 *
 * CHARACTER BLOCK:
 *   str8    id, name
 *   uint8   isProtagonist
 *   int16   walkSpeed
 *   str8    defaultDialogueId
 *   uint8   numConditions
 *   COND[]:
 *     str8  flag
 *     uint8 value
 *     str8  dialogueId
 *   uint8   numAnimations
 *   ANIM[]:
 *     str8  animId, animName, pcxFile
 *     uint8 frameWidth, frameCount, fps, loop
 *   uint8   numPatrolPoints
 *   PATROL[]:
 *     int16 x, y
 *     uint16 waitMs
 */
function serializeChar(char) {
  const conds = char.dialogueConditions || []
  const anims = char.animations || []
  const patrol = char.patrol?.points || []

  let size = sizeStr8(char.id) + sizeStr8(char.name)
  size += 1 + 2  // isProtagonist, walkSpeed
  size += sizeStr8(char.dialogueId || '')
  size += sizeStr8(char.faceSprite ? char.faceSprite.replace(/\.pcx$/i, '') : '')
  size += 1  // numConditions
  for (const c of conds) size += sizeStr8(c.flag) + 1 + sizeStr8(c.dialogueId || '')
  size += 1  // numAnimations
  for (const a of anims) {
    size += sizeStr8(a.id) + sizeStr8(a.name || a.id) + sizeStr8(a.pcxFile || '')
    size += 4  // frameWidth, frameCount, fps, loop
  }
  size += 1  // numPatrolPoints
  size += patrol.length * 6  // x,y int16 + waitMs uint16

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, char.id)
  off = writeStr8(buf, off, char.name)
  off = writeBool(buf, off, char.isProtagonist || false)
  buf.writeInt16LE(char.walkSpeed || 2, off); off += 2
  off = writeStr8(buf, off, char.dialogueId || '')
  off = writeStr8(buf, off, char.faceSprite ? char.faceSprite.replace(/\.pcx$/i, '') : '')
  buf.writeUInt8(conds.length, off); off += 1
  for (const c of conds) {
    off = writeStr8(buf, off, c.flag || '')
    off = writeBool(buf, off, c.value !== false)
    off = writeStr8(buf, off, c.dialogueId || '')
  }
  buf.writeUInt8(anims.length, off); off += 1
  for (const a of anims) {
    off = writeStr8(buf, off, a.id)
    off = writeStr8(buf, off, a.name || a.id)
    off = writeStr8(buf, off, a.pcxFile || '')
    buf.writeUInt8(a.frameWidth || 32, off); off += 1
    buf.writeUInt8(a.frameCount || 1,  off); off += 1
    buf.writeUInt8(a.fps || 8,         off); off += 1
    off = writeBool(buf, off, a.loop !== false)
  }
  buf.writeUInt8(patrol.length, off); off += 1
  for (const p of patrol) {
    buf.writeInt16LE(Math.round(p.x || 0),  off); off += 2
    buf.writeInt16LE(Math.round(p.y || 0),  off); off += 2
    buf.writeUInt16LE(p.waitMs || 0,        off); off += 2
  }
  return buf.slice(0, off)
}

/**
 * Serializa un verbset (verbset.json).
 *
 * VERBSET BLOCK:
 *   str8    id, name
 *   uint8   numVerbs
 *   VERB[]:
 *     str8  verbId, label
 *     uint8 isMovement, approachObject, isPickup
 *     uint8 screenX, screenY   posición en la barra de verbos (0-255)
 *     uint8 normalColor        color texto normal (índice paleta, 0-255)
 *     uint8 hoverColor         color texto con cursor encima (índice paleta, 0-255)
 */
function serializeVerbset(vs) {
  const verbs = vs.verbs || []
  let size = sizeStr8(vs.id) + sizeStr8(vs.name || vs.id)
  size += 1
  // Por verbo: str8 id, str8 label, uint8 isMovement, uint8 approachObj, uint8 isPickup,
  //            uint8 screenX, uint8 screenY, uint8 normalColor, uint8 hoverColor
  for (const v of verbs) size += sizeStr8(v.id) + sizeStr8(v.label || v.id) + 7

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, vs.id)
  off = writeStr8(buf, off, vs.name || vs.id)
  buf.writeUInt8(verbs.length, off); off += 1
  for (const v of verbs) {
    off = writeStr8(buf, off, v.id)
    off = writeStr8(buf, off, v.label || v.id)
    off = writeBool(buf, off, v.isMovement    || false)
    off = writeBool(buf, off, v.approachObject || false)
    off = writeBool(buf, off, v.isPickup       || false)
    buf.writeUInt8(v.screenX || 0, off); off += 1
    buf.writeUInt8(v.screenY || 0, off); off += 1
    buf.writeUInt8(v.normalColor !== undefined ? v.normalColor : 15, off); off += 1
    buf.writeUInt8(v.hoverColor  !== undefined ? v.hoverColor  : 15, off); off += 1
  }
  return buf.slice(0, off)
}

/**
 * Serializa un árbol de diálogo (dialogue.json).
 *
 * DIALOGUE BLOCK:
 *   str8    id, name, actorId
 *   uint8   numNodes
 *   NODE[]:
 *     str8    nodeId
 *     uint8   nodeType    0=start 1=line 2=choice 3=condition 4=end 5=call_script
 *     str16   text        (texto en el idioma activo, o vacío si usa localeKey)
 *     str8    localeKey   (alternativa a text inline)
 *     str8    scriptId    (para call_script o acción al seleccionar)
 *     uint8   numOutputs
 *     OUTPUT[]:
 *       str8  label       etiqueta de la opción (para choice)
 *       str8  targetNodeId
 *       str8  condFlag    condición opcional
 *       uint8 condValue
 */
function serializeDialogue(dlg) {
  const nodes = dlg.nodes || []
  let size = sizeStr8(dlg.id) + sizeStr8(dlg.name || dlg.id) + sizeStr8(dlg.actorId || '')
  size += 1  // numNodes
  for (const n of nodes) {
    size += sizeStr8(n.id) + 1
    size += sizeStr16(n.data?.text || '')
    size += sizeStr8(n.data?.localeKey || '')
    size += sizeStr8(n.data?.scriptId || '')
    const outputs = n.outputs || []
    size += 1
    for (const o of outputs) {
      size += sizeStr8(o.label || '') + sizeStr8(o.targetNodeId || '')
      size += sizeStr8(o.condFlag || '') + 1
    }
  }

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, dlg.id)
  off = writeStr8(buf, off, dlg.name || dlg.id)
  off = writeStr8(buf, off, dlg.actorId || '')
  buf.writeUInt8(nodes.length, off); off += 1
  for (const n of nodes) {
    const typeMap = { start:0, line:1, choice:2, condition:3, end:4, call_script:5 }
    off = writeStr8(buf, off, n.id)
    buf.writeUInt8(typeMap[n.type] ?? 1, off); off += 1
    off = writeStr16(buf, off, n.data?.text || '')
    off = writeStr8(buf, off, n.data?.localeKey || '')
    off = writeStr8(buf, off, n.data?.scriptId || '')
    const outputs = n.outputs || []
    buf.writeUInt8(outputs.length, off); off += 1
    for (const o of outputs) {
      off = writeStr8(buf, off, o.label || '')
      off = writeStr8(buf, off, o.targetNodeId || '')
      off = writeStr8(buf, off, o.condFlag || '')
      off = writeBool(buf, off, o.condValue !== false)
    }
  }
  return buf.slice(0, off)
}

/**
 * Serializa un script (script.json).
 *
 * SCRIPT BLOCK:
 *   str8    id, name
 *   uint8   numTriggers
 *   TRIGGER[]:
 *     uint8   triggerType  0=room_load 1=verb_object 2=dialogue_node
 *                          3=flag_change 4=attr_change 5=sequence_end
 *     str8    param1..param3  (depende del tipo, ver ScriptEditor)
 *     uint8   numConditions
 *     CONDITION[]:
 *       uint8 condType     0=flag 1=has_object 2=attr_compare 3=var_compare
 *       str8  param1..param3
 *       uint8 operator     0=eq 1=ne 2=lt 3=gt 4=le 5=ge
 *     uint8   numInstructions
 *     INSTRUCTION[]:
 *       uint8 instrType    (ver scriptStore INSTR_TYPE_*)
 *       str8  param1..param4
 */
function serializeScript(script) {
  const triggers = script.triggers || []

  const TRIGGER_TYPE = {
    room_load: 0, verb_object: 1, dialogue_node: 2,
    flag_change: 3, attr_change: 4, sequence_end: 5,
  }
  const COND_TYPE = { flag: 0, has_object: 1, attr_compare: 2, var_compare: 3 }
  const OP_MAP = { '==': 0, '!=': 1, '<': 2, '>': 3, '<=': 4, '>=': 5 }

  // Calculate size
  let size = sizeStr8(script.id) + sizeStr8(script.name || script.id)
  size += 1  // numTriggers
  for (const t of triggers) {
    size += 1 + sizeStr8(t.param1 || '') + sizeStr8(t.param2 || '') + sizeStr8(t.param3 || '')
    const conds = t.conditions || []
    size += 1
    for (const c of conds) {
      size += 1 + sizeStr8(c.param1 || '') + sizeStr8(c.param2 || '') + sizeStr8(c.param3 || '') + 1
    }
    const instrs = t.instructions || []
    size += 1
    for (const i of instrs) {
      size += 1 + sizeStr8(i.p1||'') + sizeStr8(i.p2||'') + sizeStr8(i.p3||'') + sizeStr8(i.p4||'')
    }
  }

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, script.id)
  off = writeStr8(buf, off, script.name || script.id)
  buf.writeUInt8(triggers.length, off); off += 1

  for (const t of triggers) {
    buf.writeUInt8(TRIGGER_TYPE[t.type] ?? 0, off); off += 1
    off = writeStr8(buf, off, t.param1 || t.roomId || t.verbId || t.flag || t.attrName || t.sequenceId || '')
    off = writeStr8(buf, off, t.param2 || t.objectId || t.nodeId || t.targetId || '')
    off = writeStr8(buf, off, t.param3 || '')

    const conds = t.conditions || []
    buf.writeUInt8(conds.length, off); off += 1
    for (const c of conds) {
      buf.writeUInt8(COND_TYPE[c.type] ?? 0, off); off += 1
      off = writeStr8(buf, off, c.flag || c.objectId || c.target || c.varName || '')
      off = writeStr8(buf, off, c.value != null ? String(c.value) : '')
      off = writeStr8(buf, off, c.attr || '')
      buf.writeUInt8(OP_MAP[c.operator] ?? 0, off); off += 1
    }

    const instrs = t.instructions || []
    buf.writeUInt8(instrs.length, off); off += 1
    for (const i of instrs) {
      // Map instruction type string to uint8
      const IMAP = {
        move_char:0, walk_char:1, set_animation:2, show_char:3, hide_char:4,
        teleport_char:5, set_room:6, give_object:7, remove_object:8, show_object:9,
        hide_object:10, set_flag:11, clear_flag:12, set_global:13, set_local:14,
        show_text:15, play_sound:16, play_midi:17, stop_midi:18, wait:19,
        call_script:20, call_dialogue:21, call_sequence:22, change_verbset:23,
        set_protagonist:24, game_over:25, end_game:26,
      }
      buf.writeUInt8(IMAP[i.type] ?? 0, off); off += 1
      // Serializar los campos del step como 4 params genéricos
      const fields = Object.entries(i).filter(([k]) => k !== 'type')
      off = writeStr8(buf, off, fields[0]?.[1] != null ? String(fields[0][1]) : '')
      off = writeStr8(buf, off, fields[1]?.[1] != null ? String(fields[1][1]) : '')
      off = writeStr8(buf, off, fields[2]?.[1] != null ? String(fields[2][1]) : '')
      off = writeStr8(buf, off, fields[3]?.[1] != null ? String(fields[3][1]) : '')
    }
  }
  return buf.slice(0, off)
}

/**
 * Serializa una secuencia (sequence.json).
 *
 * SEQUENCE BLOCK:
 *   str8    id, name
 *   uint8   numSteps
 *   STEP[]:
 *     uint8   stepType    (ver sequenceStore STEP_TYPE_*)
 *     uint8   blocking    0=no bloqueante 1=bloqueante
 *     uint8   numFields   número de campos extra
 *     FIELD[]:
 *       str8  key
 *       str16 value       (str16 para soportar textos largos)
 */
function serializeSequence(seq) {
  const SMAP = {
    show_text:0, scroll_text:1, clear_text:2,
    move_char:3, walk_char:4, set_animation:5, show_char:6, hide_char:7,
    move_camera:8, shake_camera:9, fade_in:10, fade_out:11, flash:12,
    play_midi:13, stop_midi:14, play_sfx:15,
    wait:16, call_script:17, set_flag:18, set_global:19,
  }
  const steps = seq.steps || []
  let size = sizeStr8(seq.id) + sizeStr8(seq.name || seq.id)
  size += 1  // numSteps
  for (const s of steps) {
    size += 1 + 1  // stepType, blocking
    const fields = Object.entries(s).filter(([k]) => k !== 'type' && k !== 'blocking')
    size += 1  // numFields
    for (const [k, v] of fields) {
      size += sizeStr8(k)
      // texts es objeto {lang:texto}, serializar como JSON string
      const vstr = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
      size += sizeStr16(vstr)
    }
  }

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, seq.id)
  off = writeStr8(buf, off, seq.name || seq.id)
  buf.writeUInt8(steps.length, off); off += 1
  for (const s of steps) {
    buf.writeUInt8(SMAP[s.type] ?? 0, off); off += 1
    off = writeBool(buf, off, s.blocking !== false)
    const fields = Object.entries(s).filter(([k]) => k !== 'type' && k !== 'blocking')
    buf.writeUInt8(fields.length, off); off += 1
    for (const [k, v] of fields) {
      off = writeStr8(buf, off, k)
      const vstr = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
      off = writeStr16(buf, off, vstr)
    }
  }
  return buf.slice(0, off)
}

/**
 * Serializa las localizaciones de un idioma.
 *
 * LOCALE BLOCK:
 *   str8    langCode    "es", "en", etc.
 *   uint16  numEntries
 *   ENTRY[]:
 *     str8  key
 *     str16 text
 */
function serializeLocale(langCode, localeObj) {
  const entries = Object.entries(localeObj || {})
  let size = sizeStr8(langCode) + 2
  for (const [k, v] of entries) size += sizeStr8(k) + sizeStr16(v || '')

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, langCode)
  buf.writeUInt16LE(entries.length, off); off += 2
  for (const [k, v] of entries) {
    off = writeStr8(buf, off, k)
    off = writeStr16(buf, off, v || '')
  }
  return buf.slice(0, off)
}

/**
 * Serializa los parámetros globales del juego (game.json).
 *
 * GAME_PARAMS BLOCK:
 *   str8    id, name, version
 *   str8    startSequence
 *   str8    activeVerbSet
 *   str8    activeLanguage
 *   uint8   rpgAttributes, scrollRooms, mapMode, allowCharacterSwitch, autosave
 *   uint8   inventoryRows, inventoryCols
 *   uint16  numPaletteColors   (siempre 256)
 *   RGB[256]:
 *     uint8 r, g, b
 */
function serializeGameParams(game) {
  const palette = game.palette || []
  let size = sizeStr8(game.id) + sizeStr8(game.name) + sizeStr8(game.version || '1.0.0')
  size += sizeStr8(game.startSequence || '')
  size += sizeStr8(game.activeVerbSet || '')
  size += sizeStr8(game.activeLanguage || 'es')
  size += 5  // system flags
  size += 2  // inventory rows/cols
  size += 2  // numPaletteColors
  size += 256 * 3  // RGB palette

  const buf = Buffer.alloc(size)
  let off = 0
  off = writeStr8(buf, off, game.id)
  off = writeStr8(buf, off, game.name)
  off = writeStr8(buf, off, game.version || '1.0.0')
  off = writeStr8(buf, off, game.startSequence || '')
  off = writeStr8(buf, off, game.activeVerbSet || '')
  off = writeStr8(buf, off, game.activeLanguage || 'es')
  const sys = game.systems || {}
  off = writeBool(buf, off, sys.rpgAttributes || false)
  off = writeBool(buf, off, sys.scrollRooms || false)
  off = writeBool(buf, off, sys.mapMode || false)
  off = writeBool(buf, off, sys.allowCharacterSwitch || false)
  off = writeBool(buf, off, sys.autosave || false)
  buf.writeUInt8(game.ui?.inventory?.rows    || 2, off); off += 1
  buf.writeUInt8(game.ui?.inventory?.columns || 4, off); off += 1
  buf.writeUInt16LE(256, off); off += 2
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = palette[i] || [0, 0, 0]
    buf.writeUInt8(r, off); off += 1
    buf.writeUInt8(g, off); off += 1
    buf.writeUInt8(b, off); off += 1
  }
  return buf.slice(0, off)
}

// ── Punto de entrada principal ────────────────────────────────────────────────

/**
 * Genera los 4 ficheros DAT del juego en el directorio de build.
 *
 * @param {string} gameDir   Directorio raíz del proyecto (contiene game.json)
 * @param {string} buildDir  Directorio de salida (se escriben los DAT aquí)
 * @param {function} log     Función de log: log(text, type?)
 * @returns {{ ok: boolean, files: string[], errors: string[] }}
 */
export async function generateDats(gameDir, buildDir, log) {
  const errors = []
  const files  = []

  function safeLog(msg, type = 'default') {
    log?.(msg, type)
  }

  function readJson(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      errors.push(`No se pudo leer ${path}: ${e.message}`)
      return null
    }
  }

  function listJsonDir(dir) {
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir).filter(f => f.endsWith('.json'))
    } catch { return [] }
  }

  // ── Leer game.json ────────────────────────────────────────────────────────
  const game = readJson(join(gameDir, 'game.json'))
  if (!game) return { ok: false, files, errors }

  safeLog('Leyendo datos del proyecto…')

  // ── SCRIPTS.DAT ───────────────────────────────────────────────────────────
  safeLog('Generando SCRIPTS.DAT…')
  {
    const blocks = []

    // game params
    blocks.push({
      id: 'game_params', resType: RES_TYPE.GAME_PARAMS,
      data: serializeGameParams(game), extra: 0,
    })

    // rooms
    const roomsDir = join(gameDir, 'rooms')
    if (existsSync(roomsDir)) {
      for (const entry of readdirSync(roomsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const room = readJson(join(roomsDir, entry.name, 'room.json'))
        if (!room) continue
        blocks.push({ id: room.id, resType: RES_TYPE.ROOM, data: serializeRoom(room) })
        safeLog(`  room: ${room.name || room.id}`)
      }
    }

    // objects
    for (const f of listJsonDir(join(gameDir, 'objects'))) {
      const obj = readJson(join(gameDir, 'objects', f))
      if (!obj) continue
      blocks.push({ id: obj.id, resType: RES_TYPE.OBJECT, data: serializeObject(obj) })
      safeLog(`  objeto: ${obj.name || obj.id}`)
    }

    // characters
    for (const f of listJsonDir(join(gameDir, 'characters'))) {
      const char = readJson(join(gameDir, 'characters', f))
      if (!char) continue
      blocks.push({ id: char.id, resType: RES_TYPE.CHARACTER, data: serializeChar(char) })
      safeLog(`  personaje: ${char.name || char.id}`)
    }

    // verbsets
    for (const f of listJsonDir(join(gameDir, 'verbsets'))) {
      const vs = readJson(join(gameDir, 'verbsets', f))
      if (!vs) continue
      blocks.push({ id: vs.id, resType: RES_TYPE.VERBSET, data: serializeVerbset(vs) })
      safeLog(`  verbset: ${vs.name || vs.id}`)
    }

    // dialogues
    for (const f of listJsonDir(join(gameDir, 'dialogues'))) {
      const dlg = readJson(join(gameDir, 'dialogues', f))
      if (!dlg) continue
      blocks.push({ id: dlg.id, resType: RES_TYPE.DIALOGUE, data: serializeDialogue(dlg) })
      safeLog(`  diálogo: ${dlg.name || dlg.id}`)
    }

    // scripts
    for (const f of listJsonDir(join(gameDir, 'scripts'))) {
      const scr = readJson(join(gameDir, 'scripts', f))
      if (!scr) continue
      blocks.push({ id: scr.id, resType: RES_TYPE.SCRIPT, data: serializeScript(scr) })
      safeLog(`  script: ${scr.name || scr.id}`)
    }

    // sequences
    for (const f of listJsonDir(join(gameDir, 'sequences'))) {
      const seq = readJson(join(gameDir, 'sequences', f))
      if (!seq) continue
      blocks.push({ id: seq.id, resType: RES_TYPE.SEQUENCE, data: serializeSequence(seq) })
      safeLog(`  secuencia: ${seq.name || seq.id}`)
    }

    // locales — los textos de secuencias ya están en los archivos de locale
    // (escritos directamente por el SequenceEditor via localeStore.setKey)
    const localesDir = join(gameDir, 'locales')
    if (existsSync(localesDir)) {
      for (const f of readdirSync(localesDir).filter(f => f.endsWith('.json'))) {
        const langCode = f.replace('.json', '')
        const locale   = readJson(join(localesDir, f))
        if (!locale) continue
        blocks.push({
          id: `locale_${langCode}`, resType: RES_TYPE.LOCALE,
          data: serializeLocale(langCode, locale),
        })
        safeLog(`  locale: ${langCode} (${Object.keys(locale).length} claves)`)
      }
    }

    const datBuf = buildDat(DAT_TYPE.SCRIPTS, blocks)
    const outPath = join(buildDir, 'SCRIPTS.DAT')
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, datBuf)
    const kb = (datBuf.length / 1024).toFixed(1)
    safeLog(`  SCRIPTS.DAT — ${blocks.length} recursos, ${kb} KB`, 'success')
    files.push(outPath)
  }

  // ── GRAPHICS.DAT ─────────────────────────────────────────────────────────
  safeLog('Generando GRAPHICS.DAT…')
  {
    const blocks = []
    const assetsDir = join(gameDir, 'assets', 'converted')

    // Backgrounds
    const bgDir = join(assetsDir, 'backgrounds')
    if (existsSync(bgDir)) {
      for (const f of readdirSync(bgDir).filter(f => f.toLowerCase().endsWith('.pcx'))) {
        try {
          const data = readFileSync(join(bgDir, f))
          blocks.push({ id: f.replace(/\.pcx$/i, ''), resType: RES_TYPE.BACKGROUND, data })
          safeLog(`  bg: ${f}`)
        } catch (e) { errors.push(`BG ${f}: ${e.message}`) }
      }
    }

    // Sprites (personajes / objetos)
    const spritesDir = join(assetsDir, 'sprites')
    if (existsSync(spritesDir)) {
      for (const f of readdirSync(spritesDir).filter(f => f.toLowerCase().endsWith('.pcx'))) {
        try {
          const data = readFileSync(join(spritesDir, f))
          blocks.push({ id: f.replace(/\.pcx$/i, ''), resType: RES_TYPE.SPRITE, data })
          safeLog(`  sprite: ${f}`)
        } catch (e) { errors.push(`Sprite ${f}: ${e.message}`) }
      }
    }

    // Generar variantes espejadas para animaciones de personajes con flipH/flipV
    // El codegen apunta a estos ids en lugar del original cuando hay flip
    {
      const charsDir = join(gameDir, 'characters')
      if (existsSync(charsDir)) {
        for (const f of readdirSync(charsDir).filter(f => f.endsWith('.json'))) {
          const ch = readJson(join(charsDir, f))
          if (!ch?.animations) continue
          for (const anim of ch.animations) {
            if (!anim.spriteFile) continue
            const needsFlipH = anim.flipH === true
            const needsFlipV = anim.flipV === true
            if (!needsFlipH && !needsFlipV) continue
            const pcxPath = join(assetsDir, 'sprites', anim.spriteFile)
            if (!existsSync(pcxPath)) continue
            try {
              const orig   = readFileSync(pcxPath)
              const flipped = flipPcxBuffer(orig, needsFlipH, needsFlipV)
              const baseName = anim.spriteFile.replace(/\.pcx$/i, '')
              const suffix   = (needsFlipH ? '_FH' : '') + (needsFlipV ? '_FV' : '')
              const flippedId = baseName + suffix
              // Solo añadir si no existe ya (evitar duplicados si varios roles usan la misma anim)
              if (!blocks.find(b => b.id === flippedId)) {
                blocks.push({ id: flippedId, resType: RES_TYPE.SPRITE, data: flipped })
                safeLog(`  sprite flip: ${flippedId} <- ${anim.spriteFile}${needsFlipH ? ' flipH' : ''}${needsFlipV ? ' flipV' : ''}`)
              }
            } catch (e) { errors.push(`SpriteFlip ${anim.spriteFile}: ${e.message}`) }
          }
        }
      }
    }

    // Objects PCX — cargar sprite por estado desde los JSON de objetos
    // El motor busca gfx_id = obj_id (ej: "obj_1741234567")
    // Para cada objeto: guardar sprite del estado activo con id = obj_id
    // y cada estado adicional con id = obj_id + "_" + stateId
    const objJsonDir = join(gameDir, 'objects')
    if (existsSync(objJsonDir)) {
      for (const f of readdirSync(objJsonDir).filter(f => f.endsWith('.json'))) {
        const obj = readJson(join(objJsonDir, f))
        if (!obj || !obj.states?.length) continue
        const assetsObjDir = join(assetsDir, 'objects')
        for (const st of obj.states) {
          if (!st.spriteFile) continue
          const pcxPath = join(assetsObjDir, st.spriteFile)
          if (!existsSync(pcxPath)) continue
          try {
            const data = readFileSync(pcxPath)
            const baseName = st.spriteFile.replace(/\.pcx$/i, '').slice(0, 27).toUpperCase()
            // Estado activo → id = "obj_POLLO" (coincide con lo que emite el codegen)
            // Otros estados → id = "obj_POLLO_stateId"
            const gfxId = (st.id === obj.activeStateId || obj.states.length === 1)
              ? `obj_${baseName}`
              : `obj_${baseName}_${st.id}`.slice(0, 31)
            blocks.push({ id: gfxId, resType: RES_TYPE.OBJECT_PCX, data })
            safeLog(`  obj sprite: ${gfxId} <- ${st.spriteFile}`)
          } catch (e) { errors.push(`ObjSprite ${obj.id}/${st.spriteFile}: ${e.message}`) }
        }
      }
    }

    // Flechas de inventario — sprites configurables desde el módulo Objetos
    // game.json: invArrows: { up, upHover, down, downHover } — rutas relativas a assets/converted/objects/
    // Se empaquetan con IDs fijos usados por el engine al cargar
    {
      const arrowMap = [
        { key: 'up',        id: 'inv_arrow_up'       },
        { key: 'upHover',   id: 'inv_arrow_up_hover'  },
        { key: 'down',      id: 'inv_arrow_down'      },
        { key: 'downHover', id: 'inv_arrow_down_hover' },
      ]
      const invArrows = game?.invArrows || {}
      const arrowAssetsDir = join(assetsDir, 'objects')
      for (const { key, id } of arrowMap) {
        const filename = invArrows[key]
        if (!filename) continue
        const pcxPath = join(arrowAssetsDir, filename)
        if (!existsSync(pcxPath)) { errors.push(`InvArrow ${id}: no encontrado: ${pcxPath}`); continue }
        try {
          const data = readFileSync(pcxPath)
          // Evitar duplicado si ya existe un bloque con el mismo id
          if (!blocks.find(b => b.id === id)) {
            blocks.push({ id, resType: RES_TYPE.OBJECT_PCX, data })
            safeLog(`  inv arrow: ${id} <- ${filename}`)
          }
        } catch (e) { errors.push(`InvArrow ${id}: ${e.message}`) }
      }
    }

    if (blocks.length === 0) {
      safeLog('  (sin gráficos PCX en el proyecto — DAT vacío)', 'warn')
    }

    const datBuf = buildDat(DAT_TYPE.GRAPHICS, blocks)
    const outPath = join(buildDir, 'GRAPHICS.DAT')
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, datBuf)
    const kb = (datBuf.length / 1024).toFixed(1)
    safeLog(`  GRAPHICS.DAT — ${blocks.length} recursos, ${kb} KB`, 'success')
    files.push(outPath)
  }

  // ── AUDIO.DAT ─────────────────────────────────────────────────────────────
  safeLog('Generando AUDIO.DAT…')
  {
    const blocks = []
    const audioDir = join(gameDir, 'audio')

    // Escanea un directorio plano añadiendo MIDIs y WAVs al array de bloques
    const _scanAudioDir = (dir) => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir)) {
        const lower = f.toLowerCase()
        try {
          const data = readFileSync(join(dir, f))
          if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
            blocks.push({ id: f.replace(/\.(mid|midi)$/i, ''), resType: RES_TYPE.MIDI, data })
            safeLog(`  MIDI: ${f}`)
          } else if (lower.endsWith('.wav')) {
            blocks.push({ id: f.replace(/\.wav$/i, ''), resType: RES_TYPE.SFX, data })
            safeLog(`  SFX: ${f}`)
          }
        } catch (e) { errors.push(`Audio ${f}: ${e.message}`) }
      }
    }

    // Raíz audio/ + subdirectorios midi/, music/, sfx/, voice/
    _scanAudioDir(audioDir)
    _scanAudioDir(join(audioDir, 'midi'))
    _scanAudioDir(join(audioDir, 'music'))
    _scanAudioDir(join(audioDir, 'sfx'))
    _scanAudioDir(join(audioDir, 'voice'))

    if (blocks.length === 0) {
      safeLog('  (sin audio en el proyecto — DAT vacío)', 'warn')
    }

    const datBuf = buildDat(DAT_TYPE.AUDIO, blocks)
    const outPath = join(buildDir, 'AUDIO.DAT')
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, datBuf)
    const kb = (datBuf.length / 1024).toFixed(1)
    safeLog(`  AUDIO.DAT — ${blocks.length} recursos, ${kb} KB`, 'success')
    files.push(outPath)
  }

  // ── FONTS.DAT ─────────────────────────────────────────────────────────────
  safeLog('Generando FONTS.DAT…')
  {
    const blocks = []
    const fontsDir = join(gameDir, 'assets', 'fonts')

    /* Generar fuentes base si no existen (small/medium/large) */
    ensureBaseFonts(fontsDir, safeLog)

    if (existsSync(fontsDir)) {
      for (const f of readdirSync(fontsDir).filter(f => f.toLowerCase().endsWith('.pcx'))) {
        try {
          const data = readFileSync(join(fontsDir, f))
          blocks.push({ id: f.replace(/\.pcx$/i, ''), resType: RES_TYPE.FONT_PCX, data })
          safeLog(`  font: ${f}`)
        } catch (e) { errors.push(`Font ${f}: ${e.message}`) }
      }
    }

    if (blocks.length === 0) {
      safeLog('  (sin fuentes en el proyecto — DAT vacío)', 'warn')
    }

    const datBuf = buildDat(DAT_TYPE.FONTS, blocks)
    const outPath = join(buildDir, 'FONTS.DAT')
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, datBuf)
    const kb = (datBuf.length / 1024).toFixed(1)
    safeLog(`  FONTS.DAT — ${blocks.length} recursos, ${kb} KB`, 'success')
    files.push(outPath)
  }

  // ── Resumen ───────────────────────────────────────────────────────────────
  const totalKb = files.reduce((sum, f) => {
    try { return sum + readFileSync(f).length } catch { return sum }
  }, 0) / 1024

  if (errors.length > 0) {
    safeLog(`⚠ ${errors.length} advertencia(s) durante la generación:`, 'warn')
    for (const e of errors) safeLog(`  · ${e}`, 'warn')
  }

  safeLog(`Distribución final: ${files.length} DAT, ${totalKb.toFixed(1)} KB total`, 'success')

  return { ok: true, files, errors }
}

/**
 * Exporta también las constantes de formato para que el motor C pueda
 * generar el .h de cabecera automáticamente si se desea.
 */
export { RES_TYPE, DAT_TYPE, FORMAT_VERSION, HEADER_SIZE, INDEX_ENTRY_SIZE }
