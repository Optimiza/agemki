/**
 * @fileoverview scriptStore — Gestión del módulo Scripts
 *
 * Los scripts son la lógica de comportamiento del juego: reaccionan a
 * interacciones del jugador (verbos, clics, flags, timers...) y ejecutan
 * una lista de instrucciones (mover personajes, cambiar flags, reproducir audio...).
 *
 * Estructura en disco: scripts/scr_XXXXXXX.json por cada script.
 *
 * Flujo típico:
 *   loadScripts(gameDir)  → puebla scripts[]
 *   openScript(gameDir, id) → carga activeScript completo
 *   addInstruction / updateInstruction / deleteInstruction → modifica activeScript + dirty=true
 *   saveScript(gameDir)   → persiste en disco + dirty=false
 *
 * @module scriptStore
 */
import { create } from 'zustand'

// ── Disparadores (trigger.type) ───────────────────────────────────────────────
//
// Un disparador define QUÉ evento activa el script.
// Cada tipo tiene campos adicionales (ej: verb_object necesita verbId y objectId).

/** @type {Record<string, {label:string, icon:string, fields:string[]}>} */
export const TRIGGERS = {
  // El jugador aplica un verbo a un personaje
  verb_char:          { label: 'Verbo + Personaje',       icon: '💬',  fields: ['verbId','charId'] },
  // El jugador elige una opción en un diálogo
  dialogue_choice:    { label: 'Opción de diálogo',       icon: '🔀',  fields: ['dialogueId','nodeId','choiceIndex'] },
  // Un flag global cambia de valor (útil para cadenas de eventos)
  flag_change:        { label: 'Flag cambia a valor',     icon: '⚑',   fields: ['flag','operator','value'] },
  // El valor de un atributo de personaje/objeto cruza un umbral
  attr_threshold:     { label: 'Atributo llega a umbral', icon: '📊',  fields: ['target','attrName','operator','value'] },
  // El protagonista entra en la room (llega desde otra room o spawn inicial)
  room_enter:         { label: 'Al entrar en room',       icon: '🚪',  fields: ['roomId'] },
  // Igual que room_enter pero solo si llega por una entrada concreta
  room_enter_via:     { label: 'Al entrar por entrada',   icon: '🚪',  fields: ['roomId', 'entryId'] },
  // El protagonista intenta usar una salida — puede bloquearse con BLOCK_EXIT
  room_exit:          { label: 'Al intentar salir',       icon: '🚪',  fields: ['roomId'] },
  // La room se carga en memoria (antes del primer frame) — ideal para música
  room_load:          { label: 'Al cargar room',          icon: '🏠',  fields: ['roomId'] },
  // Una secuencia de cutscene termina
  sequence_end:       { label: 'Al acabar secuencia',     icon: '🎬',  fields: ['sequenceId'] },
  // Se inicia una nueva partida (para inicializar flags globales)
  game_start:         { label: 'Inicio de partida',       icon: '▶',   fields: [] },
  // Un temporizador llega a cero (útil para eventos temporales)
  timer:              { label: 'Temporizador',            icon: '⏱',   fields: ['seconds'] },
  // La vida de un personaje llega a 0 (solo si rpgAttributes está activo)
  char_death:         { label: 'Muerte de personaje',     icon: '💀',  fields: ['charId'] },
  // El jugador cambia de protagonista activo (si allowCharacterSwitch=true)
  protagonist_change: { label: 'Cambio de protagonista',  icon: '🦸',  fields: ['charId'] },
  // El jugador hace clic en un objeto sin verbo activo (cursor en modo default)
  object_click:       { label: 'Clic en objeto',          icon: '👆',  fields: ['objectId'] },
  // El jugador usa un objeto del inventario CON otro objeto/personaje/escena
  usar_con:           { label: 'Usar inv. con...',         icon: '🔗',  fields: ['objectId','targetId'] },
}

// ── Instrucciones (instruction.type) ─────────────────────────────────────────
//
// Cada instrucción tiene:
//   cat    → categoría para la paleta visual (color e icono)
//   label  → texto en castellano para la UI
//   fields → lista de campos editables con su tipo de picker
//   note   → (opcional) advertencia especial
//   block  → (opcional) true si abre un bloque (IF → necesita END_IF)

/** @type {Record<string, {cat:string, label:string, fields:Array<{k:string,t:string,ph?:string}>, note?:string, block?:boolean}>} */
export const INSTR = {

  // ── Variables y flags ─────────────────────────────────────────────────────
  //
  // Las flags son variables globales del juego (persistidas en el savegame).
  // Los atributos son propiedades numéricas de personajes u objetos.
  // Las variables locales (LET) solo viven durante la ejecución del script.

  SET_FLAG:  { cat:'flags', label:'Activar flag',     fields:[{k:'flag',t:'text'},{k:'value',t:'text',ph:'true/false/número'}] },
  SET_ATTR:  { cat:'flags', label:'Cambiar atributo', fields:[{k:'target',t:'target'},{k:'attr',t:'text',ph:'hp/mp/xp/...'},{k:'value',t:'text'}] },
  // amount puede ser negativo para restar
  ADD_ATTR:  { cat:'flags', label:'Sumar a atributo', fields:[{k:'target',t:'target'},{k:'attr',t:'text',ph:'hp/mp/xp/...'},{k:'amount',t:'text',ph:'puede ser negativo'}] },
  // Variable local: scope = duración del script, no se serializa en savedata
  LET:       { cat:'flags', label:'Variable local',   fields:[{k:'varName',t:'text',ph:'nombre_var'},{k:'value',t:'text',ph:'valor o GET_ATTR(...)'}] },

  // ── Control de flujo ──────────────────────────────────────────────────────
  //
  // Regla importante: NO hay bucles (WHILE/REPEAT/FOR).
  // La lógica cíclica se modela con flags + disparadores.
  // Esto garantiza que ningún script pueda colgar el motor.

  // IF abre un bloque que DEBE cerrase con END_IF (puede tener ELIF/ELSE intermedios)
  IF:         { cat:'flow', label:'SI (condición)',   fields:[{k:'condition',t:'condition'}], block:true },
  ELIF:       { cat:'flow', label:'SI NO SI',          fields:[{k:'condition',t:'condition'}] },
  ELSE:       { cat:'flow', label:'SI NO',             fields:[] },
  END_IF:     { cat:'flow', label:'FIN SI',            fields:[] },
  // CALL_SCRIPT: ejecuta otro script — no es bloqueante, continúa en paralelo
  // AVISO: el editor no detecta recursión infinita — responsabilidad del creador
  CALL_SCRIPT:{ cat:'flow', label:'Llamar script',    fields:[{k:'scriptId',t:'script'}] },
  RETURN:     { cat:'flow', label:'Terminar script',  fields:[] },
  // BLOCK_EXIT solo tiene efecto en scripts con disparador room_exit
  // Cancela la salida del jugador de la room actual
  BLOCK_EXIT: { cat:'flow', label:'Bloquear salida',  fields:[], note:'Solo válido en room_exit' },

  // ── Personajes ────────────────────────────────────────────────────────────
  //
  // MOVE_CHAR = teleport instantáneo (sin animación, sin pathfinding)
  // WALK_CHAR = usa el walkmap activo para calcular la ruta + anima al personaje

  // Coloca al protagonista en una posición de la room actual (sin cambiar de room).
  // Útil para posicionar al personaje ANTES de un engine_change_room o después de entrar.
  SET_CHAR_ROOM_POS:  { cat:'char', label:'Colocar personaje en posición', fields:[{k:'charId',t:'char'},{k:'x',t:'number'},{k:'y',t:'number'},{k:'direction',t:'dir',ph:'left/right/up/down'},{k:'animName',t:'char_anim',ph:'animación inicial (vacío=idle)'}] },
  MOVE_CHAR:          { cat:'char', label:'Teleportar personaje',      fields:[{k:'charId',t:'char'},{k:'x',t:'number'},{k:'y',t:'number'}] },
  // Teleport junto al objeto (el motor calcula la posición exacta según el sprite del objeto)
  MOVE_CHAR_TO_OBJ:   { cat:'char', label:'Teleportar junto a objeto', fields:[{k:'charId',t:'char'},{k:'objectId',t:'object'}] },
  // speed 0 = usa la velocidad por defecto del personaje (campo speed en char.json)
  // animName vacío = usa la animación de caminar por defecto del motor
  WALK_CHAR:          { cat:'char', label:'Desplazar personaje',       fields:[{k:'charId',t:'char'},{k:'x',t:'number'},{k:'y',t:'number'},{k:'speed',t:'number',ph:'1-10 (0=vel. personaje)'},{k:'animName',t:'char_anim',ph:'vacío=anim. caminar por defecto'}] },
  WALK_CHAR_TO_OBJ:   { cat:'char', label:'Desplazar junto a objeto',  fields:[{k:'charId',t:'char'},{k:'objectId',t:'object'},{k:'speed',t:'number',ph:'1-10 (0=vel. personaje)'},{k:'animName',t:'char_anim',ph:'vacío=anim. caminar por defecto'}] },
  WALK_CHAR_DIRECT:   { cat:'char', label:'Caminar directo (sin walkmap)', fields:[{k:'charId',t:'char'},{k:'x',t:'number',ph:'x destino (puede ser fuera de pantalla)'},{k:'y',t:'number',ph:'y destino'},{k:'speed',t:'number',ph:'1-10'}] },
  // SET_ANIM: loop=true → permanente; loop=false → un ciclo y vuelve a idle; duration>0 → espera N segundos y vuelve a idle
  SET_ANIM:           { cat:'char', label:'Animar personaje',          fields:[{k:'charId',t:'char'},{k:'animName',t:'char_anim',ph:'animación'},{k:'loop',t:'bool',ph:'¿en bucle?'},{k:'duration',t:'number',ph:'segundos (0=hasta cambiar)'}] },
  FACE_DIR:           { cat:'char', label:'Orientar personaje',        fields:[{k:'charId',t:'char'},{k:'direction',t:'dir'}] },
  SET_CHAR_VISIBLE:   { cat:'char', label:'Visibilidad personaje',     fields:[{k:'charId',t:'char'},{k:'visible',t:'bool'}] },
  // Solo funciona si game.json.systems.allowCharacterSwitch es true
  CHANGE_PROTAGONIST: { cat:'char', label:'Cambiar protagonista',      fields:[{k:'charId',t:'char'}] },

  // ── Objetos ───────────────────────────────────────────────────────────────

  MOVE_OBJECT:        { cat:'object', label:'Mover objeto',            fields:[{k:'objectId',t:'object'},{k:'x',t:'number'},{k:'y',t:'number'}] },
  // stateId debe existir en el array states del objeto
  SET_OBJECT_STATE:   { cat:'object', label:'Cambiar estado objeto',   fields:[
    {k:'objectId', t:'object'},
    {k:'stateId',  t:'obj_state', ph:'estado'},
    {k:'animLoop', t:'loop_tri',  ph:'loop animación'},
    {k:'waitAnim', t:'checkbox',  ph:'esperar hasta que acabe la animación'},
  ]},
  SET_OBJECT_VISIBLE: { cat:'object', label:'Visibilidad objeto',      fields:[{k:'objectId',t:'object'},{k:'visible',t:'bool'}] },
  // Añade el objeto al inventario del personaje (que puede ser el protagonista u otro)
  GIVE_OBJECT:        { cat:'object', label:'Dar objeto a personaje',  fields:[{k:'objectId',t:'object'},{k:'charId',t:'char'}] },
  // Quita el objeto del inventario (no lo destruye, queda en el mundo)
  REMOVE_OBJECT:      { cat:'object', label:'Quitar objeto a personaje',fields:[{k:'objectId',t:'object'},{k:'charId',t:'char'}] },
  // Suelta el objeto en una posición del mundo (lo saca del inventario si lo tenía)
  DROP_OBJECT:        { cat:'object', label:'Soltar objeto en room',   fields:[{k:'objectId',t:'object'},{k:'roomId',t:'room'},{k:'x',t:'number'},{k:'y',t:'number'}] },

  // ── Room ──────────────────────────────────────────────────────────────────

  // CHANGE_ROOM: teletransporta al protagonista a otra room
  // entryId es el ID del entry point de destino (por defecto: entry_default)
  CHANGE_ROOM:  { cat:'room', label:'Cambiar de room',   fields:[{k:'roomId',t:'room'},{k:'entryId',t:'text',ph:'entry_default'}] },
  // SET_WALKMAP: cambia qué walkmap está activo en la room actual
  // Útil para puzzles donde abrir una puerta habilita nuevas zonas de paso
  SET_WALKMAP:  { cat:'room', label:'Cambiar walkmap',   fields:[{k:'walkmapId',t:'text'}] },
  // Cambia el set de verbos activo (todos los verbos de la UI se actualizan)
  SET_VERBSET:  { cat:'room', label:'Cambiar verbset',   fields:[{k:'verbsetId',t:'verbset'}] },
  // Activa o desactiva una salida de la room actual
  // enabled=true → salida accesible; enabled=false → bloqueada (_hit_exit la ignora)
  SET_EXIT_STATE: { cat:'room', label:'Activar/desactivar salida', fields:[
    {k:'exitId',  t:'exit', ph:'salida'},
    {k:'enabled', t:'bool'},
  ] },

  // Entra en una room de primer plano sin protagonista; guarda la room actual para volver.
  ENTER_CLOSEUP: { cat:'room', label:'Entrar closeup (sin protagonista)', fields:[{k:'roomId',t:'room'},{k:'showUi',t:'bool',ph:'mostrar UI de verbos'}] },
  // Regresa a la room guardada por ENTER_CLOSEUP, reinyectando el protagonista en su posición anterior.
  EXIT_CLOSEUP:  { cat:'room', label:'Salir closeup (volver a room anterior)', fields:[] },

  // ── Diálogo y texto ───────────────────────────────────────────────────────

  START_DIALOGUE: { cat:'dialog', label:'Iniciar diálogo', fields:[{k:'dialogueId',t:'dialogue'}] },
  // localeKey es una clave en los ficheros locales/ (ej: "msg.puerta_cerrada")
  // El texto se muestra en la barra de acción inferior de la pantalla
  SHOW_TEXT:      { cat:'dialog', label:'Mostrar texto',   fields:[
    {k:'localeKey', t:'locale_text'},
    {k:'color',     t:'pal_color'},
    {k:'duration',  t:'number', ph:'segundos (0=click)'},
  ] },
  CLEAR_TEXT:     { cat:'dialog', label:'Limpiar texto',   fields:[] },

  // ── Audio ─────────────────────────────────────────────────────────────────
  //
  // Los IDs de audio llevan prefijo: "midi:NOMBRE.MID" o "sfx:NOMBRE.WAV"
  // Esto permite distinguir el tipo sin inspeccionar la extensión

  PLAY_MIDI: { cat:'audio', label:'Reproducir MIDI', fields:[{k:'midiId',t:'audio'}] },
  STOP_MIDI: { cat:'audio', label:'Parar MIDI',      fields:[] },
  PLAY_SFX:  { cat:'audio', label:'Reproducir SFX',  fields:[{k:'sfxId',t:'audio'}] },

  // ── Secuencias ────────────────────────────────────────────────────────────

  // PLAY_SEQUENCE lanza una secuencia de cutscene (no bloqueante en scripts)
  // Para esperar a que acabe, usar el disparador sequence_end en otro script
  PLAY_SEQUENCE: { cat:'seq', label:'Lanzar secuencia',    fields:[{k:'sequenceId',t:'text'}] },
  // WAIT pausa la ejecución del script N segundos (bloqueante)
  WAIT:          { cat:'seq', label:'Esperar (segundos)', fields:[{k:'seconds',t:'number'}] },

  // ── Juego ─────────────────────────────────────────────────────────────────

  SAVE_CHECKPOINT: { cat:'game', label:'Guardar checkpoint', fields:[] },
  GAME_OVER:       { cat:'game', label:'Game Over',          fields:[] },
  SHOW_CREDITS:    { cat:'game', label:'Mostrar créditos',   fields:[] },
}

/** @type {Record<string, {label:string, color:string}>} Metadatos visuales por categoría */
export const INSTR_CATS = {
  flags:  { label:'Variables',  color:'#f59e0b' },
  flow:   { label:'Control',    color:'#8b5cf6' },
  char:   { label:'Personajes', color:'#3b82f6' },
  object: { label:'Objetos',    color:'#10b981' },
  room:   { label:'Room',       color:'#06b6d4' },
  dialog: { label:'Diálogo',    color:'#ec4899' },
  audio:  { label:'Audio',      color:'#f97316' },
  seq:    { label:'Secuencias', color:'#6366f1' },
  game:   { label:'Juego',      color:'#ef4444' },
}

// ── Tipos de condición para IF/ELIF ───────────────────────────────────────────
//
// Las condiciones se evalúan en orden dentro de cada bloque IF/ELIF.
// Se pueden combinar con AND/OR/NOT (campo 'logic' en la condición).

/** @type {Record<string, {label:string, fields:string[]}>} */
export const COND_TYPES = {
  flag_is:    { label:'flag es (bool)',   fields:['flag','boolValue'] },
  flag_eq:    { label:'flag ==',          fields:['flag','value'] },
  flag_neq:   { label:'flag ≠',           fields:['flag','value'] },
  flag_gt:    { label:'flag >',           fields:['flag','value'] },
  flag_lt:    { label:'flag <',           fields:['flag','value'] },
  attr_eq:    { label:'atributo ==',      fields:['target','attr','value'] },
  attr_gt:    { label:'atributo >',       fields:['target','attr','value'] },
  attr_lt:    { label:'atributo <',       fields:['target','attr','value'] },
  has_object: { label:'personaje tiene objeto', fields:['charId','objectId'] },
  in_room:    { label:'personaje está en room', fields:['charId','roomId'] },
  protagonist:{ label:'protagonista activo es', fields:['charId'] },
  var_eq:     { label:'variable local ==',      fields:['varName','value'] },
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useScriptStore = create((set, get) => ({

  /** @type {Array<{id:string, name:string, trigger:{type:string}}>} Lista resumen (sin instrucciones completas) */
  scripts: [],

  /** @type {Object|null} Script completo con instrucciones — el que está abierto en el editor */
  activeScript: null,

  /** @type {boolean} true si activeScript tiene cambios no guardados */
  dirty: false,

  /** @type {boolean} true si scripts[] ya fue cargado desde disco al menos una vez */
  loaded: false,

  // ── CRUD de scripts ─────────────────────────────────────────────────────────

  /**
   * Carga la lista resumen de scripts desde disco.
   * Solo carga id+name+trigger — las instrucciones se cargan al abrir el script.
   * @param {string} gameDir
   */
  loadScripts: async (gameDir) => {
    const r = await window.api.listScripts(gameDir)
    if (r.ok) set({ scripts: r.scripts, loaded: true })
  },

  /**
   * Crea un script nuevo en disco y recarga la lista.
   * @param {string} gameDir
   * @param {string} name
   * @returns {Object|null} El script creado con id y nombre
   */
  createScript: async (gameDir, name) => {
    const r = await window.api.createScript(gameDir, name)
    if (r.ok) { await get().loadScripts(gameDir); return r.script }
    return null
  },

  /**
   * Elimina un script del disco y actualiza la lista.
   * Si el script eliminado era el activeScript, lo cierra.
   * @param {string} gameDir
   * @param {string} id
   */
  deleteScript: async (gameDir, id) => {
    await window.api.deleteScript(gameDir, id)
    await get().loadScripts(gameDir)
    if (get().activeScript?.id === id) set({ activeScript: null })
  },

  /**
   * Duplica un script en disco (nuevo id, nombre con " (copia)") y recarga la lista.
   * @param {string} gameDir
   * @param {string} id
   */
  duplicateScript: async (gameDir, id) => {
    await window.api.duplicateScript(gameDir, id)
    await get().loadScripts(gameDir)
  },

  /**
   * Lee el script completo del disco y lo establece como activeScript.
   * Resetea dirty a false.
   * @param {string} gameDir
   * @param {string} id
   */
  openScript: async (gameDir, id) => {
    const r = await window.api.readScript(gameDir, id)
    if (r.ok) set({ activeScript: r.script, dirty: false })
  },

  /** Cierra el editor de script activo. No guarda. */
  closeScript: () => set({ activeScript: null, dirty: false }),

  /**
   * Guarda el activeScript en disco y actualiza el resumen en scripts[].
   * @param {string} gameDir
   */
  saveScript: async (gameDir) => {
    const s = get().activeScript
    if (!s) return
    await window.api.saveScript(gameDir, s)
    set({ dirty: false })
    // Actualizar solo el resumen en la lista (id+name+trigger) sin recargar todo
    set(st => ({ scripts: st.scripts.map(x => x.id === s.id
      ? { id: s.id, name: s.name, trigger: s.trigger } : x) }))
  },

  /**
   * Actualiza campos del script activo (ej: name, trigger).
   * @param {Partial<Object>} partial
   */
  updateMeta: (partial) => set(s => ({
    activeScript: s.activeScript ? { ...s.activeScript, ...partial } : null,
    dirty: true,
  })),

  // ── CRUD de instrucciones ───────────────────────────────────────────────────

  /**
   * Añade una instrucción nueva al activeScript.
   * @param {string} type - Clave de INSTR
   * @param {number|null} afterIndex - Si null, añade al final. Si número, inserta después de esa posición.
   */
  addInstruction: (type, afterIndex = null) => set(s => {
    if (!s.activeScript) return {}
    const instr = { id: `i_${Date.now()}`, type, ...makeDefaultInstr(type) }
    const list = [...s.activeScript.instructions]
    const idx = afterIndex === null ? list.length : afterIndex + 1
    list.splice(idx, 0, instr)
    return { activeScript: { ...s.activeScript, instructions: list }, dirty: true }
  }),

  /**
   * Actualiza campos de una instrucción por su id.
   * @param {string} id
   * @param {Partial<Object>} partial
   */
  updateInstruction: (id, partial) => set(s => {
    if (!s.activeScript) return {}
    return {
      activeScript: {
        ...s.activeScript,
        instructions: s.activeScript.instructions.map(i => i.id === id ? { ...i, ...partial } : i),
      },
      dirty: true,
    }
  }),

  /**
   * Elimina una instrucción por su id.
   * @param {string} id
   */
  deleteInstruction: (id) => set(s => {
    if (!s.activeScript) return {}
    return {
      activeScript: { ...s.activeScript, instructions: s.activeScript.instructions.filter(i => i.id !== id) },
      dirty: true,
    }
  }),

  /**
   * Mueve una instrucción hacia arriba (dir=-1) o hacia abajo (dir=+1).
   * @param {string} id
   * @param {-1|1} dir
   */
  duplicateInstruction: (id) => set(s => {
    if (!s.activeScript) return {}
    const list   = [...s.activeScript.instructions]
    const srcIdx = list.findIndex(i => i.id === id)
    if (srcIdx < 0) return {}
    const clone = { ...list[srcIdx], id: `i_${Date.now()}` }
    list.splice(srcIdx + 1, 0, clone)
    return { activeScript: { ...s.activeScript, instructions: list }, dirty: true }
  }),

  moveInstruction: (id, dir) => set(s => {
    if (!s.activeScript) return {}
    const list = [...s.activeScript.instructions]
    const idx = list.findIndex(i => i.id === id)
    const next = idx + dir
    if (next < 0 || next >= list.length) return {} // ya está en el límite
    ;[list[idx], list[next]] = [list[next], list[idx]]
    return { activeScript: { ...s.activeScript, instructions: list }, dirty: true }
  }),
}))

// ── Valores por defecto al crear instrucciones ───────────────────────────────
//
// Devuelve los campos adicionales pre-rellenos para que el usuario no tenga
// que rellenar todo desde cero. Valores mínimamente válidos.

/**
 * @param {string} type - Clave de INSTR
 * @returns {Object} Campos por defecto específicos del tipo
 */
function makeDefaultInstr(type) {
  switch (type) {
    case 'IF':
    case 'ELIF':         return { condition: { type: 'flag_is', flag: '', boolValue: true } }
    case 'LET':          return { varName: '', value: '' }
    case 'SET_FLAG':     return { flag: '', value: 'true' }
    case 'SET_ATTR':     return { target: 'char:', attr: 'hp', value: '0' }
    case 'ADD_ATTR':     return { target: 'char:', attr: 'hp', amount: '1' }
    case 'SET_CHAR_ROOM_POS': return { charId: '', x: 0, y: 0, direction: 'right', animName: '' }
    case 'MOVE_CHAR':    return { charId: '', x: 0, y: 0 }
    case 'WALK_CHAR':    return { charId: '', x: 0, y: 0, speed: 0 }
    case 'WALK_CHAR_TO_OBJ': return { charId: '', objectId: '', speed: 0 }
    case 'WALK_CHAR_DIRECT': return { charId: '', x: 0, y: 0, speed: 2 }
    case 'SET_ANIM':     return { charId: '', animName: '', loop: true, duration: 0 }
    case 'PLAY_ANIM':   return { charId: '', animName: '', loop: false, duration: 0 }
    case 'FACE_DIR':     return { charId: '', direction: 'front' }
    case 'SET_CHAR_VISIBLE':   return { charId: '', visible: true }
    case 'SET_OBJECT_VISIBLE': return { objectId: '', visible: true }
    case 'GIVE_OBJECT':   return { objectId: '', charId: '' }
    case 'REMOVE_OBJECT':    return { objectId: '', charId: '' }
    case 'SET_OBJECT_STATE': return { objectId: '', stateId: '', animLoop: null, waitAnim: false }
    case 'DROP_OBJECT':   return { objectId: '', roomId: '', x: 0, y: 0 }
    case 'CHANGE_ROOM':   return { roomId: '', entryId: 'entry_default' }
    case 'SET_EXIT_STATE': return { exitId: '', enabled: true }
    case 'WAIT':          return { seconds: 1 }
    default: return {}
  }
}
