/**
 * @fileoverview Builder de fixtures deterministas para tests de codegen.
 *
 * Genera ficheros binarios pequeños (PCX, MIDI, WAV) y JSON de juego.
 * Idempotente: dos invocaciones consecutivas producen los mismos bytes.
 *
 * Run:
 *   node tests/fixtures/builder.mjs
 *
 * Output:
 *   tests/fixtures/minimal/   (game.json + dirs + binarios)
 *   tests/fixtures/midgame/   (TODO: phase 1.5)
 *
 * Los ficheros se commitean al repo. Si necesitas regenerarlos, ejecuta
 * este script. La idea: un humano lee este script para entender QUE hay
 * en el fixture, no inspecciona los binarios.
 */
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = __dirname

// ── Binarios deterministas ────────────────────────────────────────────────

/**
 * Genera un PCX 8-bit indexado (formato VGA mode 13h compatible).
 * @param {number} w  ancho en pixels
 * @param {number} h  alto en pixels
 * @param {Buffer} palette  768 bytes RGB (256 colores × 3)
 * @param {Buffer} pixels   w*h bytes (1 byte por pixel = índice paleta)
 */
function makePCX(w, h, palette, pixels) {
  if (palette.length !== 768) throw new Error('la paleta debe tener 768 bytes')
  if (pixels.length !== w * h) throw new Error(`pixels debe tener ${w*h} bytes`)

  const hdr = Buffer.alloc(128, 0)
  hdr[0] = 0x0A      // manufacturer
  hdr[1] = 0x05      // version 5 (256-color VGA)
  hdr[2] = 0x01      // RLE encoding
  hdr[3] = 0x08      // 8 bits per pixel
  hdr.writeUInt16LE(0,       4)   // xmin
  hdr.writeUInt16LE(0,       6)   // ymin
  hdr.writeUInt16LE(w - 1,   8)   // xmax
  hdr.writeUInt16LE(h - 1,  10)   // ymax
  hdr.writeUInt16LE(72,     12)   // hdpi
  hdr.writeUInt16LE(72,     14)   // vdpi
  hdr[65] = 1                      // color planes
  hdr.writeUInt16LE(w,      66)   // bytes per line
  hdr.writeUInt16LE(1,      68)   // palette type

  // RLE encoding del bloque de pixels
  const rle = []
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      const v = pixels[y * w + x]
      let cnt = 1
      while (cnt < 63 && x + cnt < w && pixels[y * w + x + cnt] === v) cnt++
      if (cnt > 1 || (v & 0xC0) === 0xC0) { rle.push(0xC0 | cnt, v) }
      else                                 { rle.push(v) }
      x += cnt
    }
  }

  // Concatenar: header + RLE + 0x0C marker + 768B palette
  return Buffer.concat([
    hdr,
    Buffer.from(rle),
    Buffer.from([0x0C]),
    palette,
  ])
}

/**
 * Genera un MIDI Format 0 minimo: 1 nota C4 (60) on, off tras 480 ticks.
 * Total ~30 bytes.
 */
function makeMIDI() {
  // Header chunk
  const hdr = Buffer.from([
    0x4D, 0x54, 0x68, 0x64,             // 'MThd'
    0x00, 0x00, 0x00, 0x06,             // chunk length = 6
    0x00, 0x00,                         // format 0
    0x00, 0x01,                         // 1 track
    0x01, 0xE0,                         // ticks per quarter = 480
  ])
  // Track: tempo + note on + note off + end of track
  const trkBody = Buffer.from([
    0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,   // tempo 500000 (120 bpm)
    0x00, 0x90, 0x3C, 0x40,                       // note on C4 vel=64
    0x83, 0x60, 0x80, 0x3C, 0x40,                 // delta=480, note off C4
    0x00, 0xFF, 0x2F, 0x00,                       // end of track
  ])
  const trkHdr = Buffer.alloc(8)
  trkHdr.write('MTrk', 0, 4, 'ascii')
  trkHdr.writeUInt32BE(trkBody.length, 4)
  return Buffer.concat([hdr, trkHdr, trkBody])
}

/**
 * Genera un WAV mono 8-bit unsigned 11025Hz, 0.1s = 1102 samples.
 * Datos: silencio (0x80 = sample value 0 unsigned).
 */
function makeWAV() {
  const samples   = 1102
  const sampleRate = 11025
  const data = Buffer.alloc(samples, 0x80)

  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 4, 'ascii')
  fmt.writeUInt32LE(16, 4)        // chunk size
  fmt.writeUInt16LE(1,  8)        // PCM
  fmt.writeUInt16LE(1, 10)        // mono
  fmt.writeUInt32LE(sampleRate,    12)
  fmt.writeUInt32LE(sampleRate,    16)  // byte rate (sr * 1ch * 1B)
  fmt.writeUInt16LE(1,  20)       // block align
  fmt.writeUInt16LE(8,  22)       // bits per sample

  const dataChunk = Buffer.alloc(8 + samples)
  dataChunk.write('data', 0, 4, 'ascii')
  dataChunk.writeUInt32LE(samples, 4)
  data.copy(dataChunk, 8)

  const riffSize = 4 + fmt.length + dataChunk.length
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 4, 'ascii')
  riff.writeUInt32LE(riffSize, 4)
  const wave = Buffer.from('WAVE', 'ascii')

  return Buffer.concat([riff, wave, fmt, dataChunk])
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function writeJSON(path, obj) {
  ensureDir(dirname(path))
  // 2-space indent, sorted keys, trailing newline -- todo deterministico
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function writeBinary(path, buf) {
  ensureDir(dirname(path))
  writeFileSync(path, buf)
}

// ── Paleta determinista (256 colores) ─────────────────────────────────────
// Color 0 = transparente (negro), 1 = blanco, 2..15 = ramp 16-step grises,
// 16..255 = patron determinista para no quedar todo a 0.
function buildPalette() {
  const pal = Buffer.alloc(768)
  // negro
  pal[0] = 0;   pal[1] = 0;   pal[2] = 0
  // blanco
  pal[3] = 255; pal[4] = 255; pal[5] = 255
  // gris ramp 14 pasos
  for (let i = 2; i < 16; i++) {
    const v = Math.round((i - 1) * 255 / 14)
    pal[i*3] = v; pal[i*3 + 1] = v; pal[i*3 + 2] = v
  }
  // patron R/G/B en el resto
  for (let i = 16; i < 256; i++) {
    pal[i*3]     = (i * 7)  & 0xFF
    pal[i*3 + 1] = (i * 11) & 0xFF
    pal[i*3 + 2] = (i * 13) & 0xFF
  }
  return pal
}

// ── Fixture: minimal ──────────────────────────────────────────────────────

function buildMinimal() {
  const root = join(FIXTURES_DIR, 'minimal')

  // Limpiar directorio antes de regenerar (idempotencia)
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true })
  }
  ensureDir(root)

  // ── Paleta y pixels deterministas ──
  const palette = buildPalette()

  // Background 32×16 con un gradiente
  const bgPixels = Buffer.alloc(32 * 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 32; x++) {
      bgPixels[y * 32 + x] = ((x + y) & 0xFF)
    }
  }
  writeBinary(join(root, 'assets/converted/backgrounds/BG_001.PCX'),
              makePCX(32, 16, palette, bgPixels))

  // Sprite 16×16 (lo más sencillo posible)
  const sprPixels = Buffer.alloc(16 * 16, 0)
  for (let y = 0; y < 16; y++) sprPixels[y * 16 + (y % 16)] = 1  // diagonal blanca
  writeBinary(join(root, 'assets/converted/sprites/SPR_HERO.PCX'),
              makePCX(16, 16, palette, sprPixels))

  // Object PCX (16×16)
  const objPixels = Buffer.alloc(16 * 16, 0)
  for (let y = 4; y < 12; y++) {
    for (let x = 4; x < 12; x++) objPixels[y * 16 + x] = 14  // bloque gris claro
  }
  writeBinary(join(root, 'assets/converted/objects/OBJ_KEY.PCX'),
              makePCX(16, 16, palette, objPixels))

  // Audio
  writeBinary(join(root, 'audio/music/MUS_INTRO.MID'), makeMIDI())
  writeBinary(join(root, 'audio/sfx/SFX_PICKUP.WAV'),  makeWAV())

  // ── game.json ──
  // Convertir paleta de Buffer a array [[r,g,b], ...] como espera el codegen
  const paletteArr = []
  for (let i = 0; i < 256; i++) {
    paletteArr.push([palette[i*3], palette[i*3+1], palette[i*3+2]])
  }
  writeJSON(join(root, 'game.json'), {
    id: 'minimal',
    name: 'Fixture Minimal',
    version: '1.0.0',
    startSequence: 'seq_intro',
    activeVerbSet: 'vs_default',
    activeLanguage: 'es',
    languages: ['es', 'en'],
    systems: {
      rpgAttributes: false,
      scrollRooms: false,
      mapMode: false,
      allowCharacterSwitch: false,
      autosave: true,
    },
    ui: { inventory: { rows: 2, columns: 4 } },
    palette: paletteArr,
    walkmapCellSize: 8,
  })

  // ── Room ──
  writeJSON(join(root, 'rooms/room_001/room.json'), {
    id:               'room_001',
    name:             'taberna',
    backgroundFilePath: 'BG_001.PCX',
    backgroundSize:   { w: 320, h: 144 },
    scroll:           { enabled: false },
    exits: [],
    entries: [
      { id: 'entry_default', x: 160, y: 100 },
    ],
    objects: [
      { id: 'inst_obj_key_001', objectId: 'obj_key', x: 120, y: 110 },
    ],
    characters: [
      { id: 'cinst_hero_001', charId: 'char_hero', x: 80, y: 110 },
    ],
    walkmaps: [
      {
        id: 'wm_default',
        shapes: [
          { type: 'rect',    points: [{x: 0, y: 80}, {x: 320, y: 144}] },
          { type: 'polygon', points: [{x: 50, y: 90}, {x: 100, y: 90}, {x: 75, y: 130}] },
        ],
      },
    ],
    audio: { midi: 'MUS_INTRO' },
  })

  // ── Object ──
  writeJSON(join(root, 'objects/obj_key.json'), {
    id:          'obj_key',
    name:        'Llave',
    description: 'Una llave oxidada.',
    isPickable:  true,
    isUsable:    true,
    isVisible:   true,
    spriteFile:  'OBJ_KEY.PCX',
    activeStateId: 'st_default',
    states: [
      { id: 'st_default', spriteFile: 'OBJ_KEY.PCX' },
    ],
    verbOverrides: [
      { verbId: 'vrb_use', scriptId: 'scr_use_key' },
    ],
    defaultScript: '',
  })

  // ── Character ──
  writeJSON(join(root, 'characters/char_hero.json'), {
    id:            'char_hero',
    name:          'Héroe',
    isProtagonist: true,
    walkSpeed:     2,
    dialogueId:    'dlg_intro',
    animations: [
      { id: 'anim_idle', name: 'Idle', pcxFile: 'SPR_HERO.PCX',
        frameWidth: 16, frameCount: 1, fps: 8, loop: true },
    ],
  })

  // ── Verbset ──
  writeJSON(join(root, 'verbsets/vs_default.json'), {
    id:   'vs_default',
    name: 'Default Verbs',
    verbs: [
      { id: 'vrb_walk',    label: 'Ir a',  isMovement: true, screenX: 0,  screenY: 0,  normalColor: 15, hoverColor: 14 },
      { id: 'vrb_use',     label: 'Usar',  approachObject: true,  screenX: 0,  screenY: 10, normalColor: 15, hoverColor: 14 },
      { id: 'vrb_pick',    label: 'Coger', isPickup: true,        screenX: 0,  screenY: 20, normalColor: 15, hoverColor: 14 },
    ],
  })

  // ── Dialogue ──
  writeJSON(join(root, 'dialogues/dlg_intro.json'), {
    id:      'dlg_intro',
    name:    'Diálogo intro',
    actorId: 'char_hero',
    nodes: [
      { id: 'n_start', type: 'start',  outputs: [{ targetNodeId: 'n_line_1' }] },
      { id: 'n_line_1', type: 'line',
        data: { text: 'Hola, mundo.' },
        outputs: [{ targetNodeId: 'n_choice_1' }] },
      { id: 'n_choice_1', type: 'choice',
        outputs: [
          { label: 'Adiós', targetNodeId: 'n_end' },
          { label: 'Más',   targetNodeId: 'n_line_1', condFlag: 'has_seen_intro', condValue: false },
        ] },
      { id: 'n_end', type: 'end' },
    ],
  })

  // ── Script ──
  // NOTA: conditions[] e instructions[] vacios temporalmente -- ver Finding #4
  // en .claude/plans/0001-test-suite-and-tdd-setup.md (bug en serializeScript:
  // size-calc espera i.p1/p2/p3/p4 pero writer usa Object.entries(i) -> overflow
  // o data loss en cualquier instruccion realista). Una vez fixeado el bug, el
  // fixture midgame ejercitara el camino completo.
  writeJSON(join(root, 'scripts/scr_use_key.json'), {
    id:   'scr_use_key',
    name: 'Usar llave',
    triggers: [
      {
        type: 'verb_object',
        param1: 'vrb_use',
        param2: 'obj_key',
        conditions:   [],
        instructions: [],
      },
    ],
  })

  // ── Sequence ──
  writeJSON(join(root, 'sequences/seq_intro.json'), {
    id:   'seq_intro',
    name: 'Intro sequence',
    steps: [
      { type: 'load_room' || 'show_text', roomId: 'room_001' },
      { type: 'show_text', blocking: true, texts: { es: 'Bienvenido', en: 'Welcome' } },
      { type: 'wait',      ms: 500 },
    ],
  })

  // ── Locales ──
  writeJSON(join(root, 'locales/es.json'), {
    'intro_greeting': 'Hola',
    'door_locked':    'La puerta está cerrada.',
  })
  writeJSON(join(root, 'locales/en.json'), {
    'intro_greeting': 'Hello',
    'door_locked':    'The door is locked.',
  })

  // ── Mensaje final ──
  console.log(`fixture minimal: ${root}`)
}

// ── Main ──────────────────────────────────────────────────────────────────

buildMinimal()
