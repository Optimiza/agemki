import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, renameSync, copyFileSync } from 'fs'
import { generateSfxDat } from './sfxGenerator.js'

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC: Diálogos del sistema ─────────────────────────────────────────────────

// Elegir carpeta donde crear un juego nuevo
ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Elegir carpeta para el nuevo juego'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Abrir un juego existente (seleccionar su carpeta)
ipcMain.handle('dialog:open-game', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Abrir juego existente'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// Abrir un fichero con filtros (para importar assets)
ipcMain.handle('dialog:open-file', async (_event, { title, filters }) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: title || 'Seleccionar fichero',
    filters: filters || [{ name: 'Todos', extensions: ['*'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ── IPC: Operaciones de juego ─────────────────────────────────────────────────

// Crear juego nuevo en la carpeta indicada
ipcMain.handle('game:create', async (_event, { folderPath, name }) => {
  try {
    const id = `game_${Date.now()}`
    const gameDir = join(folderPath, id)

    // Crear estructura de carpetas
    const dirs = [
      gameDir,
      join(gameDir, 'rooms'),
      join(gameDir, 'characters'),
      join(gameDir, 'objects'),
      join(gameDir, 'dialogues'),
      join(gameDir, 'scripts'),
      join(gameDir, 'verbsets'),
      join(gameDir, 'sequences'),
      join(gameDir, 'locales'),
      join(gameDir, 'assets', 'converted', 'backgrounds'),
      join(gameDir, 'assets', 'converted', 'sprites'),
      join(gameDir, 'assets', 'converted', 'objects'),
      join(gameDir, 'assets', 'converted', 'fonts'),
      join(gameDir, 'assets', 'audio'),
      join(gameDir, '.cache'),
      join(gameDir, 'build'),
    ]
    dirs.forEach(d => mkdirSync(d, { recursive: true }))

    // game.json con paleta maestra por defecto
    const gameJson = buildDefaultGameJson(id, name)
    writeFileSync(join(gameDir, 'game.json'), JSON.stringify(gameJson, null, 2), 'utf8')

    // flags.json vacío
    writeFileSync(join(gameDir, 'flags.json'), JSON.stringify({ flags: [] }, null, 2), 'utf8')

    // locales vacíos
    writeFileSync(join(gameDir, 'locales', 'es.json'), JSON.stringify({}, null, 2), 'utf8')
    writeFileSync(join(gameDir, 'locales', 'en.json'), JSON.stringify({}, null, 2), 'utf8')

    return { ok: true, gameDir, game: gameJson }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Leer game.json de un juego
ipcMain.handle('game:read', async (_event, { gameDir }) => {
  try {
    const gameJsonPath = join(gameDir, 'game.json')
    if (!existsSync(gameJsonPath)) return { ok: false, error: 'No existe game.json en esa carpeta' }
    const game = JSON.parse(readFileSync(gameJsonPath, 'utf8'))
    return { ok: true, game }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Guardar game.json
ipcMain.handle('game:save', async (_event, { gameDir, game }) => {
  try {
    game.modified = new Date().toISOString().split('T')[0]
    writeFileSync(join(gameDir, 'game.json'), JSON.stringify(game, null, 2), 'utf8')
    return { ok: true, game }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Renombrar juego (solo cambia el campo name en game.json)
ipcMain.handle('game:rename', async (_event, { gameDir, name }) => {
  try {
    const gameJsonPath = join(gameDir, 'game.json')
    const game = JSON.parse(readFileSync(gameJsonPath, 'utf8'))
    game.name = name
    game.modified = new Date().toISOString().split('T')[0]
    writeFileSync(gameJsonPath, JSON.stringify(game, null, 2), 'utf8')
    return { ok: true, game }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Eliminar juego (borra la carpeta entera)
ipcMain.handle('game:delete', async (_event, { gameDir }) => {
  try {
    if (!existsSync(gameDir)) return { ok: false, error: 'La carpeta no existe' }
    rmSync(gameDir, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Verificar si una carpeta es un juego válido (tiene game.json)
ipcMain.handle('game:verify', async (_event, { gameDir }) => {
  try {
    const exists = existsSync(join(gameDir, 'game.json'))
    return { ok: true, valid: exists }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Assets ──────────────────────────────────────────────────────────────


// ── IPC: Rooms ───────────────────────────────────────────────────────────────


// ── IPC: Objects (biblioteca global) ─────────────────────────────────────────

ipcMain.handle('object:list', async (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'objects')
    console.log('[object:list] dir=', dir, 'exists=', existsSync(dir))
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    console.log('[object:list] files=', files)
    const objects = files.map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      catch { return null }
    }).filter(Boolean)
    objects.sort((a, b) => (a.created || '').localeCompare(b.created || ''))
    return { ok: true, objects }
  } catch (err) {
    console.error('[object:list] ERROR', err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('object:create', async (_event, { gameDir, name, type }) => {
  try {
    console.log('[object:create] gameDir=', gameDir, 'name=', name)
    const dir = join(gameDir, 'objects')
    mkdirSync(dir, { recursive: true })
    const id = `obj_${Date.now()}`
    const now = new Date().toISOString().split('T')[0]
    const obj = {
      id, name, type: type || 'scenery',
      detectable: true,
      states: [{ id: 'state_default', name: 'default', spriteFile: null, frameCount: 1 }],
      activeStateId: 'state_default',
      verbActions: [],
      verbResponses: [],
      invVerbResponses: [],
      combinations: [],
      flags: [],
      coverageZone: null,
      created: now, modified: now
    }
    const filePath = join(dir, `${id}.json`)
    writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8')
    console.log('[object:create] wrote', filePath)
    return { ok: true, object: obj }
  } catch (err) {
    console.error('[object:create] ERROR', err.message, 'gameDir=', gameDir)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('object:save', async (_event, { gameDir, object }) => {
  try {
    const dir = join(gameDir, 'objects')
    mkdirSync(dir, { recursive: true })
    object.modified = new Date().toISOString().split('T')[0]
    const filePath = join(dir, `${object.id}.json`)
    writeFileSync(filePath, JSON.stringify(object, null, 2), 'utf8')
    console.log('[object:save] wrote', filePath)
    return { ok: true, object }
  } catch (err) {
    console.error('[object:save] ERROR', err.message, 'gameDir=', gameDir)
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('object:delete', async (_event, { gameDir, objectId }) => {
  try {
    const p = join(gameDir, 'objects', `${objectId}.json`)
    if (existsSync(p)) rmSync(p)
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('object:duplicate', async (_event, { gameDir, objectId }) => {
  try {
    const src = JSON.parse(readFileSync(join(gameDir, 'objects', `${objectId}.json`), 'utf8'))
    const newId = `obj_${Date.now()}`
    const now = new Date().toISOString().split('T')[0]
    const copy = { ...src, id: newId, name: src.name + ' (copia)', created: now, modified: now }
    writeFileSync(join(gameDir, 'objects', `${newId}.json`), JSON.stringify(copy, null, 2), 'utf8')
    return { ok: true, object: copy }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('room:list', async (_event, { gameDir }) => {
  try {
    const roomsDir = join(gameDir, 'rooms')
    if (!existsSync(roomsDir)) return { ok: true, rooms: [] }
    const entries = readdirSync(roomsDir, { withFileTypes: true })
    const rooms = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const jsonPath = join(roomsDir, entry.name, 'room.json')
      if (!existsSync(jsonPath)) continue
      const room = JSON.parse(readFileSync(jsonPath, 'utf8'))
      rooms.push(room)
    }
    rooms.sort((a, b) => a.created.localeCompare(b.created))
    return { ok: true, rooms }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('room:create', async (_event, { gameDir, name }) => {
  try {
    const id = `room_${Date.now()}`
    const roomDir = join(gameDir, 'rooms', id)
    mkdirSync(roomDir, { recursive: true })
    const now = new Date().toISOString().split('T')[0]
    const wm0id = `wm_${Date.now()}`
    const room = {
      id, name,
      backgroundFilePath: null,
      backgroundSize: { w: 320, h: 144 },
      fullscreen: false,
      scroll: { enabled: false, directionH: true, directionV: false, totalW: 320, totalH: 144, cameraSpeed: 1.0 },
      camera: { followProtagonist: true, offsetX: 0, offsetY: 0 },
      walkmaps: [{ id: wm0id, name: 'default', shapes: [] }],
      activeWalkmapId: wm0id,
      objects: [], characters: [], exits: [],
      entries: [{ id: 'entry_default', x: 160, y: 100 }],
      lights: [], effects: [],
      audio: { midi: null },
      created: now, modified: now
    }
    writeFileSync(join(roomDir, 'room.json'), JSON.stringify(room, null, 2), 'utf8')
    return { ok: true, room }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('room:read', async (_event, { gameDir, roomId }) => {
  try {
    const jsonPath = join(gameDir, 'rooms', roomId, 'room.json')
    if (!existsSync(jsonPath)) return { ok: false, error: 'room.json no encontrado' }
    const room = JSON.parse(readFileSync(jsonPath, 'utf8'))
    return { ok: true, room }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('room:save', async (_event, { gameDir, room }) => {
  try {
    room.modified = new Date().toISOString().split('T')[0]
    const jsonPath = join(gameDir, 'rooms', room.id, 'room.json')
    writeFileSync(jsonPath, JSON.stringify(room, null, 2), 'utf8')
    return { ok: true, room }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('room:delete', async (_event, { gameDir, roomId }) => {
  try {
    const roomDir = join(gameDir, 'rooms', roomId)
    if (existsSync(roomDir)) rmSync(roomDir, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('room:duplicate', async (_event, { gameDir, roomId }) => {
  try {
    const srcPath = join(gameDir, 'rooms', roomId, 'room.json')
    const src = JSON.parse(readFileSync(srcPath, 'utf8'))
    const newId = `room_${Date.now()}`
    const newDir = join(gameDir, 'rooms', newId)
    mkdirSync(newDir, { recursive: true })
    const now = new Date().toISOString().split('T')[0]
    const newRoom = { ...src, id: newId, name: src.name + ' (copia)', created: now, modified: now }
    writeFileSync(join(newDir, 'room.json'), JSON.stringify(newRoom, null, 2), 'utf8')
    return { ok: true, room: newRoom }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:write-binary', async (_event, { filePath, buffer }) => {
  try {
    writeFileSync(filePath, Buffer.from(buffer))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:read-binary', async (_event, { filePath }) => {
  try {
    if (!existsSync(filePath)) return { ok: false, error: 'Fichero no encontrado' }
    const buf = readFileSync(filePath)
    return { ok: true, buffer: Array.from(buf) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:list-assets', async (_event, { gameDir, type }) => {
  try {
    const dir = join(gameDir, 'assets', 'converted', type)
    if (!existsSync(dir)) return { ok: true, files: [] }
    const files = readdirSync(dir)
      .filter(f => f.toUpperCase().endsWith('.PCX'))
      .map(f => ({ name: f, path: join(dir, f) }))
    return { ok: true, files }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:delete-asset', async (_event, { filePath }) => {
  try {
    if (existsSync(filePath)) rmSync(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* Listar ficheros de fuentes del proyecto (assets/fonts/) */
ipcMain.handle('font:list', async (_event, { gameDir }) => {
  try {
    const fontsDir = join(gameDir, 'assets', 'fonts')
    if (!existsSync(fontsDir)) return { ok: true, files: [] }
    const files = readdirSync(fontsDir)
      .filter(f => f.toUpperCase().endsWith('.PCX'))
      .map(f => ({ name: f, path: join(fontsDir, f) }))
    return { ok: true, files }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* Importar un PCX como fuente de un slot (small/medium/large).
 * Abre el diálogo de selección, copia el fichero elegido a assets/fonts/<slot>.pcx */
ipcMain.handle('font:import-slot', async (_event, { gameDir, slot }) => {
  try {
    const result = await dialog.showOpenDialog({
      title: `Seleccionar PCX para fuente "${slot}"`,
      properties: ['openFile'],
      filters: [{ name: 'PCX Bitmap', extensions: ['pcx', 'PCX'] }],
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    const src = result.filePaths[0]
    const fontsDir = join(gameDir, 'assets', 'fonts')
    if (!existsSync(fontsDir)) mkdirSync(fontsDir, { recursive: true })
    const dest = join(fontsDir, `${slot}.pcx`)
    copyFileSync(src, dest)
    return { ok: true, filename: `${slot}.pcx` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/* Busca usos de un fichero PCX en todas las secuencias del proyecto.
 * Devuelve array de { seqId, seqName, stepId, stepType } */
ipcMain.handle('fs:find-asset-uses', async (_event, { gameDir, fileName }) => {
  try {
    const seqDir = join(gameDir, 'sequences')
    const uses = []
    if (!existsSync(seqDir)) return { ok: true, uses }
    const files = readdirSync(seqDir).filter(f => f.endsWith('.json'))
    for (const f of files) {
      let seq
      try { seq = JSON.parse(readFileSync(join(seqDir, f), 'utf8')) } catch { continue }
      for (const step of (seq.steps || [])) {
        const pcxFields = [step.bgFile, step.pcxFile]
        for (const val of pcxFields) {
          if (val && (val === fileName || val.replace(/\.PCX$/i,'') === fileName.replace(/\.PCX$/i,''))) {
            uses.push({ seqId: seq.id, seqName: seq.name || seq.id, stepId: step.id, stepType: step.type })
          }
        }
      }
    }
    return { ok: true, uses }
  } catch (err) {
    return { ok: false, error: err.message, uses: [] }
  }
})

/* Elimina pasos concretos de una secuencia */
ipcMain.handle('fs:remove-seq-steps', async (_event, { gameDir, removals }) => {
  /* removals: [{ seqId, stepId }] */
  try {
    const seqDir = join(gameDir, 'sequences')
    const bySeq = {}
    for (const r of removals) {
      if (!bySeq[r.seqId]) bySeq[r.seqId] = []
      bySeq[r.seqId].push(r.stepId)
    }
    for (const [seqId, stepIds] of Object.entries(bySeq)) {
      const path = join(seqDir, `${seqId}.json`)
      if (!existsSync(path)) continue
      const seq = JSON.parse(readFileSync(path, 'utf8'))
      seq.steps = (seq.steps || []).filter(s => !stepIds.includes(s.id))
      writeFileSync(path, JSON.stringify(seq, null, 2), 'utf8')
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:resolve-pcx-name', async (_event, { gameDir, type, name }) => {
  try {
    const dir = join(gameDir, 'assets', 'converted', type)
    let base = name.replace(/\.PCX$/i, '')
    let candidate = base.slice(0, 8) + '.PCX'
    let counter = 2
    while (existsSync(join(dir, candidate))) {
      const suffix = String(counter)
      candidate = base.slice(0, 8 - suffix.length) + suffix + '.PCX'
      counter++
    }
    return { ok: true, name: candidate, path: join(dir, candidate) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── Paleta maestra por defecto ────────────────────────────────────────────────

const DEFAULT_PALETTE = [
  [255,0,255],[15,15,15],[32,32,32],[49,49,49],[66,66,66],[83,83,83],[100,100,100],[117,117,117],
  [134,134,134],[151,151,151],[168,168,168],[185,185,185],[202,202,202],[219,219,219],[236,236,236],[255,255,255],
  [20,60,140],[30,77,157],[40,94,174],[50,111,191],[60,128,208],[70,145,215],[80,160,220],[88,165,222],
  [96,171,225],[114,182,232],[132,193,239],[150,202,246],[155,205,248],[163,208,251],[167,209,253],[170,210,255],
  [10,10,40],[17,13,53],[24,16,66],[30,20,80],[52,27,53],[73,33,26],[120,40,0],[152,55,5],
  [183,70,10],[220,100,20],[228,115,35],[236,130,50],[244,150,65],[250,165,72],[253,173,76],[255,180,80],
  [10,30,10],[13,37,12],[16,44,14],[20,60,15],[27,73,17],[33,86,18],[40,100,20],[52,116,24],
  [63,133,27],[70,150,30],[95,166,41],[118,182,50],[129,191,55],[133,194,57],[137,197,58],[140,200,60],
  [40,25,10],[60,38,16],[80,55,25],[100,70,34],[120,85,43],[140,100,50],[160,120,63],[175,133,72],
  [190,147,80],[200,160,90],[206,170,105],[212,180,120],[215,185,128],[218,192,136],[219,196,143],[220,200,150],
  [30,25,20],[43,35,28],[57,47,38],[70,60,50],[82,70,58],[95,82,68],[120,110,90],[60,35,10],
  [73,46,16],[86,57,21],[100,65,25],[120,82,36],[133,90,42],[146,98,47],[153,104,51],[160,110,55],
  [0,20,60],[0,30,76],[0,40,93],[0,50,110],[0,66,126],[0,83,143],[0,100,160],[6,116,173],
  [12,133,186],[20,160,200],[40,177,212],[60,193,223],[65,198,225],[70,202,227],[75,206,229],[80,210,230],
  [20,15,15],[30,22,20],[40,30,26],[50,40,35],[63,50,44],[76,60,53],[90,75,65],[80,40,20],
  [96,53,27],[112,66,34],[130,75,40],[140,84,42],[50,38,25],[60,48,32],[70,56,38],[80,65,45],
  [80,20,0],[106,33,0],[133,46,0],[160,60,0],[180,80,0],[200,100,0],[220,120,0],[232,145,5],
  [244,170,10],[255,200,20],[255,210,65],[255,220,110],[255,228,130],[255,232,143],[255,236,152],[255,240,160],
  [200,130,90],[213,147,110],[226,165,130],[240,190,150],[244,198,160],[248,206,170],[252,213,180],[255,220,190],
  [160,90,50],[173,103,63],[186,116,70],[200,130,80],[208,140,90],[219,152,100],[224,158,105],[230,165,110],
  [80,45,20],[93,55,26],[106,65,30],[120,75,35],[133,85,43],[146,95,49],[153,100,52],[160,105,55],
  [180,0,0],[220,30,30],[120,0,0],[0,140,0],[40,180,40],[0,80,0],[0,80,200],[60,130,240],
  [0,40,120],[160,0,160],[200,60,200],[200,160,0],[240,220,0],[200,80,0],[240,130,40],[255,255,255],
  [10,5,0],[30,15,5],[60,35,10],[90,55,20],[130,85,35],[170,120,55],[200,160,80],[230,200,110],
  [255,230,150],[200,60,20],[230,100,40],[150,150,150],[200,200,200],[20,10,30],[100,60,120],[20,80,60],
  [0,60,40],[0,100,70],[0,140,100],[200,220,255],[220,235,255],[240,248,255],[255,200,200],[255,220,220],
  [180,220,180],[200,240,200],[255,240,200],[255,248,220],[220,200,255],[240,220,255],[255,180,100],[255,200,130],
  [255,215,160],[100,80,60],[120,100,80],[140,120,100],[160,140,120],[60,20,0],[80,30,5],[100,40,10],
  [120,50,15],[0,0,80],[0,0,120],[0,0,160],[20,20,200],[0,120,120],[0,160,160],[0,200,200],
  [120,120,0],[160,160,0],[200,200,0],[120,0,120],[160,0,160],[40,0,0],[80,0,0],[160,0,0],
  [200,0,0],[0,40,0],[0,80,0],[0,160,0],[0,200,0],[0,0,40],[0,0,80],[0,0,160],
  [0,0,200],[20,20,20],[40,40,40],[60,60,60],[80,80,80],[160,160,160],[180,180,180],[210,210,210]
]

function buildDefaultGameJson(id, name) {
  const now = new Date().toISOString().split('T')[0]
  return {
    id,
    name,
    version: '1.0.0',
    created: now,
    modified: now,
    palette: DEFAULT_PALETTE,
    protagonists: [],
    activeProtagonist: null,
    allowCharacterSwitch: false,
    startSequence: null,
    activeVerbSet: null,
    activeLanguage: 'es',
    ui: { inventory: { rows: 2, columns: 4 } },
    systems: {
      rpgAttributes: false,
      scrollRooms: false,
      mapMode: false,
      autosave: false
    },
    audio: {
      /* Driver AIL2 — ficheros a distribuir junto al juego.
         driver_adv opciones: ADLIB.ADV | SBFM.ADV | GENMID.ADV | MT32MPU.ADV | PCSPKR.ADV | "" = sin audio
         driver_patches solo para drivers FM: ADLIB.AD | STDPATCH.AD | etc. */
      driver_adv:     'ADLIB.ADV',
      driver_patches: 'ADLIB.AD',
      music_volume:   100,
      sfx_volume:     100,
    }
  }
}

// ── Verbsets ──────────────────────────────────────────────────────────────────

ipcMain.handle('verbset:list', async (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'verbsets')
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const verbsets = files.map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      catch { return null }
    }).filter(Boolean)
    verbsets.sort((a, b) => (a.created || '').localeCompare(b.created || ''))
    return { ok: true, verbsets }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('verbset:create', async (_event, { gameDir, name }) => {
  try {
    const dir = join(gameDir, 'verbsets')
    mkdirSync(dir, { recursive: true })
    const vsId = `verbset_${Date.now()}`
    const now  = new Date().toISOString().split('T')[0]
    const t    = Date.now()
    // 9 verbos canónicos SCUMM + Ir a (isMovement)
    const verbs = [
      { id: `${vsId}_mirar`,   icon: '👁',  isMovement: false, isDefault: false, approachObject: true,  order: 0 },
      { id: `${vsId}_coger`,   icon: '🖐',  isMovement: false, isDefault: false, approachObject: true,  isPickup: true, order: 1 },
      { id: `${vsId}_usar`,    icon: '⚙️',  isMovement: false, isDefault: true,  approachObject: true,  order: 2 },
      { id: `${vsId}_abrir`,   icon: '🚪',  isMovement: false, isDefault: false, approachObject: true,  order: 3 },
      { id: `${vsId}_cerrar`,  icon: '🔒',  isMovement: false, isDefault: false, approachObject: true,  order: 4 },
      { id: `${vsId}_empujar`, icon: '👉',  isMovement: false, isDefault: false, approachObject: true,  order: 5 },
      { id: `${vsId}_tirar`,   icon: '👈',  isMovement: false, isDefault: false, approachObject: true,  order: 6 },
      { id: `${vsId}_hablar`,  icon: '💬',  isMovement: false, isDefault: false, approachObject: true,  order: 7 },
      { id: `${vsId}_dar`,     icon: '🤝',  isMovement: false, isDefault: false, approachObject: false, isGive: true, order: 8 },
      { id: `${vsId}_ira`,     icon: '👟',  isMovement: true,  isDefault: false, approachObject: false, order: 9 },
    ]
    const verbset = { id: vsId, name, verbs, created: now, modified: now }
    writeFileSync(join(dir, `${vsId}.json`), JSON.stringify(verbset, null, 2), 'utf8')

    // Escribir labels por defecto en es.json y en.json
    const defaultLabels = {
      es: { mirar:'Mirar', coger:'Coger', usar:'Usar', abrir:'Abrir', cerrar:'Cerrar',
            empujar:'Empujar', tirar:'Tirar', hablar:'Hablar', dar:'Dar', ira:'Ir a' },
      en: { mirar:'Look at', coger:'Pick up', usar:'Use', abrir:'Open', cerrar:'Close',
            empujar:'Push', tirar:'Pull', hablar:'Talk', dar:'Give', ira:'Walk to' },
    }
    for (const lang of ['es', 'en']) {
      const localePath = join(gameDir, 'locales', `${lang}.json`)
      let locale = {}
      try { locale = JSON.parse(readFileSync(localePath, 'utf8')) } catch {}
      verbs.forEach(v => {
        const shortKey = v.id.replace(`${vsId}_`, '')
        locale[`verb.${v.id}`] = defaultLabels[lang][shortKey] || shortKey
      })
      writeFileSync(localePath, JSON.stringify(locale, null, 2), 'utf8')
    }

    return { ok: true, verbset }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('verbset:save', async (_event, { gameDir, verbset }) => {
  try {
    const dir = join(gameDir, 'verbsets')
    mkdirSync(dir, { recursive: true })
    verbset.modified = new Date().toISOString().split('T')[0]
    writeFileSync(join(dir, `${verbset.id}.json`), JSON.stringify(verbset, null, 2), 'utf8')
    return { ok: true, verbset }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('verbset:delete', async (_event, { gameDir, verbsetId }) => {
  try {
    const p = join(gameDir, 'verbsets', `${verbsetId}.json`)
    if (existsSync(p)) rmSync(p)
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('verbset:duplicate', async (_event, { gameDir, verbsetId }) => {
  try {
    const dir  = join(gameDir, 'verbsets')
    const src  = JSON.parse(readFileSync(join(dir, `${verbsetId}.json`), 'utf8'))
    const newId = `verbset_${Date.now()}`
    const now  = new Date().toISOString().split('T')[0]
    const copy = { ...src, id: newId, name: src.name + ' (copia)',
      verbs: src.verbs.map(v => ({ ...v, id: `verb_${Date.now()}_${Math.random().toString(36).slice(2,6)}` })),
      created: now, modified: now }
    writeFileSync(join(dir, `${newId}.json`), JSON.stringify(copy, null, 2), 'utf8')
    return { ok: true, verbset: copy }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Locales ───────────────────────────────────────────────────────────────────

ipcMain.handle('locale:read', async (_event, { gameDir, lang }) => {
  try {
    const path = join(gameDir, 'locales', `${lang}.json`)
    if (!existsSync(path)) return { ok: true, data: {} }
    return { ok: true, data: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('locale:save', async (_event, { gameDir, lang, data }) => {
  try {
    const dir = join(gameDir, 'locales')
    mkdirSync(dir, { recursive: true })
    // Sort keys for readability
    const sorted = Object.fromEntries(Object.entries(data).sort(([a],[b]) => a.localeCompare(b)))
    writeFileSync(join(dir, `${lang}.json`), JSON.stringify(sorted, null, 2), 'utf8')
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('locale:list-langs', async (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'locales')
    mkdirSync(dir, { recursive: true })
    const langs = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
    return { ok: true, langs }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Language management ───────────────────────────────────────────────────────

ipcMain.handle('lang:add', async (_event, { gameDir, lang }) => {
  try {
    const gamePath = join(gameDir, 'game.json')
    const game = JSON.parse(readFileSync(gamePath, 'utf8'))
    if (!game.languages) game.languages = ['es', 'en']
    if (!game.languages.includes(lang)) game.languages.push(lang)
    writeFileSync(gamePath, JSON.stringify(game, null, 2), 'utf8')
    // Crear fichero locale vacío
    const localeDir = join(gameDir, 'locales')
    mkdirSync(localeDir, { recursive: true })
    const locPath = join(localeDir, `${lang}.json`)
    if (!existsSync(locPath)) writeFileSync(locPath, '{}', 'utf8')
    return { ok: true, game }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('lang:delete', async (_event, { gameDir, lang }) => {
  try {
    const gamePath = join(gameDir, 'game.json')
    const game = JSON.parse(readFileSync(gamePath, 'utf8'))
    game.languages = (game.languages || ['es', 'en']).filter(l => l !== lang)
    writeFileSync(gamePath, JSON.stringify(game, null, 2), 'utf8')
    const locPath = join(gameDir, 'locales', `${lang}.json`)
    if (existsSync(locPath)) rmSync(locPath)
    return { ok: true, game }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Asset rename ──────────────────────────────────────────────────────────────
ipcMain.handle('asset:rename', async (_event, { oldPath, newName }) => {
  try {
    const dir     = oldPath.substring(0, oldPath.lastIndexOf('/') + 1).replace(/\//g, require('path').sep)
    const newPath = require('path').join(require('path').dirname(oldPath), newName)
    if (existsSync(newPath)) return { ok: false, error: 'Ya existe un asset con ese nombre' }
    renameSync(oldPath, newPath)
    return { ok: true, newPath }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Audio files ───────────────────────────────────────────────────────────────
ipcMain.handle('audio:list', async (_event, { gameDir, type }) => {
  try {
    const dir = join(gameDir, 'audio', type)
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir)
      .filter(f => /\.(mid|midi|wav)$/i.test(f))
      .map(f => {
        const fp = join(dir, f)
        const stat = require('fs').statSync(fp)
        return { name: f, path: fp, size: stat.size }
      })
    return { ok: true, files }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('audio:import', async (_event, { gameDir, type, srcPath, name }) => {
  try {
    const dir = join(gameDir, 'audio', type)
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, name)
    require('fs').copyFileSync(srcPath, dest)
    return { ok: true, path: dest }
  } catch (err) { return { ok: false, error: err.message } }
})

/* Preview de audio — usa el reproductor del sistema */
let _previewProc = null
ipcMain.handle('audio:preview', async (_event, { filePath }) => {
  try {
    // Parar preview anterior
    if (_previewProc) { try { _previewProc.kill() } catch(e) {} _previewProc = null }
    const { spawn } = require('child_process')
    const p = process.platform
    let proc
    if (p === 'win32') {
      // wmplayer soporta WAV y MIDI — mismo método para todos los formatos
      proc = spawn('cmd', ['/c', 'start', '/b', 'wmplayer', `"${filePath}"`],
        { detached: true, stdio: 'ignore', shell: true })
    } else if (p === 'darwin') {
      proc = spawn('afplay', [filePath], { detached: true, stdio: 'ignore' })
    } else {
      proc = spawn('aplay', [filePath], { detached: true, stdio: 'ignore' })
    }
    proc.unref()
    _previewProc = proc
    return { ok: true }
  } catch(e) { return { ok: false, error: e.message } }
})

ipcMain.handle('audio:preview:stop', async () => {
  if (_previewProc) { try { _previewProc.kill() } catch(e) {} _previewProc = null }
  // En Windows matar wmplayer si está corriendo
  if (process.platform === 'win32') {
    require('child_process').spawn('taskkill', ['/F', '/IM', 'wmplayer.exe'],
      { detached: true, stdio: 'ignore' }).unref()
  }
  return { ok: true }
})

// ── Characters ────────────────────────────────────────────────────────────────

ipcMain.handle('char:list', async (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'characters')
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const chars = files.map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) }
      catch { return null }
    }).filter(Boolean)
    chars.sort((a, b) => (a.created || '').localeCompare(b.created || ''))
    return { ok: true, chars }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('char:create', async (_event, { gameDir, name, isProtagonist }) => {
  try {
    const dir = join(gameDir, 'characters')
    mkdirSync(dir, { recursive: true })
    const id  = `char_${Date.now()}`
    const now = new Date().toISOString().split('T')[0]
    const char = {
      id, isProtagonist: !!isProtagonist,
      walkSpeed: 2,
      dialogueId: null,
      dialogueConditions: [],  // [{ id, flag, operator, value, dialogueId }]
      inventory: [],         // [{ objectId, objectName }]
      animations: [],
      animRoles: {           // qué animación hace cada rol del motor
        idle:       null,    // obligatorio — se espeja automáticamente si dir=="left"
        walk_right: null,    // obligatorio
        walk_left:  null,    // null = espejo horizontal de walk_right
        walk_up:    null,    // null = usa walk_right
        walk_down:  null,    // null = usa walk_right
      },
      patrol: [],
      flags: [],
      created: now, modified: now,
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(char, null, 2), 'utf8')

    // Write name to all locales
    const localesDir = join(gameDir, 'locales')
    mkdirSync(localesDir, { recursive: true })
    try {
      const langFiles = readdirSync(localesDir).filter(f => f.endsWith('.json'))
      const targets = langFiles.length ? langFiles : ['es.json']
      for (const lf of targets) {
        const lp = join(localesDir, lf)
        let locale = {}
        try { locale = JSON.parse(readFileSync(lp, 'utf8')) } catch {}
        locale[`char.${id}.name`] = name
        writeFileSync(lp, JSON.stringify(locale, null, 2), 'utf8')
      }
    } catch (le) { console.error('[char:create] locale error', le.message) }

    return { ok: true, char: { ...char, name } }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('char:save', async (_event, { gameDir, char }) => {
  try {
    const dir = join(gameDir, 'characters')
    mkdirSync(dir, { recursive: true })
    char.modified = new Date().toISOString().split('T')[0]
    writeFileSync(join(dir, `${char.id}.json`), JSON.stringify(char, null, 2), 'utf8')
    return { ok: true, char }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('char:delete', async (_event, { gameDir, charId }) => {
  try {
    const p = join(gameDir, 'characters', `${charId}.json`)
    if (existsSync(p)) rmSync(p)
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('char:duplicate', async (_event, { gameDir, charId }) => {
  try {
    const dir = join(gameDir, 'characters')
    const src = JSON.parse(readFileSync(join(dir, `${charId}.json`), 'utf8'))
    const newId = `char_${Date.now()}`
    const now   = new Date().toISOString().split('T')[0]
    const copy  = {
      ...src, id: newId,
      animations: src.animations.map(a => ({ ...a, id: `anim_${Date.now()}_${Math.random().toString(36).slice(2,5)}` })),
      created: now, modified: now,
    }
    writeFileSync(join(dir, `${newId}.json`), JSON.stringify(copy, null, 2), 'utf8')
    // Copy locale name
    const localesDir = join(gameDir, 'locales')
    try {
      readdirSync(localesDir).filter(f => f.endsWith('.json')).forEach(lf => {
        const lp = join(localesDir, lf)
        let locale = {}
        try { locale = JSON.parse(readFileSync(lp, 'utf8')) } catch {}
        locale[`char.${newId}.name`] = (locale[`char.${charId}.name`] || '') + ' (copia)'
        writeFileSync(lp, JSON.stringify(locale, null, 2), 'utf8')
      })
    } catch {}
    return { ok: true, char: copy }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Dialogues ─────────────────────────────────────────────────────────────────

ipcMain.handle('dialogue:list', (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'dialogues')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    const dialogues = []
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        dialogues.push({ id: d.id, name: d.name, actorId: d.actorId || null })
      } catch {}
    }
    return { ok: true, dialogues }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('dialogue:create', (_event, { gameDir, name }) => {
  try {
    const dir = join(gameDir, 'dialogues')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const id      = `dlg_${Date.now()}`
    const startId = `start_${Date.now()}`
    const line1Id = `node_${Date.now()}_l`
    const dialogue = {
      id, name: name || 'Nuevo diálogo', actorId: null,
      nodes: [
        { id: startId, type: 'start', _x: 300, _y: 20 },
        { id: line1Id, type: 'line',  actorId: null, textKey: `dlg.${id}.line1`, _x: 300, _y: 130 },
        { id: 'node_end', type: 'end', _x: 300, _y: 260 },
      ],
      connections: [
        { from: startId, to: line1Id,    choiceIndex: null },
        { from: line1Id, to: 'node_end', choiceIndex: null },
      ],
      created:  new Date().toISOString().slice(0, 10),
      modified: new Date().toISOString().slice(0, 10),
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(dialogue, null, 2), 'utf8')
    return { ok: true, dialogue }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('dialogue:read', (_event, { gameDir, id }) => {
  try {
    const raw = readFileSync(join(gameDir, 'dialogues', `${id}.json`), 'utf8')
    return { ok: true, dialogue: JSON.parse(raw) }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('dialogue:save', (_event, { gameDir, dialogue }) => {
  try {
    dialogue.modified = new Date().toISOString().slice(0, 10)
    writeFileSync(
      join(gameDir, 'dialogues', `${dialogue.id}.json`),
      JSON.stringify(dialogue, null, 2), 'utf8'
    )
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('dialogue:delete', (_event, { gameDir, id }) => {
  try {
    rmSync(join(gameDir, 'dialogues', `${id}.json`))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('dialogue:duplicate', (_event, { gameDir, id }) => {
  try {
    const orig  = JSON.parse(readFileSync(join(gameDir, 'dialogues', `${id}.json`), 'utf8'))
    const newId = `dlg_${Date.now()}`
    const copy  = { ...orig, id: newId, name: orig.name + ' (copia)', created: new Date().toISOString().slice(0,10) }
    writeFileSync(join(gameDir, 'dialogues', `${newId}.json`), JSON.stringify(copy, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ── Scripts ───────────────────────────────────────────────────────────────────

ipcMain.handle('script:list', (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'scripts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const scripts = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return { id: d.id, name: d.name, trigger: d.trigger }
      } catch { return null }
    }).filter(Boolean)
    return { ok: true, scripts }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('script:create', (_event, { gameDir, name }) => {
  try {
    const dir = join(gameDir, 'scripts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const id = `scr_${Date.now()}`
    const script = {
      id, name: name || 'Nuevo script',
      trigger: { type: 'game_start' },
      instructions: [],
      created: new Date().toISOString().slice(0, 10),
      modified: new Date().toISOString().slice(0, 10),
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(script, null, 2), 'utf8')
    return { ok: true, script }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('script:read', (_event, { gameDir, id }) => {
  try {
    const raw = readFileSync(join(gameDir, 'scripts', `${id}.json`), 'utf8')
    return { ok: true, script: JSON.parse(raw) }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('script:save', (_event, { gameDir, script }) => {
  try {
    script.modified = new Date().toISOString().slice(0, 10)
    writeFileSync(join(gameDir, 'scripts', `${script.id}.json`), JSON.stringify(script, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('script:delete', (_event, { gameDir, id }) => {
  try { rmSync(join(gameDir, 'scripts', `${id}.json`)); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('script:duplicate', (_event, { gameDir, id }) => {
  try {
    const orig = JSON.parse(readFileSync(join(gameDir, 'scripts', `${id}.json`), 'utf8'))
    const newId = `scr_${Date.now()}`
    writeFileSync(join(gameDir, 'scripts', `${newId}.json`),
      JSON.stringify({ ...orig, id: newId, name: orig.name + ' (copia)' }, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ── Sequences ─────────────────────────────────────────────────────────────────

ipcMain.handle('sequence:list', (_event, { gameDir }) => {
  try {
    const dir = join(gameDir, 'sequences')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const seqs = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return { id: d.id, name: d.name }
      } catch { return null }
    }).filter(Boolean)
    return { ok: true, sequences: seqs }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('sequence:create', (_event, { gameDir, name }) => {
  try {
    const dir = join(gameDir, 'sequences')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const id = `seq_${Date.now()}`
    const sequence = {
      id, name: name || 'Nueva secuencia',
      steps: [{ id: `s_${Date.now()}`, type: 'end_sequence' }],
      created: new Date().toISOString().slice(0, 10),
      modified: new Date().toISOString().slice(0, 10),
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(sequence, null, 2), 'utf8')
    return { ok: true, sequence }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('sequence:read', (_event, { gameDir, id }) => {
  try {
    const raw = readFileSync(join(gameDir, 'sequences', `${id}.json`), 'utf8')
    const sequence = JSON.parse(raw)
    /* Migrar formato antiguo: step.texts:{en,es} → localeKey + escribir en locale */
    let migrated = false
    for (const step of (sequence.steps || [])) {
      if ((step.type === 'show_text' || step.type === 'scroll_text') && step.texts && !step.localeKey) {
        const key = `seq_${id.replace(/[^a-z0-9]/gi,'_')}_${step.id.replace(/[^a-z0-9]/gi,'_')}`
        step.localeKey = key
        /* Escribir textos en ficheros locale */
        for (const [lang, txt] of Object.entries(step.texts)) {
          try {
            const locPath = path_m.join(gameDir, 'locales', `${lang}.json`)
            let loc = {}
            if (existsSync(locPath)) loc = JSON.parse(readFileSync(locPath, 'utf8'))
            if (!loc[key]) { loc[key] = txt; writeFileSync(locPath, JSON.stringify(loc, null, 2), 'utf8') }
          } catch(_) {}
        }
        delete step.texts
        migrated = true
      }
    }
    if (migrated) writeFileSync(join(gameDir, 'sequences', `${id}.json`), JSON.stringify(sequence, null, 2), 'utf8')
    return { ok: true, sequence }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('sequence:save', (_event, { gameDir, sequence }) => {
  try {
    sequence.modified = new Date().toISOString().slice(0, 10)
    writeFileSync(join(gameDir, 'sequences', `${sequence.id}.json`), JSON.stringify(sequence, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('sequence:delete', (_event, { gameDir, id }) => {
  try { rmSync(join(gameDir, 'sequences', `${id}.json`)); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('sequence:duplicate', (_event, { gameDir, id }) => {
  try {
    const orig = JSON.parse(readFileSync(join(gameDir, 'sequences', `${id}.json`), 'utf8'))
    const newId = `seq_${Date.now()}`
    writeFileSync(join(gameDir, 'sequences', `${newId}.json`),
      JSON.stringify({ ...orig, id: newId, name: orig.name + ' (copia)' }, null, 2), 'utf8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ── Build Manager ─────────────────────────────────────────────────────────────
// Todos los procesos de compilación corren aquí (proceso main/Node.js) porque
// el renderer (Chromium) no puede ejecutar procesos del SO directamente.

const { spawn, execSync } = require('child_process')
const path_m = require('path')

/**
 * Detecta si Open Watcom y DOSBox-X están instalados y accesibles.
 * Busca en las rutas por defecto y en PATH.
 */

ipcMain.handle('assets:sync', async (_event, { gameDir }) => {
  try {
    const map = syncAssetsMap(gameDir)
    return { ok: true, map }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('assets:read', async (_event, { gameDir }) => {
  try {
    const map = loadAssetsMap(gameDir)
    return { ok: true, map }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('build:check-tools', (_event, { gameDir, watcomDir, dosboxPath: dosboxPathArg } = {}) => {
  const saved = loadSettings()
  const configuredWatcom = (watcomDir || saved.watcomDir || '').trim()
  const configuredDosbox = (dosboxPathArg || saved.dosboxPath || '').trim()

  // Normaliza separadores (el usuario puede poner / o \ en Windows)
  function norm(p) { return p.replace(/\//g, path_m.sep).replace(/\\/g, path_m.sep) }

  // Candidatos de Watcom: probamos binnt (Win32), binw (Win32 legacy) y binl (Linux)
  const watcomCandidates = [
    configuredWatcom ? norm(path_m.join(configuredWatcom, 'binnt', 'wcc386.exe')) : null,
    configuredWatcom ? norm(path_m.join(configuredWatcom, 'binw',  'wcc386.exe')) : null,
    configuredWatcom ? norm(path_m.join(configuredWatcom, 'binl',  'wcc386'))     : null,
    // Si el usuario puso la ruta directa al ejecutable
    configuredWatcom && configuredWatcom.toLowerCase().includes('wcc386') ? norm(configuredWatcom) : null,
    'C:\\WATCOM\\binnt\\wcc386.exe',
    'C:\\WATCOM\\binw\\wcc386.exe',
    'C:\\WATCOM2\\binnt\\wcc386.exe',
    'C:\\Program Files\\Open Watcom\\binnt\\wcc386.exe',
    'C:\\Program Files (x86)\\Open Watcom\\binnt\\wcc386.exe',
    '/usr/bin/wcc386',
    '/opt/watcom/binl/wcc386',
  ].filter(Boolean)

  const dosboxCandidates = [
    configuredDosbox ? norm(configuredDosbox) : null,
    'C:\\Program Files\\DOSBox-X\\dosbox-x.exe',
    'C:\\Program Files (x86)\\DOSBox-X\\dosbox-x.exe',
    'C:\\DOSBox-X\\dosbox-x.exe',
    '/usr/bin/dosbox-x',
    '/usr/local/bin/dosbox-x',
    '/Applications/dosbox-x.app/Contents/MacOS/dosbox-x',
  ].filter(Boolean)

  function findTool(candidates, name) {
    // 1. Buscar en candidatos por ruta completa
    for (const c of candidates) {
      if (existsSync(c)) return { ok: true, path: c }
    }
    // 2. Buscar en PATH del sistema
    try {
      const cmd = process.platform === 'win32'
        ? `where ${name} 2>nul`
        : `which ${name} 2>/dev/null`
      const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
      if (result) return { ok: true, path: result.split('\n')[0].trim() }
    } catch {}
    return { ok: false, path: null }
  }

  const watcom = findTool(watcomCandidates, 'wcc386')
  const dosbox = findTool(dosboxCandidates, 'dosbox-x')

  return {
    ok: true,
    tools: {
      watcom: watcom.ok, watcomPath: watcom.path,
      dosbox: dosbox.ok, dosboxPath: dosbox.path,
    }
  }
})

/**
 * Lista los ficheros en la carpeta build/ del juego.
 * Devuelve nombre, tamaño y fecha de modificación.
 */
ipcMain.handle('build:list-files', (_event, { gameDir }) => {
  try {
    const cfg = loadSettings()
    const customBuildDir = cfg.buildDir || null
    const defaultBuildDir = path_m.join(gameDir, '..', '..', 'build')
    const buildDir = customBuildDir
      ? (path_m.isAbsolute(customBuildDir) ? customBuildDir : path_m.join(gameDir, customBuildDir))
      : defaultBuildDir
    if (!existsSync(buildDir)) return { ok: true, files: [] }
    const files = readdirSync(buildDir).map(name => {
      const p = path_m.join(buildDir, name)
      const stat = require('fs').statSync(p)
      return { name, size: stat.size, mtime: stat.mtime.toISOString() }
    }).filter(f => !f.name.startsWith('.'))
    return { ok: true, files }
  } catch (e) { return { ok: false, error: e.message } }
})

/**
 * Abre la carpeta build/ en el explorador del SO.
 */
ipcMain.handle('build:open-dir', (_event, { gameDir }) => {
  try {
    const cfg = loadSettings()
    const customBuildDir = cfg.buildDir || null
    const defaultBuildDir = path_m.join(gameDir, '..', '..', 'build')
    const buildDir = customBuildDir
      ? (path_m.isAbsolute(customBuildDir) ? customBuildDir : path_m.join(gameDir, customBuildDir))
      : defaultBuildDir
    if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true })
    require('electron').shell.openPath(buildDir)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

/**
 * Ejecuta el proceso de compilación con Open Watcom.
 *
 * Modos:
 *   debug   → -DDEBUG_MODE, sin optimizaciones, con símbolos
 *   release → -O2, genera ficheros DAT para distribución
 *   run     → debug + lanza DOSBox-X al terminar
 *
 * Los mensajes de log se emiten evento a evento al renderer via webContents.send.
 * El renderer los recibe via onBuildLog.
 */
ipcMain.handle('build:run', async (_event, { gameDir, mode }) => {
  const startTime = Date.now()
  const win = require('electron').BrowserWindow.getAllWindows()[0]

  function log(text, type = 'default') {
    win?.webContents?.send('build:log', { text, type })
  }

  try {
    const buildDir = path_m.join(gameDir, '..', '..', 'build')
    if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true })

    log('Verificando estructura del proyecto…')
    // Sincronizar assets.json (asignar ids a PCX nuevos)
    const buildAssetsMap = syncAssetsMap(gameDir)
    const assetCount = Object.keys(buildAssetsMap).length
    log(`  assets.json: ${assetCount} PCX registrados`, 'info')

    // Generar makefile temporal para Watcom
    const isDebug   = mode === 'debug' || mode === 'run'
    const isRelease = mode === 'release'

    const gameId = path_m.basename(gameDir)

    // Leer rutas configuradas antes de generar el Makefile (necesita watcomDir para -i=)
    const cfg = loadSettings()
    const watcomDir  = cfg.watcomDir  || ''
    const dosboxExe  = cfg.dosboxPath || 'dosbox-x'
    const dosboxConf = cfg.dosboxConf || null
    const customBuildDir = cfg.buildDir || null
    const effectiveBuildDir = customBuildDir
      ? (path_m.isAbsolute(customBuildDir) ? customBuildDir : path_m.join(gameDir, customBuildDir))
      : buildDir
    if (!existsSync(effectiveBuildDir)) mkdirSync(effectiveBuildDir, { recursive: true })

    // Limpiar .obj y .DAT anteriores que pueden estar bloqueados o ser obsoletos
    try {
      const { readdirSync, unlinkSync } = require('fs')
      for (const f of readdirSync(effectiveBuildDir)) {
        if (/\.(obj|err|DAT)$/i.test(f)) {
          try { unlinkSync(path_m.join(effectiveBuildDir, f)) } catch(e) {}
        }
      }
    } catch(e) {}

    const useMidpak = !!(cfg.useMidpak)

    // Leer game.json — necesario para CFLAGS (walkmapCellSize) y configuración de audio
    let gameJson = {}
    try { gameJson = JSON.parse(readFileSync(path_m.join(gameDir, 'game.json'), 'utf8')) } catch {}
    const walkmapCellSize = gameJson.walkmapCellSize === 4 ? 4 : 8
    const audioDriver     = (gameJson.audio?.audioDriver) || 'a32adlib.dll'

    const makefile = generateMakefile(gameDir, effectiveBuildDir, gameId, isDebug, watcomDir, useMidpak, walkmapCellSize)
    const makefilePath = path_m.join(effectiveBuildDir, 'Makefile')
    writeFileSync(makefilePath, makefile, 'utf8')

    log(`Makefile generado en: ${makefilePath}`)
    log(`Build dir: ${effectiveBuildDir}`)
    log(`Modo: ${mode.toUpperCase()}`)
    log('──────────────────────────────────')
    log('Iniciando Open Watcom…')
    const wmakePath = watcomDir
      ? path_m.join(watcomDir, process.platform === 'win32' ? 'binnt\\wmake.exe' : 'binl/wmake')
      : 'wmake'
    // Copiar ficheros del motor C al buildDir (agemki_engine.h/c + agemki_audio.h/c)
    const engineSrcDir = path_m.join(__dirname, '../../resources/engine')
    const engineFiles  = ['agemki_engine.h', 'agemki_engine.c', 'agemki_audio.h', 'agemki_audio.c', 'mididrv.h', 'mididrv.c', 'opl2.h', 'opl2.c', 'opl3.h', 'opl3.c', 'opl_patches.h', 'opl_patches.c', 'mpu.h', 'mpu.c', 'midi.h', 'midi.c', 'timer.h', 'timer.c', 'sb.h', 'sb.c']
    for (const ef of engineFiles) {
      const src_path = path_m.join(engineSrcDir, ef)
      const dst_path = path_m.join(effectiveBuildDir, ef)
      if (existsSync(src_path)) {
        try { copyFileSync(src_path, dst_path) } catch(e) {
          try { require('fs').unlinkSync(dst_path) } catch(_) {}
          copyFileSync(src_path, dst_path)
        }
        try { require('fs').chmodSync(dst_path, 0o666) } catch(_) {}
        log(`  Copiado ${ef} al buildDir`, 'info')
      } else {
        log(`  AVISO: ${ef} no encontrado en resources/engine/`, 'warn')
      }
    }

    // Copiar ficheros AIL/32 al buildDir
    { const { copyFileSync: cpSync, chmodSync } = require('fs')
      const driversDir = path_m.join(__dirname, '../../resources/drivers')
      const engineSrc  = path_m.join(__dirname, '../../resources/engine')

      // Helper: copiar y quitar solo-lectura
      function safeCopy(src, dst) {
        try { cpSync(src, dst) } catch(e) {
          // Si falla por permisos, intentar borrar destino y reintentar
          try { require('fs').unlinkSync(dst) } catch(_) {}
          cpSync(src, dst)
        }
        try { chmodSync(dst, 0o666) } catch(_) {}
      }

      // Headers AIL/32
      for (const hf of []) {
        const src = path_m.join(engineSrc, hf)
        if (existsSync(src)) {
          safeCopy(src, path_m.join(effectiveBuildDir, hf))
          log(`  Copiado ${hf} al buildDir`, 'info')
        }
      }

      // OBJ linkables
      for (const obj of []) {
        const src = path_m.join(driversDir, obj)
        if (existsSync(src)) {
          safeCopy(src, path_m.join(effectiveBuildDir, obj))
          log(`  Copiado ${obj} al buildDir`, 'info')
        } else {
          log(`  AVISO: ${obj} no encontrado en resources/drivers/`, 'warn')
        }
      }

      // Driver DLL activo → copiar al buildDir (junto al EXE)
      if (audioDriver) {
        const dllSrc = path_m.join(driversDir, audioDriver)
        if (existsSync(dllSrc)) {
          safeCopy(dllSrc, path_m.join(effectiveBuildDir, audioDriver))
          log(`  Audio driver: ${audioDriver}`, 'info')
        } else {
          log(`  AVISO: driver ${audioDriver} no encontrado`, 'warn')
        }
      }
      // Banco de instrumentos GM para OPL2/OPL3 (GENMIDI.OP2)
      { const toolsDir  = path_m.join(__dirname, '../../resources/tools')
        const genmidiSrc = path_m.join(toolsDir, 'GENMIDI.OP2')
        const genmidiDst = path_m.join(effectiveBuildDir, 'GENMIDI.OP2')
        if (existsSync(genmidiSrc)) {
          safeCopy(genmidiSrc, genmidiDst)
          log('  Copiado GENMIDI.OP2 al buildDir', 'info')
        } else {
          log('  AVISO: GENMIDI.OP2 no encontrado en resources/tools/ — OPL sonara sin banco GM', 'warn')
        }
      }
      // DOS4GW.EXE — extender DOS requerido para ejecutar GAME.EXE
      { const toolsDir  = path_m.join(__dirname, '../../resources/tools')
        const dos4gwSrc = path_m.join(toolsDir, 'DOS4GW.EXE')
        const dos4gwDst = path_m.join(effectiveBuildDir, 'DOS4GW.EXE')
        if (existsSync(dos4gwSrc)) {
          safeCopy(dos4gwSrc, dos4gwDst)
          log('  Copiado DOS4GW.EXE al buildDir', 'info')
        } else {
          log('  AVISO: DOS4GW.EXE no encontrado en resources/tools/ — el juego no arrancara sin el extender DOS', 'warn')
        }
      }
    }

    // Generar agemki_dat.h — siempre necesario (main.c lo incluye)
    const headerPath = path_m.join(effectiveBuildDir, 'agemki_dat.h')
    writeFileSync(headerPath, generateDatHeader(), 'utf8')
    log('  agemki_dat.h generado', 'info')

    // Generar main.c — siempre necesario para compilar
    log('Generando main.c...')
    log(`  Audio: driver='${audioDriver || 'a32adlib.dll (fallback)'}' patches='${audioDriver && !audioDriver.includes('adlib') && !audioDriver.includes('sbfm') && !audioDriver.includes('sbp') && !audioDriver.includes('spkr') ? '(ninguno)' : 'SAMPLE.AD'}' vol=${(gameJson.audio?.music_volume ?? 100)}`)
    const mainResult = await generateMainC(gameDir, audioDriver)
    if (!mainResult.ok) {
      return { ok: false, error: 'main.c: ' + mainResult.error }
    }
    const mainPath = path_m.join(effectiveBuildDir, 'main.c')
    writeFileSync(mainPath, mainResult.code, 'utf8')
    log(`  main.c en: ${mainPath}`, 'info')
    log(`  main.c generado (${mainResult.code.split('\n').length} líneas)`, 'success')

    // Ejecutar wmake (el make de Watcom) — emite output en tiempo real
    // Setear WATCOM en el entorno para que wlink encuentre dos4g y las libs
    const watcomEnv = watcomDir ? { WATCOM: watcomDir } : {}
    const buildResult = await runProcess(wmakePath, ['-f', makefilePath], effectiveBuildDir, log, watcomEnv)

    if (!buildResult.ok) {
      return { ok: false, error: `wmake falló con código ${buildResult.code}` }
    }

    log('──────────────────────────────────', 'info')
    log('Compilación completada.', 'success')

    // Generar DATs siempre — son necesarios para ejecutar el juego
    log('──────────────────────────────────', 'info')
    log('Generando ficheros DAT…')
    const datResult = await generateDats(gameDir, effectiveBuildDir, log, useMidpak)
    if (!datResult.ok) {
      log('Aviso DATs: ' + (datResult.errors?.[0] || 'desconocido'), 'warn')
    }

    // Generar SFX.DAT desde los WAV del juego
    log('──────────────────────────────────', 'info')
    const sfxResult = await generateSfxDat(gameDir, effectiveBuildDir, log)
    if (!sfxResult.ok && sfxResult.error) {
      log('Aviso SFX: ' + sfxResult.error, 'warn')
    }

    // Limpiar artefactos de compilación innecesarios para ejecutar el juego
    // Se conservan .c y .h para facilitar la depuración
    try {
      const { readdirSync: rds, unlinkSync: uls } = require('fs')
      let cleaned = []
      for (const f of rds(effectiveBuildDir)) {
        if (/\.(obj|err)$/i.test(f) || f === 'Makefile') {
          try { uls(path_m.join(effectiveBuildDir, f)); cleaned.push(f) } catch(_) {}
        }
      }
      if (cleaned.length) log(`Limpieza: eliminados ${cleaned.length} artefactos (${cleaned.join(', ')})`, 'info')
    } catch(e) {}

    // Resumen de ficheros en el buildDir
    try {
      const buildFiles = readdirSync(effectiveBuildDir)
        .filter(f => /\.(EXE|DAT|DLL|AD|XMI|CFG|OP2|LOG)$/i.test(f))
      log(`Directorio build: ${effectiveBuildDir}`)
      log(`Ficheros listos: ${buildFiles.join(', ')}`)
    } catch(e) {}

    // Si mode=run, lanzar DOSBox-X con el ejecutable generado
    if (mode === 'run') {
      log('Lanzando DOSBox-X…', 'info')
      // Montar buildDir como C: y ejecutar GAME.EXE directamente
      const buildDirDos = effectiveBuildDir.replace(/\\/g, '\\\\')
      const mountCmd = `mount c ${buildDirDos}`
      const dosboxArgs = dosboxConf
        ? ['-conf', dosboxConf,
           '-c', mountCmd,
           '-c', 'c:',
           '-c', 'GAME.EXE',
           '-c', 'exit']
        : ['-c', mountCmd,
           '-c', 'c:',
           '-c', 'GAME.EXE',
           '-c', 'exit']
      // Ejecutar DOSBox-X de forma no bloqueante (el usuario interactúa con él)
      const dosbox = spawn(dosboxExe, dosboxArgs, { detached: true, stdio: 'ignore' })
      dosbox.unref() // desvincula del proceso padre para que no bloquee
      log('DOSBox-X iniciado.', 'success')
    }

    return { ok: true, elapsedMs: Date.now() - startTime }

  } catch (e) {
    log(`Error inesperado: ${e.message}`, 'error')
    return { ok: false, error: e.message }
  }
})

/**
 * Ejecuta un proceso hijo y emite su stdout/stderr como líneas de log.
 * Resuelve cuando el proceso termina.
 *
 * @param {string} cmd - Ejecutable
 * @param {string[]} args
 * @param {string} cwd - Directorio de trabajo
 * @param {Function} log - Función para emitir líneas de log al renderer
 * @returns {Promise<{ok:boolean, code:number}>}
 */
function runProcess(cmd, args, cwd, log, extraEnv) {
  return new Promise(resolve => {
    const env = extraEnv ? Object.assign({}, process.env, extraEnv) : process.env
    const proc = spawn(cmd, args, { cwd, stdio: 'pipe', shell: true, env })
    proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => log(l)))
    proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => log(l, 'error')))
    proc.on('close', code => resolve({ ok: code === 0, code }))
    proc.on('error', e => { log(`No se pudo ejecutar ${cmd}: ${e.message}`, 'error'); resolve({ ok: false, code: -1 }) })
  })
}

/**
 * Genera un Makefile básico para Open Watcom.
 * En producción real este fichero se generaría con todas las fuentes C del motor.
 * Aquí es un stub funcional que compila si las fuentes existen.
 *
 * @param {string} gameDir
 * @param {string} buildDir
 * @param {string} gameId
 * @param {boolean} isDebug
 * @returns {string} Contenido del Makefile
 */
/**
 * Convierte una cadena UTF-8 a un Buffer en codificación CP850 (DOS Western Europe).
 * Los caracteres sin equivalente CP850 se sustituyen por '?' (0x3F).
 * El motor lee los textos byte a byte y _char_to_glyph espera CP850.
 *
 * Mapa Unicode → CP850 para los caracteres que soporta el motor:
 *   ASCII 32-127 → mismos valores
 *   Acentos españoles, catalanes y franceses → códigos CP850
 */
function utf8ToCp850(str) {
  // Mapa: codepoint Unicode → byte CP850. UNA entrada por línea (los comentarios // ocultan el resto).
  const MAP = {
    // Español minúsculas
    0xE1: 0xA0, // á
    0xE9: 0x82, // é
    0xED: 0xA1, // í
    0xF3: 0xA2, // ó
    0xFA: 0xA3, // ú
    0xFC: 0x81, // ü
    0xF1: 0xA4, // ñ
    // Español mayúsculas
    0xC1: 0xB5, // Á
    0xC9: 0x90, // É
    0xCD: 0xD6, // Í
    0xD3: 0xE0, // Ó
    0xDA: 0xE9, // Ú
    0xDC: 0x9A, // Ü
    0xD1: 0xA5, // Ñ
    // Español signos
    0xBF: 0xA8, // ¿
    0xA1: 0xAD, // ¡
    // Catalán / Francés — graves minúsculas
    0xE0: 0x85, // à
    0xE8: 0x8A, // è
    0xEC: 0x8D, // ì
    0xF2: 0x95, // ò
    0xF9: 0x97, // ù
    // Catalán / Francés — circumflejos minúsculas
    0xE2: 0x83, // â
    0xEA: 0x88, // ê
    0xEE: 0x8C, // î
    0xF4: 0x93, // ô
    0xFB: 0x96, // û
    // Diéresis minúsculas
    0xEF: 0x8B, // ï
    0xE7: 0x87, // ç
    // Mayúsculas con acento
    0xC0: 0x8E, // À
    0xC8: 0xD4, // È
    0xCC: 0xDE, // Ì
    0xD2: 0xE3, // Ò
    0xD9: 0xEB, // Ù
    0xC2: 0xB6, // Â
    0xCA: 0xD2, // Ê
    0xCE: 0xD7, // Î
    0xD4: 0xE2, // Ô
    0xDB: 0xEA, // Û
    0xCF: 0xD8, // Ï
    0xC7: 0x80, // Ç
    // Guillemets
    0xAB: 0xAE, // «
    0xBB: 0xAF, // »
    // Punt volat catalán (· U+00B7)
    0xB7: 0xFA,
  }
  const out = []
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i)
    i += cp > 0xFFFF ? 2 : 1
    if (cp === 0x0A || cp === 0x0D) {
      out.push(cp)                    // \n y \r pasan tal cual — el motor los necesita
    } else if (cp >= 32 && cp <= 127) {
      out.push(cp)                    // ASCII imprimible directo
    } else if (MAP[cp] !== undefined) {
      out.push(MAP[cp])               // carácter con acento → CP850
    } else {
      out.push(0x3F)                  // '?' para caracteres no soportados
    }
  }
  return Buffer.from(out)
}

function generateMakefile(gameDir, buildDir, gameId, isDebug, watcomDir, useMidpak, walkmapCellSize = 8) {
  const cellDefine = `-dWALKMAP_CELL_SIZE=${walkmapCellSize === 4 ? 4 : 8}`
  const flags = isDebug
    ? `-3 -mf -d2 -za99 -w3 -wcd202 -wcd102 -DDEBUG_MODE ${cellDefine}`
    : `-3 -mf -O2 -za99 -w3 -wcd202 -wcd102 ${cellDefine}`
  const bd = buildDir.split('/').join('\\\\')
  const wd = (watcomDir || '').replace(/\\/g, '\\\\')
  const watcomH   = wd ? wd + '\\\\H'      : '$(%WATCOM%)\\\\H'
  const watcomLib = wd ? wd + '\\\\lib386' : '$(%WATCOM%)\\\\lib386'
  const clibName = 'clib3r.lib'

  return `# Makefile generado por AGEMKI (ACHUS Game Engine Mark I)
# Juego: ${gameId}
# Modo: ${isDebug ? 'DEBUG' : 'RELEASE'} + mididrv MPU-401
CC = wcc386
LD = wlink
WATCOM_INC = ${watcomH}
CFLAGS = ${flags} -bt=dos -i=$(WATCOM_INC)
BUILDDIR = ${bd}
WATCOM_LIB = ${watcomLib}

OBJS = main.obj agemki_engine.obj agemki_audio.obj mididrv.obj opl2.obj opl3.obj opl_patches.obj mpu.obj midi.obj timer.obj sb.obj

.c.obj:
\t$(CC) $(CFLAGS) -fo=$@ $<

GAME.EXE: $(OBJS)
\t$(LD) system dos4g name GAME.EXE file main.obj,agemki_engine.obj,agemki_audio.obj,mididrv.obj,opl2.obj,opl3.obj,opl_patches.obj,mpu.obj,midi.obj,timer.obj,sb.obj libpath $(WATCOM_LIB) lib ${clibName}

main.obj: main.c agemki_engine.h agemki_dat.h agemki_audio.h
\t$(CC) $(CFLAGS) -fo=main.obj main.c

agemki_engine.obj: agemki_engine.c agemki_engine.h agemki_dat.h agemki_audio.h
\t$(CC) $(CFLAGS) -fo=agemki_engine.obj agemki_engine.c

agemki_audio.obj: agemki_audio.c agemki_audio.h agemki_engine.h mididrv.h mpu.h midi.h timer.h
\t$(CC) $(CFLAGS) -fo=agemki_audio.obj agemki_audio.c

clean:
\tdel $(bd)\\*.obj $(bd)\\GAME.EXE
`
}

// ── Guía de usuario ───────────────────────────────────────────────────────────
// Abre la guía HTML en una ventana BrowserWindow separada (sin chrome de editor).
// La guía vive en resources/help/index.html — se empaqueta con la app.

ipcMain.handle('help:open', () => {
  const { BrowserWindow, app } = require('electron')
  const path_h = require('path')

  // Ruta a la guía: en dev = resources/help/, en prod = dentro del asar
  const isDev = !app.isPackaged
  const helpPath = isDev
    ? path_h.join(__dirname, '../../resources/help/index.html')
    : path_h.join(process.resourcesPath, 'help/index.html')

  // Crear ventana flotante sin barra de menú
  const win = new BrowserWindow({
    width:  960,
    height: 740,
    title:  'ACHUS Game Engine Mark I (AGEMKI) — Guía de Usuario',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  win.loadFile(helpPath)
})

// ── Editor Settings (rutas de herramientas externas) ─────────────────────────
// Se persisten en userData/settings.json (fuera del proyecto, por máquina).
// Permite configurar Watcom y DOSBox-X sin hardcodear rutas.

const SETTINGS_PATH = join(app.getPath('userData'), 'agemki-settings.json')

function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    }
  } catch {}
  return {}
}

// ── assets.json helpers ──────────────────────────────────────────────────────
// Formato: { "NOMBRE.PCX": "timestamp_id", ... }
function loadAssetsMap(gameDir) {
  try {
    const p = join(gameDir, 'assets.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  } catch { return {} }
}
function saveAssetsMap(gameDir, map) {
  writeFileSync(join(gameDir, 'assets.json'), JSON.stringify(map, null, 2), 'utf8')
}
function syncAssetsMap(gameDir) {
  // Escanea todas las carpetas PCX y asigna un id timestamp a cada PCX nuevo
  const map = loadAssetsMap(gameDir)
  const dirs = [
    join(gameDir, 'assets', 'converted', 'backgrounds'),
    join(gameDir, 'assets', 'converted', 'sprites'),
    join(gameDir, 'assets', 'converted', 'objects'),
    join(gameDir, 'assets', 'converted', 'fonts'),
  ]
  let changed = false
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(f => f.toUpperCase().endsWith('.PCX'))) {
      const key = f.toUpperCase()
      if (!map[key]) {
        map[key] = String(Date.now()) + String(Math.floor(Math.random() * 1000))
        changed = true
      }
    }
  }
  if (changed) saveAssetsMap(gameDir, map)
  return map
}
function resolveAssetId(map, filename) {
  // Devuelve el id timestamp del PCX, o deriva uno del nombre si no está en el mapa
  if (!filename) return ''
  const key = path_m.basename(filename).toUpperCase()
  return map[key] || ''
}
// ─────────────────────────────────────────────────────────────────────────────



function saveSettings(data) {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch { return false }
}

ipcMain.handle('settings:load', () => {
  return { ok: true, settings: loadSettings() }
})

ipcMain.handle('settings:save', (_event, settings) => {
  const ok = saveSettings(settings)
  return { ok }
})

/* Lee un fichero HTML de resources/drivers/ y lo devuelve como texto.
 * El renderer crea un Blob URL para mostrarlo en un iframe. */
ipcMain.handle('tools:read-html', (_event, { filename }) => {
  try {
    const p = join(app.getAppPath(), 'resources', 'drivers', filename)
    const content = readFileSync(p, 'utf8')
    return { ok: true, content }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/**
 * generateDats — Genera GRAPHICS.DAT y AUDIO.DAT para el build release.
 *
 * FORMATO AGEMKI DAT v1
 * ─────────────────────
 * Header  16 bytes:
 *   magic[4]       "AGMK"
 *   dat_type       uint8   (0=GRAPHICS, 2=AUDIO)
 *   version        uint8   = 1
 *   num_blocks     uint16  little-endian
 *   index_offset   uint32  = 16 (siempre)
 *   data_offset    uint32  = 16 + num_blocks * 48
 *
 * Entrada de índice 48 bytes × num_blocks:
 *   id[32]         nombre null-padded  (ej: "room_abc_bg ...")
 *   res_type       uint8   (ver constantes RES_*)
 *   flags          uint8   = 0
 *   reserved       uint16  = 0
 *   offset         uint32  offset desde inicio de DATA (no desde inicio de fichero)
 *   size           uint32  bytes del recurso
 *   extra          uint32  frame_width para spritesheets, 0 para el resto
 *
 * Bloque DATA: ficheros raw concatenados en el mismo orden que el índice.
 *
 * @param {string} gameDir   Directorio raíz del juego
 * @param {string} buildDir  Directorio de salida del build
 * @param {Function} log     Función de log del BuildManager
 * @returns {Promise<{ok:boolean, errors:string[]}>}
 */
/**
 * Convierte un buffer MIDI (.mid, format 0 o 1) a formato XMI (IFF XMID).
 * XMI = eXtended MIDI: contenedor IFF con un track MIDI por secuencia.
 * MIDPAK solo acepta XMI, no MIDI estándar.
 *
 * Algoritmo:
 *  1. Parsear cabecera MIDI (MThd) y todas las pistas (MTrk).
 *  2. Si format 1, fusionar todas las pistas en una sola (format 0).
 *  3. Convertir deltas de ticks a intervalos de tiempo XMI (centi-beats).
 *  4. Envolver en contenedor IFF: FORM XDIR → CAT XMID → FORM XMID → EVNT.
 *
 * Ref: https://moddingwiki.shikadi.net/wiki/XMI_Format
 */

async function generateDats(gameDir, buildDir, log, useMidpak) {
  const errors = []

  // ── Constantes del formato ─────────────────────────────────────────────────
  const MAGIC          = Buffer.from('AGMK')
  const VERSION        = 1
  const HEADER_SIZE    = 16
  const INDEX_ENTRY    = 48   // bytes por entrada de índice
  const DAT_TYPE_GFX   = 0
  const DAT_TYPE_AUDIO = 2

  const RES_BACKGROUND = 0x01
  const RES_SPRITE     = 0x02
  const RES_OBJECT_PCX = 0x03
  const RES_FONT_PCX   = 0x04
  const RES_MIDI       = 0x20
  const RES_SFX        = 0x21

  /**
   * Escribe una entrada de índice de 48 bytes en el buffer.
   * @param {Buffer} buf       Buffer del índice (tamaño = num_blocks * 48)
   * @param {number} pos       Posición de escritura (múltiplo de 48)
   * @param {string} id        Nombre del asset (máx 31 chars + null)
   * @param {number} res_type  Constante RES_*
   * @param {number} offset    Offset desde inicio de DATA
   * @param {number} size      Bytes del recurso
   * @param {number} extra     Frame width para spritesheets, 0 si no aplica
   */
  function writeIndexEntry(buf, pos, id, res_type, offset, size, extra = 0) {
    buf.fill(0, pos, pos + INDEX_ENTRY)         // zero-pad toda la entrada
    const nameBytes = Buffer.from(id, 'utf8').slice(0, 31)
    nameBytes.copy(buf, pos)                    // id[32] null-padded
    buf.writeUInt8(res_type,  pos + 32)         // res_type
    buf.writeUInt8(0,         pos + 33)         // flags = 0
    buf.writeUInt16LE(0,      pos + 34)         // reserved
    buf.writeUInt32LE(offset, pos + 36)         // offset en DATA
    buf.writeUInt32LE(size,   pos + 40)         // tamaño
    buf.writeUInt32LE(extra,  pos + 44)         // extra
  }

  /**
   * Construye un fichero DAT a partir de una lista de recursos.
   * @param {Array<{id:string, res_type:number, filePath:string, extra?:number}>} entries
   * @param {number} dat_type  DAT_TYPE_GFX | DAT_TYPE_AUDIO
   * @param {string} outPath   Ruta del fichero .DAT de salida
   */
  async function buildDat(entries, dat_type, outPath) {
    const num = entries.length
    const dataOffset = HEADER_SIZE + num * INDEX_ENTRY

    // Leer todos los ficheros (o usar buffer directo si está disponible)
    const buffers = []
    for (const e of entries) {
      if (e.buffer) {
        buffers.push(e.buffer)
      } else if (!existsSync(e.filePath)) {
        errors.push(`Asset no encontrado: ${e.filePath}`)
        buffers.push(Buffer.alloc(0))
      } else {
        buffers.push(readFileSync(e.filePath))
      }
    }

    // Calcular offsets acumulados en DATA
    const offsets = []
    let cursor = 0
    for (const b of buffers) { offsets.push(cursor); cursor += b.length }
    const totalDataSize = cursor

    // Header (16 bytes)
    const header = Buffer.alloc(HEADER_SIZE, 0)
    MAGIC.copy(header, 0)
    header.writeUInt8(dat_type, 4)
    header.writeUInt8(VERSION,  5)
    header.writeUInt16LE(num,   6)
    header.writeUInt32LE(HEADER_SIZE, 8)          // index_offset = 16
    header.writeUInt32LE(dataOffset,  12)         // data_offset

    // Índice (num * 48 bytes)
    const indexBuf = Buffer.alloc(num * INDEX_ENTRY, 0)
    for (let i = 0; i < num; i++) {
      writeIndexEntry(indexBuf, i * INDEX_ENTRY,
        entries[i].id,
        entries[i].res_type,
        offsets[i],
        buffers[i].length,
        entries[i].extra || 0
      )
    }

    // Concatenar y escribir
    const out = Buffer.concat([header, indexBuf, ...buffers])
    try { require('fs').unlinkSync(outPath) } catch(_) {}
    writeFileSync(outPath, out)
    try { require('fs').chmodSync(outPath, 0o666) } catch(_) {}
    return { entries: num, bytes: out.length }
  }

  // ── Recopilar assets ───────────────────────────────────────────────────────

  log('Recopilando assets del proyecto…')

  const gfxEntries   = []
  const audioEntries = []

  // Helper: leer un directorio de forma segura
  function safeReaddir(dir) {
    try { return existsSync(dir) ? readdirSync(dir) : [] } catch { return [] }
  }
  // Sincronizar y cargar mapa de assets (PCX → id timestamp)
  const assetsMap = syncAssetsMap(gameDir)
  // Auditoría: reportar PCX faltantes
  const missingPcx = []

  // — Backgrounds de rooms —
  const bgDir = path_m.join(gameDir, 'assets', 'converted', 'backgrounds')
  for (const f of safeReaddir(bgDir).filter(f => f.toUpperCase().endsWith('.PCX'))) {
    const filePath = path_m.join(bgDir, f)
    const id = resolveAssetId(assetsMap, f) || ('bg_' + path_m.basename(f, path_m.extname(f)).slice(0, 28))
    if (!existsSync(filePath)) { missingPcx.push(f); continue }
    gfxEntries.push({ id, res_type: RES_BACKGROUND, filePath })
  }
  log(`  Backgrounds: ${gfxEntries.length} PCX`)

  // — Sprites de personajes —
  const sprDir = path_m.join(gameDir, 'assets', 'converted', 'sprites')
  const sprBefore = gfxEntries.length
  for (const f of safeReaddir(sprDir).filter(f => f.toUpperCase().endsWith('.PCX'))) {
    const filePath = path_m.join(sprDir, f)
    const id = resolveAssetId(assetsMap, f) || ('spr_' + path_m.basename(f, path_m.extname(f)).slice(0, 27))
    if (!existsSync(filePath)) { missingPcx.push(f); continue }
    gfxEntries.push({ id, res_type: RES_SPRITE, filePath })
  }
  log(`  Sprites: ${gfxEntries.length - sprBefore} PCX`)

  // — Variantes espejadas de sprites (flipH / flipV) —
  // Lee los JSONs de personajes, genera PCX espejados en memoria y los añade al DAT
  // con id "spr_NOMBRE_FH", "spr_NOMBRE_FV" o "spr_NOMBRE_FH_FV"
  {
    function flipPcxBuffer(buf, flipH, flipV) {
      try {
        const dv  = new DataView(buf.buffer, buf.byteOffset)
        const totalW = dv.getUint16(8,  true) + 1
        const totalH = dv.getUint16(10, true) + 1
        const bpl    = dv.getUint16(66, true)
        const pixels = new Uint8Array(bpl * totalH)
        let pos = 128, out = 0
        while (out < pixels.length && pos < buf.length - 769) {
          const b = buf[pos++]
          if ((b & 0xC0) === 0xC0) {
            const run = b & 0x3F, val = buf[pos++]
            for (let i = 0; i < run && out < pixels.length; i++) pixels[out++] = val
          } else { pixels[out++] = b }
        }
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
            if (run > 1 || (v & 0xC0) === 0xC0) { encoded.push(0xC0 | run, v) }
            else { encoded.push(v) }
            x += run
          }
        }
        const header  = Buffer.from(buf).slice(0, 128)
        const palette = Buffer.from(buf).slice(buf.length - 769)
        return Buffer.concat([header, Buffer.from(encoded), palette])
      } catch (e) { log(`  flipPcxBuffer error: ${e.message}`, 'warn'); return buf }
    }

    const charsDir = path_m.join(gameDir, 'characters')
    const seenFlipped = new Set()
    for (const f of safeReaddir(charsDir).filter(f => f.endsWith('.json'))) {
      let ch
      try { ch = JSON.parse(readFileSync(path_m.join(charsDir, f), 'utf8')) } catch { continue }
      for (const anim of (ch.animations || [])) {
        if (!anim.spriteFile || (!anim.flipH && !anim.flipV)) continue
        const baseName = path_m.basename(anim.spriteFile, path_m.extname(anim.spriteFile)).slice(0, 24)
        const suffix   = (anim.flipH ? '_FH' : '') + (anim.flipV ? '_FV' : '')
        const flippedId = 'spr_' + baseName + suffix
        if (seenFlipped.has(flippedId)) continue
        const pcxPath = path_m.join(sprDir, anim.spriteFile)
        if (!existsSync(pcxPath)) { log(`  [flip] PCX no encontrado: ${anim.spriteFile}`, 'warn'); continue }
        try {
          const orig    = readFileSync(pcxPath)
          const flipped = flipPcxBuffer(orig, anim.flipH === true, anim.flipV === true)
          gfxEntries.push({ id: flippedId, res_type: RES_SPRITE, buffer: flipped })
          seenFlipped.add(flippedId)
          log(`  sprite flip: ${flippedId}${anim.flipH ? ' ↔' : ''}${anim.flipV ? ' ↕' : ''}`)
        } catch (e) { errors.push(`SpriteFlip ${anim.spriteFile}: ${e.message}`) }
      }
    }
  }

  // — PCX de objetos —
  const objDir = path_m.join(gameDir, 'assets', 'converted', 'objects')
  const objBefore = gfxEntries.length
  for (const f of safeReaddir(objDir).filter(f => f.toUpperCase().endsWith('.PCX'))) {
    const filePath = path_m.join(objDir, f)
    const id = resolveAssetId(assetsMap, f) || ('obj_' + path_m.basename(f, path_m.extname(f)).slice(0, 27))
    if (!existsSync(filePath)) { missingPcx.push(f); continue }
    gfxEntries.push({ id, res_type: RES_OBJECT_PCX, filePath })
  }
  log(`  Objetos: ${gfxEntries.length - objBefore} PCX`)

  // — Flechas de inventario — IDs fijos que el motor busca por nombre
  {
    let gameJsonForArrows = {}
    try { gameJsonForArrows = JSON.parse(readFileSync(path_m.join(gameDir, 'game.json'), 'utf8')) } catch (_) {}
    const invArrows = gameJsonForArrows.invArrows || {}
    const arrowMap = [
      { key: 'up',        id: 'inv_arrow_up'        },
      { key: 'upHover',   id: 'inv_arrow_up_hover'  },
      { key: 'down',      id: 'inv_arrow_down'      },
      { key: 'downHover', id: 'inv_arrow_down_hover' },
    ]
    for (const { key, id } of arrowMap) {
      const filename = invArrows[key]
      if (!filename) continue
      const filePath = path_m.join(objDir, filename)
      if (!existsSync(filePath)) { log(`  ⚠ inv_arrow ${id}: PCX no encontrado: ${filename}`, 'warn'); continue }
      // Solo añadir si no existe ya una entrada con ese id fijo
      if (!gfxEntries.find(e => e.id === id)) {
        gfxEntries.push({ id, res_type: RES_OBJECT_PCX, filePath })
        log(`  inv arrow: ${id} <- ${filename}`)
      }
    }
  }

  // — Fuentes bitmap —
  // Fuentes: van a FONTS.DAT (no a GRAPHICS.DAT)
  const fntDir = path_m.join(gameDir, 'assets', 'converted', 'fonts')
  const fntFiles = safeReaddir(fntDir).filter(f => f.toUpperCase().endsWith('.PCX'))
  log('  Fuentes encontradas: ' + fntFiles.length + ' PCX -> FONTS.DAT')

  // — MIDI — guardar directamente en AUDIO.DAT
  const midiDir = path_m.join(gameDir, 'audio', 'music')
  for (const f of safeReaddir(midiDir).filter(f => /\.(mid|midi)$/i.test(f))) {
    const baseName = path_m.basename(f, path_m.extname(f))
    /* Sanitizar: espacios y caracteres no alfanuméricos → guion bajo */
    const safeBase = baseName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 27)
    const id = 'mid_' + safeBase
    let filePath = path_m.join(midiDir, f)
    log('  MIDI: ' + f)
    audioEntries.push({ id, res_type: RES_MIDI, filePath })
  }
  log(`  MIDI: ${audioEntries.length} ficheros`)

  // — SFX WAV —
  const sfxBefore = audioEntries.length
  const sfxDir = path_m.join(gameDir, 'audio', 'sfx')
  for (const f of safeReaddir(sfxDir).filter(f => /\.wav$/i.test(f))) {
    const id = 'sfx_' + path_m.basename(f, path_m.extname(f)).slice(0, 27)
    audioEntries.push({ id, res_type: RES_SFX, filePath: path_m.join(sfxDir, f) })
  }
  log(`  SFX WAV: ${audioEntries.length - sfxBefore} ficheros`)

  // ── Generar GRAPHICS.DAT ───────────────────────────────────────────────────
  if (gfxEntries.length === 0) {
    log('  GRAPHICS.DAT — sin assets gráficos, se omite', 'info')
  } else {
    if (missingPcx.length > 0) {
      for (const m of missingPcx) log(`  ⚠ PCX faltante: ${m}`, 'warn')
    }
    log(`Generando GRAPHICS.DAT (${gfxEntries.length} recursos)…`)
    try {
      const gfxPath = path_m.join(buildDir, 'GRAPHICS.DAT')
      const r = await buildDat(gfxEntries, DAT_TYPE_GFX, gfxPath)
      const kb = (r.bytes / 1024).toFixed(1)
      log(`  GRAPHICS.DAT — ${r.entries} entradas, ${kb} KB`, 'success')
    } catch (e) {
      errors.push('GRAPHICS.DAT: ' + e.message)
      log('  GRAPHICS.DAT — ERROR: ' + e.message, 'error')
    }
  }

  // ── Generar FONTS.DAT ────────────────────────────────────────────────────────
  {
    const DAT_TYPE_FONTS = 4
    log('Generando FONTS.DAT...')
    try {
      // Asegurar fuentes base con fontGenerator
      const { ensureBaseFonts } = await import('./fontGenerator.js')
      ensureBaseFonts(fntDir, (msg) => log('  ' + msg))

      const fontEntries = safeReaddir(fntDir)
        .filter(f => f.toUpperCase().endsWith('.PCX'))
        .map(f => ({
          id: path_m.basename(f, path_m.extname(f)).slice(0, 31),
          res_type: RES_FONT_PCX,
          filePath: path_m.join(fntDir, f)
        }))

      if (fontEntries.length === 0) {
        log('  FONTS.DAT -- sin fuentes, se omite', 'warn')
      } else {
        const fontsPath = path_m.join(buildDir, 'FONTS.DAT')
        const r = await buildDat(fontEntries, DAT_TYPE_FONTS, fontsPath)
        log('  FONTS.DAT -- ' + r.entries + ' fuentes, ' + (r.bytes/1024).toFixed(1) + ' KB', 'success')
      }
    } catch(e) {
      errors.push('FONTS.DAT: ' + e.message)
      log('  FONTS.DAT -- ERROR: ' + e.message, 'error')
    }
  }

  // ── Generar AUDIO.DAT ──────────────────────────────────────────────────────
  if (audioEntries.length === 0) {
    log('  AUDIO.DAT — sin assets de audio, se omite', 'info')
  } else {
    log(`Generando AUDIO.DAT (${audioEntries.length} recursos)…`)
    try {
      const audioPath = path_m.join(buildDir, 'AUDIO.DAT')
      const r = await buildDat(audioEntries, DAT_TYPE_AUDIO, audioPath)
      const kb = (r.bytes / 1024).toFixed(1)
      log(`  AUDIO.DAT — ${r.entries} entradas, ${kb} KB`, 'success')
    } catch (e) {
      errors.push('AUDIO.DAT: ' + e.message)
      log('  AUDIO.DAT — ERROR: ' + e.message, 'error')
    }
  }

  // ── Generar TEXT.DAT ───────────────────────────────────────────────────────
  // Formato TEXT.DAT:
  //   Header estándar AGMK (dat_type=3=TEXT)
  //   Índice: una entrada por idioma, id = "lang_es", "lang_en", etc.
  //   DATA: por cada idioma, un bloque binario compacto:
  //     uint16 num_keys
  //     por cada clave:
  //       uint8  key_len   + key_bytes   (sin null terminator)
  //       uint16 val_len   + val_bytes   (sin null terminator, UTF-8)
  // El motor carga el idioma activo al arrancar y construye una tabla hash
  // en RAM para acceso O(1) por clave.
  const DAT_TYPE_TEXT = 3
  const RES_LOCALE    = 0x30

  const localesDir = path_m.join(gameDir, 'locales')
  const langFiles  = safeReaddir(localesDir).filter(f => f.endsWith('.json'))

  /* Claves de menú — se inyectan en cada locale si no existen */
  const MENU_LOCALE_DEFAULTS = {
    es: {
      'menu.titulo':            'MENU',
      'menu.continuar':         'Continuar',
      'menu.nueva_partida':     'Nueva partida',
      'menu.configuracion':     'Configuracion',
      'menu.guardar_partida':   'Guardar partida',
      'menu.restaurar_partida': 'Restaurar partida',
      'menu.salir':             'Salir a DOS',
      'menu.config.titulo':     'Configuracion',
      'menu.config.idioma':     'Idioma',
    },
    en: {
      'menu.titulo':            'MENU',
      'menu.continuar':         'Continue',
      'menu.nueva_partida':     'New game',
      'menu.configuracion':     'Settings',
      'menu.guardar_partida':   'Save game',
      'menu.restaurar_partida': 'Load game',
      'menu.salir':             'Quit to DOS',
      'menu.config.titulo':     'Settings',
      'menu.config.idioma':     'Language',
    }
  }
  for (const lf of langFiles) {
    const lang = lf.replace('.json', '')
    const localePath = path_m.join(localesDir, lf)
    let locale = {}
    try { locale = JSON.parse(readFileSync(localePath, 'utf8')) } catch {}
    const defaults = MENU_LOCALE_DEFAULTS[lang] || MENU_LOCALE_DEFAULTS['en']
    let changed = false
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in locale)) { locale[k] = v; changed = true }
    }
    /* Inyectar nombres de salidas si no existen en el locale */
    { const _roomsDir = path_m.join(gameDir, 'rooms')
      const _roomDirs = safeReaddir(_roomsDir).filter(d =>
        existsSync(path_m.join(_roomsDir, d, 'room.json')))
      for (const _rid of _roomDirs) {
        let _room = null
        try { _room = JSON.parse(readFileSync(path_m.join(_roomsDir, _rid, 'room.json'), 'utf8')) } catch {}
        if (!_room?.exits?.length) continue
        for (const ex of _room.exits) {
          const nameKey = `exit.${ex.id.replace(/[^a-zA-Z0-9_]/g,'_')}.name`
          if (!(nameKey in locale)) { locale[nameKey] = ex.name || ex.id; changed = true }
        }
      }
    }
    /* Inyectar textos del sistema sys.* con valor vacío si no existen */
    const SYS_KEYS = ['sys.cannot_reach', 'sys.cannot_pickup', 'sys.cannot_use', 'sys.usar_con.no_result', 'sys.usar_con.no_inv']
    for (const sk of SYS_KEYS) {
      if (!(sk in locale)) { locale[sk] = ''; changed = true }
    }
    if (changed) writeFileSync(localePath, JSON.stringify(locale, null, 2), 'utf8')
  }

  if (langFiles.length === 0) {
    log('  TEXT.DAT — sin idiomas, se omite', 'info')
  } else {
    log(`Generando TEXT.DAT (${langFiles.length} idiomas)…`)
    try {
      // Construir entradas de texto: una por idioma
      const textEntries = []
      const textBuffers = []

      for (const lf of langFiles) {
        const lang = lf.replace('.json', '')
        let data = {}
        try { data = JSON.parse(readFileSync(path_m.join(localesDir, lf), 'utf8')) } catch {}
        const keys = Object.keys(data)

        // Serializar: uint16 num_keys + [uint8 klen + kbytes + uint16 vlen + vbytes]*
        const parts = []
        const numBuf = Buffer.alloc(2); numBuf.writeUInt16LE(keys.length, 0); parts.push(numBuf)
        for (const k of keys) {
          const kb = Buffer.from(k, 'utf8')          // claves: siempre ASCII, utf8 ok
          const vb = utf8ToCp850(data[k] || '')      // valores: convertir a CP850 para el motor DOS
          const klenBuf = Buffer.alloc(1); klenBuf.writeUInt8(Math.min(kb.length, 255), 0)
          const vlenBuf = Buffer.alloc(2); vlenBuf.writeUInt16LE(vb.length, 0)
          parts.push(klenBuf, kb.slice(0, 255), vlenBuf, vb)
        }
        const blob = Buffer.concat(parts)
        const id   = `lang_${lang}`.slice(0, 31)
        textEntries.push({ id, res_type: RES_LOCALE, filePath: null, _buf: blob })
        textBuffers.push(blob)
        log(`    ${lang}: ${keys.length} claves, ${blob.length} bytes`)
      }

      // buildDat espera filePath — para TEXT.DAT escribimos los buffers en tmp y luego los borramos
      // En lugar de eso construimos el DAT manualmente (igual que buildDat pero con buffers directos)
      const num        = textEntries.length
      const dataOffset = HEADER_SIZE + num * INDEX_ENTRY
      let cursor = 0
      const offsets = textBuffers.map(b => { const o = cursor; cursor += b.length; return o })

      const header = Buffer.alloc(HEADER_SIZE, 0)
      MAGIC.copy(header, 0)
      header.writeUInt8(DAT_TYPE_TEXT, 4)
      header.writeUInt8(VERSION,       5)
      header.writeUInt16LE(num,        6)
      header.writeUInt32LE(HEADER_SIZE, 8)
      header.writeUInt32LE(dataOffset,  12)

      const indexBuf = Buffer.alloc(num * INDEX_ENTRY, 0)
      for (let i = 0; i < num; i++) {
        writeIndexEntry(indexBuf, i * INDEX_ENTRY,
          textEntries[i].id, RES_LOCALE, offsets[i], textBuffers[i].length, 0)
      }

      const out      = Buffer.concat([header, indexBuf, ...textBuffers])
      const textPath = path_m.join(buildDir, 'TEXT.DAT')
      writeFileSync(textPath, out)
      const kb = (out.length / 1024).toFixed(1)
      log(`  TEXT.DAT — ${num} idiomas, ${kb} KB`, 'success')
    } catch (e) {
      errors.push('TEXT.DAT: ' + e.message)
      log('  TEXT.DAT — ERROR: ' + e.message, 'error')
    }
  }

  // ── Generar SCRIPTS.DAT ───────────────────────────────────────────────────
  // Contiene: verbsets, rooms (params), personajes, objetos, secuencias, scripts
  log('Generando SCRIPTS.DAT...')
  try {
    const DAT_TYPE_SCRIPTS = 1
    const RES_GAME_PARAMS  = 0x00
    const RES_ROOM         = 0x10
    const RES_OBJECT       = 0x11
    const RES_CHARACTER    = 0x12
    const RES_VERBSET      = 0x13
    const RES_DIALOGUE     = 0x14
    const RES_SCRIPT       = 0x15
    const RES_SEQUENCE     = 0x16

    function sStr8(s)  { return 1 + Buffer.byteLength(String(s||''),'utf8') }
    function wStr8(b,o,s) {
      const bytes = Buffer.from(String(s||''), 'utf8')
      b.writeUInt8(bytes.length, o); bytes.copy(b, o+1); return o+1+bytes.length
    }
    function wBool(b,o,v) { b.writeUInt8(v?1:0,o); return o+1 }

    const scrBlocks = []  // { id, res_type, data }

    // Cargar locales para labels de verbos: guardados como "verb.<verbId>"
    let verbLocale = {}
    try {
      const gj = JSON.parse(readFileSync(path_m.join(gameDir, 'game.json'), 'utf8'))
      const activeLang = gj.activeLanguage || 'es'
      const lp = path_m.join(gameDir, 'locales', activeLang + '.json')
      if (existsSync(lp)) verbLocale = JSON.parse(readFileSync(lp, 'utf8'))
    } catch(e2) { /* sin locales */ }

    // verbsets
    const vsDir = path_m.join(gameDir, 'verbsets')
    for (const f of safeReaddir(vsDir).filter(f => f.endsWith('.json'))) {
      try {
        const vs = JSON.parse(readFileSync(path_m.join(vsDir, f), 'utf8'))
        const verbs = vs.verbs || []
        function verbLabel(v) {
          const loc = verbLocale['verb.' + v.id]
          if (loc && loc.trim()) return loc.trim()
          if (v.label && v.label.trim()) return v.label.trim()
          const parts = v.id.split('_')
          return parts[parts.length - 1] || v.id
        }
        let sz = sStr8(vs.id) + sStr8(vs.name||vs.id) + 1
        for (const v of verbs) sz += sStr8(v.id) + sStr8(verbLabel(v)) + 7
        const buf = Buffer.alloc(sz)
        let off = 0
        off = wStr8(buf, off, vs.id)
        off = wStr8(buf, off, vs.name||vs.id)
        buf.writeUInt8(verbs.length, off); off++
        for (let vi = 0; vi < verbs.length; vi++) {
          const v = verbs[vi]
          off = wStr8(buf, off, v.id)
          off = wStr8(buf, off, verbLabel(v))
          off = wBool(buf, off, v.isMovement||false)
          off = wBool(buf, off, v.approachObject||false)
          off = wBool(buf, off, v.isPickup||false)
          buf.writeUInt8(vi % 3, off); off++          // col por indice
          buf.writeUInt8(Math.floor(vi / 3), off); off++ // row por indice
          buf.writeUInt8(v.normalColor !== undefined ? v.normalColor : 15, off); off++ // normal_color
          buf.writeUInt8(v.hoverColor  !== undefined ? v.hoverColor  : 15, off); off++ // hover_color
        }
        scrBlocks.push({ id: vs.id, res_type: RES_VERBSET, data: buf.slice(0,off) })
        log('  verbset: ' + (vs.name||vs.id) + ' (' + verbs.length + ' verbos)')
      } catch(e2) { errors.push('verbset ' + f + ': ' + e2.message) }
    }

    // rooms (solo params basicos para el motor)
    const roomsDir2 = path_m.join(gameDir, 'rooms')
    for (const entry of safeReaddir(roomsDir2)) {
      const rjson = path_m.join(roomsDir2, entry, 'room.json')
      if (!existsSync(rjson)) continue
      try {
        const room = JSON.parse(readFileSync(rjson, 'utf8'))
        const sz = sStr8(room.id) + sStr8(room.name||room.id) + sStr8(room.bgId||'') + 2
        const buf = Buffer.alloc(sz)
        let off = 0
        off = wStr8(buf, off, room.id)
        off = wStr8(buf, off, room.name||room.id)
        off = wStr8(buf, off, room.bgId||'')
        buf.writeUInt8(room.walkmapCols||40, off); off++
        buf.writeUInt8(room.walkmapRows||25, off); off++
        scrBlocks.push({ id: room.id, res_type: RES_ROOM, data: buf.slice(0,off) })
      } catch(e2) { errors.push(`room ${entry}: ${e2.message}`) }
    }

    const scr_dataOffset = HEADER_SIZE + scrBlocks.length * INDEX_ENTRY
    const scr_header = Buffer.alloc(HEADER_SIZE, 0)
    MAGIC.copy(scr_header, 0)
    scr_header.writeUInt8(DAT_TYPE_SCRIPTS, 4)
    scr_header.writeUInt8(VERSION, 5)
    scr_header.writeUInt16LE(scrBlocks.length, 6)
    scr_header.writeUInt32LE(HEADER_SIZE, 8)
    scr_header.writeUInt32LE(scr_dataOffset, 12)

    const scr_indexBuf = Buffer.alloc(scrBlocks.length * INDEX_ENTRY, 0)
    let scr_relOff = 0
    for (let i = 0; i < scrBlocks.length; i++) {
      writeIndexEntry(scr_indexBuf, i * INDEX_ENTRY,
        scrBlocks[i].id, scrBlocks[i].res_type, scr_relOff, scrBlocks[i].data.length, 0)
      scr_relOff += scrBlocks[i].data.length
    }

    const scr_out = Buffer.concat([scr_header, scr_indexBuf, ...scrBlocks.map(b=>b.data)])
    const scr_path = path_m.join(buildDir, 'SCRIPTS.DAT')
    writeFileSync(scr_path, scr_out)
    log(`  SCRIPTS.DAT -- ${scrBlocks.length} recursos, ${(scr_out.length/1024).toFixed(1)} KB`, 'success')
  } catch(e) {
    errors.push('SCRIPTS.DAT: ' + e.message)
    log('  SCRIPTS.DAT -- ERROR: ' + e.message, 'error')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * generateMainC -- Genera main.c a partir de todos los JSON del proyecto.
 *
 * El fichero generado es el punto de entrada del juego DOS. Contiene:
 *   - Declaraciones forward de todas las rooms, secuencias y scripts
 *   - Implementación de cada room (load_bg, place_chars, register_exits,
 *     register_objects, register_scripts)
 *   - Implementación de cada secuencia (pasos en orden)
 *   - Implementación de cada script (instrucciones con IF/flag/char/audio)
 *   - main() que inicializa el motor y arranca el juego
 *
 * El motor base (agemki_engine.h/c) provee todas las funciones que se llaman.
 *
 * @param {string} gameDir   Directorio raíz del juego
 * @returns {Promise<{ok:boolean, code:string, error?:string}>}
 */
async function generateMainC(gameDir, audioDriver) {
  const lines = []
  const e = s => lines.push(s)  // emit line

  // helpers
  function safeRead(p) {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  }
  function safeReaddir(dir) {
    try { return existsSync(dir) ? readdirSync(dir) : [] } catch { return [] }
  }
  function cId(s) {
    // Convierte un id a identificador C válido
    return String(s).replace(/[^a-zA-Z0-9_]/g, '_')
  }
  function cStr(s) {
    // Escapa una string para literal C
    return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  }
  function sfxIdToEngineId(sfxId) {
    // Convierte "sfx:insertcoin.wav" al id que sfxGenerator graba en SFX.DAT: "sfx_insertcoin"
    // Debe coincidir exactamente con la lógica de sfxGenerator.js
    const name = String(sfxId || '').replace(/^sfx:/i, '').replace(/\.wav$/i, '')
    return 'sfx_' + name.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  }

  // Cargar mapa de assets (PCX → id timestamp)
  const assetsMap = syncAssetsMap(gameDir)

  // Leer game.json
  const gamePath = path_m.join(gameDir, 'game.json')
  const game = safeRead(gamePath)
  if (!game) return { ok: false, error: 'No se puede leer game.json' }

  // Leer todos los recursos
  const charIds = safeReaddir(path_m.join(gameDir, 'characters'))
    .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''))
  const chars = {}
  for (const id of charIds) {
    const c = safeRead(path_m.join(gameDir, 'characters', `${id}.json`))
    if (c) chars[id] = c
  }

  const objectIds = safeReaddir(path_m.join(gameDir, 'objects'))
    .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''))
  const objects = {}
  for (const id of objectIds) {
    const o = safeRead(path_m.join(gameDir, 'objects', `${id}.json`))
    if (o) objects[id] = o
  }

  const roomIds = safeReaddir(path_m.join(gameDir, 'rooms'))
    .filter(d => existsSync(path_m.join(gameDir, 'rooms', d, 'room.json')))
  const rooms = {}
  for (const id of roomIds) {
    const r = safeRead(path_m.join(gameDir, 'rooms', id, 'room.json'))
    if (r) rooms[id] = r
  }

  const verbsetFiles = safeReaddir(path_m.join(gameDir, 'verbsets')).filter(f => f.endsWith('.json'))
  const verbsetsMap = {}
  for (const f of verbsetFiles) {
    const vs = safeRead(path_m.join(gameDir, 'verbsets', f))
    if (vs) verbsetsMap[vs.id] = vs
  }

  const seqIds = safeReaddir(path_m.join(gameDir, 'sequences'))
    .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''))
  const sequences = {}
  for (const id of seqIds) {
    const s = safeRead(path_m.join(gameDir, 'sequences', `${id}.json`))
    if (s) sequences[id] = s
  }

  const scriptIds = safeReaddir(path_m.join(gameDir, 'scripts'))
    .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''))
  const scripts = {}
  for (const id of scriptIds) {
    const s = safeRead(path_m.join(gameDir, 'scripts', `${id}.json`))
    if (s) scripts[id] = s
  }

  const dialogueIds = safeReaddir(path_m.join(gameDir, 'dialogues'))
    .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''))
  const dialogues = {}
  for (const id of dialogueIds) {
    const d = safeRead(path_m.join(gameDir, 'dialogues', `${id}.json`))
    if (d) dialogues[id] = d
  }

  // ── Cabecera ────────────────────────────────────────────────────────────────
  e('/* ================================================================')
  e(` * main.c — ${cStr(game.name || game.id)}`)
  e(' * Generado por AGEMKI. NO EDITAR MANUALMENTE.')
  e(' * Se sobreescribe en cada build.')
  e(' * ================================================================ */')
  e('#include "agemki_dat.h"')
  e('#include "agemki_engine.h"')
  /* MIDPAK no requiere includes extra en main.c */
  e('')

  // ── Constantes de animación hardcodeadas ──────────────────────────────────
  // El motor C usa estas constantes directamente — sin búsqueda de strings en runtime.
  // Roles: idle, walk_right, walk_left (null=espejo), walk_up (null=walk_right), walk_down (null=walk_right)
  e('/* ── Animaciones de personajes (hardcodeadas por el generador) ── */')
  for (const id of charIds) {
    const ch = chars[id]
    if (!ch) continue
    const roles   = ch.animRoles || {}
    const anims   = ch.animations || []
    const prefix  = `CHAR_${cId(id).toUpperCase()}`

    // Helper: busca la animación por id y devuelve sus campos
    function getAnim(animId) {
      return anims.find(a => a.id === animId) || null
    }

    e(`/* ${cStr(ch.name || id)} */`)

    const ROLE_DEFS = [
      { role: 'idle',       fallback: null },
      { role: 'walk_right', fallback: null },
      { role: 'walk_left',  fallback: 'walk_right' },
      { role: 'walk_up',    fallback: 'walk_right' },
      { role: 'walk_down',  fallback: 'walk_right' },
      { role: 'idle_up',    fallback: null },
      { role: 'idle_down',  fallback: null },
      { role: 'talk',       fallback: null },
      { role: 'talk_left',  fallback: 'talk' },
      { role: 'talk_up',    fallback: 'talk' },
      { role: 'talk_down',  fallback: 'talk' },
      { role: 'give',       fallback: 'talk' },
    ]

    for (const { role, fallback } of ROLE_DEFS) {
      const ownAnimId      = roles[role]
      const fallbackAnimId = fallback ? roles[fallback] : null
      const ownAnim        = ownAnimId      ? getAnim(ownAnimId)      : null
      const fallbackAnim   = fallbackAnimId ? getAnim(fallbackAnimId) : null
      const sourceAnim     = ownAnim || fallbackAnim || null

      const isFlipH = sourceAnim?.flipH === true ||
                      (!ownAnim && role === 'walk_left' && !!roles['walk_right'])
      const isFlipV = sourceAnim?.flipV === true

      // El PCX que el motor recibe:
      // - Si hay flip → id del PCX espejado generado por el datGenerator (_FH, _FV, _FH_FV)
      // - Si no hay flip → id del PCX original
      // En ambos casos el motor recibe el pixel correcto y _FLIP/_FLIPV = 0
      const macPfx = `${prefix}_${role.toUpperCase()}`
      let pcxName = ''
      if (sourceAnim?.spriteFile) {
        // Para flips: el id base es siempre spr_NOMBRE (igual que en el DAT builder)
        // Para no-flip: usar assetsMap si disponible
        const baseName = `spr_${sourceAnim.spriteFile.replace(/\.PCX$/i, '').slice(0, 24)}`
        const suffix   = (isFlipH ? '_FH' : '') + (isFlipV ? '_FV' : '')
        if (suffix) {
          pcxName = baseName + suffix  // flip: siempre spr_NOMBRE_FH/FV
        } else {
          pcxName = resolveAssetId(assetsMap, sourceAnim.spriteFile) || baseName
        }
      }
      e(`#define ${macPfx}_PCX    "${pcxName}"`)
      e(`#define ${macPfx}_FRAMES ${sourceAnim?.frameCount || 1}`)
      e(`#define ${macPfx}_FPS    ${sourceAnim?.fps || 8}`)
      e(`#define ${macPfx}_FW     ${sourceAnim?.frameWidth || 0}`)
      e(`#define ${macPfx}_LOOP   ${sourceAnim?.loop !== false ? 1 : 0}`)
      e(`#define ${macPfx}_FLIP   0`)   /* siempre 0: el PCX ya viene pre-espejado */
      e(`#define ${macPfx}_FLIPV  0`)
    }
    e(`#define ${prefix}_SPEED   ${ch.walkSpeed || 2}`)
    e(`#define ${prefix}_PROTAGONIST ${ch.isProtagonist ? 1 : 0}`)
    e('')
  }

  // ── Forward declarations ────────────────────────────────────────────────────
  e('/* ── Forward declarations ─────────────────────────────────────── */')
  for (const id of roomIds)    e(`static void room_${cId(id)}(void);`)
  for (const id of seqIds)     e(`static void seq_${cId(id)}(void);`)
  for (const id of scriptIds)  e(`static void scr_${cId(id)}(void);`)
  for (const id of dialogueIds) e(`static void dlg_${cId(id)}(void);`)
  e('')

  // ── Funciones de colocacion de protagonistas (party reinject) ────────────────
  // Generadas para cada isProtagonist=true. El motor las llama cuando necesita
  // reinyectar al personaje en una room que no lo coloca en su load_fn.
  {
    const protagonists = charIds.filter(id => chars[id]?.isProtagonist)
    if (protagonists.length > 0) {
      e('/* ── Party: funciones de colocacion de protagonistas ─────────── */')
      for (const id of protagonists) {
        const ch = chars[id]
        const pfx = `CHAR_${cId(id).toUpperCase()}`
        e(`static void _party_place_${cId(id)}(s16 _ppx, s16 _ppy) {`)
        e(`    engine_place_char("${cStr(id)}", _ppx, _ppy,`)
        e(`        ${pfx}_IDLE_PCX,       ${pfx}_IDLE_FRAMES,       ${pfx}_IDLE_FPS,       ${pfx}_IDLE_FW,`)
        e(`        ${pfx}_WALK_RIGHT_PCX, ${pfx}_WALK_RIGHT_FRAMES, ${pfx}_WALK_RIGHT_FPS, ${pfx}_WALK_RIGHT_FW,`)
        e(`        ${pfx}_WALK_LEFT_PCX,  ${pfx}_WALK_LEFT_FRAMES,  ${pfx}_WALK_LEFT_FPS,  ${pfx}_WALK_LEFT_FW,  ${pfx}_WALK_LEFT_FLIP,`)
        e(`        ${pfx}_WALK_UP_PCX,    ${pfx}_WALK_UP_FRAMES,    ${pfx}_WALK_UP_FPS,    ${pfx}_WALK_UP_FW,`)
        e(`        ${pfx}_WALK_DOWN_PCX,  ${pfx}_WALK_DOWN_FRAMES,  ${pfx}_WALK_DOWN_FPS,  ${pfx}_WALK_DOWN_FW,`)
        e(`        ${pfx}_IDLE_UP_PCX,    ${pfx}_IDLE_UP_FRAMES,    ${pfx}_IDLE_UP_FPS,    ${pfx}_IDLE_UP_FW,`)
        e(`        ${pfx}_IDLE_DOWN_PCX,  ${pfx}_IDLE_DOWN_FRAMES,  ${pfx}_IDLE_DOWN_FPS,  ${pfx}_IDLE_DOWN_FW,`)
        e(`        ${pfx}_SPEED, ${pfx}_PROTAGONIST);`)
        const stColor = typeof ch.subtitleColor === 'number' ? ch.subtitleColor : 15
        if (stColor !== 15) e(`    engine_set_char_subtitle_color("${cStr(id)}", ${stColor});`)
        e(`}`)
      }
      e('')
    }
  }

  // ── Helper: resuelve ID de animación JSON → nombre de rol del motor ──────────
  // El motor solo conoce roles ("idle","walk_right",...). Los IDs como
  // "anim_1774xxx" son del editor y se mapean via ch.animRoles en compile-time.
  const ANIM_ROLE_NAMES = ['idle','walk_right','walk_left','walk_up','walk_down','idle_up','idle_down','talk','talk_left','talk_up','talk_down','give']
  function resolveAnimRole(charId, animId) {
    if (!animId) return animId
    if (ANIM_ROLE_NAMES.includes(animId)) return animId  // ya es un nombre de rol
    const ch = chars[charId]
    if (ch?.animRoles) {
      for (const [role, id] of Object.entries(ch.animRoles)) {
        if (id === animId) return role
      }
    }
    return animId  // fallback: lo pasa tal cual
  }

  // ── Generador de instrucciones de script ────────────────────────────────────
  function emitInstruction(instr, indent) {
    const p = ' '.repeat(indent)
    const t = instr.type || ''
    switch (t) {
      case 'SET_FLAG':
        e(`${p}engine_set_flag("${cStr(instr.flag)}", ${JSON.stringify(instr.value || 'true')});`)
        break
      case 'IF':
        e(`${p}if (engine_eval_cond("${cStr(JSON.stringify(instr.condition || ''))}")) {`)
        break
      case 'ELIF':
        e(`${p}} else if (engine_eval_cond("${cStr(JSON.stringify(instr.condition || ''))}")) {`)
        break
      case 'ELSE':
        e(`${p}} else {`)
        break
      case 'END_IF':
        e(`${p}}`)
        break
      case 'RETURN':
        e(`${p}return;`)
        break
      case 'CALL_SCRIPT':
        e(`${p}scr_${cId(instr.scriptId)}();`)
        break
      case 'CHANGE_ROOM':
        e(`${p}engine_change_room("${cStr(instr.roomId)}", "${cStr(instr.entryId || 'entry_default')}");`)
        break
      case 'ENTER_CLOSEUP':
        e(`${p}engine_enter_closeup("${cStr(instr.roomId)}", ${instr.showUi ? 1 : 0});`)
        break
      case 'EXIT_CLOSEUP':
        e(`${p}engine_exit_closeup();`)
        break
      case 'SET_CHAR_ROOM_POS': {
        const _dir = instr.direction || 'right'
        const _anim = instr.animName || ''
        const _chDef = chars[instr.charId]
        if (_chDef) {
          // Si el personaje ya esta en la room (colocado por el party system),
          // no recolocar — preservar posicion y animacion guardadas.
          // Si no esta, colocarlo con sus datos de animacion completos.
          const _pfx = `CHAR_${cId(instr.charId).toUpperCase()}`
          e(`${p}if (!engine_char_in_room("${cStr(instr.charId)}")) {`)
          e(`${p}    engine_remove_char("${cStr(instr.charId)}");`)
          e(`${p}    engine_place_char("${cStr(instr.charId)}", ${instr.x|0}, ${instr.y|0},`)
          e(`${p}        ${_pfx}_IDLE_PCX,       ${_pfx}_IDLE_FRAMES,       ${_pfx}_IDLE_FPS,       ${_pfx}_IDLE_FW,`)
          e(`${p}        ${_pfx}_WALK_RIGHT_PCX, ${_pfx}_WALK_RIGHT_FRAMES, ${_pfx}_WALK_RIGHT_FPS, ${_pfx}_WALK_RIGHT_FW,`)
          e(`${p}        ${_pfx}_WALK_LEFT_PCX,  ${_pfx}_WALK_LEFT_FRAMES,  ${_pfx}_WALK_LEFT_FPS,  ${_pfx}_WALK_LEFT_FW,  ${_pfx}_WALK_LEFT_FLIP,`)
          e(`${p}        ${_pfx}_WALK_UP_PCX,    ${_pfx}_WALK_UP_FRAMES,    ${_pfx}_WALK_UP_FPS,    ${_pfx}_WALK_UP_FW,`)
          e(`${p}        ${_pfx}_WALK_DOWN_PCX,  ${_pfx}_WALK_DOWN_FRAMES,  ${_pfx}_WALK_DOWN_FPS,  ${_pfx}_WALK_DOWN_FW,`)
          e(`${p}        ${_pfx}_IDLE_UP_PCX,    ${_pfx}_IDLE_UP_FRAMES,    ${_pfx}_IDLE_UP_FPS,    ${_pfx}_IDLE_UP_FW,`)
          e(`${p}        ${_pfx}_IDLE_DOWN_PCX,  ${_pfx}_IDLE_DOWN_FRAMES,  ${_pfx}_IDLE_DOWN_FPS,  ${_pfx}_IDLE_DOWN_FW,`)
          e(`${p}        ${_pfx}_SPEED, ${_pfx}_PROTAGONIST);`)
          e(`${p}    engine_face_dir("${cStr(instr.charId)}", "${cStr(_dir)}");`)
          if (_anim) e(`${p}    engine_play_anim("${cStr(instr.charId)}", "${cStr(_anim)}");`)
          e(`${p}}`)
          // Animaciones de hablar: siempre se configuran (independiente del guard),
          // para que funcionen tanto en placement normal como cuando el personaje
          // ya estaba en la room colocado por el party system.
          if (_chDef.animRoles?.talk)
            e(`${p}engine_set_char_talk_anim("${cStr(instr.charId)}", ${_pfx}_TALK_PCX, ${_pfx}_TALK_FRAMES, ${_pfx}_TALK_FPS, ${_pfx}_TALK_FW);`)
          if (_chDef.animRoles?.talk_left)
            e(`${p}engine_set_char_talk_anim_left("${cStr(instr.charId)}", ${_pfx}_TALK_LEFT_PCX, ${_pfx}_TALK_LEFT_FRAMES, ${_pfx}_TALK_LEFT_FPS, ${_pfx}_TALK_LEFT_FW);`)
          if (_chDef.animRoles?.talk_up)
            e(`${p}engine_set_char_talk_anim_up("${cStr(instr.charId)}", ${_pfx}_TALK_UP_PCX, ${_pfx}_TALK_UP_FRAMES, ${_pfx}_TALK_UP_FPS, ${_pfx}_TALK_UP_FW);`)
          if (_chDef.animRoles?.talk_down)
            e(`${p}engine_set_char_talk_anim_down("${cStr(instr.charId)}", ${_pfx}_TALK_DOWN_PCX, ${_pfx}_TALK_DOWN_FRAMES, ${_pfx}_TALK_DOWN_FPS, ${_pfx}_TALK_DOWN_FW);`)
          if (_chDef.animRoles?.give)
            e(`${p}engine_set_char_give_anim("${cStr(instr.charId)}", ${_pfx}_GIVE_PCX, ${_pfx}_GIVE_FRAMES, ${_pfx}_GIVE_FPS, ${_pfx}_GIVE_FW);`)
        } else {
          // Personaje no definido en el proyecto — fallback a teleport simple
          e(`${p}if (!engine_char_in_room("${cStr(instr.charId)}")) {`)
          e(`${p}    engine_move_char("${cStr(instr.charId)}", ${instr.x|0}, ${instr.y|0});`)
          e(`${p}    engine_face_dir("${cStr(instr.charId)}", "${cStr(_dir)}");`)
          e(`${p}}`)
        }
        break
      }
      case 'MOVE_CHAR':
        e(`${p}engine_move_char("${cStr(instr.charId)}", ${instr.x|0}, ${instr.y|0});`)
        break
      case 'WALK_CHAR':
        e(`${p}engine_walk_char("${cStr(instr.charId)}", ${instr.x|0}, ${instr.y|0}, ${instr.speed|0});`)
        e(`${p}engine_wait_walk("${cStr(instr.charId)}");`)
        break
      case 'WALK_CHAR_TO_OBJ':
        e(`${p}engine_walk_char_to_obj("${cStr(instr.charId)}", "${cStr(instr.objectId)}", ${instr.speed|0});`)
        e(`${p}engine_wait_walk("${cStr(instr.charId)}");`)
        break
      case 'WALK_CHAR_DIRECT':
        e(`${p}engine_walk_char_direct("${cStr(instr.charId)}", ${instr.x|0}, ${instr.y|0}, ${instr.speed|0});`)
        e(`${p}engine_wait_walk("${cStr(instr.charId)}");`)
        break
      case 'SET_ANIM':
      case 'PLAY_ANIM': {
        /* Resolver animacion: rol del motor o PCX personalizado */
        const _emitSetAnim = (charId, animId) => {
          const _role = resolveAnimRole(charId, animId)
          if (_role !== animId) {
            e(`${p}engine_set_anim("${cStr(charId)}", "${cStr(_role)}");`)
          } else {
            const _chDef = chars[charId]
            const _ad = (_chDef?.animations || []).find(a => a.id === animId)
            if (_ad?.spriteFile) {
              const _pcxId = resolveAssetId(assetsMap, _ad.spriteFile) ||
                             ('spr_' + _ad.spriteFile.replace(/\.PCX$/i, '').slice(0, 24))
              e(`${p}engine_set_anim_pcx("${cStr(charId)}", "${_pcxId}", ${_ad.frameCount||1}, ${_ad.fps||8}, ${_ad.frameWidth||0});`)
            } else {
              e(`${p}engine_set_anim("${cStr(charId)}", "${cStr(_role)}");`)
            }
          }
        }
        _emitSetAnim(instr.charId, instr.animName)
        /* loop=false o duration>0: espera y vuelve a idle */
        const _loop = instr.loop !== false  /* default true */
        const _dur  = Math.round((instr.duration || 0) * 1000)
        if (_dur > 0) {
          e(`${p}engine_wait_ms(${_dur});`)
          e(`${p}engine_set_anim("${cStr(instr.charId)}", "idle");`)
        } else if (!_loop) {
          /* un ciclo completo: esperar ms_per_frame * frames */
          const _chDef = chars[instr.charId]
          const _ad = (_chDef?.animations || []).find(a => a.id === instr.animName)
          const _frames = _ad?.frameCount || 1
          const _fps    = _ad?.fps || 8
          const _cycleMs = Math.round((_frames / _fps) * 1000) || 125
          e(`${p}engine_wait_ms(${_cycleMs});`)
          e(`${p}engine_set_anim("${cStr(instr.charId)}", "idle");`)
        }
        break
      }
      case 'FACE_DIR':
        e(`${p}engine_face_dir("${cStr(instr.charId)}", "${cStr(instr.direction)}");`)
        break
      case 'SET_CHAR_VISIBLE':
        e(`${p}engine_set_char_visible("${cStr(instr.charId)}", ${instr.visible ? 1 : 0});`)
        break
      case 'CHANGE_PROTAGONIST':
        e(`${p}engine_change_protagonist("${cStr(instr.charId)}");`)
        break
      case 'PICKUP_OBJECT':
        e(`${p}engine_pickup_object("${cStr(instr.objectId)}", "${cStr(instr.verbId||'coger')}");`)
        break
      case 'MOVE_OBJECT':
        e(`${p}engine_move_object("${cStr(instr.objectId)}", ${instr.x|0}, ${instr.y|0});`)
        break
      case 'SET_OBJECT_STATE':
        if (instr.stateId) e(`${p}engine_set_object_state("${cStr(instr.objectId)}", "${cStr(instr.stateId)}");`)
        if (instr.animLoop === true)  e(`${p}engine_set_object_anim_loop("${cStr(instr.objectId)}", 1);`)
        if (instr.animLoop === false) e(`${p}engine_set_object_anim_loop("${cStr(instr.objectId)}", 0);`)
        if (instr.waitAnim) e(`${p}engine_seq_wait_object_anim("${cStr(instr.objectId)}");`)
        break
      case 'SET_OBJECT_VISIBLE':
        e(`${p}engine_set_object_visible("${cStr(instr.objectId)}", ${instr.visible ? 1 : 0});`)
        break
      case 'GIVE_OBJECT':
        e(`${p}engine_give_object("${cStr(instr.objectId)}", "${cStr(instr.charId)}");`)
        break
      case 'REMOVE_OBJECT':
        e(`${p}engine_remove_object("${cStr(instr.objectId)}", "${cStr(instr.charId)}");`)
        break
      case 'DROP_OBJECT':
        e(`${p}engine_drop_object("${cStr(instr.objectId)}", "${cStr(instr.roomId)}", ${instr.x|0}, ${instr.y|0});`)
        break
      case 'SET_WALKMAP':
        e(`${p}engine_set_walkmap("${cStr(instr.walkmapId)}");`)
        break
      case 'SET_EXIT_STATE':
        e(`${p}engine_set_exit_enabled("${cStr(instr.exitId)}", ${instr.enabled ? 1 : 0});`)
        break
      case 'SET_VERBSET': {
        e(`${p}engine_set_verbset("${cStr(instr.verbsetId)}");`)
        const _svVs = verbsetsMap[instr.verbsetId]
        for (const _svV of (_svVs?.verbs || []))
          if (_svV.isGive) e(`${p}engine_set_give_verb("${cStr(_svV.id)}");`)
        break
      }
      case 'START_DIALOGUE':
        e(`${p}dlg_${cId(instr.dialogueId)}();`)
        break
      case 'SHOW_TEXT': {
        const stColor = typeof instr.color === 'number' ? instr.color : 15
        const stDur   = instr.duration > 0 ? Math.round(instr.duration * 1000) : 0
        e(`${p}engine_show_text_ex("${cStr(instr.localeKey)}", ${stColor}, ${stDur}u);`)
        break
      }
      case 'CLEAR_TEXT':
        e(`${p}engine_clear_text();`)
        break
      case 'PLAY_MIDI': {
        const _mraw = (instr.midiId || '').replace(/^mid_/i,'').replace(/[^a-zA-Z0-9_]/g,'_').slice(0,27)
        e(`${p}engine_play_midi("mid_${_mraw}");`)
        break
      }
      case 'STOP_MIDI':
        e(`${p}engine_stop_midi();`)
        break
      case 'PAUSE_MIDI':
        e(`${p}engine_pause_midi();`)
        break
      case 'RESUME_MIDI':
        e(`${p}engine_resume_midi();`)
        break
      case 'SET_MUSIC_VOLUME':
        e(`${p}engine_set_music_volume(${(instr.volume||100)|0}, ${(instr.fade_ms||0)|0});`)
        break
      case 'SET_MUSIC_TEMPO':
        e(`${p}engine_set_music_tempo(${(instr.percent||100)|0}, ${(instr.fade_ms||0)|0});`)
        break
      case 'FADE_MUSIC_OUT':
        e(`${p}engine_set_music_volume(0, ${(instr.fade_ms||2000)|0});`)
        break
      case 'PLAY_SFX':
        e(`${p}engine_play_sfx("${cStr(sfxIdToEngineId(instr.sfxId))}");`)
        break
      case 'STOP_SFX':
        e(`${p}engine_stop_sfx();`)
        break
      case 'SET_SFX_VOLUME':
        e(`${p}engine_set_sfx_volume(${(instr.volume||100)|0});`)
        break
      case 'PLAY_SEQUENCE':
        e(`${p}seq_${cId(instr.sequenceId)}();`)
        break
      case 'WAIT':
        e(`${p}engine_wait_ms(${Math.round((instr.seconds||0)*1000)});`)
        break
      case 'BLOCK_EXIT':
        e(`${p}engine_block_exit();`)
        break
      case 'SET_ATTR':
        e(`${p}engine_set_attr("${cStr(instr.target)}", "${cStr(instr.attr)}", "${instr.value||0}");`)
        break
      case 'ADD_ATTR':
        e(`${p}engine_add_attr("${cStr(instr.target)}", "${cStr(instr.attr)}", "${instr.amount||0}");`)
        break
      default:
        e(`${p}/* TODO: instrucción no soportada: ${t} */`)
    }
  }

  // ── Scripts ─────────────────────────────────────────────────────────────────
  e('/* ── Scripts ──────────────────────────────────────────────────── */')
  for (const id of scriptIds) {
    const scr = scripts[id]
    e(`static void scr_${cId(id)}(void) {`)
    e(`    /* trigger: ${scr.trigger?.type || 'manual'} */`)
    for (const instr of (scr.instructions || [])) {
      emitInstruction(instr, 4)
    }
    e('}')
    e('')
  }

  // ── Say handlers (text responses) ──────────────────────────────────────────
  e('/* ── Say handlers (respuestas de texto con animacion hablar) ──── */')
  for (const objId of Object.keys(objects || {})) {
    const objDef = objects[objId]
    if (!objDef) continue
    for (const vr of (objDef.verbResponses || [])) {
      if (!vr.verbId) continue
      // Char-specific text say functions
      for (const cr of (vr.charResponses || [])) {
        if (!cr.charId || cr.mode !== 'text') continue
        const crKey = `obj.${objId}.verb.${vr.verbId}.${cr.charId}`
        e(`static void say_${cId(objId)}_verb_${cId(vr.verbId)}_${cId(cr.charId)}(void) {`)
        e(`    engine_say(NULL, "${crKey}");`)
        e(`}`)
        e(``)
      }
      // Generic text say function
      if (vr.mode !== 'text') continue
      e(`static void say_${cId(objId)}_verb_${cId(vr.verbId)}(void) {`)
      if (vr.sayAnim)
        e(`    engine_say_anim(NULL, "obj.${objId}.verb.${vr.verbId}", "${cStr(vr.sayAnim)}");`)
      else
        e(`    engine_say(NULL, "obj.${objId}.verb.${vr.verbId}");`)
      for (let ei = 0; ei < (vr.extraLines || []).length; ei++) {
        const el = vr.extraLines[ei]
        if (el.sayAnim)
          e(`    engine_say_anim(NULL, "obj.${objId}.verb.${vr.verbId}.e${ei}", "${cStr(el.sayAnim)}");`)
        else
          e(`    engine_say(NULL, "obj.${objId}.verb.${vr.verbId}.e${ei}");`)
      }
      e(`}`)
      e(``)
    }
    for (const vr of (objDef.invVerbResponses || [])) {
      if (!vr.verbId) continue
      for (const cr of (vr.charResponses || [])) {
        if (!cr.charId || cr.mode !== 'text') continue
        const crKey = `obj.${objId}.inv_verb.${vr.verbId}.${cr.charId}`
        e(`static void say_${cId(objId)}_invverb_${cId(vr.verbId)}_${cId(cr.charId)}(void) {`)
        e(`    engine_say(NULL, "${crKey}");`)
        e(`}`)
        e(``)
      }
      if (vr.mode !== 'text') continue
      e(`static void say_${cId(objId)}_invverb_${cId(vr.verbId)}(void) {`)
      if (vr.sayAnim)
        e(`    engine_say_anim(NULL, "obj.${objId}.inv_verb.${vr.verbId}", "${cStr(vr.sayAnim)}");`)
      else
        e(`    engine_say(NULL, "obj.${objId}.inv_verb.${vr.verbId}");`)
      for (let ei = 0; ei < (vr.extraLines || []).length; ei++) {
        const el = vr.extraLines[ei]
        if (el.sayAnim)
          e(`    engine_say_anim(NULL, "obj.${objId}.inv_verb.${vr.verbId}.e${ei}", "${cStr(el.sayAnim)}");`)
        else
          e(`    engine_say(NULL, "obj.${objId}.inv_verb.${vr.verbId}.e${ei}");`)
      }
      e(`}`)
      e(``)
    }
  }
  e('')

  // ── Diálogos ────────────────────────────────────────────────────────────────
  e('/* ── Diálogos ─────────────────────────────────────────────────── */')
  for (const id of dialogueIds) {
    const dlg = dialogues[id]
    e(`static void dlg_${cId(id)}(void) {`)
    const nodes = dlg.nodes || []
    const conns = dlg.connections || []
    const connMap = {}
    for (const c of conns) {
      if (!connMap[c.from]) connMap[c.from] = []
      connMap[c.from].push(c)
    }
    e(`    static const DialogueNode nodes_${cId(id)}[] = {`)
    for (const node of nodes) {
      const nodeConns = (connMap[node.id] || []).sort((a,b) => (a.choiceIndex??0) - (b.choiceIndex??0))
      /* Construir lines[] */
      const lines = []
      /* Resuelve animId de dialogo → rol del motor, o "pcxid|frames|fps|fw" para custom */
      const resolveDialogAnim = (charId, animId) => {
        if (!animId) return ''
        const role = resolveAnimRole(charId, animId)
        if (role !== animId) return role  // es un rol conocido
        // Animacion personalizada: buscar en char.animations y construir pcxid|frames|fps|fw
        const chDef = chars[charId]
        const ad = (chDef?.animations || []).find(a => a.id === animId)
        if (ad?.spriteFile) {
          const base = 'spr_' + ad.spriteFile.replace(/\.PCX$/i, '').slice(0, 24)
          const suffix = (ad.flipH ? '_FH' : '') + (ad.flipV ? '_FV' : '')
          const pcxId = resolveAssetId(assetsMap, ad.flipH || ad.flipV ? base + suffix : ad.spriteFile)
                        || (base + suffix)
          return `${pcxId}|${ad.frameCount||1}|${ad.fps||8}|${ad.frameWidth||0}`
        }
        return animId  // fallback
      }
      if (node.type === 'line' || !node.type || node.type === 'npc_line') {
        const speaker = node.actorId || node.speakerId || node.speaker_id || ''
        const textKey = node.textKey || node.text_key || ''
        const anim = resolveDialogAnim(speaker, node.animation || '')
        const dir  = resolveDialogAnim(speaker, node.direction || '')
        const cf   = node.charFilter || ''
        if (textKey) lines.push({ speaker, textKey, anim, dir, charFilter: cf })
        for (const extra of (node.extraLines || [])) {
          const exSpeaker = extra.actorId || extra.speakerId || ''
          lines.push({
            speaker: exSpeaker,
            textKey: extra.textKey || '',
            anim: resolveDialogAnim(exSpeaker, extra.animation || ''),
            dir: resolveDialogAnim(exSpeaker, extra.direction || ''),
            charFilter: extra.charFilter || ''
          })
        }
      }
      const linesStr = lines.map(l =>
        `{ "${cStr(l.speaker)}", "${cStr(l.textKey)}", "${cStr(l.anim)}", "${cStr(l.dir)}", "${cStr(l.charFilter||'')}" }`
      ).join(', ')
      const linesInit = linesStr || '{ "", "", "", "", "" }'
      const numLines = lines.length
      /* Construir options */
      let opts, numOpts
      if (node.type === 'choice' && node.choices?.length) {
        const choiceOpts = node.choices.map((ch, ci) => {
          const conn = nodeConns.find(c => c.choiceIndex === ci)
          const nextId = conn ? conn.to : ''
          const condStr = ch.condition && typeof ch.condition === 'object'
            ? JSON.stringify(ch.condition)
            : (ch.condition || '')
          return `{ "${cStr(ch.textKey||ch.text||'')}", "${cStr(condStr)}", "${cStr(nextId)}", "${cStr(ch.charFilter||'')}" }`
        })
        opts = choiceOpts.join(', ')
        numOpts = node.choices.length
      } else if (nodeConns.length > 0) {
        const nextId = nodeConns[0].to
        opts = `{ "", "", "${cStr(nextId)}", "" }`
        numOpts = 1
      } else {
        opts = '{0}'
        numOpts = 0
      }
      e(`        { "${cStr(node.id)}", { ${linesInit} }, ${numLines}, { ${opts} }, ${numOpts} },`)
    }
    e(`    };`)
    const _startNode = nodes.find(n => n.type === 'start') || nodes[0]
    if (dlg.colors) {
      const dc = dlg.colors
      e(`    engine_set_dialogue_colors(${dc.bg|0}, ${dc.brd|0}, ${dc.txt|0}, ${dc.sel|0});`)
    }
    e(`    engine_run_dialogue(nodes_${cId(id)}, ${nodes.length}, "${cStr(_startNode?.id || '')}");`)
    e('}')
    e('')
  }

  // ── Secuencias ──────────────────────────────────────────────────────────────
  e('/* ── Secuencias ───────────────────────────────────────────────── */')
  for (const id of seqIds) {
    const seq = sequences[id]
    e(`static void seq_${cId(id)}(void) {`)
    e(`    engine_hide_ui();`)
    for (const step of (seq.steps || [])) {
      const t = step.type || ''
      switch (t) {
        case 'show_text': {
          /* Compatibilidad formato antiguo: texts:{en,es} → escribir en locales */
          let textKey = step.localeKey || `seq_${cId(id)}_${cId(step.id)}`
          if (!step.localeKey && step.texts && typeof step.texts === 'object') {
            // Migrar texts al locale directamente en el DAT
            // (los textos ya estarán en el locale si el usuario los editó en el editor antiguo)
            textKey = `seq_${cId(id)}_${cId(step.id)}`
          }
          const colorIdx   = typeof step.color === 'number' ? step.color : 15
          const bgColorIdx = typeof step.bgColor === 'number' ? step.bgColor : 0
          const hasBg      = (step.bgColor !== undefined && step.bgColor !== '') ? 1 : 0
          const bgPcxId    = cStr(step.bgPcx || '')
          const align      = cStr(step.align || 'center')
          const pos        = cStr(step.position || 'bottom')
          const effect     = cStr(step.effect || 'none')
          const twSpeed    = step.typewriterSpeed || 20
          const dur        = Math.round((step.duration || 3) * 1000)
          const fontName   = step.font || 'medium'
          e(`    engine_seq_show_text("${cStr(textKey)}", "${cStr(fontName)}", ${colorIdx}, ${bgColorIdx}, ${hasBg}, "${bgPcxId}", "${pos}", "${align}", "${effect}", ${twSpeed}, ${dur});`)
          break
        }
        case 'scroll_text': {
          const textKey = step.localeKey || `seq_${cId(id)}_${cId(step.id)}`
          const colorIdx = typeof step.color === 'number' ? step.color : 14
          const align   = cStr(step.align || 'center')
          e(`    engine_seq_scroll_text_ex("${cStr(textKey)}", ${colorIdx}, "${align}", ${step.speed||40});`)
          break
        }
        case 'move_text': {
          const textKey  = step.localeKey || `seq_${cId(id)}_${cId(step.id)}`
          const fontIdx  = step.font === 'large' ? 2 : step.font === 'medium' ? 1 : 0
          const colorIdx = typeof step.color === 'number' ? step.color : 15
          const bgType   = (step.bgType === undefined || step.bgType === null) ? 0 : (step.bgType|0)
          const bgColor  = typeof step.bgColor === 'number' ? step.bgColor : 0
          const bgPcx    = (bgType === 1 && step.bgPcx)
            ? (resolveAssetId(assetsMap, step.bgPcx) || cStr(step.bgPcx))
            : ''
          e(`    engine_seq_move_text("${cStr(textKey)}", ${fontIdx}, ${colorIdx}, ${step.x0|0}, ${step.y0|0}, ${step.x1|0}, ${step.y1|0}, ${step.speed||60}, ${bgType}, ${bgColor}, "${bgPcx}", 1);`)
          break
        }
        case 'call_sequence': {
          if (step.sequenceId) {
            e(`    engine_seq_call(seq_${cId(step.sequenceId)});`)
          }
          break
        }
        case 'load_room':
          e(`    engine_change_room("${cStr(step.roomId||'')}", "${cStr(step.entryId||'entry_default')}");`)
          break
        case 'enter_closeup':
          e(`    engine_enter_closeup("${cStr(step.roomId||'')}", ${step.showUi ? 1 : 0});`)
          break
        case 'exit_closeup':
          e(`    engine_exit_closeup();`)
          break
        case 'play_midi': {
          const _mf = (step.midiId||'').replace(/^midi:/i,'')
          const _mb = _mf.replace(/\.[^.]+$/, '').slice(0, 27)
          const mid = _mb.startsWith('mid_') ? _mb : 'mid_' + _mb
          e(`    engine_play_midi("${mid}");`)
          break
        }
        case 'stop_midi':
          e(`    engine_stop_midi();`)
          break
        case 'pause_midi':
          e(`    engine_pause_midi();`)
          break
        case 'resume_midi':
          e(`    engine_resume_midi();`)
          break
        case 'set_music_volume':
          e(`    engine_set_music_volume(${(step.volume||100)|0}, ${(step.fade_ms||0)|0});`)
          break
        case 'set_music_tempo':
          e(`    engine_set_music_tempo(${(step.percent||100)|0}, ${(step.fade_ms||0)|0});`)
          break
        case 'fade_music_out':
          e(`    engine_set_music_volume(0, ${(step.fade_ms||2000)|0});`)
          break
        case 'play_sfx':
          e(`    engine_play_sfx("${cStr(sfxIdToEngineId(step.sfxId||''))}");`)
          break
        case 'stop_sfx':
          e(`    engine_stop_sfx();`)
          break
        case 'set_sfx_volume':
          e(`    engine_set_sfx_volume(${(step.volume||100)|0});`)
          break
        case 'wait':
          e(`    engine_wait_ms(${Math.round((step.seconds||0)*1000)});`)
          break
        case 'walk_char':
          e(`    engine_walk_char("${cStr(step.charId)}", ${step.x|0}, ${step.y|0}, ${step.speed|0});`)
          e(`    engine_wait_walk("${cStr(step.charId)}");`)
          break
        case 'move_char':
          e(`    engine_move_char("${cStr(step.charId)}", ${step.x|0}, ${step.y|0});`)
          break
        case 'set_flag':
          e(`    engine_set_flag("${cStr(step.flag)}", ${JSON.stringify(step.value||'true')});`)
          break
        case 'set_attr': {
          const attrTarget = cStr(step.target || '')
          const attrId     = cStr(step.attr || '')
          const attrVal    = String(step.value ?? 0)
          if (step.mode === 'add') {
            e(`    engine_add_attr("${attrTarget}", "${attrId}", "${attrVal}");`)
          } else if (step.mode === 'sub') {
            e(`    engine_add_attr("${attrTarget}", "${attrId}", "-${attrVal.replace(/^-/,'')}");`)
          } else {
            e(`    engine_set_attr("${attrTarget}", "${attrId}", "${attrVal}");`)
          }
          break
        }
        case 'call_script':
          e(`    scr_${cId(step.scriptId)}();`)
          break
        case 'end_sequence':
          e(`    engine_show_ui();`)
          e(`    return;`)
          break
        case 'play_rooms': {
          const flag = cStr(step.flag || '')
          const val  = cStr(step.value || 'true')
          // Controlar UI antes de entrar en modo interactivo
          e(step.showUi === false ? `    engine_hide_ui();` : `    engine_show_ui();`)
          if (step.roomId) {
            e(`    engine_change_room("${cStr(step.roomId)}", "${cStr(step.entryId||'entry_default')}");`)
          }
          e(`    engine_play_rooms("${flag}", "${val}");`)
          break
        }
        case 'set_ui':
          e(step.visible === false ? `    engine_hide_ui();` : `    engine_show_ui();`)
          break
        case 'solid_color':
          e(`    engine_seq_solid_color(${step.colorIdx|0}, ${Math.round((step.duration||2)*1000)});`)
          break
        case 'fade_to_color':
          e(`    engine_seq_fade_to_color(${step.colorIdx|0}, ${Math.round((step.duration||1)*1000)});`)
          break
        case 'fade_from_color':
          e(`    engine_seq_fade_from_color(${step.colorIdx|0}, ${Math.round((step.duration||1)*1000)});`)
          break
        case 'color_fade': {
          /* fromColor: -1 = pantalla actual (255 en C); toColor: siempre índice de paleta */
          const fc = (step.fromColor === -1 || step.fromColor === undefined || step.fromColor === null) ? 255 : (step.fromColor|0)
          const tc = Math.min(254, Math.max(0, step.toColor|0))
          e(`    engine_seq_color_fade(${fc}, ${tc}, ${Math.round((step.duration||1)*1000)});`)
          break
        }
        case 'show_pcx': {
          const pcxId = resolveAssetId(assetsMap, step.pcxFile||'') || cStr(step.pcxFile||'')
          e(`    engine_seq_show_pcx("${pcxId}", ${Math.round((step.duration||3)*1000)});`)
          break
        }
        case 'load_bg': {
          const bgId = resolveAssetId(assetsMap, step.bgFile||'') || cStr(step.bgFile||'')
          e(`    engine_load_bg("${bgId}");`)
          break
        }
        case 'show_bg': {
          const bgId = resolveAssetId(assetsMap, step.bgFile||'') || cStr(step.bgFile||'')
          const dur  = Math.round((step.duration||0)*1000)
          const ui   = step.showUi ? 1 : 0
          e(`    engine_seq_show_bg("${bgId}", ${dur}, ${ui});`)
          break
        }
        case 'set_anim':
          e(`    engine_seq_set_anim("${cStr(step.charId)}", "${cStr(step.animName||'idle')}", ${step.fps|0}, ${step.loop?1:0}, ${Math.round((step.duration||0)*1000)});`)
          break
        case 'face_dir':
          e(`    engine_seq_face_dir("${cStr(step.charId)}", "${cStr(step.dir||'front')}");`)
          break
        case 'set_char_visible':
          e(`    engine_seq_set_char_visible("${cStr(step.charId)}", ${step.visible?1:0});`)
          break
        case 'teleport_char':
          e(`    engine_move_char("${cStr(step.charId)}", ${step.x|0}, ${step.y|0});`)
          break
        case 'start_dialogue':
          e(`    dlg_${cId(step.dialogueId)}();`)
          break
        case 'pickup_object':
          e(`    engine_give_object("${cStr(step.objectId)}", "${cStr(step.charId||'')}");`)
          break
        case 'give_object':
          e(`    engine_remove_object("${cStr(step.objectId)}", "${cStr(step.fromCharId||'')}");`)
          e(`    engine_give_object("${cStr(step.objectId)}", "${cStr(step.toCharId||'')}");`)
          break
        case 'remove_from_inventory':
          e(`    engine_remove_object("${cStr(step.objectId)}", "${cStr(step.charId||'')}");`)
          break
        case 'drop_object':
          e(`    engine_drop_object("${cStr(step.objectId)}", "${cStr(step.roomId||g_cur_room||'')}", ${step.x|0}, ${step.y|0});`)
          break
        case 'move_object':
          e(`    engine_move_object("${cStr(step.objectId)}", ${step.x|0}, ${step.y|0});`)
          break
        case 'set_object_visible':
          e(`    engine_set_object_visible("${cStr(step.objectId)}", ${step.visible?1:0});`)
          break
        case 'set_object_state':
          e(`    engine_set_object_state("${cStr(step.objectId)}", "${cStr(step.stateId||'')}");`)
          break
        case 'set_object_anim_loop':
          e(`    engine_set_object_anim_loop("${cStr(step.objectId)}", ${step.loop?1:0});`)
          break
        case 'wait_object_anim':
          e(`    engine_seq_wait_object_anim("${cStr(step.objectId)}");`)
          break
        case 'parallel_block': {
          /* Bloque paralelo: lanzar todos los pasos en modo no bloqueante */
          const psteps = step.steps || []
          for (const ps of psteps) {
            if (ps.type === 'walk_char') {
              e(`    engine_walk_char_nb("${cStr(ps.charId)}", ${ps.x|0}, ${ps.y|0}, ${ps.speed|0});`)
            } else if (ps.type === 'set_anim') {
              e(`    engine_seq_set_anim("${cStr(ps.charId)}", "${cStr(ps.animName||'idle')}", ${ps.fps|0}, 0, 0);`)
            } else if (ps.type === 'face_dir') {
              e(`    engine_seq_face_dir("${cStr(ps.charId)}", "${cStr(ps.dir||'front')}");`)
            } else if (ps.type === 'move_text') {
              const ptKey   = ps.localeKey || `seq_${cId(id)}_${cId(ps.id)}`
              const pFont   = ps.font === 'large' ? 2 : ps.font === 'medium' ? 1 : 0
              const pColor  = typeof ps.color === 'number' ? ps.color : 15
              const pBgType = (ps.bgType === undefined || ps.bgType === null) ? 0 : (ps.bgType|0)
              const pBgCol  = typeof ps.bgColor === 'number' ? ps.bgColor : 0
              const pBgPcx  = ps.bgType === 1
                ? (resolveAssetId(assetsMap, ps.bgPcx||'') || cStr(ps.bgPcx||''))
                : ''
              e(`    engine_seq_move_text_nb("${cStr(ptKey)}", ${pFont}, ${pColor}, ${ps.x0|0}, ${ps.y0|0}, ${ps.x1|0}, ${ps.y1|0}, ${ps.speed||60}, ${pBgType}, ${pBgCol}, "${pBgPcx}");`)
            }
          }
          e(`    engine_wait_all_chars();`)
          break
        }
        default:
          e(`    /* TODO: paso de secuencia no soportado: ${t} */`)
      }
    }
    e(`    engine_show_ui();`)
    e('}')
    e('')
  }

  // ── Rooms ───────────────────────────────────────────────────────────────────
  e('/* ── Rooms ────────────────────────────────────────────────────── */')
  for (const id of roomIds) {
    const room = rooms[id]
    // El ID del background en el DAT es bg_ + nombre del fichero PCX sin extensión
    // room.backgroundFilePath = "SALA1.PCX" → id en DAT = "bg_SALA1"
    const bgFile = room.backgroundFilePath || ''
    const bgName = bgFile
      ? (resolveAssetId(assetsMap, bgFile) || ('bg_' + bgFile.replace(/\.PCX$/i, '').replace(/\.pcx$/i, '')).slice(0, 31))
      : ''
    // Rasterizar walkmap a bitmap 40x25 ANTES de abrir la funcion (scope global)
    // Ancho real de la room: si hay scroll usa el mayor entre totalW y backgroundSize.w
    const bgActualW = (room.backgroundSize?.w || 320)
    const scrollActualW = room.scroll?.halves
      ? (bgActualW > 320 ? bgActualW : 640)  // modo halves: ancho completo del PCX
      : (room.scroll?.enabled && room.scroll?.directionH)
        ? Math.max(room.scroll?.totalW || 320, bgActualW)
        : 320
    const wmRoomW = scrollActualW > 320 ? scrollActualW : 320
    const WM_CELL  = game.walkmapCellSize === 4 ? 4 : 8   // tamaño de celda del motor
    const WM_GRID_W = Math.ceil(wmRoomW / WM_CELL)
    const WM_GRID_H = Math.ceil(144     / WM_CELL)
    if (room.activeWalkmapId) {
      const wm = (room.walkmaps || []).find(w => w.id === room.activeWalkmapId)
      const CELL_W = WM_CELL, CELL_H = WM_CELL
      const GRID_W = WM_GRID_W, GRID_H = WM_GRID_H
      const bitmap = new Uint8Array(GRID_W * GRID_H)
      if (wm?.shapes?.length) {
        // Rayo de punto dentro de polígono (ray casting)
        function ptInPoly(px, py, pts) {
          let inside = false
          for (let i = 0, j = pts.length-1; i < pts.length; j = i++) {
            const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y
            if (((yi > py) !== (yj > py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside = !inside
          }
          return inside
        }
        for (const shape of wm.shapes) {
          const add = shape.mode !== 'sub'
          for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
              const cellX = gx * CELL_W, cellY = gy * CELL_H
              const cellX2 = cellX + CELL_W, cellY2 = cellY + CELL_H
              const cx = cellX + CELL_W / 2, cy = cellY + CELL_H / 2
              let hit = false
              if (shape.type === 'rect') {
                if (add) {
                  // ADD: AABB — captura rects más pequeños que una celda
                  hit = cellX < shape.x + shape.w && cellX2 > shape.x &&
                        cellY < shape.y + shape.h && cellY2 > shape.y
                } else {
                  // SUB: centro-punto — conservador, no come celdas de borde
                  hit = cx >= shape.x && cx < shape.x + shape.w &&
                        cy >= shape.y && cy < shape.y + shape.h
                }
              } else if (shape.type === 'circle') {
                if (add) {
                  // ADD: distancia mínima círculo-AABB
                  const nearX = Math.max(cellX, Math.min(shape.cx, cellX2))
                  const nearY = Math.max(cellY, Math.min(shape.cy, cellY2))
                  const dx = shape.cx - nearX, dy = shape.cy - nearY
                  hit = dx*dx + dy*dy <= shape.r * shape.r
                } else {
                  // SUB: solo si el centro cae dentro del círculo
                  const dx = cx - shape.cx, dy = cy - shape.cy
                  hit = dx*dx + dy*dy <= shape.r * shape.r
                }
              } else if (shape.type === 'polygon' && shape.points?.length >= 3) {
                // Siempre centro-punto (conservador para add y sub)
                hit = ptInPoly(cx, cy, shape.points)
              }
              if (hit) bitmap[gy*GRID_W+gx] = add ? 1 : 0
            }
          }
        }
      }
      const wmVar = 'g_wm_' + cId(id)
      const bytes = Array.from(bitmap).join(',')
      e('static const unsigned char ' + wmVar + '[' + (GRID_W*GRID_H) + '] = {' + bytes + '};')
    }

    // Dispatcher room_enter_via: función estática antes de la room para combinar
    // room_enter y room_enter_via (filtrada por engine_get_cur_entry).
    {
      const _rscripts = scriptIds.map(sid => scripts[sid]).filter(s => s?.trigger?.roomId === id)
      const _enter    = _rscripts.filter(s => s.trigger?.type === 'room_enter')
      const _via      = _rscripts.filter(s => s.trigger?.type === 'room_enter_via')
      if (_enter.length > 1 || _via.length > 0) {
        e(`static void _rent_${cId(id)}(void) {`)
        for (const s of _enter) e(`    scr_${cId(s.id)}();`)
        for (const s of _via) {
          const eid = cStr(s.trigger?.entryId || '')
          e(`    if (engine_cur_entry_is("${eid}")) scr_${cId(s.id)}();`)
        }
        e(`}`)
      }
    }
    e(`static void room_${cId(id)}(void) {`)
    e(`    /* "${cStr(room.name || id)}" */`)
    if (room.fullscreen) {
      e(`    engine_load_bg_fullscreen("${bgName}");`)
    } else {
      e(`    engine_load_bg("${bgName}");`)
    }
    if (room.noSave) e(`    engine_set_room_no_save(1);`)

    // Scroll por mitades (tipo Scumm Bar): PCX de 2×320px, pan manual sin camera-follow
    if (room.scroll?.halves) {
      const halfW = Math.round((room.backgroundSize?.w || 640) / 2)
      e(`    engine_set_scroll_halves(${halfW});`)
    } else if (room.scroll?.enabled && room.scroll?.directionH && scrollActualW > 320) {
      // Scroll horizontal continuo — usa scrollActualW (max de totalW y backgroundSize.w)
      e(`    engine_set_room_scroll(${scrollActualW | 0});`)
    }

    // Cargar walkmap si existe
    if (room.activeWalkmapId) {
      const wmVar = 'g_wm_' + cId(id)
      e('    engine_walkmap_clear();')
      e('    engine_walkmap_load_bitmap(' + wmVar + ', ' + WM_GRID_W + ', ' + WM_GRID_H + ');')
    }

    // Zonas de escalado de personajes
    e('    engine_clear_scale_zones();')
    if (room.scaling?.enabled && room.scaling?.zones?.length) {
      for (const z of room.scaling.zones) {
        const type = z.type === 'linear' ? 1 : 0
        const pct0 = Math.max(1, Math.min(200, z.pct0 || 100))
        const pct1 = Math.max(1, Math.min(200, z.pct1 || pct0))
        e(`    engine_add_scale_zone(${z.y0|0}, ${z.y1|0}, ${type}, ${pct0}, ${pct1});`)
      }
    }

    // Entries
    if (room.entries?.length) {
      e(`    /* entry points */`)
      for (const en of room.entries) {
        e(`    engine_register_entry("${cStr(en.id)}", ${en.x|0}, ${en.y|0});`)
      }
    }

    // Exits
    if (room.exits?.length) {
      e(`    /* exits */`)
      for (const ex of room.exits) {
        const tz = ex.triggerZone || {}
        const exitNameKey = `exit.${cId(ex.id)}.name`
        e(`    engine_register_exit("${cStr(ex.id)}", ${tz.x|0}, ${tz.y|0}, ${tz.w|0}, ${tz.h|0}, "${cStr(ex.targetRoom)}", "${cStr(ex.targetEntry||'entry_default')}", "${exitNameKey}", ${ex.blocked ? 0 : 1});`)
      }
    }

    // Objetos en room
    if (room.objects?.length) {
      e(`    /* objetos */`)
      for (const obj of room.objects) {
        // Resolver gfx_id desde el spriteFile del estado activo del objeto
        const objDef = objects[obj.objectId]
        let gfxId = ''
        if (objDef?.states?.length) {
          const activeSt = objDef.states.find(s => s.id === objDef.activeStateId) || objDef.states[0]
          if (activeSt?.spriteFile) {
            gfxId = resolveAssetId(assetsMap, activeSt.spriteFile) || ('obj_' + activeSt.spriteFile.replace(/\.pcx$/i, '').slice(0, 27).toUpperCase())
          }
        }
        const isPickable = obj.pickable || objDef?.type === 'pickable' || objDef?.pickable || false
        const isDetectable = objDef?.detectable !== false
        const invGfxRaw = obj.invGfxId || objDef?.invGfxId || ''
        // Emite engine_add_object_state o engine_add_object_state_anim según el estado
        const emitStates = (instId, states) => {
          if (!states?.length) return
          for (const st of states) {
            const stGfx = st.spriteFile
              ? (resolveAssetId(assetsMap, st.spriteFile) || ('obj_' + st.spriteFile.replace(/\.pcx$/i,'').slice(0,27).toUpperCase()))
              : gfxId
            if (st.animated && (st.frameCount || 0) > 1) {
              const frames = Math.max(2, st.frameCount || 2)
              const fps    = Math.max(1, st.fps || 8)
              const fw     = Math.max(0, st.frameWidth || 0)
              e(`    engine_add_object_state_anim("${cStr(instId)}", "${cStr(st.id)}", "${cStr(stGfx)}", ${frames}, ${fps}, ${fw});`)
            } else {
              e(`    engine_add_object_state("${cStr(instId)}", "${cStr(st.id)}", "${cStr(stGfx)}");`)
            }
          }
        }
        if (isPickable) {
          const invGfx = invGfxRaw
            ? (resolveAssetId(assetsMap, invGfxRaw) || ('spr_' + invGfxRaw.replace(/\.pcx$/i,'').slice(0,27).toUpperCase()))
            : ''
          e(`    engine_place_object_ex("${cStr(obj.id)}", "${cStr(obj.objectId||obj.id)}", "${cStr(gfxId)}", ${obj.x|0}, ${obj.y|0}, 1, "${cStr(invGfx)}");`)
          emitStates(obj.id, objDef?.states)
        } else {
          e(`    engine_place_object("${cStr(obj.id)}", "${cStr(obj.objectId||obj.id)}", "${cStr(gfxId)}", ${obj.x|0}, ${obj.y|0});`)
          emitStates(obj.id, objDef?.states)
        }
        if (!isDetectable) {
          e(`    engine_set_object_detectable("${cStr(obj.id)}", 0);`)
        }
        if (obj.overLight) {
          e(`    engine_set_object_over_light("${cStr(obj.id)}", 1);`)
        }
        // Objetos de decorado: siempre detrás de personajes (bg_layer automático)
        if (objDef?.type === 'scenery') {
          e(`    engine_set_object_bg_layer("${cStr(obj.id)}", 1);`)
        }
        // Si el estado activo tiene animLoop=false o bgLayer, emitir las llamadas correspondientes
        { const activeSt = (objDef?.states || []).find(s => s.id === (objDef?.activeStateId || 'state_default'))
          if (activeSt?.animated && activeSt?.animLoop === false) {
            e(`    engine_set_object_anim_loop("${cStr(obj.id)}", 0);`)
          }
          if (activeSt?.bgLayer && objDef?.type !== 'scenery') {
            e(`    engine_set_object_bg_layer("${cStr(obj.id)}", 1);`)
          }
        }
        // Animacion ambiental periodica: buscar cualquier estado con ambientIntervalMin > 0
        { const ambSt = (objDef?.states || []).find(s => (s.ambientIntervalMin || 0) > 0)
          if (ambSt) {
            const minMs = Math.round(ambSt.ambientIntervalMin * 1000)
            const maxMs = Math.round((ambSt.ambientIntervalMax || ambSt.ambientIntervalMin * 2) * 1000)
            e(`    engine_set_object_ambient("${cStr(obj.id)}", "${cStr(ambSt.id)}", ${minMs}U, ${maxMs}U);`)
          }
        }
      }
    }

    // Personajes en room
    if (room.characters?.length) {
      e(`    /* personajes */`)
      for (const ch of room.characters) {
        const chDef = chars[ch.charId]
    if (chDef) {
      const pfx = `CHAR_${cId(ch.charId).toUpperCase()}`
      e(`    engine_place_char("${cStr(ch.charId)}", ${ch.x|0}, ${ch.y|0},`)
      e(`        ${pfx}_IDLE_PCX,       ${pfx}_IDLE_FRAMES,       ${pfx}_IDLE_FPS,       ${pfx}_IDLE_FW,`)
      e(`        ${pfx}_WALK_RIGHT_PCX, ${pfx}_WALK_RIGHT_FRAMES, ${pfx}_WALK_RIGHT_FPS, ${pfx}_WALK_RIGHT_FW,`)
      e(`        ${pfx}_WALK_LEFT_PCX,  ${pfx}_WALK_LEFT_FRAMES,  ${pfx}_WALK_LEFT_FPS,  ${pfx}_WALK_LEFT_FW,  ${pfx}_WALK_LEFT_FLIP,`)
      e(`        ${pfx}_WALK_UP_PCX,    ${pfx}_WALK_UP_FRAMES,    ${pfx}_WALK_UP_FPS,    ${pfx}_WALK_UP_FW,`)
      e(`        ${pfx}_WALK_DOWN_PCX,  ${pfx}_WALK_DOWN_FRAMES,  ${pfx}_WALK_DOWN_FPS,  ${pfx}_WALK_DOWN_FW,`)
      e(`        ${pfx}_IDLE_UP_PCX,    ${pfx}_IDLE_UP_FRAMES,    ${pfx}_IDLE_UP_FPS,    ${pfx}_IDLE_UP_FW,`)
      e(`        ${pfx}_IDLE_DOWN_PCX,  ${pfx}_IDLE_DOWN_FRAMES,  ${pfx}_IDLE_DOWN_FPS,  ${pfx}_IDLE_DOWN_FW,`)
      e(`        ${pfx}_SPEED, ${pfx}_PROTAGONIST);`)
      const stColor = typeof chDef.subtitleColor === 'number' ? chDef.subtitleColor : 15
      if (stColor !== 15) e(`    engine_set_char_subtitle_color("${cStr(ch.charId)}", ${stColor});`)
      // Direccion inicial del personaje en la room
      const facing = ch.facingDir || 'right'
      // "front"/"back" se mapean a idle_down/idle_up; "left"/"right" a face_dir
      if (facing === 'left')  e(`    engine_face_dir("${cStr(ch.charId)}", "left");`)
      else if (facing === 'right') { /* right es el defecto de engine_place_char */ }
      else if (facing === 'front') e(`    engine_face_dir("${cStr(ch.charId)}", "front");`)
      else if (facing === 'back')  e(`    engine_face_dir("${cStr(ch.charId)}", "back");`)
      // Animacion inicial si no es idle
      if (ch.currentAnimation && ch.currentAnimation !== 'idle') {
        e(`    engine_play_anim("${cStr(ch.charId)}", "${cStr(ch.currentAnimation)}");`)
      }
      if (chDef.light?.enabled) {
        const lt = chDef.light
        const ox  = Math.round(lt.offsetX || 0)
        const oy  = Math.round(lt.offsetY || 0)
        const r   = Math.max(1, Math.round(lt.radius || 60))
        const i   = Math.max(0, Math.min(100, Math.round(lt.intensity ?? 80)))
        const ca  = Math.max(1, Math.min(360, Math.round(lt.coneAngle ?? 360)))
        const fa  = Math.max(0, Math.min(100, Math.round(lt.flicker?.amplitude ?? 0)))
        const fh  = Math.max(0, Math.min(255, Math.round(lt.flicker?.speed ?? 0)))
        e(`    engine_char_set_light("${cStr(ch.charId)}", ${ox}, ${oy}, ${r}, ${i}, ${ca}, ${fa}, ${fh});`)
      }
      // Animaciones de hablar (por dirección)
      const pfxTalk = `CHAR_${cId(ch.charId).toUpperCase()}`
      if (chDef.animRoles?.talk) {
        e(`    engine_set_char_talk_anim("${cStr(ch.charId)}", ${pfxTalk}_TALK_PCX, ${pfxTalk}_TALK_FRAMES, ${pfxTalk}_TALK_FPS, ${pfxTalk}_TALK_FW);`)
      }
      if (chDef.animRoles?.talk_left) {
        e(`    engine_set_char_talk_anim_left("${cStr(ch.charId)}", ${pfxTalk}_TALK_LEFT_PCX, ${pfxTalk}_TALK_LEFT_FRAMES, ${pfxTalk}_TALK_LEFT_FPS, ${pfxTalk}_TALK_LEFT_FW);`)
      }
      if (chDef.animRoles?.talk_up) {
        e(`    engine_set_char_talk_anim_up("${cStr(ch.charId)}", ${pfxTalk}_TALK_UP_PCX, ${pfxTalk}_TALK_UP_FRAMES, ${pfxTalk}_TALK_UP_FPS, ${pfxTalk}_TALK_UP_FW);`)
      }
      if (chDef.animRoles?.talk_down) {
        e(`    engine_set_char_talk_anim_down("${cStr(ch.charId)}", ${pfxTalk}_TALK_DOWN_PCX, ${pfxTalk}_TALK_DOWN_FRAMES, ${pfxTalk}_TALK_DOWN_FPS, ${pfxTalk}_TALK_DOWN_FW);`)
      }
      if (chDef.animRoles?.give) {
        e(`    engine_set_char_give_anim("${cStr(ch.charId)}", ${pfxTalk}_GIVE_PCX, ${pfxTalk}_GIVE_FRAMES, ${pfxTalk}_GIVE_FPS, ${pfxTalk}_GIVE_FW);`)
      }
    } else {
      e(`    engine_place_char("${cStr(ch.charId)}", ${ch.x|0}, ${ch.y|0},`)
      e(`        "", 1, 8, 0,  "", 1, 8, 0,  "", 1, 8, 0, 0,  "", 1, 8, 0,  "", 1, 8, 0,  "", 1, 8, 0,  "", 1, 8, 0,  2, 0);`)
    }
      }
    }

    // Iluminacion de room
    if ((room.ambientLight ?? 100) < 100 || (room.lights || []).length > 0) {
      const ambient = Math.max(0, Math.min(100, room.ambientLight ?? 100))
      e(`    /* iluminacion */`)
      if (ambient < 100) {
        e(`    engine_set_ambient_light(${ambient});`)
      }
      for (const lt of (room.lights || [])) {
        const x  = Math.round(lt.x  || 0)
        const y  = Math.round(lt.y  || 0)
        const r  = Math.max(1, Math.round(lt.radius || 80))
        const i  = Math.max(0, Math.min(100, Math.round(lt.intensity ?? 80)))
        const ca = Math.max(1, Math.min(360, Math.round(lt.coneAngle ?? 360)))
        const dx = Math.round(Math.max(-127, Math.min(127, (lt.dirX ?? 1) * 64)))
        const dy = Math.round(Math.max(-127, Math.min(127, (lt.dirY ?? 0) * 64)))
        const fa = Math.max(0, Math.min(100, Math.round(lt.flicker?.amplitude ?? 0)))
        const fh = Math.max(0, Math.min(255, Math.round(lt.flicker?.speed ?? 0)))
        e(`    engine_add_room_light(${x}, ${y}, ${r}, ${i}, ${ca}, ${dx}, ${dy}, ${fa}, ${fh});`)
      }
    }

    // MIDI de la room — se lanza al entrar; loop=1 por defecto salvo que esté desmarcado
    // midiCont=true → engine_play_midi_cont (no reinicia si ya suena la misma pista)
    if (room.audio?.midi) {
      const midiBase = room.audio.midi.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 27)
      const loopFlag = room.audio.loop !== false ? 1 : 0
      const fn = room.audio.midiCont ? 'engine_play_midi_cont' : 'engine_play_midi_loop'
      e(`    ${fn}("mid_${midiBase}", ${loopFlag});`)
    } else {
      e(`    engine_stop_midi();`)
    }

    // Scripts de esta room (triggers room_load, room_enter, room_enter_via, room_exit)
    const roomScripts = scriptIds
      .map(sid => scripts[sid])
      .filter(s => s?.trigger?.roomId === id)
    if (roomScripts.length) {
      e(`    /* scripts de la room */`)
      const enterScripts    = roomScripts.filter(s => s.trigger?.type === 'room_enter')
      const enterViaScripts = roomScripts.filter(s => s.trigger?.type === 'room_enter_via')
      for (const s of roomScripts) {
        const trigType = s.trigger?.type || ''
        if (trigType === 'room_load') e(`    engine_on_room_load(scr_${cId(s.id)});`)
        if (trigType === 'room_exit') e(`    engine_on_room_exit(scr_${cId(s.id)});`)
      }
      // room_enter + room_enter_via: si hay más de un handler se usa un dispatcher
      if (enterScripts.length === 1 && enterViaScripts.length === 0) {
        e(`    engine_on_room_enter(scr_${cId(enterScripts[0].id)});`)
      } else if (enterScripts.length > 0 || enterViaScripts.length > 0) {
        e(`    engine_on_room_enter(_rent_${cId(id)});`)
      }
    }

    e('}')
    e('')
  }

  // ── Tabla de rooms ──────────────────────────────────────────────────────────
  e('/* ── Tabla de rooms ───────────────────────────────────────────── */')
  e('static const RoomEntry g_rooms[] = {')
  for (const id of roomIds) {
    e(`    { "${cStr(id)}", room_${cId(id)} },`)
  }
  e('    { (const char*)0, (void(*)(void))0 }')
  e('};')
  e('')

  // ── Registro global de scripts (verb+objeto) ────────────────────────────────
  e('/* ── Handlers verbo+objeto ─────────────────────────────────────── */')
  e('static void register_verb_handlers(void) {')
  // ── Scripts manuales (object_click, usar_con, etc.) ──
  // verb_object y verb_inv se registran exclusivamente desde el módulo de objetos (verbResponses/invVerbResponses)
  // [diag] scripts=${scriptIds.length} rooms=${roomIds.length}
  for (const id of scriptIds) {
    const scr = scripts[id]
    const tr  = scr?.trigger
    if (!tr) continue
    if (tr.type === 'usar_con') {
      e(`    engine_on_usar_con("${cStr(tr.objectId)}", "${cStr(tr.targetId || '')}", scr_${cId(id)}, ${tr.requireBothInv ? 1 : 0});`)
    } else if (tr.type === 'object_click') {
      e(`    engine_on_object_click("${cStr(tr.objectId)}", scr_${cId(id)});`)
    } else if (tr.type === 'game_start') {
      e(`    engine_on_game_start(scr_${cId(id)});`)
    } else if (tr.type === 'sequence_end') {
      e(`    engine_on_sequence_end("${cStr(tr.sequenceId)}", scr_${cId(id)});`)
    } else if (tr.type === 'flag_change') {
      const op = cStr(tr.operator || 'is_true')
      e(`    engine_on_flag_change("${cStr(tr.flag)}", "${op}", scr_${cId(id)});`)
    }
  }
  // ── Auto-pickup: sentinel NULL para objetos pickable sin handler manual ──
  const _pickVsId = game.verbsetId || ''
  const _verbsetFiles2 = safeReaddir(path_m.join(gameDir, 'verbsets')).filter(f => f.endsWith('.json'))
  const _verbsetsMap2 = {}
  for (const _vf of _verbsetFiles2) {
    const _vd = safeRead(path_m.join(gameDir, 'verbsets', _vf))
    if (_vd) _verbsetsMap2[_vd.id] = _vd
  }
  const _pickVsList = Object.values(_verbsetsMap2)
  const _pickVs = _pickVsList.find(v => v.id === _pickVsId) || _pickVsList[0]
  const _pickVerb = _pickVs?.verbs?.find(v =>
    v.id.endsWith('_coger') || v.id.endsWith('_pickup') || v.id.endsWith('_take'))
  if (_pickVerb) {

    for (const _prId of roomIds) {
      const _prRoom = rooms[_prId]
      if (!_prRoom?.objects) continue
      for (const _prObj of _prRoom.objects) {
        const _prObjDef = objects[_prObj.objectId]

        if (!_prObj.pickable && _prObjDef?.type !== 'pickable' && !_prObjDef?.pickable) continue
        const _prObjId = _prObj.objectId || _prObj.id
        const _prHasManual = scriptIds.some(_prSid => {
          const _prTr = scripts[_prSid]?.trigger
          return _prTr &&
            (_prTr.type === 'verb_object' || _prTr.type === 'verb_use') &&
            _prTr.verbId === _pickVerb.id &&
            _prTr.objectId === _prObjId
        })
        if (!_prHasManual)
          e(`    engine_on_verb_object("${cStr(_pickVerb.id)}", "${cStr(_prObjId)}", (void(*)(void))0);`)
      }
    }
  }
  // Respuestas de objeto (verbResponses/invVerbResponses/combinations)
  for (const objId of Object.keys(objects || {})) {
    const objDef = objects[objId]
    if (!objDef) continue
    for (const vr of (objDef.verbResponses || [])) {
      if (!vr.verbId) continue
      // Respuestas char-específicas primero (mayor prioridad en dispatch)
      for (const cr of (vr.charResponses || [])) {
        if (!cr.charId) continue
        if (cr.mode === 'script' && cr.scriptId && scripts[cr.scriptId])
          e(`    engine_on_verb_object_char("${cStr(vr.verbId)}", "${cStr(objId)}", "${cStr(cr.charId)}", scr_${cId(cr.scriptId)});`)
        else if (cr.mode === 'text')
          e(`    engine_on_verb_object_char("${cStr(vr.verbId)}", "${cStr(objId)}", "${cStr(cr.charId)}", say_${cId(objId)}_verb_${cId(vr.verbId)}_${cId(cr.charId)});`)
      }
      // Respuesta genérica (fallback)
      if (vr.mode === 'script' && vr.scriptId && scripts[vr.scriptId])
        e(`    engine_on_verb_object("${cStr(vr.verbId)}", "${cStr(objId)}", scr_${cId(vr.scriptId)});`)
      else if (vr.mode === 'text')
        e(`    engine_on_verb_object("${cStr(vr.verbId)}", "${cStr(objId)}", say_${cId(objId)}_verb_${cId(vr.verbId)});`)
    }
    for (const vr of (objDef.invVerbResponses || [])) {
      if (!vr.verbId) continue
      for (const cr of (vr.charResponses || [])) {
        if (!cr.charId) continue
        if (cr.mode === 'script' && cr.scriptId && scripts[cr.scriptId])
          e(`    engine_on_verb_inv_char("${cStr(vr.verbId)}", "${cStr(objId)}", "${cStr(cr.charId)}", scr_${cId(cr.scriptId)});`)
        else if (cr.mode === 'text')
          e(`    engine_on_verb_inv_char("${cStr(vr.verbId)}", "${cStr(objId)}", "${cStr(cr.charId)}", say_${cId(objId)}_invverb_${cId(vr.verbId)}_${cId(cr.charId)});`)
      }
      if (vr.mode === 'script' && vr.scriptId && scripts[vr.scriptId])
        e(`    engine_on_verb_inv("${cStr(vr.verbId)}", "${cStr(objId)}", scr_${cId(vr.scriptId)});`)
      else if (vr.mode === 'text')
        e(`    engine_on_verb_inv("${cStr(vr.verbId)}", "${cStr(objId)}", say_${cId(objId)}_invverb_${cId(vr.verbId)});`)
    }
    for (const c of (objDef.combinations || [])) {
      if (!c.scriptId || !scripts[c.scriptId]) continue
      if (c.charId)
        e(`    engine_on_usar_con_char("${cStr(objId)}", "${cStr(c.withId || '')}", "${cStr(c.charId)}", scr_${cId(c.scriptId)}, ${c.requireBothInv ? 1 : 0});`)
      else
        e(`    engine_on_usar_con("${cStr(objId)}", "${cStr(c.withId || '')}", scr_${cId(c.scriptId)}, ${c.requireBothInv ? 1 : 0});`)
    }
  }
  e('}')
  e('')

  // ── main() ──────────────────────────────────────────────────────────────────
  e('/* ── main ─────────────────────────────────────────────────────── */')
  e('int main(void) {')
  e(`    engine_init("${cStr(game.name || game.id)}");`)

  // Inicializar audio AIL/32 — siempre, con fallback a a32adlib.dll
  {
    const aud     = game.audio || {}
    const dll     = cStr(audioDriver || 'a32adlib.dll')
    const isOpl   = !audioDriver || audioDriver.includes('adlib') || audioDriver.includes('sbfm') || audioDriver.includes('sbp') || audioDriver.includes('spkr')
    const patches = cStr(isOpl ? 'GENMIDI.OP2' : '')
    const mvol    = (aud.music_volume != null) ? (aud.music_volume|0) : 100
    const svol    = (aud.sfx_volume   != null) ? (aud.sfx_volume|0)   : 100
    e(`    /* Audio MPU-401 via mididrv */`)
    e(`    engine_audio_init(NULL, NULL, ${mvol}, ${svol});`)
  }

  // Paleta maestra — aplicar a VGA antes del primer render
  if (Array.isArray(game.palette) && game.palette.length === 256) {
    e(`    /* Paleta maestra del juego — aplicar a VGA antes del primer render */`)
    e(`    {`)
    e(`        static const unsigned char g_pal[768] = {`)
    const palBytes = game.palette.flatMap(([r, g2, b]) => [r, g2, b])
    for (let i = 0; i < 768; i += 16) {
      e(`            ${palBytes.slice(i, i + 16).join(',')},`)
    }
    e(`        };`)
    e(`        engine_set_palette(g_pal);`)
    e(`    }`)
  }

  // Verbset inicial
  const startVerbset = game.activeVerbSet || ''
  if (startVerbset) {
    e(`    engine_set_verbset("${cStr(startVerbset)}");`)
    // Registrar verbos dar de todos los verbsets
    for (const _vs of Object.values(verbsetsMap)) {
      for (const _vv of (_vs.verbs || [])) {
        if (_vv.isGive) e(`    engine_set_give_verb("${cStr(_vv.id)}");`)
      }
    }
  }

  e(`    engine_set_room_table(g_rooms);`)
  e(`    register_verb_handlers();`)
  e('')

  /* Sistema de atributos RPG */
  if (game.systems?.rpgAttributes && Array.isArray(game.attributes) && game.attributes.length > 0) {
    const attrs = game.attributes
    const deathAttr = attrs.find(a => a.isDeathAttr)
    e(`    /* Sistema de atributos RPG */`)
    if (deathAttr) e(`    engine_set_death_attr("${cStr(deathAttr.id)}");`)
    /* Inicializar atributos para cada personaje */
    const charFiles = safeReaddir(path_m.join(gameDir, 'characters'))
      .filter(f => f.endsWith('.json'))
    for (const cf of charFiles) {
      const ch = safeRead(path_m.join(gameDir, 'characters', cf))
      if (!ch) continue
      for (const attr of attrs) {
        const val = ch.attrs?.[attr.id] ?? attr.defaultValue ?? 0
        e(`    engine_set_attr("${cStr(ch.id)}", "${cStr(attr.id)}", "${val}");`)
      }
    }
    e('')
  }
  /* Registrar inv_gfx de todos los objetos para engine_give_object en secuencias.
   * Busca invGfxId en: 1) definición de objeto (librería), 2) instancias de rooms */
  {
    const invGfxMap = {}  /* objectId → invGfxId */
    /* 1. Desde la librería de objetos — buscar en estados */
    for (const id of objectIds) {
      const obj = objects[id]
      if (!obj) continue
      /* invGfxId directo o en los estados del objeto */
      const raw = obj.invGfxId || obj.inv_gfx_id ||
                  (obj.states && obj.states.length > 0 ? obj.states[0].inventorySprite : '') || ''
      if (raw) invGfxMap[id] = raw
    }
    /* 2. Desde instancias en rooms (sobreescribe si hay valor) */
    for (const rid of roomIds) {
      const room = rooms[rid]
      if (!room) continue
      for (const obj of (room.objects || [])) {
        if (obj.invGfxId && obj.objectId) invGfxMap[obj.objectId] = obj.invGfxId
      }
    }
    const invEntries = Object.entries(invGfxMap)
    if (invEntries.length > 0) {
      e(`    /* Tabla global de iconos de inventario por objeto */`)
      for (const [oid, rawGfx] of invEntries) {
        const invGfx = rawGfx
          ? (resolveAssetId(assetsMap, rawGfx) || ('spr_' + rawGfx.replace(/\.pcx$/i,'').slice(0,27).toUpperCase()))
          : ''
        if (invGfx) e(`    engine_register_obj_inv_gfx("${cStr(oid)}", "${cStr(invGfx)}");`)
      }
      e('')
    }
  }
  // Party de protagonistas — registrar todos los isProtagonist=true
  {
    const protagonists = charIds.filter(id => chars[id]?.isProtagonist)
    if (protagonists.length > 0) {
      e(`    /* Party de protagonistas */`)
      for (const id of protagonists) {
        const ch = chars[id]
        e(`    engine_party_add("${cStr(id)}", _party_place_${cId(id)});`)
        const rawFace = ch.faceSprite || ''
        if (rawFace) {
          const faceId = resolveAssetId(assetsMap, rawFace)
            || ('spr_' + rawFace.replace(/\.pcx$/i, '').slice(0, 27).toUpperCase())
          e(`    engine_set_char_face_sprite("${cStr(id)}", "${cStr(faceId)}");`)
        }
      }
      // Colores del popup de party (de game.json -> partyPopup)
      const pp = game.partyPopup || {}
      const hasCols = pp.colorBg !== undefined || pp.colorBorder !== undefined
                   || pp.colorActive !== undefined || pp.colorHover !== undefined
      if (hasCols) {
        const bg     = pp.colorBg     ?? 1
        const border = pp.colorBorder ?? 8
        const active = pp.colorActive ?? 8
        const hover  = pp.colorHover  ?? 4
        e(`    engine_set_party_popup_colors(${bg}, ${border}, ${active}, ${hover});`)
      }
      // Colores por defecto del panel de dialogos (de game.json -> dialogueColors)
      const dc = game.dialogueColors || {}
      const hasDlgCols = dc.colorBg !== undefined || dc.colorBrd !== undefined
                      || dc.colorTxt !== undefined || dc.colorSel !== undefined
      if (hasDlgCols) {
        e(`    engine_set_dialogue_colors(${dc.colorBg ?? 16}, ${dc.colorBrd ?? 0}, ${dc.colorTxt ?? 15}, ${dc.colorSel ?? 26});`)
      }
      // Colores del menu de juego / barra de verbos (de game.json -> uiColors)
      const uc = game.uiColors || {}
      const hasUiCols = uc.colorBg !== undefined || uc.colorAction !== undefined
                     || uc.colorSel !== undefined || uc.colorInvHov !== undefined
      if (hasUiCols) {
        e(`    engine_set_ui_colors(${uc.colorBg ?? 1}, ${uc.colorAction ?? 15}, ${uc.colorSel ?? 14}, ${uc.colorInvHov ?? 8});`)
      }
      // Colores del menu ESC/pausa (de game.json -> menuColors)
      const mc = game.menuColors || {}
      const hasMenuCols = mc.colorBg !== undefined || mc.colorBtn !== undefined
                       || mc.colorSel !== undefined || mc.colorBrd !== undefined
                       || mc.colorTxt !== undefined || mc.colorAct !== undefined
      if (hasMenuCols) {
        e(`    engine_set_menu_colors(${mc.colorBg ?? 16}, ${mc.colorBtn ?? 20}, ${mc.colorSel ?? 26}, ${mc.colorBrd ?? 0}, ${mc.colorTxt ?? 15}, ${mc.colorAct ?? 12});`)
      }
      e('')
    }
  }
  e(`    /* Bucle de partida: se repite si el jugador elige "Nueva partida" */`)
  e(`    do {`)
  // Inventario inicial — dentro del bucle para que se restaure tras engine_reset_game()
  // engine_give_object ignora duplicados, por lo que es seguro llamarlo en cada iteración
  {
    const hasAny = charIds.some(id => chars[id]?.inventory?.length > 0)
    if (hasAny) {
      e(`        /* Inventario inicial de personajes */`)
      for (const id of charIds) {
        const ch = chars[id]
        if (!ch?.inventory?.length) continue
        for (const item of ch.inventory) {
          if (item.objectId)
            e(`        engine_give_object("${cStr(item.objectId)}", "${cStr(id)}");`)
        }
      }
      e(``)
    }
  }
  if (game.startSequence) {
    e(`        /* secuencia de inicio — controla todo el flujo incluyendo load_room */`)
    e(`        seq_${cId(game.startSequence)}();`)
  } else {
    e(`        /* sin secuencia de inicio — el juego arranca sin cargar ninguna room */`)
    e(`        /* ATENCION: define una secuencia de inicio con un paso load_room */`)
  }
  e(`        engine_loop();`)
  e(`        if (!engine_restart_requested()) break;`)
  e(`        engine_reset_game();`)
  e(`    } while (1);`)
  e(`    engine_audio_shutdown();`)
  e(`    return 0;`)
  e('}')


  return { ok: true, code: lines.join('\n') + '\n' }
}

/**
 * Genera agemki_dat.h — cabecera C con las estructuras y constantes del
 * formato DAT para incluir en el motor DOS.
 * Se regenera en cada build release. NO EDITAR MANUALMENTE.
 */
function generateDatHeader() {
  return `/* ============================================================
 * agemki_dat.h — AGEMKI DAT Format v1
 * Generado automáticamente por el editor. NO EDITAR.
 * Solo tipos, constantes y macros — sin implementación.
 * Incluir con: #include "agemki_dat.h"
 * ============================================================ */
#ifndef AGEMKI_DAT_H
#define AGEMKI_DAT_H

/* Tipos enteros portables sin stdint.h (Open Watcom DOS) */
#ifndef AGEMKI_INTTYPES_DEFINED
#define AGEMKI_INTTYPES_DEFINED
#if defined(__WATCOMC__) || defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L
#  include <stdint.h>
#else
typedef unsigned char  uint8_t;
typedef unsigned short uint16_t;
typedef unsigned long  uint32_t;
typedef signed short   int16_t;
typedef signed long    int32_t;
#endif
#ifndef NULL
#define NULL 0
#endif
#endif

/* -- Ficheros DAT ─────────────────────────────────────────────────────────── */
#define DAT_GRAPHICS  "GRAPHICS.DAT"
#define DAT_AUDIO     "AUDIO.DAT"
#define DAT_TEXT      "TEXT.DAT"

/* ── Tipo de DAT (campo dat_type) ─────────────────────────────────────────── */
#define DAT_TYPE_GRAPHICS  0
#define DAT_TYPE_AUDIO     2
#define DAT_TYPE_TEXT      3

/* ── Tipo de recurso (campo res_type en DatIndex) ─────────────────────────── */
#define RES_BACKGROUND   0x01
#define RES_SPRITE       0x02
#define RES_OBJECT_PCX   0x03
#define RES_FONT_PCX     0x04
#define RES_MIDI         0x20
#define RES_SFX          0x21
#define RES_LOCALE       0x30

/* ── Tamaños fijos ────────────────────────────────────────────────────────── */
#define DAT_HEADER_SIZE   16
#define DAT_INDEX_ENTRY   48
#define DAT_ID_LEN        32
#define DAT_MAGIC_STR     "AGMK"
#define DAT_VERSION       1

/* ── Estructuras (little-endian, packed) ──────────────────────────────────── */
#pragma pack(push, 1)
typedef struct {
    char     magic[4];        /* "AGMK"                      */
    uint8_t  dat_type;        /* DAT_TYPE_*                  */
    uint8_t  version;         /* DAT_VERSION = 1             */
    uint16_t num_blocks;
    uint32_t index_offset;    /* siempre 16                  */
    uint32_t data_offset;     /* 16 + num_blocks * 48        */
} DatHeader;

typedef struct {
    char     id[32];          /* nombre null-padded          */
    uint8_t  res_type;        /* RES_*                       */
    uint8_t  flags;           /* 0 = normal                  */
    uint16_t reserved;
    uint32_t offset;          /* offset desde data_offset    */
    uint32_t size;
    uint32_t extra;           /* frame_width para sprites    */
} DatIndex;
#pragma pack(pop)

#endif /* AGEMKI_DAT_H */
`
}
