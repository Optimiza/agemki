import { useState, useEffect } from 'react'
import React from 'react'
import { useAppStore } from '../../store/appStore'
import { useObjectStore } from '../../store/objectStore'
import { useCharStore } from '../../store/charStore'
import { useCharFirstFrame } from '../../hooks/useCharFirstFrame'
import { useLocaleStore } from '../../store/localeStore'
import { useSceneStore, TOOLS, LAYERS } from '../../store/sceneStore'
import './SceneSidePanel.css'

const LAYER_LIST = [
  { id: LAYERS.BACKGROUND,  label: 'Fondo' },
  { id: LAYERS.OBJECTS,     label: 'Objetos' },
  { id: LAYERS.CHARACTERS,  label: 'Personajes' },
  { id: LAYERS.WALKMAP,     label: 'Walkmap' },
  { id: LAYERS.VISIBILITY,  label: 'Visibility' },
  { id: LAYERS.LIGHTS,      label: 'Luces' },
  { id: LAYERS.EFFECTS,     label: 'Efectos' },
]

// ── Selector de MIDI ─────────────────────────────────────────────────────────

function MidiPicker({ value, gameDir, onChange, loop, onLoopChange, cont, onContChange }) {
  const [files, setFiles] = useState(null)
  const [playing, setPlaying] = useState(false)

  function load() {
    if (!gameDir) return
    window.api.listAudioFiles(gameDir, 'music').then(r => {
      const names = (r.ok ? (r.files || []) : []).map(f => f.name || f)
      setFiles(names)
    })
  }

  useEffect(() => { load() }, [gameDir])

  async function togglePlay() {
    if (playing) {
      await window.api.stopPreview()
      setPlaying(false)
    } else if (value && gameDir) {
      const path = gameDir + '/audio/music/' + value
      await window.api.previewAudio(path)
      setPlaying(true)
    }
  }

  // Parar al desmontar
  useEffect(() => () => { if (playing) window.api.stopPreview() }, [playing])

  const empty = files !== null && files.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <select value={value || ''} onChange={e => { onChange(e.target.value || null); setPlaying(false) }}
          style={{ flex: 1 }}>
          <option value="">— sin música —</option>
          {(files || []).map(f => (
            <option key={f} value={f}>{f}</option>
          ))}
          {!files && <option disabled>Cargando…</option>}
        </select>
        {value && (
          <button className="btn-ghost" title={playing ? 'Parar' : 'Previsualizar'}
            onClick={togglePlay} style={{ padding: '0 6px', fontSize: 12 }}>
            {playing ? '⏹' : '▶'}
          </button>
        )}
        <button className="btn-ghost" title="Recargar lista" onClick={load}
          style={{ padding: '0 6px', fontSize: 12 }}>↻</button>
      </div>
      {value && (
        <div style={{ display:'flex', gap:12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={loop !== false} style={{ margin: 0 }}
              onChange={e => onLoopChange?.(e.target.checked)} />
            Loop
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer', userSelect: 'none' }}
            title="No reinicia la pista si ya está sonando (útil para closeups con la misma música)">
            <input type="checkbox" checked={!!cont} style={{ margin: 0 }}
              onChange={e => onContChange?.(e.target.checked)} />
            Continuar si ya suena
          </label>
        </div>
      )}
      {empty && (
        <span style={{ fontSize: 10, color: 'var(--c-text-muted, #888)' }}>
          Pon los .mid en <code>audio/music/</code>
        </span>
      )}
    </div>
  )
}

function BgPicker({ value, gameDir, onChange }) {
  const [assets, setAssets] = useState(null)
  const [open, setOpen]     = useState(false)

  async function handleOpen() {
    const result = await window.api.listAssets(gameDir, 'backgrounds')
    setAssets(result.ok ? result.files : [])
    setOpen(true)
  }

  return (
    <div className="bg-picker">
      <div className="bg-picker__current" onClick={handleOpen}>
        {value || <span className="muted">Sin fondo</span>}
      </div>
      <button className="btn-ghost bg-picker__btn" onClick={handleOpen} title="Elegir fondo">📁</button>
      {open && (
        <div className="bg-picker__dropdown">
          <div className="bg-picker__header">
            Fondos disponibles
            <button className="btn-icon" onClick={() => setOpen(false)}>✕</button>
          </div>
          {assets === null && <div className="bg-picker__empty">Cargando...</div>}
          {assets?.length === 0 && <div className="bg-picker__empty">Sin fondos. Importa uno en Asset Studio.</div>}
          {assets?.map(a => (
            <div key={a.name}
              className={`bg-picker__item ${a.name === value ? 'active' : ''}`}
              onClick={() => { onChange(a.name); setOpen(false) }}>
              {a.name}
            </div>
          ))}
          <div className="bg-picker__item bg-picker__item--none"
            onClick={() => { onChange(null); setOpen(false) }}>
            — Sin fondo —
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sección colapsable ────────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="side-section">
      <div className="side-section__header" onClick={() => setOpen(v => !v)}>
        <span>{title}</span>
        <span className="side-section__chevron">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="side-section__body">{children}</div>}
    </div>
  )
}

// ── Panel de instancias de objetos ────────────────────────────────────────────

function ObjectPickerDropdown({ objects, onPick, onClose }) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    const h = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} className="obj-picker-dropdown">
      <div className="obj-picker-header">
        Biblioteca de objetos
        <button className="btn-icon" onClick={onClose}>✕</button>
      </div>
      {objects.length === 0 && (
        <div className="obj-picker-empty">Sin objetos en la biblioteca.</div>
      )}
      {objects.map(obj => (
        <div key={obj.id} className="obj-picker-item" onClick={() => onPick(obj)}>
          {obj.name} <span className="obj-picker-type">{obj.type}</span>
        </div>
      ))}
    </div>
  )
}

function ObjectInstancePanel({ room, gameDir, selectedInstanceId, onSelect, onAdd, onDelete }) {
  const { objects, loadObjects } = useObjectStore()
  const { updateObjectInstance } = useSceneStore()
  const [showPicker, setShowPicker] = useState(false)

  async function handleOpenPicker() {
    await loadObjects(gameDir)
    setShowPicker(true)
  }

  const insts = room?.objects || []
  const selInst = insts.find(i => i.id === selectedInstanceId)

  function addState(instId) {
    const inst = insts.find(i => i.id === instId)
    if (!inst) return
    const states = [...(inst.states || []), { id: `state_${Date.now()}`, gfxId: '' }]
    updateObjectInstance(instId, { states })
  }
  function removeState(instId, stIdx) {
    const inst = insts.find(i => i.id === instId)
    if (!inst) return
    const states = (inst.states || []).filter((_, i) => i !== stIdx)
    updateObjectInstance(instId, { states })
  }
  function updateState(instId, stIdx, partial) {
    const inst = insts.find(i => i.id === instId)
    if (!inst) return
    const states = (inst.states || []).map((s, i) => i === stIdx ? { ...s, ...partial } : s)
    updateObjectInstance(instId, { states })
  }

  return (
    <div className="inst-panel">
      {insts.length === 0 && (
        <div className="inst-empty">Sin objetos. Añade desde la biblioteca.</div>
      )}
      {insts.map(inst => (
        <div key={inst.id}>
          <div
            className={`inst-row ${inst.id === selectedInstanceId ? 'active' : ''}`}
            onClick={() => onSelect(inst.id === selectedInstanceId ? null : inst.id)}
          >
            <span className="inst-name">{inst.objectName || inst.objectId}</span>
            <span className="inst-pos">{inst.x},{inst.y}</span>
            {inst.pickable  && <span className="inst-badge" title="Recogible">🎒</span>}
            {inst.overLight && <span className="inst-badge" title="Tapa la luz">💡↑</span>}
            <button className="btn-icon inst-del"
              onClick={e => { e.stopPropagation(); onDelete(inst.id) }}>🗑</button>
          </div>
          {inst.id === selectedInstanceId && (
            <div className="inst-editor">
              <div className="inst-editor-row">
                <label>X <input type="number" value={inst.x}
                  onChange={e => updateObjectInstance(inst.id, { x: parseInt(e.target.value)||0 })} /></label>
                <label>Y <input type="number" value={inst.y}
                  onChange={e => updateObjectInstance(inst.id, { y: parseInt(e.target.value)||0 })} /></label>
              </div>
              <div className="inst-editor-row">
                <label>
                  <input type="checkbox" checked={!!inst.pickable}
                    onChange={e => updateObjectInstance(inst.id, { pickable: e.target.checked })} />
                  {' '}Recogible (inventario)
                </label>
              </div>
              <div className="inst-editor-row">
                <label title="Si está activo, el objeto se dibuja ENCIMA del efecto de luz (no le afecta la oscuridad). Usar para elementos de primer plano como ATALAYA2.">
                  <input type="checkbox" checked={!!inst.overLight}
                    onChange={e => updateObjectInstance(inst.id, { overLight: e.target.checked })} />
                  {' '}Tapa la luz <span style={{fontSize:10,color:'var(--muted)'}}>— primer plano sobre oscuridad</span>
                </label>
              </div>
              {inst.pickable && (
                <div className="inst-editor-row">
                  <label>Icono inventario (PCX)
                    <input type="text" placeholder="vacío = usar sprite principal"
                      value={inst.invGfxId || ''}
                      onChange={e => updateObjectInstance(inst.id, { invGfxId: e.target.value })} />
                  </label>
                </div>
              )}
              <div className="inst-editor-section">
                <span className="inst-editor-label">Estados visuales</span>
                {(inst.states || []).map((st, si) => (
                  <div key={si} className="inst-state-row">
                    <input type="text" placeholder="id (ej: abierto)" value={st.id}
                      onChange={e => updateState(inst.id, si, { id: e.target.value })} />
                    <input type="text" placeholder="PCX del estado" value={st.gfxId}
                      onChange={e => updateState(inst.id, si, { gfxId: e.target.value })} />
                    <button className="btn-icon" onClick={() => removeState(inst.id, si)}>✕</button>
                  </div>
                ))}
                <button className="btn-ghost btn-small" onClick={() => addState(inst.id)}>
                  + Estado
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <button className="btn-ghost inst-add" onClick={handleOpenPicker}>
        ＋ Añadir objeto
      </button>
      {showPicker && (
        <ObjectPickerDropdown
          objects={objects}
          onPick={(obj) => {
            const cx = Math.round((room.backgroundSize.w || 160) / 2)
            const cy = Math.round((room.backgroundSize.h || 72) / 2)
            onAdd(obj.id, obj.name, cx, cy)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

// ── SceneSidePanel ────────────────────────────────────────────────────────────


// ── Panel de personajes en room ───────────────────────────────────────────────

// Small component so we can call useCharFirstFrame per item inside a list
function CharPickerItem({ char, name, gameDir, palette, onAdd }) {
  const frameUrl = useCharFirstFrame(char, gameDir, palette)
  return (
    <div className="inst-picker__item"
      onClick={() => onAdd(char.id, name)}>
      <div className="inst-picker__thumb">
        {frameUrl
          ? <img src={frameUrl} alt={name}
              style={{ maxWidth: '100%', maxHeight: '100%', imageRendering: 'pixelated', objectFit: 'contain' }} />
          : <span>{char.isProtagonist ? '🦸' : '🧍'}</span>}
      </div>
      <span className="inst-picker__name">{name}</span>
      {char.isProtagonist && <span className="inst-picker__badge">proto</span>}
    </div>
  )
}

function CharInstancePanel({ room, gameDir, palette, selectedCharInstId, onSelect, onAdd, onDelete }) {
  const { chars, loaded, loadChars } = useCharStore()
  const { locales, activeLang }      = useLocaleStore()
  const { updateCharInstance }       = useSceneStore()
  const [showPicker, setShowPicker]  = useState(false)
  const [pickerFilter, setPickerFilter] = useState('')

  useEffect(() => { if (gameDir && !loaded) loadChars(gameDir) }, [gameDir])

  function getCharName(char) {
    return (locales[activeLang] || {})[`char.${char.id}.name`]
        || (locales['es']       || {})[`char.${char.id}.name`]
        || char.id
  }

  const instances = room?.characters || []
  const selectedInst = instances.find(i => i.id === selectedCharInstId)
  const selectedDef  = selectedInst ? chars.find(c => c.id === selectedInst.charId) : null

  const DIRS = ['front', 'back', 'left', 'right']

  return (
    <div className="inst-panel">
      {instances.length === 0
        ? <div className="inst-empty">Sin personajes en esta room</div>
        : instances.map(inst => {
          const def = chars.find(c => c.id === inst.charId)
          const name = def ? getCharName(def) : inst.charName || inst.charId
          return (
            <div key={inst.id}>
              <div
                className={`inst-row ${inst.id === selectedCharInstId ? 'active' : ''}`}
                onClick={() => onSelect(inst.id === selectedCharInstId ? null : inst.id)}>
                <span className="inst-icon">{def?.isProtagonist ? '🦸' : '🧍'}</span>
                <span className="inst-name" title={name}>{name}</span>
                <div className="inst-row__meta">
                  <span>{inst.x},{inst.y}</span>
                  {inst.currentAnimation && <span className="inst-anim-badge">{inst.currentAnimation}</span>}
                </div>
                <button className="btn-icon inst-del" onClick={e => { e.stopPropagation(); onDelete(inst.id) }}>🗑</button>
              </div>

              {/* ── Panel de propiedades de instancia ── */}
              {inst.id === selectedCharInstId && (
                <div className="char-inst-props">
                  <div className="char-inst-props__row">
                    <label>X
                      <input type="number" value={inst.x} min={0} max={9999}
                        onChange={e => updateCharInstance(inst.id, { x: parseInt(e.target.value) || 0 })} />
                    </label>
                    <label>Y
                      <input type="number" value={inst.y} min={0} max={9999}
                        onChange={e => updateCharInstance(inst.id, { y: parseInt(e.target.value) || 0 })} />
                    </label>
                  </div>
                  <div className="char-inst-props__row">
                    <label>Dirección
                      <select value={inst.facingDir || 'front'}
                        onChange={e => updateCharInstance(inst.id, { facingDir: e.target.value })}>
                        {DIRS.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="char-inst-props__row">
                    <label>Animación inicial
                      <select value={inst.currentAnimation || ''}
                        onChange={e => updateCharInstance(inst.id, { currentAnimation: e.target.value || null })}>
                        <option value="">— ninguna (usar default del motor) —</option>
                        {(selectedDef?.animations || []).map(a => (
                          <option key={a.id} value={a.name}>{a.name}</option>
                        ))}
                        {(!selectedDef?.animations || selectedDef.animations.length === 0) && (
                          <option disabled>Sin animaciones definidas en el personaje</option>
                        )}
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </div>
          )
        })
      }

      <button className="inst-add-btn" onClick={() => setShowPicker(s => !s)}>
        {showPicker ? '▲ Cerrar' : '＋ Añadir personaje'}
      </button>

      {showPicker && (
        <div className="inst-picker">
          <input type="text" placeholder="Filtrar…" value={pickerFilter}
            onChange={e => setPickerFilter(e.target.value)} />
          {chars.length === 0
            ? <div className="inst-picker__empty">Sin personajes. Crea uno en el módulo 🧍 Personajes.</div>
            : chars
                .filter(c => !pickerFilter || getCharName(c).toLowerCase().includes(pickerFilter.toLowerCase()))
                .map(c => (
                  <CharPickerItem key={c.id} char={c} name={getCharName(c)}
                    gameDir={gameDir} palette={palette}
                    onAdd={(id, name) => { onAdd(id, name); setShowPicker(false); setPickerFilter('') }} />
                ))
          }
        </div>
      )}
    </div>
  )
}


// ── ExitPanel ─────────────────────────────────────────────────────────────────

function ExitPanel({ room, gameDir, selectedExitId, onSelect, onAdd, onUpdate, onDelete }) {
  const [rooms, setRooms] = useState(null)
  useEffect(() => {
    if (!gameDir) return
    window.api.listRooms(gameDir).then(r => setRooms(r.ok ? r.rooms : []))
  }, [gameDir])

  const exits   = room?.exits || []
  const selExit = exits.find(e => e.id === selectedExitId)

  return (
    <div className="exit-panel">
      {exits.length === 0
        ? <div className="inst-empty">Sin salidas — añade una y arrástrala al canvas</div>
        : exits.map(ex => (
          <div key={ex.id}>
            <div className={`inst-row ${ex.id === selectedExitId ? 'active' : ''}`}
              onClick={() => onSelect(ex.id === selectedExitId ? null : ex.id)}>
              <span className="inst-icon">→</span>
              <span className="inst-name" title={ex.name}>{ex.name}</span>
              <span className="inst-row__meta" style={{ fontSize: 10, opacity: 0.6 }}>
                {ex.targetRoom ? (rooms||[]).find(r=>r.id===ex.targetRoom)?.name || ex.targetRoom : '?'}
              </span>
              <button className="btn-icon inst-del"
                onClick={e => { e.stopPropagation(); onDelete(ex.id) }}>🗑</button>
            </div>

            {ex.id === selectedExitId && (
              <div className="char-inst-props">
                <div className="char-inst-props__row">
                  <label style={{ flex: 1 }}>Nombre ID
                    <input type="text" value={ex.name}
                      onChange={e => onUpdate(ex.id, { name: e.target.value.replace(/\s+/g,'_').toLowerCase() })} />
                  </label>
                </div>

                <div className="char-inst-props__row">
                  <label>X <input type="number" value={ex.triggerZone.x} min={0}
                    onChange={e => onUpdate(ex.id, { triggerZone: { ...ex.triggerZone, x: parseInt(e.target.value)||0 } })} /></label>
                  <label>Y <input type="number" value={ex.triggerZone.y} min={0}
                    onChange={e => onUpdate(ex.id, { triggerZone: { ...ex.triggerZone, y: parseInt(e.target.value)||0 } })} /></label>
                </div>
                <div className="char-inst-props__row">
                  <label>W <input type="number" value={ex.triggerZone.w} min={4}
                    onChange={e => onUpdate(ex.id, { triggerZone: { ...ex.triggerZone, w: Math.max(4, parseInt(e.target.value)||20) } })} /></label>
                  <label>H <input type="number" value={ex.triggerZone.h} min={4}
                    onChange={e => onUpdate(ex.id, { triggerZone: { ...ex.triggerZone, h: Math.max(4, parseInt(e.target.value)||10) } })} /></label>
                </div>

                <div className="char-inst-props__row">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!ex.blocked}
                      onChange={e => onUpdate(ex.id, { blocked: e.target.checked || undefined })} />
                    Bloqueada al inicio
                  </label>
                </div>

                <div className="char-inst-props__row" style={{ flexDirection: 'column', gap: 4 }}>
                  <label style={{ width: '100%' }}>Room destino
                    <select value={ex.targetRoom || ''}
                      onChange={e => onUpdate(ex.id, { targetRoom: e.target.value || null, targetEntry: null })}>
                      <option value="">— seleccionar —</option>
                      {/* Current room first (useful for maze/internal exits) */}
                      <option value={room.id}>↩ {room.name || room.id} (esta sala)</option>
                      {(rooms || []).filter(r => r.id !== room.id).map(r =>
                        <option key={r.id} value={r.id}>{r.name || r.id}</option>
                      )}
                    </select>
                  </label>
                  {ex.targetRoom && (
                    <label style={{ width: '100%' }}>Punto de entrada
                      <TargetEntryPicker gameDir={gameDir} targetRoom={ex.targetRoom}
                        value={ex.targetEntry}
                        onChange={v => onUpdate(ex.id, { targetEntry: v })} />
                    </label>
                  )}
                </div>

                <div className="char-inst-props__row">
                  <label style={{ flex: 1 }}>Condición (flag)
                    <input type="text" placeholder="ej: puerta_abierta"
                      value={ex.condition || ''}
                      onChange={e => onUpdate(ex.id, { condition: e.target.value || null })} />
                  </label>
                </div>
                <div className="char-inst-props__row" style={{ flexDirection: 'column', gap: 4 }}>
                  <label style={{ flex: 1 }}>📜 Script de transición
                    <input type="text" placeholder="ej: script_puerta_norte"
                      value={ex.transitionScript || ''}
                      onChange={e => onUpdate(ex.id, { transitionScript: e.target.value || null })} />
                  </label>
                  <small className="field-hint">El motor ejecuta este script antes de cambiar de room. Aquí van las animaciones de puerta, fundidos, etc.</small>
                </div>
              </div>
            )}
          </div>
        ))
      }
      <button className="inst-add-btn" onClick={onAdd}>＋ Añadir salida</button>
    </div>
  )
}

// Loads entries of a target room for the picker
function TargetEntryPicker({ gameDir, targetRoom, value, onChange }) {
  const [entries, setEntries] = useState(null)
  useEffect(() => {
    if (!gameDir || !targetRoom) { setEntries([]); return }
    window.api.readRoom(gameDir, targetRoom).then(r => {
      setEntries(r.ok ? (r.room.entries || []) : [])
    })
  }, [gameDir, targetRoom])

  if (!entries) return <small style={{ opacity: 0.5 }}>Cargando…</small>
  return (
    <select value={value || ''}
      onChange={e => onChange(e.target.value || null)}>
      <option value="">— seleccionar —</option>
      {entries.map(en => <option key={en.id} value={en.id}>{en.name} ({en.x},{en.y})</option>)}
    </select>
  )
}

// ── EntryPanel ────────────────────────────────────────────────────────────────

function EntryPanel({ room, selectedEntryId, onSelect, onAdd, onUpdate, onDelete }) {
  const entries = room?.entries || []
  return (
    <div className="exit-panel">
      {entries.length === 0
        ? <div className="inst-empty">Sin puntos de entrada</div>
        : entries.map(en => (
          <div key={en.id}>
            <div className={`inst-row ${en.id === selectedEntryId ? 'active' : ''}`}
              onClick={() => onSelect(en.id === selectedEntryId ? null : en.id)}>
              <span className="inst-icon" style={{ color: '#3cdc78' }}>✚</span>
              <span className="inst-name">{en.name}</span>
              <span className="inst-row__meta" style={{ fontSize: 10, opacity: 0.6 }}>{en.x},{en.y}</span>
              <button className="btn-icon inst-del"
                onClick={e => { e.stopPropagation(); onDelete(en.id) }}>🗑</button>
            </div>

            {en.id === selectedEntryId && (
              <div className="char-inst-props">
                <div className="char-inst-props__row">
                  <label style={{ flex: 1 }}>Nombre ID
                    <input type="text" value={en.name}
                      onChange={e => onUpdate(en.id, { name: e.target.value.replace(/\s+/g,'_').toLowerCase() })} />
                  </label>
                </div>
                <div className="char-inst-props__row">
                  <label>X <input type="number" value={en.x} min={0}
                    onChange={e => onUpdate(en.id, { x: parseInt(e.target.value)||0 })} /></label>
                  <label>Y <input type="number" value={en.y} min={0}
                    onChange={e => onUpdate(en.id, { y: parseInt(e.target.value)||0 })} /></label>
                </div>
              </div>
            )}
          </div>
        ))
      }
      <button className="inst-add-btn" onClick={onAdd}>＋ Añadir entrada</button>
    </div>
  )
}

export default function SceneSidePanel({ panelMode = 'all' }) {
  const { activeGame } = useAppStore()
  const {
    activeRoom, updateRoom, dirty,
    activeTool, setTool,
    drawMode, setDrawMode,
    layers, toggleLayer,
    addWalkmap, deleteWalkmap, setActiveWalkmap,
    commitPendingPolygon, pendingPolygon,
    addObjectInstance, deleteObjectInstance, selectInstance, selectedInstanceId,
    addCharInstance, deleteCharInstance, selectCharInst, selectedCharInstId,
    addExit, updateExit, deleteExit, selectExit, selectedExitId,
    addEntry, updateEntry, deleteEntry, selectEntry, selectedEntryId,
    addLight, updateLight, updateLightFlicker, deleteLight, selectLight, selectedLightId,
  } = useSceneStore()

  const gameDir = activeGame?.gameDir

  if (!activeRoom) return null
  const room  = activeRoom
  const roomW  = room.backgroundSize?.w || 160
  const roomH  = room.backgroundSize?.h || 100
  const scroll = room.scroll

  function setScroll(partial) { updateRoom({ scroll: { ...room.scroll, ...partial } }) }
  function setBgSize(partial)  { updateRoom({ backgroundSize: { ...room.backgroundSize, ...partial } }) }

  async function handleBgChange(filename) {
    updateRoom({ backgroundFilePath: filename })
    if (filename) {
      const path = `${gameDir}/assets/converted/backgrounds/${filename}`
      const result = await window.api.readBinary(path)
      if (result.ok) {
        const { pcxFileToDataURL } = await import('../../utils/pcxConverter')
        const url = pcxFileToDataURL(new Uint8Array(result.buffer), activeGame.game.palette)
        useSceneStore.getState().setBackgroundUrl(url)
        const img = new Image()
        img.onload = () => updateRoom({ backgroundSize: { w: img.naturalWidth, h: img.naturalHeight } })
        img.src = url
      }
    } else {
      useSceneStore.getState().setBackgroundUrl(null)
    }
  }

  const activeWm = room.walkmaps?.find(w => w.id === room.activeWalkmapId)
  const show = (s) => panelMode === 'all' || panelMode === s

  return (
    <div className="scene-side-panel">

      {/* ── Propiedades de room ── */}
      {show('props') && <Section title="Propiedades">
        <div className="prop-row">
          <label>Nombre</label>
          <input type="text" value={room.name}
            onChange={e => updateRoom({ name: e.target.value })} />
        </div>

        <div className="prop-row">
          <label>Fondo PCX</label>
          <BgPicker value={room.backgroundFilePath} gameDir={gameDir} onChange={handleBgChange} />
        </div>

        <div className="prop-row">
          <label>Tamaño (px)</label>
          <div className="prop-size">
            <input type="number" value={room.backgroundSize.w} min={1} max={9999}
              onChange={e => setBgSize({ w: +e.target.value })} />
            <span>×</span>
            <input type="number" value={room.backgroundSize.h} min={1} max={9999}
              onChange={e => setBgSize({ h: +e.target.value })} />
          </div>
        </div>

        <div className="prop-row prop-row--check">
          <label>Scroll</label>
          <input type="checkbox" checked={scroll.enabled && !scroll.halves}
            onChange={e => setScroll({ enabled: e.target.checked, halves: false })} />
        </div>

        {scroll.enabled && !scroll.halves && <>
          <div className="prop-row">
            <label>Dirección</label>
            <div className="prop-checks">
              <label><input type="checkbox" checked={scroll.directionH}
                onChange={e => setScroll({ directionH: e.target.checked })} /> H</label>
              <label><input type="checkbox" checked={scroll.directionV}
                onChange={e => setScroll({ directionV: e.target.checked })} /> V</label>
            </div>
          </div>
          {scroll.directionH && (
            <div className="prop-row">
              <label>Ancho total</label>
              <input type="number" value={scroll.totalW} min={320} max={9999}
                onChange={e => setScroll({ totalW: +e.target.value })} />
            </div>
          )}
          {scroll.directionV && (
            <div className="prop-row">
              <label>Alto total</label>
              <input type="number" value={scroll.totalH} min={144} max={9999}
                onChange={e => setScroll({ totalH: +e.target.value })} />
            </div>
          )}
          <div className="prop-row">
            <label>Velocidad cám.</label>
            <input type="number" value={scroll.cameraSpeed} min={0.1} max={10} step={0.1}
              onChange={e => setScroll({ cameraSpeed: +e.target.value })} />
          </div>
        </>}

        {/* Scroll por mitades — PCX de 2×320px con pan manual (estilo Scumm Bar) */}
        <div className="prop-row prop-row--check">
          <label title="PCX de 640px: cámara muestra solo una mitad. Al llegar al límite central la cámara hace pan de 2s al otro lado.">
            Scroll mitades
          </label>
          <input type="checkbox" checked={!!scroll.halves}
            onChange={e => setScroll({ halves: e.target.checked, enabled: e.target.checked, directionH: false, directionV: false })} />
        </div>

        {/* ── Escalado de personajes ── */}
        <div className="prop-row prop-row--check">
          <label>Escalado</label>
          <input type="checkbox" checked={room.scaling?.enabled || false}
            onChange={e => updateRoom({ scaling: { ...(room.scaling||{}), enabled: e.target.checked, zones: room.scaling?.zones || [] } })} />
        </div>

        {room.scaling?.enabled && (
          <div className="scaling-zones">
            <div className="scaling-zones__header">
              <span>Zonas de escala</span>
              <button className="btn-ghost btn-tiny" onClick={() => {
                const zones = [...(room.scaling?.zones || []), { y0: 0, y1: 72, type: 'linear', pct0: 50, pct1: 100 }]
                updateRoom({ scaling: { ...room.scaling, zones } })
              }}>+ Zona</button>
            </div>
            {(room.scaling?.zones || []).map((z, zi) => (
              <div key={zi} className="scaling-zone">
                <div className="scaling-zone__row">
                  <label>Y0<input type="number" min={0} max={200} value={z.y0}
                    onChange={e => { const zones=[...room.scaling.zones]; zones[zi]={...z,y0:+e.target.value}; updateRoom({scaling:{...room.scaling,zones}}) }} /></label>
                  <label>Y1<input type="number" min={0} max={200} value={z.y1}
                    onChange={e => { const zones=[...room.scaling.zones]; zones[zi]={...z,y1:+e.target.value}; updateRoom({scaling:{...room.scaling,zones}}) }} /></label>
                  <button className="btn-ghost btn-tiny" onClick={() => {
                    const zones = room.scaling.zones.filter((_,i)=>i!==zi)
                    updateRoom({scaling:{...room.scaling,zones}})
                  }}>✕</button>
                </div>
                <div className="scaling-zone__row">
                  <label>
                    <select value={z.type} onChange={e => { const zones=[...room.scaling.zones]; zones[zi]={...z,type:e.target.value}; updateRoom({scaling:{...room.scaling,zones}}) }}>
                      <option value="fixed">Fijo</option>
                      <option value="linear">Lineal</option>
                    </select>
                  </label>
                  <label>%0<input type="number" min={1} max={200} value={z.pct0}
                    onChange={e => { const zones=[...room.scaling.zones]; zones[zi]={...z,pct0:+e.target.value}; updateRoom({scaling:{...room.scaling,zones}}) }} /></label>
                  {z.type === 'linear' && <label>%1<input type="number" min={1} max={200} value={z.pct1||100}
                    onChange={e => { const zones=[...room.scaling.zones]; zones[zi]={...z,pct1:+e.target.value}; updateRoom({scaling:{...room.scaling,zones}}) }} /></label>}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="prop-row prop-row--check">
          <label>Pantalla completa (320×200)</label>
          <input type="checkbox" checked={room.fullscreen || false}
            onChange={e => updateRoom({ fullscreen: e.target.checked })} />
        </div>
        {room.fullscreen && (
          <div className="prop-hint">Sin UI de verbos ni inventario. Usa engine_exit_fullscreen() para volver al modo normal.</div>
        )}

        <div className="prop-row">
          <label>🎵 MIDI</label>
          <MidiPicker value={room.audio?.midi || ''}
            gameDir={gameDir}
            loop={room.audio?.loop !== false}
            onLoopChange={v => updateRoom({ audio: { ...room.audio, loop: v } })}
            cont={!!room.audio?.midiCont}
            onContChange={v => updateRoom({ audio: { ...room.audio, midiCont: v || null } })}
            onChange={v => updateRoom({ audio: { ...room.audio, midi: v || null } })} />
        </div>
      </Section>}

      {/* ── Herramientas ── */}
      {show('layers') && <Section title="Herramientas">
        <div className="tool-buttons">
          <button className={`tool-btn ${activeTool === TOOLS.SELECT ? 'active' : ''}`}
            onClick={() => setTool(TOOLS.SELECT)}>◻ Seleccionar</button>
          <button className={`tool-btn ${activeTool === TOOLS.PAN ? 'active' : ''}`}
            onClick={() => setTool(TOOLS.PAN)}>✋ Mover vista</button>
        </div>
      </Section>}

      {/* ── Capas ── */}
      {show('layers') && <Section title="Capas">
        {LAYER_LIST.map(l => (
          <div key={l.id} className="layer-row">
            <input type="checkbox" id={`layer-${l.id}`}
              checked={layers[l.id]} onChange={() => toggleLayer(l.id)} />
            <label htmlFor={`layer-${l.id}`}>{l.label}</label>
          </div>
        ))}
      </Section>}

      {/* ── Walkmap ── */}
      {show('walkmap') && <Section title="Walkmap">
        <div className="prop-row">
          <label>Activo</label>
          <select value={room.activeWalkmapId || ''}
            onChange={e => setActiveWalkmap(e.target.value)}>
            {room.walkmaps?.map(wm => (
              <option key={wm.id} value={wm.id}>{wm.name}</option>
            ))}
          </select>
        </div>

        <div className="wm-actions">
          <button className="btn-ghost" onClick={addWalkmap}>＋ Añadir</button>
          <button className="btn-ghost btn-ghost--danger"
            disabled={!room.walkmaps || room.walkmaps.length <= 1}
            onClick={() => room.activeWalkmapId && deleteWalkmap(room.activeWalkmapId)}>
            🗑 Borrar
          </button>
        </div>

        <div className="prop-row">
          <label>Modo</label>
          <div className="draw-mode-toggle">
            <button className={`draw-mode-btn draw-mode-btn--add ${drawMode === 'add' ? 'active' : ''}`}
              onClick={() => setDrawMode('add')} title="Sumar zona navegable">＋ Sumar</button>
            <button className={`draw-mode-btn draw-mode-btn--sub ${drawMode === 'sub' ? 'active' : ''}`}
              onClick={() => setDrawMode('sub')} title="Restar zona navegable">− Restar</button>
          </div>
        </div>

        <div className="tool-buttons">
          <button className={`tool-btn ${activeTool === TOOLS.POLYGON ? 'active' : ''}`}
            onClick={() => setTool(TOOLS.POLYGON)}>⬡ Polígono</button>
          <button className={`tool-btn ${activeTool === TOOLS.RECT ? 'active' : ''}`}
            onClick={() => setTool(TOOLS.RECT)}>▭ Rectángulo</button>
          <button className={`tool-btn ${activeTool === TOOLS.CIRCLE ? 'active' : ''}`}
            onClick={() => setTool(TOOLS.CIRCLE)}>○ Círculo</button>
        </div>

        {activeTool === TOOLS.POLYGON && pendingPolygon && pendingPolygon.length >= 3 && (
          <button className="btn-primary wm-confirm-btn" onClick={() => commitPendingPolygon()}>
            ✓ Confirmar polígono ({drawMode === 'add' ? 'sumar' : 'restar'})
          </button>
        )}

        {activeWm && (
          <div className="wm-info">
            {activeWm.shapes.length} forma{activeWm.shapes.length !== 1 ? 's' : ''}
          </div>
        )}
      </Section>}

      {/* ── Objetos en room ── */}
      {show('objects') && <Section title="Objetos en room" defaultOpen={true}>
        <ObjectInstancePanel
          room={room}
          gameDir={gameDir}
          selectedInstanceId={selectedInstanceId}
          onSelect={selectInstance}
          onAdd={addObjectInstance}
          onDelete={deleteObjectInstance}
        />
      </Section>}

      {show('characters') && <Section title="Personajes en room" defaultOpen={true}>
        <CharInstancePanel
          room={room}
          gameDir={gameDir}
          selectedCharInstId={selectedCharInstId}
          palette={activeGame?.game?.palette || []}
          onSelect={selectCharInst}
          onAdd={(charId, charName) => addCharInstance(charId, charName, Math.round(roomW/2), Math.round(roomH*0.7))}
          onDelete={deleteCharInstance}
        />
      </Section>}
      {show('exits') && <Section title="Salidas (Exits)" defaultOpen={true}>
        <ExitPanel
          room={room}
          gameDir={gameDir}
          selectedExitId={selectedExitId}
          onSelect={selectExit}
          onAdd={addExit}
          onUpdate={updateExit}
          onDelete={deleteExit}
        />
      </Section>}

      {show('exits') && <Section title="Puntos de entrada" defaultOpen={true}>
        <EntryPanel
          room={room}
          selectedEntryId={selectedEntryId}
          onSelect={selectEntry}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onDelete={deleteEntry}
        />
      </Section>}

      {show('lights') && (
        <Section title="Iluminación">
          <div className="prop-row">
            <label>Luz ambiente</label>
            <div className="light-ambient-row">
              <input type="range" min={0} max={100} value={room.ambientLight ?? 100}
                onChange={e => updateRoom({ ambientLight: +e.target.value })} />
              <span className="light-ambient-val">{room.ambientLight ?? 100}%</span>
            </div>
          </div>

          <div className="prop-row prop-row--label-only" style={{ marginTop: 10 }}>
            <label>Fuentes de luz</label>
            <button className="btn-ghost btn-xs" onClick={addLight}>＋ Añadir</button>
          </div>

          {(room.lights || []).length === 0 && (
            <div className="panel-empty">Sin fuentes de luz</div>
          )}

          {(room.lights || []).map(light => {
            const isCone = (light.coneAngle ?? 360) < 360
            const sel    = selectedLightId === light.id
            return (
              <div key={light.id}
                className={`light-card ${sel ? 'active' : ''}`}
                onClick={() => selectLight(light.id)}>
                <div className="light-card__header">
                  <span className="light-card__icon">{isCone ? '🔦' : '💡'}</span>
                  <span className="light-card__name">{light.id}</span>
                  <button className="btn-icon light-card__del"
                    onClick={e => { e.stopPropagation(); deleteLight(light.id) }}>✕</button>
                </div>

                {sel && (
                  <div className="light-card__body" onClick={e => e.stopPropagation()}>

                    {/* Posición */}
                    <div className="light-row">
                      <label>X</label>
                      <input type="number" value={light.x}
                        onChange={e => updateLight(light.id, { x: +e.target.value })} />
                      <label>Y</label>
                      <input type="number" value={light.y}
                        onChange={e => updateLight(light.id, { y: +e.target.value })} />
                    </div>

                    {/* Radio + intensidad */}
                    <div className="light-row">
                      <label>Radio</label>
                      <input type="number" min={8} max={999} value={light.radius}
                        onChange={e => updateLight(light.id, { radius: +e.target.value })} />
                      <label>Int.</label>
                      <input type="number" min={0} max={100} value={light.intensity}
                        onChange={e => updateLight(light.id, { intensity: +e.target.value })} />
                    </div>

                    {/* Ángulo del cono */}
                    <div className="light-row">
                      <label>Ángulo</label>
                      <input type="number" min={10} max={360} value={light.coneAngle ?? 360}
                        onChange={e => updateLight(light.id, { coneAngle: +e.target.value })} />
                      <span className="light-unit">° (360=omni)</span>
                    </div>

                    {/* Dirección — solo si es cono */}
                    {isCone && (
                      <div className="light-row">
                        <label>Dir X</label>
                        <input type="number" min={-1} max={1} step={0.1} value={light.dirX ?? 1}
                          onChange={e => updateLight(light.id, { dirX: +e.target.value })} />
                        <label>Dir Y</label>
                        <input type="number" min={-1} max={1} step={0.1} value={light.dirY ?? 0}
                          onChange={e => updateLight(light.id, { dirY: +e.target.value })} />
                      </div>
                    )}

                    {/* Parpadeo */}
                    <div className="light-section-label">Parpadeo</div>
                    <div className="light-row">
                      <label>Amp.</label>
                      <input type="number" min={0} max={100} value={light.flicker?.amplitude ?? 0}
                        onChange={e => updateLightFlicker(light.id, { amplitude: +e.target.value })} />
                      <label>Hz</label>
                      <input type="number" min={0.1} max={20} step={0.1} value={light.flicker?.speed ?? 2}
                        onChange={e => updateLightFlicker(light.id, { speed: +e.target.value })} />
                    </div>
                    <div className="light-row">
                      <label>Ruido</label>
                      <input type="range" min={0} max={1} step={0.05} value={light.flicker?.noise ?? 0.3}
                        onChange={e => updateLightFlicker(light.id, { noise: +e.target.value })} />
                      <span className="light-unit">{(light.flicker?.noise ?? 0.3).toFixed(2)}</span>
                    </div>

                  </div>
                )}
              </div>
            )
          })}
        </Section>
      )}

    </div>
  )
}
