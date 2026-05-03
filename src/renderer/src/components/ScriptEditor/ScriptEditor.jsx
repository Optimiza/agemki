/**
 * @fileoverview ScriptEditor — Editor del módulo Scripts
 *
 * Permite crear y editar scripts: la lógica de respuesta a interacciones
 * del jugador en el juego. Cada script tiene un disparador (trigger) y
 * una lista de instrucciones que se ejecutan en orden.
 *
 * ARQUITECTURA (5 componentes):
 *
 *   ScriptLibrary
 *     Lista de scripts agrupados por tipo de disparador.
 *     CRUD: crear, duplicar, eliminar. Doble clic → abre editor.
 *
 *   ScriptEditorView
 *     Vista de edición de un script concreto. Contiene:
 *       - TriggerEditor: configura el disparador del script.
 *       - InstrPalette: paleta de instrucciones agrupadas por categoría.
 *       - Lista de InstrRow: instrucciones reordenables con ▲▼.
 *
 *   TriggerEditor
 *     Selector de tipo de disparador + campos contextuales (verbId+objectId,
 *     roomId, flag+operador+valor, etc. según el tipo elegido).
 *
 *   InstrRow
 *     Una instrucción en la lista. Muestra su categoría con color, sus campos
 *     editables con pickers contextuales, y controles ▲▼ + eliminar + añadir.
 *
 *   FieldPicker
 *     Renderiza el widget de edición correcto según el tipo de campo:
 *     char, room, object, dialogue, script, audio, char_anim, bool, dir, number, text...
 *
 * DATOS — cache de módulo:
 *   useGameData() carga rooms, objetos, verbsets, audios y scripts via IPC.
 *   Los datos se cachean en _gameDataCache a nivel de módulo para no relanzar
 *   llamadas IPC al remontar el componente (ej: al volver de otro módulo).
 *   El cache se invalida cuando cambia gameDir.
 *
 * DIRTY STATE:
 *   scriptStore.dirty = true mientras haya cambios sin guardar.
 *   EditorLayout intercepta el cambio de módulo y pregunta si guardar.
 *   El botón Guardar del toolbar solo está activo cuando dirty=true.
 *
 * @module ScriptEditor
 */
import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../../store/appStore'
import { useScriptStore, TRIGGERS, INSTR, INSTR_CATS, COND_TYPES } from '../../store/scriptStore'
import { useCharStore } from '../../store/charStore'
import { useLocaleStore } from '../../store/localeStore'
import { useDialogueStore } from '../../store/dialogueStore'
import './ScriptEditor.css'

// ── Cache de datos del juego (para los pickers de campos) ────────────────────
//
// Los pickers de instrucción (selects de room, personaje, objeto, audio...)
// necesitan listas de elementos del proyecto. Estas listas se cargan via IPC
// una sola vez por sesión y se cachean aquí a nivel de módulo.
//
// Por qué a nivel de módulo y no dentro del componente:
//   - Los componentes React se remontan al cambiar de módulo.
//   - Si el cache estuviera en useState, se perdería al remontar.
//   - Al nivel de módulo JS el cache sobrevive toda la sesión.
//   - Se invalida cuando cambia gameDir (juego diferente abierto).
/** @type {{gameDir:string|null, rooms:Array, objects:Array, verbsets:Array, audios:Array, scripts:Array}} */
const _gameDataCache = { gameDir: null, rooms: [], objects: [], verbsets: [], audios: [], scripts: [] }

/**
 * Hook que proporciona todos los datos del proyecto necesarios para los pickers
 * de campos de instrucción (rooms, objetos, personajes, verbsets, audios, scripts).
 *
 * Carga datos via IPC solo la primera vez para el gameDir actual.
 * Las llamadas a los stores de Zustand (chars, dialogues, locales) son reactivas —
 * se actualizan automáticamente cuando esos stores cambian.
 *
 * @param {string} gameDir
 * @returns {{chars, rooms, objects, verbsets, audios, scripts, dialogues, locales, activeLang, charName:(id:string)=>string}}
 */
function useGameData(gameDir) {
  const chars      = useCharStore(s => s.chars)
  const dialogues  = useDialogueStore(s => s.dialogues)
  const locales    = useLocaleStore(s => s.locales)
  const activeLang = useLocaleStore(s => s.activeLang)
  const [rooms, setRooms]       = useState(_gameDataCache.rooms)
  const [objects, setObjects]   = useState(_gameDataCache.objects)
  const [verbsets, setVerbsets] = useState(_gameDataCache.verbsets)
  const [audios, setAudios]     = useState(_gameDataCache.audios)
  const [scripts, setScripts]   = useState(_gameDataCache.scripts)

  useEffect(() => {
    if (!gameDir || _gameDataCache.gameDir === gameDir) return
    _gameDataCache.gameDir = gameDir
    useCharStore.getState().loadChars(gameDir)
    useDialogueStore.getState().loadDialogues(gameDir)
    useLocaleStore.getState().loadAll(gameDir)
    window.api.listRooms(gameDir).then(r => {
      const v = r.ok ? (r.rooms || []) : []
      _gameDataCache.rooms = v; setRooms(v)
    })
    window.api.listObjects(gameDir).then(r => {
      const v = r.ok ? (r.objects || []) : []
      _gameDataCache.objects = v; setObjects(v)
    })
    window.api.listVerbsets(gameDir).then(r => {
      const v = r.ok ? (r.verbsets || []) : []
      _gameDataCache.verbsets = v; setVerbsets(v)
    })
    Promise.all([
      window.api.listAudioFiles(gameDir, 'music'),  // AudioManager importa MIDI en 'music'
      window.api.listAudioFiles(gameDir, 'sfx'),
    ]).then(([midi, sfx]) => {
      const getName = f => f.name || f   // la API devuelve objetos {name, path, size}
      const midis = (midi.ok ? midi.files || [] : []).map(f => `midi:${getName(f)}`)
      const sfxs  = (sfx.ok  ? sfx.files  || [] : []).map(f => `sfx:${getName(f)}`)
      const v = [...midis, ...sfxs]
      _gameDataCache.audios = v; setAudios(v)
    })
    window.api.listScripts(gameDir).then(r => {
      const v = r.ok ? (r.scripts || []) : []
      _gameDataCache.scripts = v; setScripts(v)
    })
  }, [gameDir])

  function charName(id) {
    if (!id) return ''
    const c = chars.find(x => x.id === id)
    return (locales[activeLang] || {})[`char.${id}.name`] || c?.name || id
  }

  const activeScriptId = useScriptStore ? useScriptStore(s => s.activeScript?.id) : ''
  const { activeGame } = useAppStore()
  return { chars, rooms, objects, verbsets, audios, scripts, dialogues, charName,
           locales, activeLang, langs: useLocaleStore.getState().langs || ['es'],
           activeScriptId, activeGame,
           gameDir: activeGame?.gameDir || gameDir }
}

// ── Pickers de campos de instrucción ─────────────────────────────────────────
//
// FieldPicker renderiza el widget de edición adecuado según el tipo de campo
// (campo 't' en la definición de la instrucción en scriptStore).
//
// Tipos soportados:
//   'char'      → <select> con personajes del proyecto
//   'room'      → <select> con rooms del proyecto
//   'object'    → <select> con objetos del proyecto
//   'dialogue'  → <select> con diálogos del proyecto
//   'script'    → <select> con scripts del proyecto (excepto el activo)
//   'verbset'   → <select> con verbsets del proyecto
//   'audio'     → <select> con ficheros midi:* y sfx:*
//   'char_anim' → <select> con animaciones del personaje seleccionado en la misma instrucción
//   'obj_state' → <select> con estados del objeto seleccionado en la misma instrucción
//   'exit'      → <select> con todas las salidas de todas las rooms
//   'target'    → <input> con placeholder "char:id / obj:id"
//   'bool'      → <select> sí/no
//   'dir'       → <select> front/back/left/right
//   'number'    → <input type="number">
//   'condition' → delega en ConditionEditor (inline)
//   'text'      → <input type="text"> genérico

/**
 * @param {Object} props
 * @param {{k:string, t:string, ph?:string}} props.fieldDef - Definición del campo de la instrucción
 * @param {*} props.value - Valor actual del campo
 * @param {Function} props.onChange - Callback(newValue) cuando cambia el valor
 * @param {Object} props.data - Datos del proyecto (del hook useGameData)
 * @param {Object} [props.instr={}] - Instrucción completa (para char_anim que necesita charId)
 */
function FieldPicker({ fieldDef, value, onChange, data, instr = {}, scriptId = '' }) {
  const { k, t, ph } = fieldDef
  const { chars, rooms, objects, verbsets, audios, scripts, dialogues, charName,
          locales, activeLang, langs } = data
  const setLocaleKey = useLocaleStore(s => s.setKey)
  const saveLocale   = useLocaleStore(s => s.saveAll)

  switch (t) {
    case 'char':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— personaje —</option>
          <option value="@">@ protagonista activo</option>
          {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
        </select>
      )
    case 'room':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— room —</option>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
        </select>
      )
    case 'object':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— objeto —</option>
          {objects.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
        </select>
      )
    case 'verbset':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— verbset —</option>
          {verbsets.map(v => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
        </select>
      )
    case 'dialogue':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— diálogo —</option>
          {dialogues.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )
    case 'script':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— script —</option>
          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )
    case 'audio':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— audio —</option>
          {audios.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      )
    case 'bool':
      return (
        <select value={String(value ?? true)} onChange={e => onChange(e.target.value === 'true')}>
          <option value="true">visible / activo</option>
          <option value="false">oculto / inactivo</option>
        </select>
      )
    case 'char_anim': {
      const charId = instr.charId || ''
      const char   = chars.find(c => c.id === charId)
      const anims  = char?.animations || []
      const MOTOR_ROLES = [
        { id: 'idle',       label: 'idle' },
        { id: 'walk_right', label: 'walk_right' },
        { id: 'walk_left',  label: 'walk_left' },
        { id: 'walk_up',    label: 'walk_up' },
        { id: 'walk_down',  label: 'walk_down' },
        { id: 'idle_up',    label: 'idle_up' },
        { id: 'idle_down',  label: 'idle_down' },
      ]
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— sin cambio —</option>
          {!charId && <option disabled>— selecciona un personaje primero —</option>}
          {anims.length > 0 && (
            <optgroup label="Animaciones del personaje">
              {anims.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </optgroup>
          )}
          <optgroup label="Roles del motor">
            {MOTOR_ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </optgroup>
        </select>
      )
    }
    case 'dir':
      return (
        <select value={value || 'front'} onChange={e => onChange(e.target.value)}>
          {['front','back','left','right'].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      )
    case 'target':
      return (
        <div className="scr-target-field">
          <select value={(value || '').split(':')[0] || 'char'}
            onChange={e => onChange(e.target.value + ':' + (value || '').split(':')[1] || '')}>
            <option value="char">personaje</option>
            <option value="obj">objeto</option>
            <option value="game">juego</option>
          </select>
          {(value || '').startsWith('char:') && (
            <select value={(value || '').split(':')[1] || ''}
              onChange={e => onChange('char:' + e.target.value)}>
              <option value="">— personaje —</option>
              {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
            </select>
          )}
          {(value || '').startsWith('obj:') && (
            <select value={(value || '').split(':')[1] || ''}
              onChange={e => onChange('obj:' + e.target.value)}>
              <option value="">— objeto —</option>
              {objects.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
            </select>
          )}
        </div>
      )
    case 'checkbox':
      return (
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
      )
    case 'obj_state': {
      // Dropdown con los estados del objeto seleccionado en la misma instrucción
      const selObj = objects.find(o => o.id === (instr.objectId || ''))
      const states  = selObj?.states || []
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— estado —</option>
          {!instr.objectId && <option disabled>— selecciona un objeto primero —</option>}
          {states.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
        </select>
      )
    }
    case 'exit': {
      // Dropdown con todas las salidas de todas las rooms
      const allExits = rooms.flatMap(r => (r.exits || []).map(ex => ({
        ...ex, roomName: r.name || r.id, roomId: r.id
      })))
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— salida —</option>
          {allExits.map(ex => (
            <option key={ex.id} value={ex.id}>{ex.name || ex.id} ({ex.roomName})</option>
          ))}
        </select>
      )
    }
    case 'loop_tri':
      return (
        <select value={value ?? ''} onChange={e => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
          <option value="">sin cambio</option>
          <option value="true">infinito</option>
          <option value="false">una vez</option>
        </select>
      )
    case 'number':
      return <input type="number" value={value ?? 0} onChange={e => onChange(Number(e.target.value))} style={{ width: 64 }} />
    case 'condition':
      return <ConditionEditor value={value} onChange={onChange} data={data} />
    case 'locale_text': {
      // Genera clave automática a partir de scriptId+instrId y muestra inputs por idioma
      const autoKey = scriptId && instr.id ? `${scriptId}_${instr.id}` : (value || '')
      // Si no hay clave guardada, guardarla automáticamente
      if (!value && autoKey) { setTimeout(() => onChange(autoKey), 0) }
      const key = value || autoKey
      return (
        <div className="scr-locale-text">
          {(langs || ['es']).map(lang => (
            <div key={lang} className="scr-locale-row">
              <span className="lang-badge">{lang.toUpperCase()}</span>
              <input type="text"
                value={(locales[lang] || {})[key] || ''}
                onChange={e => { setLocaleKey(lang, key, e.target.value); saveLocale(data.activeGame?.gameDir) }}
                placeholder={`Texto en ${lang}…`} />
            </div>
          ))}
        </div>
      )
    }
    default:
      return <input type="text" value={value || ''} placeholder={ph || k} onChange={e => onChange(e.target.value)} />
  }
}

// ── Editor de condiciones (para instrucciones IF/ELIF) ────────────────────────
//
// Una condición tiene la forma: { type: 'flag_is', flag: 'puerta_abierta', boolValue: true }
// El tipo determina qué campos adicionales se muestran (flag, value, attr, charId, roomId...).
// Ver COND_TYPES en scriptStore para la lista completa.
//
// La condición puede tener un campo 'logic': 'and'|'or'|'not' para combinar
// con la condición anterior en una cadena IF/ELIF.

/**
 * @param {Object} props
 * @param {Object} props.value    - Objeto condición { type, flag?, value?, attr?, charId?, ... }
 * @param {Function} props.onChange - Callback(newCondition)
 * @param {Object} props.data     - Datos del proyecto (chars, rooms, objects, charName)
 */
function ConditionEditor({ value, onChange, data }) {
  const cond = value || { type: 'flag_is', flag: '', boolValue: true }
  const def  = COND_TYPES[cond.type] || {}
  const { chars, rooms, objects, charName } = data

  function up(partial) { onChange({ ...cond, ...partial }) }

  return (
    <div className="scr-condition">
      <select value={cond.type} onChange={e => onChange({ type: e.target.value })}>
        {Object.entries(COND_TYPES).map(([k, v]) =>
          <option key={k} value={k}>{v.label}</option>
        )}
      </select>

      {def.fields?.includes('flag') && (
        <input type="text" placeholder="nombre_flag" value={cond.flag || ''}
          onChange={e => up({ flag: e.target.value })} />
      )}
      {def.fields?.includes('boolValue') && (
        <select value={String(cond.boolValue ?? true)} onChange={e => up({ boolValue: e.target.value === 'true' })}>
          <option value="true">verdadero</option>
          <option value="false">falso</option>
        </select>
      )}
      {def.fields?.includes('value') && !def.fields?.includes('boolValue') && (
        <input type="text" placeholder="valor" value={cond.value || ''}
          onChange={e => up({ value: e.target.value })} style={{ width: 72 }} />
      )}
      {def.fields?.includes('target') && (
        <input type="text" placeholder="char:id / obj:id" value={cond.target || ''}
          onChange={e => up({ target: e.target.value })} />
      )}
      {def.fields?.includes('attr') && (
        <input type="text" placeholder="hp/mp/xp/..." value={cond.attr || ''}
          onChange={e => up({ attr: e.target.value })} style={{ width: 72 }} />
      )}
      {def.fields?.includes('charId') && (
        <select value={cond.charId || ''} onChange={e => up({ charId: e.target.value })}>
          <option value="">— personaje —</option>
          {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
        </select>
      )}
      {def.fields?.includes('objectId') && (
        <select value={cond.objectId || ''} onChange={e => up({ objectId: e.target.value })}>
          <option value="">— objeto —</option>
          {objects.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
        </select>
      )}
      {def.fields?.includes('roomId') && (
        <select value={cond.roomId || ''} onChange={e => up({ roomId: e.target.value })}>
          <option value="">— room —</option>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
        </select>
      )}
      {def.fields?.includes('varName') && (
        <input type="text" placeholder="nombre_variable" value={cond.varName || ''}
          onChange={e => up({ varName: e.target.value })} />
      )}
    </div>
  )
}

// ── Editor de disparador ──────────────────────────────────────────────────────
//
// El disparador define QUÉ evento activa el script. Al cambiar el tipo,
// los campos adicionales cambian según lo definido en TRIGGERS[type].fields.
// Al cambiar el tipo se resetean los campos del trigger para evitar campos
// huérfanos de un tipo anterior.

/**
 * @param {Object} props
 * @param {{type:string, [field:string]:any}} props.trigger - Objeto disparador actual
 * @param {Function} props.onChange - Callback(newTrigger)
 * @param {Object} props.data - Datos del proyecto
 */
function TriggerEditor({ trigger, onChange, data }) {
  const { chars, rooms, objects, verbsets, dialogues, audios, scripts, charName,
          locales, activeLang } = data
  const tdef = TRIGGERS[trigger.type] || { fields: [] }

  function up(partial) { onChange({ ...trigger, ...partial }) }

  return (
    <div className="scr-trigger">
      <label>Disparador
        <select value={TRIGGERS[trigger.type] ? trigger.type : (Object.keys(TRIGGERS)[0] || '')} onChange={e => onChange({ type: e.target.value })}>
          {Object.entries(TRIGGERS).map(([k, v]) =>
            <option key={k} value={k}>{v.icon} {v.label}</option>
          )}
        </select>
      </label>

      {tdef.fields.includes('verbId') && (() => {
        const loc = locales[activeLang] || {}
        const activeVsId = data.activeGame?.game?.activeVerbSet
        const activeVs = verbsets.find(vs => vs.id === activeVsId) || verbsets[0]
        const vsVerbs = (activeVs?.verbs || []).map(v => ({
          id: v.id,
          label: loc['verb.' + v.id] || v.label || v.id
        }))
        return (
          <label>Verbo
            <select value={trigger.verbId || ''} onChange={e => up({ verbId: e.target.value })}>
              <option value="">— cualquier verbo —</option>
              {vsVerbs.map(v => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </label>
        )
      })()}
      {tdef.fields.includes('objectId') && (
        <label>Objeto
          <select value={trigger.objectId || ''} onChange={e => up({ objectId: e.target.value })}>
            <option value="">— cualquier objeto —</option>
            {objects.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
          </select>
        </label>
      )}
      {tdef.fields.includes('charId') && (
        <label>Personaje
          <select value={trigger.charId || ''} onChange={e => up({ charId: e.target.value })}>
            <option value="">— cualquier personaje —</option>
            {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
          </select>
        </label>
      )}
      {tdef.fields.includes('roomId') && (
        <label>Room
          <select value={trigger.roomId || ''} onChange={e => up({ roomId: e.target.value, entryId: '' })}>
            <option value="">— cualquier room —</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
          </select>
        </label>
      )}
      {tdef.fields.includes('entryId') && (() => {
        const selectedRoom = rooms.find(r => r.id === trigger.roomId)
        const entries = selectedRoom?.entries || []
        return (
          <label>Entrada
            <select value={trigger.entryId || ''} onChange={e => up({ entryId: e.target.value })}>
              <option value="">— selecciona room primero —</option>
              {entries.map(ep => <option key={ep.id} value={ep.id}>{ep.name || ep.id}</option>)}
            </select>
          </label>
        )
      })()}
      {tdef.fields.includes('dialogueId') && (
        <label>Diálogo
          <select value={trigger.dialogueId || ''} onChange={e => up({ dialogueId: e.target.value })}>
            <option value="">— diálogo —</option>
            {dialogues.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      {tdef.fields.includes('nodeId') && (
        <label>Nodo ID
          <input type="text" placeholder="node_xxx" value={trigger.nodeId || ''}
            onChange={e => up({ nodeId: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('choiceIndex') && (
        <label>Índice opción
          <input type="number" min={0} value={trigger.choiceIndex ?? 0}
            onChange={e => up({ choiceIndex: Number(e.target.value) })} style={{ width: 60 }} />
        </label>
      )}
      {tdef.fields.includes('flag') && (
        <label>Flag
          <input type="text" placeholder="nombre_flag" value={trigger.flag || ''}
            onChange={e => up({ flag: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('operator') && (
        <label>Operador
          <select value={trigger.operator || 'is_true'} onChange={e => up({ operator: e.target.value })}>
            <option value="is_true">es verdadero</option>
            <option value="is_false">es falso</option>
            <option value="eq">== valor</option>
            <option value="gt">&gt; valor</option>
            <option value="lt">&lt; valor</option>
          </select>
        </label>
      )}
      {tdef.fields.includes('value') && (
        <label>Valor
          <input type="text" value={trigger.value || ''} onChange={e => up({ value: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('target') && (
        <label>Target (char:id / obj:id)
          <input type="text" placeholder="char:id" value={trigger.target || ''}
            onChange={e => up({ target: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('attrName') && (
        <label>Atributo
          <input type="text" placeholder="hp/mp/xp/..." value={trigger.attrName || ''}
            onChange={e => up({ attrName: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('seconds') && (
        <label>Segundos
          <input type="number" min={0.1} step={0.5} value={trigger.seconds || 5}
            onChange={e => up({ seconds: Number(e.target.value) })} style={{ width: 70 }} />
        </label>
      )}
      {tdef.fields.includes('sequenceId') && (
        <label>Secuencia ID
          <input type="text" placeholder="seq_xxx" value={trigger.sequenceId || ''}
            onChange={e => up({ sequenceId: e.target.value })} />
        </label>
      )}
      {tdef.fields.includes('targetId') && (
        <label>Con... (obj/personaje, vacío = cualquiera)
          <select value={trigger.targetId || ''} onChange={e => up({ targetId: e.target.value })}>
            <option value="">— cualquier objetivo —</option>
            <optgroup label="Objetos">
              {objects.map(o => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
            </optgroup>
            <optgroup label="Personajes">
              {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
            </optgroup>
          </select>
        </label>
      )}
    </div>
  )
}

// ── Fila de instrucción ───────────────────────────────────────────────────────
//
// Renderiza una instrucción en la lista del script. Tiene dos estados:
//   - Colapsado: muestra solo el encabezado (categoría + tipo + nota)
//   - Expandido: muestra además los campos editables
//
// Las instrucciones de flujo (IF/ELIF/ELSE/END_IF) tienen estilo especial
// (borde izquierdo más grueso) para indicar su rol de bloque.
//
// El botón ＋ debajo de cada fila fija el "afterIndex" para la paleta: el
// siguiente paso que se añada desde la paleta se insertará después de esa posición.

/**
 * @param {Object} props
 * @param {{id:string, type:string, [field:string]:any}} props.instr
 * @param {number} props.idx        - Posición en la lista (0-based)
 * @param {number} props.total      - Total de instrucciones
 * @param {Object} props.data       - Datos del proyecto (pickers)
 * @param {Function} props.onUpdate - (id, partial) => void
 * @param {Function} props.onDelete - (id) => void
 * @param {Function} props.onMove   - (id, dir: -1|1) => void
 * @param {Function} props.onAddAfter - (idx) => void — fija el afterIndex en la paleta
 */
function InstrRow({ instr, idx, total, data, onUpdate, onDelete, onMove, onDuplicate, onAddAfter }) {
  const [open, setOpen] = useState(true)
  const def  = INSTR[instr.type] || {}
  const cat  = INSTR_CATS[def.cat] || { color: '#64748b', label: '' }
  const isFlow = def.cat === 'flow'

  const indent = ['ELIF','ELSE','END_IF'].includes(instr.type) ? 0
    : instr.type === 'IF' ? 0 : null

  return (
    <div className={`scr-instr ${isFlow ? 'scr-instr--flow' : ''}`}
      style={{ '--instr-color': cat.color }}>
      <div className="scr-instr__header" onClick={() => def.fields?.length && setOpen(o => !o)}>
        <div className="scr-instr__order">
          <button className="btn-icon btn-tiny" onClick={e => { e.stopPropagation(); onMove(instr.id, -1) }} disabled={idx === 0}>▲</button>
          <span className="scr-instr__idx">{idx + 1}</span>
          <button className="btn-icon btn-tiny" onClick={e => { e.stopPropagation(); onMove(instr.id, 1) }} disabled={idx === total - 1}>▼</button>
        </div>
        <span className="scr-instr__cat" style={{ background: cat.color + '22', color: cat.color }}>
          {cat.label}
        </span>
        <span className="scr-instr__type">{def.label || instr.type}</span>
        {def.note && <span className="scr-instr__note">{def.note}</span>}
        <div className="scr-instr__actions">
          <button className="btn-icon btn-tiny" title="Añadir instrucción después"
            onClick={e => { e.stopPropagation(); onAddAfter(idx) }}>＋</button>
          <button className="btn-icon btn-tiny" title="Duplicar instrucción"
            onClick={e => { e.stopPropagation(); onDuplicate(instr.id) }}>⧉</button>
          <button className="btn-icon btn-tiny scr-del"
            onClick={e => { e.stopPropagation(); onDelete(instr.id) }}>✕</button>
        </div>
      </div>

      {open && def.fields?.length > 0 && (
        <div className="scr-instr__fields">
          {def.fields.map(fd => (
            <label key={fd.k} className="scr-field-row">
              <span className="scr-field-label">{fd.k}</span>
              <FieldPicker
                fieldDef={fd}
                value={instr[fd.k]}
                onChange={v => onUpdate(instr.id, { [fd.k]: v })}
                data={data}
                instr={instr}
                scriptId={data.activeScriptId || ''}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Instruction palette ───────────────────────────────────────────────────────
function InstrPalette({ onAdd }) {
  return (
    <div className="scr-palette">
      <div className="scr-palette__title">Instrucciones</div>
      {Object.entries(INSTR_CATS).map(([catKey, catMeta]) => (
        <div key={catKey} className="scr-palette__cat">
          <div className="scr-palette__cat-label" style={{ color: catMeta.color }}>
            {catMeta.label}
          </div>
          {Object.entries(INSTR)
            .filter(([, d]) => d.cat === catKey)
            .map(([type, d]) => (
              <button key={type} className="scr-palette__btn"
                style={{ '--cat-color': catMeta.color }}
                onClick={() => onAdd(type)}>
                {d.label}
              </button>
            ))
          }
        </div>
      ))}
    </div>
  )
}

// ── Script list ───────────────────────────────────────────────────────────────
function ScriptLibrary({ gameDir, onOpen }) {
  const { scripts, loaded, loadScripts, createScript, deleteScript, duplicateScript } = useScriptStore()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName]   = useState('')
  const [filter, setFilter]     = useState('')
  const inputRef    = useRef(null)
  const containerRef = useRef(null)

  // Devuelve el foco al contenedor tras operaciones que eliminan el elemento enfocado
  function refocus() { setTimeout(() => containerRef.current?.focus(), 0) }

  useEffect(() => { if (gameDir && !loaded) loadScripts(gameDir) }, [gameDir])
  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  async function handleDelete(id, name) {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    await deleteScript(gameDir, id)
    refocus()
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) { setCreating(false); refocus(); return }
    const s = await createScript(gameDir, name)
    setNewName(''); setCreating(false)
    if (s) onOpen(s.id)
  }

  const filtered = scripts.filter(s => !filter || s.name.toLowerCase().includes(filter.toLowerCase()))

  // Group by trigger type
  const grouped = {}
  filtered.forEach(s => {
    const t = s.trigger?.type || 'other'
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(s)
  })

  return (
    <div className="scr-library" ref={containerRef} tabIndex={-1} style={{ outline: 'none' }}>
      <div className="scr-library__toolbar">
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ Nuevo script</button>
        <input type="search" placeholder="Buscar…" value={filter} onChange={e => setFilter(e.target.value)} />
        <span className="scr-library__count">{scripts.length} script{scripts.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="scr-library__list">
        {creating && (
          <div className="scr-card scr-card--new">
            <span>📜</span>
            <input ref={inputRef} className="scr-card__name-input" value={newName}
              placeholder="Nombre del script"
              onChange={e => setNewName(e.target.value)}
              onBlur={handleCreate}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }} />
          </div>
        )}

        {filtered.length === 0 && !creating && (
          <div className="scr-empty">
            {scripts.length === 0 ? 'Sin scripts. Crea uno arriba.' : 'Sin resultados.'}
          </div>
        )}

        {Object.entries(grouped).map(([trigType, list]) => (
          <div key={trigType} className="scr-group">
            <div className="scr-group__header">
              {TRIGGERS[trigType]?.icon} {TRIGGERS[trigType]?.label || trigType}
            </div>
            {list.map(s => (
              <div key={s.id} className="scr-card" onDoubleClick={() => onOpen(s.id)}>
                <span className="scr-card__icon">📜</span>
                <div className="scr-card__info">
                  <span className="scr-card__name">{s.name}</span>
                  <span className="scr-card__trigger">{TRIGGERS[s.trigger?.type]?.label || '—'}</span>
                </div>
                <div className="scr-card__actions">
                  <button className="btn-icon" onClick={() => onOpen(s.id)}>✏</button>
                  <button className="btn-icon" onClick={() => duplicateScript(gameDir, s.id)}>⧉</button>
                  <button className="btn-icon scr-del" onClick={() => handleDelete(s.id, s.name)}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Script ↔ Code codec ───────────────────────────────────────────────────────
//
// Formato texto por línea:
//   INSTR_TYPE id=i_xxx field1=value field2="quoted string" cond={"type":"..."}
//
// El campo `id` se serializa siempre para preservar claves de locale_text
// (cuyo key tiene forma `scriptId_instrId`). Si se omite al parsear se genera
// uno nuevo. Las líneas vacías y que comienzan por # son ignoradas al parsear.

function instrToLine(instr) {
  const def = INSTR[instr.type]
  if (!def) return `# desconocido: ${instr.type}`
  const parts = [instr.type, `id=${instr.id}`]
  for (const fd of (def.fields || [])) {
    const v = instr[fd.k]
    if (v === undefined || v === null) continue
    if (typeof v === 'object') {
      parts.push(`${fd.k}=${JSON.stringify(v)}`)
    } else if (typeof v === 'string') {
      const needsQuote = /[\s="{}\[\]#]/.test(v) || v === ''
      parts.push(needsQuote
        ? `${fd.k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : `${fd.k}=${v}`)
    } else {
      parts.push(`${fd.k}=${v}`)
    }
  }
  return parts.join(' ')
}

/** Extrae pares key=value respetando strings entre comillas y objetos JSON */
function parseKVPairs(str) {
  const result = {}
  let i = 0
  while (i < str.length) {
    while (i < str.length && str[i] === ' ') i++
    if (i >= str.length) break
    // Leer clave
    const keyStart = i
    while (i < str.length && str[i] !== '=' && str[i] !== ' ') i++
    const key = str.slice(keyStart, i).trim()
    if (!key || str[i] !== '=') { i++; continue }
    i++ // saltar '='
    // Leer valor
    let value
    if (str[i] === '"') {
      i++
      let s = ''
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { s += str[i + 1]; i += 2 }
        else { s += str[i]; i++ }
      }
      i++ // cerrar "
      value = s
    } else if (str[i] === '{' || str[i] === '[') {
      const start = i
      let depth = 0; let inStr = false; let esc = false
      while (i < str.length) {
        const ch = str[i]
        if (esc) { esc = false }
        else if (ch === '\\' && inStr) { esc = true }
        else if (ch === '"') { inStr = !inStr }
        else if (!inStr && (ch === '{' || ch === '[')) depth++
        else if (!inStr && (ch === '}' || ch === ']')) depth--
        i++
        if (depth === 0) break
      }
      try { value = JSON.parse(str.slice(start, i)) }
      catch { value = str.slice(start, i) }
    } else {
      const start = i
      while (i < str.length && str[i] !== ' ') i++
      value = str.slice(start, i)
    }
    if (key) result[key] = value
  }
  return result
}

function parseInstrLine(line) {
  const sp = line.indexOf(' ')
  const type = sp < 0 ? line : line.slice(0, sp)
  if (!INSTR[type]) throw new Error(`Instrucción desconocida: "${type}"`)
  const rest = sp < 0 ? '' : line.slice(sp + 1)
  const kv = parseKVPairs(rest)
  const def = INSTR[type]
  const fields = {}
  for (const fd of (def.fields || [])) {
    if (kv[fd.k] === undefined) continue
    const raw = kv[fd.k]
    if (fd.t === 'number') fields[fd.k] = Number(raw)
    else if (fd.t === 'bool' || fd.t === 'checkbox') fields[fd.k] = raw === 'true' || raw === true
    else if (fd.t === 'loop_tri') fields[fd.k] = raw === '' || raw === null ? null : (raw === 'true' || raw === true)
    else if (fd.t === 'condition') fields[fd.k] = typeof raw === 'object' ? raw : (() => { try { return JSON.parse(raw) } catch { return raw } })()
    else fields[fd.k] = raw
  }
  const id = kv.id || `i_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  return { id, type, ...fields }
}

function scriptToCode(script) {
  if (!script) return ''
  const trig = script.trigger || {}
  const trigDef = TRIGGERS[trig.type] || { fields: [] }
  const header = [
    `# trigger: ${trig.type || 'none'}`,
    ...trigDef.fields.map(f => trig[f] !== undefined ? `# ${f}: ${trig[f]}` : null).filter(Boolean),
    '',
  ]
  const body = (script.instructions || []).map(instrToLine)
  return [...header, ...body].join('\n')
}

function codeToInstructions(code) {
  const lines = code.split('\n')
  const instructions = []
  const errors = []
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim()
    if (!line || line.startsWith('#')) continue
    try {
      instructions.push(parseInstrLine(line))
    } catch (e) {
      errors.push(`Línea ${n + 1}: ${e.message}`)
    }
  }
  return { instructions, errors }
}

// ── Code view component ───────────────────────────────────────────────────────
function ScriptCodeView({ script, onApply }) {
  const [code, setCode] = useState(() => scriptToCode(script))
  const [errors, setErrors] = useState([])

  // Regenerar si el script cambió externamente (ej: al abrir)
  const scriptRef = useRef(script)
  useEffect(() => {
    if (script !== scriptRef.current) {
      scriptRef.current = script
      setCode(scriptToCode(script))
      setErrors([])
    }
  }, [script])

  function handleApply() {
    const { instructions, errors: errs } = codeToInstructions(code)
    if (errs.length > 0) { setErrors(errs); return }
    setErrors([])
    onApply(instructions)
  }

  return (
    <div className="scr-code-view">
      <div className="scr-code-view__bar">
        <span className="scr-code-view__hint">
          Una instrucción por línea · <code>TIPO campo=valor</code> · líneas con <code>#</code> = comentarios
        </span>
        <button className="btn-primary" onClick={handleApply}>✓ Aplicar</button>
      </div>
      {errors.length > 0 && (
        <div className="scr-code-view__errors">
          {errors.map((e, i) => <div key={i} className="scr-code-view__err">{e}</div>)}
        </div>
      )}
      <textarea
        className="scr-code-view__editor"
        value={code}
        onChange={e => { setCode(e.target.value); setErrors([]) }}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  )
}

// ── Script editor view ────────────────────────────────────────────────────────
function ScriptEditorView({ gameDir, scriptId, onBack }) {
  const { activeScript, dirty, openScript, saveScript, closeScript,
          updateMeta, addInstruction, updateInstruction, deleteInstruction, moveInstruction, duplicateInstruction } = useScriptStore()
  const [addingAfter, setAddingAfter] = useState(null)
  const [tab, setTab] = useState('blocks') // 'blocks' | 'code'

  const data = useGameData(gameDir)

  useEffect(() => {
    openScript(gameDir, scriptId)
    return () => closeScript()
  }, [scriptId])

  function handleBack() {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Salir?')) return
    onBack()
  }

  function handleAddInstr(type) {
    addInstruction(type, addingAfter)
    setAddingAfter(null)
  }

  function handleTabSwitch(newTab) {
    setTab(newTab)
  }

  function handleApplyCode(instructions) {
    updateMeta({ instructions })
  }

  if (!activeScript) return <div className="scr-loading">Cargando script…</div>

  return (
    <div className="scr-editor">
      {/* Toolbar */}
      <div className="scr-editor__toolbar">
        <button className="btn-ghost" onClick={handleBack}>← Scripts</button>
        <input className="scr-editor__name" value={activeScript.name}
          onChange={e => updateMeta({ name: e.target.value })} />
        {dirty && <span className="scr-dirty">●</span>}
        <div className="scr-view-tabs">
          <button className={`scr-view-tab ${tab === 'blocks' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('blocks')}>⊞ Bloques</button>
          <button className={`scr-view-tab ${tab === 'code' ? 'active' : ''}`}
            onClick={() => handleTabSwitch('code')}>&#60;/&#62; Código</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className={`btn-primary ${!dirty ? 'btn-primary--disabled' : ''}`}
          disabled={!dirty} onClick={() => saveScript(gameDir)}>
          💾 Guardar
        </button>
      </div>

      {tab === 'code' ? (
        <div className="scr-code-wrapper">
          {/* Trigger always visible above code */}
          <div className="scr-section scr-section--trigger-bar">
            <div className="scr-section__title">⚡ Disparador</div>
            <TriggerEditor
              trigger={activeScript.trigger || { type: 'game_start' }}
              onChange={t => updateMeta({ trigger: t })}
              data={data}
            />
          </div>
          <ScriptCodeView script={activeScript} onApply={handleApplyCode} />
        </div>
      ) : (
        /* Blocks view: palette | trigger+instructions */
        <div className="scr-workspace">
          <InstrPalette onAdd={handleAddInstr} />
          <div className="scr-main">
            <div className="scr-section">
              <div className="scr-section__title">⚡ Disparador</div>
              <TriggerEditor
                trigger={activeScript.trigger || { type: 'game_start' }}
                onChange={t => updateMeta({ trigger: t })}
                data={data}
              />
            </div>

            <div className="scr-section scr-section--instructions">
              <div className="scr-section__title">
                📋 Instrucciones
                <span className="scr-section__count">{activeScript.instructions?.length || 0}</span>
                {addingAfter !== null && (
                  <span className="scr-adding-hint">
                    Añadiendo después de #{addingAfter + 1} —
                    <button className="btn-ghost scr-cancel-add" onClick={() => setAddingAfter(null)}>cancelar</button>
                  </span>
                )}
              </div>

              {(!activeScript.instructions || activeScript.instructions.length === 0) && (
                <div className="scr-instr-empty">
                  Sin instrucciones — selecciona una del panel izquierdo.
                </div>
              )}

              {(activeScript.instructions || []).map((instr, idx) => (
                <InstrRow key={instr.id} instr={instr} idx={idx}
                  total={activeScript.instructions.length}
                  data={data}
                  onUpdate={updateInstruction}
                  onDelete={deleteInstruction}
                  onMove={moveInstruction}
                  onDuplicate={duplicateInstruction}
                  onAddAfter={(i) => setAddingAfter(i === addingAfter ? null : i)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function ScriptEditor() {
  const { activeGame } = useAppStore()
  const [editingId, setEditingId] = useState(null)
  const gameDir = activeGame?.gameDir

  if (editingId) {
    return <ScriptEditorView gameDir={gameDir} scriptId={editingId} onBack={() => setEditingId(null)} />
  }

  return (
    <div className="scr-module">
      <div className="scr-module__header">
        <h2>📜 Scripts</h2>
        <p>Lógica del juego. Agrupados por disparador. Doble clic para editar.</p>
      </div>
      <ScriptLibrary gameDir={gameDir} onOpen={setEditingId} />
    </div>
  )
}
