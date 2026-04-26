import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../../store/appStore'
import { useVerbsetStore } from '../../store/verbsetStore'
import { useLocaleStore } from '../../store/localeStore'
import PalettePicker from '../shared/PalettePicker'
import './VerbsetEditor.css'

const ICON_PRESETS = [
  '👁','🖐','⚙️','💬','👟','🔍','🗝','🚪','📦','🎒',
  '💡','🔧','✂️','🖊','🗡','🛡','🔓','🔒','❓','💰',
  '🤝','👋','👂','🐾','🧪','🎭','📜','🗺️','⚡','🌀',
  '👉','👈','🤲','🫳','🫴',
]

// ── Preview barra MS-DOS ──────────────────────────────────────────────────────
function VerbsetPreview({ verbset, locales, activeLang }) {
  if (!verbset?.verbs?.length) return null
  const sorted = [...verbset.verbs].sort((a, b) => a.order - b.order)
  const loc = locales[activeLang] || {}

  return (
    <div className="vs-preview">
      <div className="vs-preview__label">Vista previa — barra de verbos MS-DOS ({activeLang})</div>
      <div className="vs-preview__bar">
        {sorted.map(v => (
          <div key={v.id}
            className={`vs-preview__verb ${v.isMovement ? 'movement' : ''} ${v.isDefault ? 'default' : ''}`}>
            <span className="vs-preview__icon">{v.icon}</span>
            <span className="vs-preview__name">{loc[`verb.${v.id}`] || '—'}</span>
          </div>
        ))}
      </div>
      <div className="vs-preview__legend">
        <span className="legend-movement">█ Movimiento</span>
        <span className="legend-default">█ Por defecto</span>
      </div>
    </div>
  )
}

// ── Fila de verbo ─────────────────────────────────────────────────────────────
function VerbRow({ verb, index, total, langs, locales, palette, onUpdate, onDelete, onMove, onSetLabel }) {
  const [showIconPicker, setShowIconPicker] = useState(false)
  const pickerRef = useRef(null)

  useEffect(() => {
    if (!showIconPicker) return
    const h = e => { if (!pickerRef.current?.contains(e.target)) setShowIconPicker(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showIconPicker])

  return (
    <div className={`verb-row ${verb.isMovement ? 'verb-row--movement' : ''} ${verb.isDefault ? 'verb-row--default' : ''}`}>
      {/* Orden */}
      <div className="verb-row__order">
        <button className="btn-icon" disabled={index === 0} onClick={() => onMove(-1)} title="Subir">▲</button>
        <span className="verb-row__num">{index + 1}</span>
        <button className="btn-icon" disabled={index === total - 1} onClick={() => onMove(1)} title="Bajar">▼</button>
      </div>

      {/* Icono */}
      <div className="verb-row__icon-wrap" ref={pickerRef}>
        <button className="verb-row__icon-btn" onClick={() => setShowIconPicker(p => !p)} title="Cambiar icono">
          <span>{verb.icon || '❓'}</span>
        </button>
        {showIconPicker && (
          <div className="icon-picker">
            {ICON_PRESETS.map(ic => (
              <button key={ic} className={`icon-picker__item ${verb.icon === ic ? 'active' : ''}`}
                onClick={() => { onUpdate({ icon: ic }); setShowIconPicker(false) }}>
                {ic}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Labels por idioma */}
      <div className="verb-row__labels">
        {langs.map(lang => (
          <div key={lang} className="verb-row__label-row">
            <span className="lang-badge">{lang.toUpperCase()}</span>
            <input type="text"
              value={(locales[lang] || {})[`verb.${verb.id}`] || ''}
              onChange={e => onSetLabel(verb.id, lang, e.target.value)}
              placeholder={`Nombre en ${lang}...`} />
          </div>
        ))}
      </div>

      {/* Flags */}
      <div className="verb-row__flags">
        <label className={`flag-toggle ${verb.isMovement ? 'active' : ''}`}
          title="Verbo de movimiento — activo sin verbo seleccionado. Solo uno posible.">
          <input type="checkbox" checked={verb.isMovement}
            onChange={e => onUpdate({ isMovement: e.target.checked })} />
          <span>🚶 Mov.</span>
        </label>
        <label className={`flag-toggle ${verb.isDefault ? 'active' : ''}`}
          title="Verbo seleccionado al arrancar. Solo uno posible.">
          <input type="checkbox" checked={verb.isDefault}
            onChange={e => onUpdate({ isDefault: e.target.checked })} />
          <span>⭐ Def.</span>
        </label>
        <label className={`flag-toggle ${verb.approachObject ? 'active' : ''}`}
          title="El personaje camina hasta el objeto antes de ejecutar la acción.">
          <input type="checkbox" checked={!!verb.approachObject}
            onChange={e => onUpdate({ approachObject: e.target.checked })} />
          <span>🦶 Acercar</span>
        </label>
        <label className={`flag-toggle ${verb.isPickup ? 'active' : ''}`}
          title="Al usar este verbo sobre un objeto cogible, lo recoge y lo manda al inventario.">
          <input type="checkbox" checked={!!verb.isPickup}
            onChange={e => onUpdate({ isPickup: e.target.checked })} />
          <span>🎒 Coger</span>
        </label>
        <label className={`flag-toggle ${verb.isGive ? 'active' : ''}`}
          title="Verbo dar: seleccionar objeto inventario → esperar personaje objetivo. Party: transferencia automática. NPC: ejecuta handler engine_on_verb_inv.">
          <input type="checkbox" checked={!!verb.isGive}
            onChange={e => onUpdate({ isGive: e.target.checked })} />
          <span>🤝 Dar</span>
        </label>
      </div>

      {/* Colores de texto */}
      <div className="verb-row__colors">
        <div className="verb-color-field">
          <span className="verb-color-label">Color normal</span>
          <PalettePicker palette={palette}
            value={verb.normalColor !== undefined ? verb.normalColor : 15}
            onChange={v => onUpdate({ normalColor: v })} />
        </div>
        <div className="verb-color-field">
          <span className="verb-color-label">Color hover</span>
          <PalettePicker palette={palette}
            value={verb.hoverColor !== undefined ? verb.hoverColor : 15}
            onChange={v => onUpdate({ hoverColor: v })} />
        </div>
      </div>

      <button className="btn-icon verb-row__del" onClick={onDelete}
        disabled={total <= 1} title="Eliminar verbo">🗑</button>
    </div>
  )
}

// ── Panel editor del verbset activo ───────────────────────────────────────────
function VerbsetPanel({ gameDir, palette }) {
  const {
    activeVerbset, dirty,
    updateVerbset, updateVerb, deleteVerb, moveVerb,
    setVerbLabel, saveActiveVerbset, closeVerbset,
  } = useVerbsetStore()
  const { langs, activeLang, setActiveLang, locales } = useLocaleStore()
  const [activeTab, setActiveTab] = useState('verbos')

  if (!activeVerbset) return (
    <div className="vs-panel vs-panel--empty">
      <span>📋</span>
      <p>Selecciona un verbset para editarlo</p>
      <small>O crea uno nuevo con ＋</small>
    </div>
  )

  const sorted = [...activeVerbset.verbs].sort((a, b) => a.order - b.order)
  const hasMovement = activeVerbset.verbs.some(v => v.isMovement)
  const hasDefault  = activeVerbset.verbs.some(v => v.isDefault)

  return (
    <div className="vs-panel">
      {/* Header */}
      <div className="vs-panel__header">
        <div className="vs-panel__title">
          <input className="vs-name-input" type="text" value={activeVerbset.name}
            onChange={e => updateVerbset({ name: e.target.value })} />
          {dirty && <span className="dirty-dot">●</span>}
        </div>
        <div className="vs-panel__actions">
          {/* Selector de idioma de preview */}
          <div className="lang-tabs">
            {langs.map(l => (
              <button key={l} className={`lang-tab ${activeLang === l ? 'active' : ''}`}
                onClick={() => setActiveLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button className="btn-ghost" onClick={closeVerbset}>✕</button>
          <button className="btn-primary" disabled={!dirty}
            onClick={() => saveActiveVerbset(gameDir)}>
            💾 Guardar
          </button>
        </div>
      </div>

      {/* Warnings */}
      {!hasMovement && (
        <div className="vs-warning">
          ⚠ Sin verbo de Movimiento — el personaje no podrá moverse sin seleccionar verbo
        </div>
      )}
      {!hasDefault && (
        <div className="vs-warning vs-warning--soft">
          ℹ Sin verbo Por defecto — el juego arrancará sin ninguno preseleccionado
        </div>
      )}

      {/* Tabs */}
      <div className="vs-tabs">
        <button className={`vs-tab ${activeTab === 'verbos' ? 'vs-tab--active' : ''}`}
          onClick={() => setActiveTab('verbos')}>
          Verbos ({activeVerbset.verbs.length})
        </button>
        <button className={`vs-tab ${activeTab === 'defaults' ? 'vs-tab--active' : ''}`}
          onClick={() => setActiveTab('defaults')}>
          Respuestas por defecto
        </button>
      </div>

      {/* Tab: Vista previa + Lista de verbos */}
      {activeTab === 'verbos' && (
        <>
          <VerbsetPreview verbset={activeVerbset} locales={locales} activeLang={activeLang} />
          <div className="vs-panel__section-hint" style={{ marginBottom: 8 }}>
            Labels por idioma · clave: <code>verb.ID</code>
          </div>
          <div className="vs-verbs-list">
            {sorted.map((verb, i) => (
              <VerbRow key={verb.id} verb={verb} index={i} total={sorted.length}
                langs={langs} locales={locales} palette={palette}
                onUpdate={patch => updateVerb(verb.id, patch)}
                onDelete={() => deleteVerb(verb.id)}
                onMove={dir => moveVerb(verb.id, dir)}
                onSetLabel={(id, lang, label) => setVerbLabel(id, lang, label)} />
            ))}
          </div>
        </>
      )}

      {/* Tab: Respuestas por defecto */}
      {activeTab === 'defaults' && (
        <>
          <div className="vs-panel__section-hint" style={{ marginBottom: 8 }}>
            Si el objeto no tiene respuesta propia · clave: <code>verb.{activeVerbset.id}.ID.default</code>
          </div>
          <div className="vs-defaults-list">
            {sorted.filter(v => !v.isMovement).map(verb => (
              <div key={verb.id} className="vs-default-row">
                <span className="vs-default-row__icon">{verb.icon || '❓'}</span>
                <span className="vs-default-row__label">
                  {(locales[activeLang] || {})[`verb.${verb.id}`] || verb.id}
                </span>
                <div className="vs-default-row__inputs">
                  {langs.map(lang => {
                    const key = `verb.${activeVerbset.id}.${verb.id}.default`
                    return (
                      <div key={lang} className="vs-default-row__lang">
                        <span className="lang-badge">{lang.toUpperCase()}</span>
                        <input type="text"
                          value={(locales[lang] || {})[key] || ''}
                          onChange={e => setVerbLabel(`${activeVerbset.id}.${verb.id}.default`, lang, e.target.value)}
                          placeholder={`Respuesta en ${lang}…`} />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

    </div>
  )
}

// ── Lista de verbsets ─────────────────────────────────────────────────────────
function VerbsetList({ gameDir }) {
  const { verbsets, activeVerbset, dirty,
          loadVerbsets, createVerbset, deleteVerbset, duplicateVerbset, openVerbset } = useVerbsetStore()
  const { langs, activeLang, locales, loadAll } = useLocaleStore()
  const { activeGame, updateGame } = useAppStore()

  const [creating, setCreating]   = useState(false)
  const [newName, setNewName]     = useState('')
  const [ctxMenu, setCtxMenu]     = useState(null)
  const newInputRef               = useRef(null)

  useEffect(() => { if (gameDir) { loadVerbsets(gameDir); loadAll(gameDir) } }, [gameDir])
  useEffect(() => { if (creating) newInputRef.current?.focus() }, [creating])

  async function handleCreate() {
    const name = newName.trim() || 'Nuevo verbset'
    const vs = await createVerbset(gameDir, name)
    setCreating(false); setNewName('')
    if (vs) openVerbset(vs)
  }

  function handleOpen(vs) {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Continuar?')) return
    openVerbset(vs)
  }

  async function handleSetActive(vs) {
    const updatedGame = { ...activeGame.game, activeVerbSet: vs.id }
    const result = await window.api.saveGame(gameDir, updatedGame)
    if (result.ok) updateGame(updatedGame)
    setCtxMenu(null)
  }

  async function handleDelete(vs) {
    if (!confirm(`¿Eliminar "${vs.name}"?`)) return
    if (activeGame?.game?.activeVerbSet === vs.id) {
      const updatedGame = { ...activeGame.game, activeVerbSet: null }
      await window.api.saveGame(gameDir, updatedGame)
      updateGame(updatedGame)
    }
    deleteVerbset(gameDir, vs.id)
    setCtxMenu(null)
  }

  const activeVerbSetId = activeGame?.game?.activeVerbSet
  const loc = locales[activeLang] || {}

  return (
    <div className="vs-list-panel" onClick={() => setCtxMenu(null)}>
      <div className="vs-list-panel__header">
        <span className="vs-list-panel__title">Verbsets</span>
        <button className="btn-icon" onClick={() => setCreating(true)} title="Nuevo verbset">＋</button>
      </div>

      {verbsets.length === 0 && !creating && (
        <div className="vs-list-empty">
          <span>📋</span><p>Sin verbsets</p><small>Crea uno con ＋</small>
        </div>
      )}

      <div className="vs-list">
        {verbsets.map(vs => {
          const labels = (vs.verbs || [])
            .sort((a,b) => a.order - b.order)
            .map(v => loc[`verb.${v.id}`] || '?')
          return (
            <div key={vs.id}
              className={`vs-card ${activeVerbset?.id === vs.id ? 'selected' : ''} ${activeVerbSetId === vs.id ? 'game-active' : ''}`}
              onClick={() => handleOpen(vs)}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ vs, x: e.clientX, y: e.clientY }) }}>
              <div className="vs-card__name">
                {vs.name}
                {activeVerbSetId === vs.id && <span className="vs-active-badge">ACTIVO</span>}
              </div>
              <div className="vs-card__meta">
                {vs.verbs?.length || 0} verbos
                {vs.verbs?.some(v => v.isMovement) ? '' : ' · ⚠ sin movimiento'}
              </div>
              {/* Mini preview: iconos + primera letra del label */}
              <div className="vs-card__icons">
                {(vs.verbs || []).sort((a,b)=>a.order-b.order).slice(0,10).map((v,i) => (
                  <span key={v.id} className="vs-card__verb-chip" title={labels[i]}>
                    <span>{v.icon}</span>
                    <span className="vs-card__verb-chip-label">{labels[i]}</span>
                  </span>
                ))}
              </div>
            </div>
          )
        })}

        {creating && (
          <div className="vs-creating">
            <input ref={newInputRef} type="text" value={newName} placeholder="Nombre del verbset"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key==='Enter') handleCreate(); if (e.key==='Escape') { setCreating(false); setNewName('') } }} />
            <button className="btn-primary" onClick={handleCreate}>✓</button>
            <button className="btn-ghost" onClick={() => { setCreating(false); setNewName('') }}>✕</button>
          </div>
        )}
      </div>

      {ctxMenu && (
        <div className="ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}>
          <button onClick={() => { handleOpen(ctxMenu.vs); setCtxMenu(null) }}>✏ Editar</button>
          <button onClick={() => handleSetActive(ctxMenu.vs)}>
            {activeVerbSetId === ctxMenu.vs.id ? '✓ Verbset activo del juego' : '⭐ Establecer como activo'}
          </button>
          <button onClick={() => { duplicateVerbset(gameDir, ctxMenu.vs.id); setCtxMenu(null) }}>⧉ Duplicar</button>
          <div className="ctx-menu__sep" />
          <button className="ctx-menu__danger" onClick={() => handleDelete(ctxMenu.vs)}>🗑 Eliminar</button>
        </div>
      )}
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function VerbsetEditor() {
  const { activeGame } = useAppStore()
  const palette = activeGame?.game?.palette || []
  return (
    <div className="verbset-editor">
      <VerbsetList gameDir={activeGame?.gameDir} />
      <VerbsetPanel gameDir={activeGame?.gameDir} palette={palette} />
    </div>
  )
}
