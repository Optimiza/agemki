/**
 * @fileoverview sequenceStore — Gestión del módulo Secuencias
 *
 * Las secuencias son listas ordenadas de pasos que se ejecutan de forma
 * lineal y bloqueante. Se usan para cutscenes, intros, transiciones y
 * cualquier escena no interactiva (el jugador no puede interactuar durante).
 *
 * Diferencia clave con scripts:
 *   - Scripts: reaccionan a interacciones del jugador (verbo+objeto, flags...)
 *   - Secuencias: narrativas predefinidas, sin input del jugador
 *
 * Estructura en disco: sequences/seq_XXXXXXX.json
 *
 * Flujo típico:
 *   loadSequences(gameDir) → puebla sequences[]
 *   openSequence(gameDir, id) → carga activeSequence completo con steps[]
 *   addStep / updateStep / deleteStep / moveStep → modifica + dirty=true
 *   saveSequence(gameDir) → persiste + dirty=false
 *
 * @module sequenceStore
 */
import { create } from 'zustand' 

// ── Categorías de pasos ───────────────────────────────────────────────────────
//
// Cada categoría agrupa pasos relacionados en la paleta visual del editor.
// El color se usa en el encabezado de cada paso en la lista.

/** @type {Record<string, {label:string, color:string}>} */
export const STEP_CATS = {
  visual:  { label:'Visual',     color:'#6366f1' }, // Fundidos, fondos, imágenes, texto, diálogos
  char:    { label:'Personajes', color:'#3b82f6' }, // Mover, animar, orientar
  audio:   { label:'Audio',      color:'#f97316' }, // MIDI, SFX
  object:  { label:'Objetos',    color:'#f59e0b' }, // Inventario, estados, visibilidad
  logic:   { label:'Lógica',     color:'#8b5cf6' }, // Flags, atributos, scripts
  timing:  { label:'Tiempo',     color:'#10b981' }, // Wait, end
}

// ── Tipos de paso ─────────────────────────────────────────────────────────────
//
// Cada tipo tiene:
//   cat    → categoría (clave de STEP_CATS)
//   label  → texto en castellano para la paleta
//   fields → campos editables con su tipo de picker
//   note   → (opcional) aclaración sobre comportamiento de bloqueo

/** @type {Record<string, {cat:string, label:string, fields:Array<{k:string,t:string,ph?:string}>, note?:string}>} */
export const STEPS = {

  // ── Visual ─────────────────────────────────────────────────────────────────

  solid_color:    { cat:'visual', label:'Pantalla de color',     fields:[{k:'colorIdx',t:'pal_color'},{k:'duration',t:'number',ph:'segundos'}], hidden:true },
  fade_from_color:{ cat:'visual', label:'Fundido desde color',   fields:[{k:'colorIdx',t:'pal_color'},{k:'duration',t:'number',ph:'segundos'}], hidden:true },
  fade_to_color:  { cat:'visual', label:'Fundido a color',       fields:[{k:'colorIdx',t:'pal_color'},{k:'duration',t:'number',ph:'segundos'}], hidden:true },
  color_fade:     { cat:'visual', label:'Fundido de color',      fields:[
    {k:'fromColor', t:'pal_color_or_screen', ph:'origen (-1=pantalla actual)'},
    {k:'toColor',   t:'pal_color', ph:'color destino'},
    {k:'duration',  t:'number', ph:'segundos'},
  ]},
  load_bg:        { cat:'visual', label:'Cargar fondo',          fields:[{k:'bgFile',t:'asset',ph:'NOMBRE.PCX'}], hidden:true },
  show_pcx:       { cat:'visual', label:'Mostrar PCX pantalla completa', fields:[{k:'pcxFile',t:'asset',ph:'NOMBRE.PCX'},{k:'duration',t:'number',ph:'segundos'}], hidden:true },
  show_bg:        { cat:'visual', label:'Mostrar fondo',         fields:[
    {k:'bgFile',   t:'bg_asset', ph:'fondo PCX'},
    {k:'duration', t:'number',   ph:'segundos (0=continuar)'},
    {k:'showUi',   t:'bool',     ph:'Mostrar UI'},
  ]},
  load_room:      { cat:'visual', label:'Cargar room (obsoleto)',  fields:[{k:'roomId',t:'room'},{k:'entryId',t:'entry',ph:'entry_default'}], hidden:true },
  play_rooms:     { cat:'visual', label:'Play rooms (interactivo)', fields:[{k:'roomId',t:'room'},{k:'entryId',t:'entry',ph:'entry_default'},{k:'showUi',t:'bool',ph:'Mostrar UI'},{k:'flag',t:'text',ph:'flag de salida (opcional)'},{k:'value',t:'text',ph:'valor (vacío=true)'}], note:'Carga la room e inicia el modo interactivo. El flag es condición de salida.' },
  set_ui:         { cat:'visual', label:'Mostrar/ocultar UI',       fields:[{k:'visible',t:'bool',ph:'UI visible'}] },

  // ── Personajes ─────────────────────────────────────────────────────────────

  walk_char:        { cat:'char', label:'Desplazar personaje',   fields:[{k:'charId',t:'char'},{k:'x',t:'number'},{k:'y',t:'number'},{k:'speed',t:'number',ph:'0=vel.personaje'}] },
  teleport_char:    { cat:'char', label:'Teleportar personaje',  fields:[{k:'charId',t:'char'},{k:'x',t:'number'},{k:'y',t:'number'}] },
  set_anim:         { cat:'char', label:'Animar personaje',      fields:[{k:'charId',t:'char'},{k:'animName',t:'char_anim'},{k:'fps',t:'number',ph:'0=default'},{k:'loop',t:'bool'},{k:'duration',t:'number',ph:'segundos (0=una vez)'}] },
  face_dir:         { cat:'char', label:'Orientar personaje',    fields:[{k:'charId',t:'char'},{k:'dir',t:'dir'}] },
  set_char_visible: { cat:'char', label:'Visibilidad personaje', fields:[{k:'charId',t:'char'},{k:'visible',t:'bool'}] },
  parallel_block:   { cat:'char', label:'Bloque paralelo',       fields:[], note:'Los pasos dentro se ejecutan a la vez' },
  party_join:       { cat:'char', label:'Añadir personaje al grupo',      fields:[{k:'charId',t:'char'}] },
  party_leave:      { cat:'char', label:'Eliminar personaje del grupo',   fields:[{k:'charId',t:'char'}] },
  party_clear:      { cat:'char', label:'Vaciar grupo de personajes',     fields:[] },

  // ── Diálogo ────────────────────────────────────────────────────────────────

  start_dialogue: { cat:'visual', label:'Iniciar diálogo',             fields:[{k:'dialogueId',t:'dialogue'}], note:'Bloqueante' },
  show_text:      { cat:'visual', label:'Mostrar texto',               fields:[
    {k:'localeKey',        t:'seq_locale_text'},
    {k:'font',             t:'text',        ph:'small/medium/large'},
    {k:'color',            t:'pal_color'},
    {k:'bgColor',          t:'pal_color_opt'},
    {k:'position',         t:'text',        ph:'top/center/bottom'},
    {k:'align',            t:'text',        ph:'left/center/right'},
    {k:'effect',           t:'text',        ph:'none/fade/typewriter'},
    {k:'typewriterSpeed',  t:'number',      ph:'chars/seg'},
    {k:'duration',         t:'number',      ph:'segundos (0=hasta click)'},
  ]},
  scroll_text:    { cat:'visual', label:'Texto con scroll (cámara)',   fields:[
    {k:'localeKey', t:'seq_locale_text'},
    {k:'color',     t:'pal_color'},
    {k:'align',     t:'text',   ph:'left/center/right'},
    {k:'speed',     t:'number', ph:'pixels/seg'},
  ], hidden:true },

  move_text:      { cat:'visual', label:'Mover texto',  fields:[
    {k:'localeKey',  t:'seq_locale_text'},
    {k:'font',       t:'font_size'},
    {k:'color',      t:'pal_color'},
    {k:'x0',         t:'number', ph:'x origen'},
    {k:'y0',         t:'number', ph:'y origen'},
    {k:'x1',         t:'number', ph:'x destino'},
    {k:'y1',         t:'number', ph:'y destino'},
    {k:'speed',      t:'number', ph:'pixels/seg'},
    {k:'bgType',     t:'move_text_bg', ph:'fondo'},
    {k:'bgColor',    t:'pal_color'},
    {k:'bgPcx',      t:'bg_asset', ph:'fondo PCX'},
  ], note:'bgType: -1=pantalla, 0=color, 1=PCX' },

  // ── Audio ──────────────────────────────────────────────────────────────────

  play_midi:        { cat:'audio', label:'Reproducir MIDI',  fields:[{k:'midiId',t:'audio'}] },
  stop_midi:        { cat:'audio', label:'Parar MIDI',       fields:[] },
  pause_midi:       { cat:'audio', label:'Pausar MIDI',      fields:[] },
  resume_midi:      { cat:'audio', label:'Reanudar MIDI',    fields:[] },
  set_music_volume: { cat:'audio', label:'Volumen música',   fields:[{k:'volume',t:'number',ph:'0-127'},{k:'fade_ms',t:'number',ph:'0=instantáneo'}] },
  set_music_tempo:  { cat:'audio', label:'Tempo música',     fields:[{k:'percent',t:'number',ph:'100=normal'},{k:'fade_ms',t:'number',ph:'ms'}] },
  fade_music_out:   { cat:'audio', label:'Fade out música',  fields:[{k:'fade_ms',t:'number',ph:'ms'}] },
  play_sfx:         { cat:'audio', label:'Reproducir SFX',   fields:[{k:'sfxId',t:'audio'}] },
  stop_sfx:         { cat:'audio', label:'Parar SFX',        fields:[] },
  set_sfx_volume:   { cat:'audio', label:'Volumen SFX',      fields:[{k:'volume',t:'number',ph:'0-127'}] },

  // ── Objetos ────────────────────────────────────────────────────────────────

  pickup_object:        { cat:'object', label:'Coger objeto',              fields:[{k:'objectId',t:'object'},{k:'charId',t:'char',ph:'vacío=protagonista'}] },
  give_object:          { cat:'object', label:'Dar objeto (personaje→personaje)', fields:[{k:'objectId',t:'object'},{k:'fromCharId',t:'char',ph:'origen'},{k:'toCharId',t:'char',ph:'destino'}] },
  remove_from_inventory:{ cat:'object', label:'Quitar del inventario',     fields:[{k:'objectId',t:'object'},{k:'charId',t:'char',ph:'vacío=protagonista'}] },
  drop_object:          { cat:'object', label:'Soltar objeto en sala',     fields:[{k:'objectId',t:'object'},{k:'roomId',t:'room'},{k:'x',t:'number'},{k:'y',t:'number'}] },
  move_object:          { cat:'object', label:'Mover objeto',              fields:[{k:'objectId',t:'object'},{k:'x',t:'number'},{k:'y',t:'number'}] },
  set_object_state:     { cat:'object', label:'Cambiar estado objeto',     fields:[{k:'objectId',t:'object'},{k:'stateId',t:'text',ph:'id del estado'}] },
  set_object_anim_loop: { cat:'object', label:'Loop animación objeto',     fields:[{k:'objectId',t:'object'},{k:'loop',t:'bool'}], note:'Infinito=sí, Una vez=no' },
  wait_object_anim:     { cat:'object', label:'Esperar animación objeto',  fields:[{k:'objectId',t:'object'}], note:'Bloqueante hasta que acabe la animación (solo one-shot)' },
  activate_object_flag: { cat:'object', label:'Activar flag objeto', hidden:true, fields:[{k:'objectId',t:'object'},{k:'flag',t:'text',ph:'nombre_flag'},{k:'value',t:'text',ph:'true'}] },

  // ── Lógica ─────────────────────────────────────────────────────────────────

  set_flag:      { cat:'logic', label:'Establecer flag',    fields:[{k:'flag',t:'text',ph:'nombre_flag'},{k:'value',t:'text',ph:'true/false/valor'}] },
  set_attr:      { cat:'logic', label:'Cambiar atributo',   fields:[
    {k:'target', t:'char', ph:'personaje'},
    {k:'attr',   t:'attr_id', ph:'atributo'},
    {k:'mode',   t:'attr_mode', ph:'modo'},
    {k:'value',  t:'number', ph:'valor'},
  ] },
  call_script:   { cat:'logic', label:'Ejecutar script',    fields:[{k:'scriptId',t:'script'}], note:'No bloqueante' },
  call_sequence: { cat:'logic', label:'Llamar secuencia',   fields:[{k:'sequenceId',t:'sequence'}], note:'Bloqueante' },

  // ── Tiempo ─────────────────────────────────────────────────────────────────

  wait:         { cat:'timing', label:'Esperar (segundos)', fields:[{k:'seconds',t:'number',ph:'segundos'}] },
  end_sequence: { cat:'timing', label:'Fin de secuencia',   fields:[] },

  // ── Protección ─────────────────────────────────────────────────────────────

  protection_screen: { cat:'logic', label:'Pantalla de protección', note:'Bloqueante — acierto para continuar', fields:[
    { k:'question',   t:'text',              ph:'Texto de la pregunta' },
    { k:'answer',     t:'text',              ph:'Respuesta correcta (se compila como CRC32)' },
    { k:'inputMode',  t:'prot_input_mode' },
    { k:'imgMode',    t:'prot_img_mode' },
    { k:'pcxA',       t:'bg_asset',          ph:'PCX principal / superior' },
    { k:'pcxB',       t:'bg_asset',          ph:'PCX inferior / derecho' },
    { k:'bgMode',     t:'prot_bg_mode' },
    { k:'bgColor',    t:'pal_color' },
    { k:'pcxBg',      t:'bg_asset',          ph:'PCX de fondo 320×200' },
    { k:'failAction', t:'prot_fail_action' },
    { k:'maxTries',   t:'number',            ph:'Intentos (0=infinito)' },
  ]},
}

// ── Valores por defecto al insertar un paso nuevo ─────────────────────────────
//
// Proporciona valores mínimamente válidos para que el creador
// no tenga que rellenar todo desde cero al añadir un paso.

/**
 * @param {string} type - Clave de STEPS
 * @returns {Object} Campos por defecto del paso
 */
function makeDefaultStep(type) {
  switch (type) {
    case 'solid_color':          return { colorIdx: 0, duration: 2.0 }
    case 'fade_from_color':      return { colorIdx: 0, duration: 1.0 }
    case 'fade_to_color':        return { colorIdx: 0, duration: 1.0 }
    case 'color_fade':           return { fromColor: -1, toColor: 0, duration: 1.0 }
    case 'load_bg':              return { bgFile: '' }
    case 'show_pcx':             return { pcxFile: '', duration: 3.0 }
    case 'show_bg':              return { bgFile: '', duration: 0, showUi: false }
    case 'load_room':            return { roomId: '', entryId: 'entry_default' }
    case 'play_rooms':           return { roomId: '', entryId: 'entry_default', showUi: true, flag: '', value: 'true' }
    case 'set_ui':               return { visible: true }
    case 'walk_char':            return { charId: '', x: 0, y: 0, speed: 0 }
    case 'teleport_char':        return { charId: '', x: 0, y: 0 }
    case 'set_anim':             return { charId: '', animName: 'idle', fps: 0, loop: false, duration: 0 }
    case 'face_dir':             return { charId: '', dir: 'front' }
    case 'set_char_visible':     return { charId: '', visible: true }
    case 'parallel_block':       return { steps: [] }
    case 'party_join':           return { charId: '' }
    case 'party_leave':          return { charId: '' }
    case 'party_clear':          return {}
    case 'start_dialogue':       return { dialogueId: '' }
    case 'show_text':            return { localeKey:'', font:'medium', color:15, bgColor:'', position:'bottom', align:'center', effect:'none', typewriterSpeed:20, duration:3.0 }
    case 'scroll_text':          return { localeKey:'', color:14, align:'center', speed:40 }
    case 'move_text':            return { localeKey:'', font:'small', color:15, x0:0, y0:200, x1:0, y1:0, speed:60, bgType:0, bgColor:0, bgPcx:'' }
    case 'play_midi':            return { midiId: '' }
    case 'stop_midi':            return {}
    case 'pause_midi':           return {}
    case 'resume_midi':          return {}
    case 'set_music_volume':     return { volume: 100, fade_ms: 0 }
    case 'set_music_tempo':      return { percent: 100, fade_ms: 0 }
    case 'fade_music_out':       return { fade_ms: 2000 }
    case 'play_sfx':             return { sfxId: '' }
    case 'stop_sfx':             return {}
    case 'set_sfx_volume':       return { volume: 100 }
    case 'pickup_object':        return { objectId: '', charId: '' }
    case 'give_object':          return { objectId: '', fromCharId: '', toCharId: '' }
    case 'remove_from_inventory':return { objectId: '', charId: '' }
    case 'drop_object':          return { objectId: '', roomId: '', x: 0, y: 0 }
    case 'move_object':          return { objectId: '', x: 0, y: 0 }
    case 'set_object_state':     return { objectId: '', stateId: '' }
    case 'set_object_anim_loop': return { objectId: '', loop: true }
    case 'wait_object_anim':     return { objectId: '' }
    case 'activate_object_flag': return { objectId: '', flag: '', value: 'true' }
    case 'set_flag':             return { flag: '', value: 'true' }
    case 'set_attr':             return { target: '', attr: '', mode: 'set', value: 0 }
    case 'call_script':          return { scriptId: '' }
    case 'call_sequence':        return { sequenceId: '' }
    case 'wait':                 return { seconds: 1.0 }
    case 'end_sequence':         return {}
    case 'protection_screen':    return {
      question: '', answer: '',
      inputMode: 'text', imgMode: 'none',
      pcxA: '', pcxB: '',
      bgMode: 'black', bgColor: 0, pcxBg: '',
      failAction: 'same', maxTries: 3,
    }
    default:                     return {}
  }
}
// ── Store ─────────────────────────────────────────────────────────────────────

export const useSequenceStore = create((set, get) => ({

  /** @type {Array<{id:string, name:string}>} Lista resumen (sin steps completos) */
  sequences: [],

  /** @type {Object|null} Secuencia completa con steps[] — la que está abierta en el editor */
  activeSequence: null,

  /** @type {boolean} true si activeSequence tiene cambios no guardados */
  dirty: false,

  /** @type {boolean} true si sequences[] ya fue cargado desde disco al menos una vez */
  loaded: false,

  // ── CRUD de secuencias ──────────────────────────────────────────────────────

  /**
   * Carga la lista resumen de secuencias desde disco.
   * @param {string} gameDir
   */
  loadSequences: async (gameDir) => {
    const r = await window.api.listSequences(gameDir)
    if (r.ok) set({ sequences: r.sequences, loaded: true })
  },

  /**
   * Crea una secuencia nueva en disco con un paso end_sequence por defecto.
   * @param {string} gameDir
   * @param {string} name
   * @returns {Object|null}
   */
  createSequence: async (gameDir, name) => {
    const r = await window.api.createSequence(gameDir, name)
    if (r.ok) { await get().loadSequences(gameDir); return r.sequence }
    return null
  },

  /**
   * Elimina una secuencia del disco.
   * Si era la activeSequence, la cierra.
   * @param {string} gameDir
   * @param {string} id
   */
  deleteSequence: async (gameDir, id) => {
    await window.api.deleteSequence(gameDir, id)
    await get().loadSequences(gameDir)
    if (get().activeSequence?.id === id) set({ activeSequence: null })
  },

  /**
   * @param {string} gameDir
   * @param {string} id
   */
  duplicateSequence: async (gameDir, id) => {
    await window.api.duplicateSequence(gameDir, id)
    await get().loadSequences(gameDir)
  },

  /**
   * Lee la secuencia completa (con steps[]) y la establece como activeSequence.
   * @param {string} gameDir
   * @param {string} id
   */
  openSequence: async (gameDir, id) => {
    const r = await window.api.readSequence(gameDir, id)
    if (r.ok) set({ activeSequence: r.sequence, dirty: false })
  },

  /** Cierra el editor sin guardar. */
  closeSequence: () => set({ activeSequence: null, dirty: false }),

  /**
   * Persiste activeSequence en disco y resetea dirty.
   * @param {string} gameDir
   */
  saveSequence: async (gameDir) => {
    const s = get().activeSequence
    if (!s) return
    await window.api.saveSequence(gameDir, s)
    set({ dirty: false })
    // Actualizar el resumen en la lista sin recargar todo
    set(st => ({ sequences: st.sequences.map(x => x.id === s.id ? { id: s.id, name: s.name } : x) }))
  },

  /**
   * Actualiza campos de cabecera de la secuencia (ej: name).
   * @param {Partial<Object>} partial
   */
  updateMeta: (partial) => set(s => ({
    activeSequence: s.activeSequence ? { ...s.activeSequence, ...partial } : null,
    dirty: true,
  })),

  // ── CRUD de pasos ───────────────────────────────────────────────────────────

  /**
   * Inserta un paso nuevo en la lista.
   * @param {string} type - Clave de STEPS
   * @param {number|null} afterIndex - null = añadir al final; número = insertar después de esa posición
   */
  addStep: (type, afterIndex = null) => set(s => {
    if (!s.activeSequence) return {}
    const step = { id: `s_${Date.now()}`, type, ...makeDefaultStep(type) }
    const list = [...s.activeSequence.steps]
    const idx = afterIndex === null ? list.length : afterIndex + 1
    list.splice(idx, 0, step)
    return { activeSequence: { ...s.activeSequence, steps: list }, dirty: true }
  }),

  /**
   * Duplica un paso existente insertando la copia justo después.
   * El clon recibe un id nuevo para no colisionar con el original.
   * @param {string} stepId
   */
  duplicateStep: (stepId) => set(s => {
    if (!s.activeSequence) return {}
    const list  = [...s.activeSequence.steps]
    const srcIdx = list.findIndex(i => i.id === stepId)
    if (srcIdx < 0) return {}
    const clone = { ...list[srcIdx], id: `s_${Date.now()}` }
    list.splice(srcIdx + 1, 0, clone)
    return { activeSequence: { ...s.activeSequence, steps: list }, dirty: true }
  }),

  /**
   * Actualiza campos de un paso por su id.
   * @param {string} id
   * @param {Partial<Object>} partial
   */
  updateStep: (id, partial) => set(s => {
    if (!s.activeSequence) return {}
    return {
      activeSequence: {
        ...s.activeSequence,
        steps: s.activeSequence.steps.map(i => i.id === id ? { ...i, ...partial } : i),
      },
      dirty: true,
    }
  }),

  /**
   * Elimina un paso por su id.
   * @param {string} id
   */
  deleteStep: (id) => set(s => {
    if (!s.activeSequence) return {}
    return {
      activeSequence: { ...s.activeSequence, steps: s.activeSequence.steps.filter(i => i.id !== id) },
      dirty: true,
    }
  }),

  /**
   * Mueve un paso hacia arriba (dir=-1) o hacia abajo (dir=+1).
   * No hace nada si el paso ya está en el límite.
   * @param {string} id
   * @param {-1|1} dir
   */
  moveStep: (id, dir) => set(s => {
    if (!s.activeSequence) return {}
    const list = [...s.activeSequence.steps]
    const idx = list.findIndex(i => i.id === id)
    const next = idx + dir
    if (next < 0 || next >= list.length) return {}
    ;[list[idx], list[next]] = [list[next], list[idx]]
    return { activeSequence: { ...s.activeSequence, steps: list }, dirty: true }
  }),
}))
