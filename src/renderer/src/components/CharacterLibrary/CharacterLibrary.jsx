import { useState, useEffect, useRef } from 'react'
import { useAppStore }    from '../../store/appStore'
import { useCharStore }   from '../../store/charStore'
import { useLocaleStore } from '../../store/localeStore'
import CharacterEditor    from './CharacterEditor'
import PartyBallPanel     from './PartyBallPanel'
import { useCharFirstFrame } from '../../hooks/useCharFirstFrame'
import './CharacterLibrary.css'

// ── Tarjeta de personaje ──────────────────────────────────────────────────────
function CharCard({ char, name, isActive, onOpen, onDelete, onDuplicate, gameDir, palette }) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef(null)
  const frameUrl = useCharFirstFrame(char, gameDir, palette)

  useEffect(() => {
    if (!menu) return
    function close(e) { if (!menuRef.current?.contains(e.target)) setMenu(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  return (
    <div className={'char-card' + (isActive ? ' active' : '')}
      onDoubleClick={onOpen}>
      <div className="char-card__avatar">
        {frameUrl
          ? <img src={frameUrl} alt={name}
              style={{ width: 40, height: 40, imageRendering: 'pixelated', objectFit: 'contain' }} />
          : (char.isProtagonist ? '🦸' : '🧍')}
      </div>
      <div className="char-card__body">
        <div className="char-card__name">{name || char.id}</div>
        <div className="char-card__meta">
          {char.isProtagonist && <span className="badge badge--proto">Protagonista</span>}
          <span className="badge">{char.animations?.length || 0} anim</span>
          {char.patrol?.length > 0 && <span className="badge badge--patrol">🔄 patrulla</span>}
        </div>
      </div>
      <div className="char-card__actions">
        <button className="btn-icon" onClick={onOpen} title="Editar">✏</button>
        <div className="ctx-wrap" ref={menuRef}>
          <button className="btn-icon" onClick={() => setMenu(m => !m)} title="Más">⋮</button>
          {menu && (
            <div className="ctx-menu">
              <button onClick={() => { onDuplicate(); setMenu(false) }}>📋 Duplicar</button>
              <button className="danger" onClick={() => { onDelete(); setMenu(false) }}>🗑 Eliminar</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function CharacterLibrary() {
  const { activeGame, updateGame } = useAppStore()
  const { chars, activeChar, loaded,
          loadChars, createChar, deleteChar, duplicateChar, openChar } = useCharStore()
  const { langs, activeLang, locales, loadAll: loadLocales,
          loaded: localesLoaded } = useLocaleStore()

  const [tab, setTab]             = useState('chars') // 'chars' | 'partyball'
  const [creating, setCreating]   = useState(false)
  const [newName, setNewName]     = useState('')
  const [newIsProto, setNewIsProto] = useState(false)
  const [filter, setFilter]       = useState('')
  const newInputRef = useRef(null)

  const gameDir = activeGame?.gameDir
  const game    = activeGame?.game

  useEffect(() => {
    if (!gameDir) return
    if (!loaded)         loadChars(gameDir)
    if (!localesLoaded)  loadLocales(gameDir)
  }, [gameDir])

  useEffect(() => {
    if (creating) newInputRef.current?.focus()
  }, [creating])

  function getName(char) {
    return (locales[activeLang] || {})[`char.${char.id}.name`]
        || (locales['es']       || {})[`char.${char.id}.name`]
        || char.id
  }

  const filtered = chars.filter(c => {
    const n = getName(c).toLowerCase()
    return !filter || n.includes(filter.toLowerCase()) || c.id.includes(filter.toLowerCase())
  })

  const protagonists = chars.filter(c => c.isProtagonist)
  const npcs         = chars.filter(c => !c.isProtagonist)

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    await createChar(gameDir, name, newIsProto)
    setCreating(false)
    setNewName('')
    setNewIsProto(false)
  }

  async function handleDelete(char) {
    if (!confirm(`¿Eliminar "${getName(char)}"? Esta acción no se puede deshacer.`)) return
    await deleteChar(gameDir, char.id)
  }

  async function handleOpen(char) {
    openChar(char)
  }

  // ── Si hay personaje activo, mostrar editor ──────────────────────────────
  if (activeChar) return <CharacterEditor />

  return (
    <div className="char-library">
      {/* Tabs */}
      <div className="obj-right-tabs">
        <button className={`obj-right-tab ${tab === 'chars' ? 'active' : ''}`}
          onClick={() => setTab('chars')}>Personajes</button>
        <button className={`obj-right-tab ${tab === 'partyball' ? 'active' : ''}`}
          onClick={() => setTab('partyball')}>Bola de party</button>
      </div>

      {tab === 'partyball' && <PartyBallPanel />}

      {tab === 'chars' && <>
      {/* Toolbar */}
      <div className="char-library__toolbar">
        <input type="text" className="char-library__search" placeholder="Buscar personaje…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ Personaje</button>
      </div>

      {/* Crear inline */}
      {creating && (
        <div className="char-create-bar">
          <input ref={newInputRef} type="text" value={newName} placeholder="Nombre del personaje…"
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }} />
          <label className="char-create-bar__proto">
            <input type="checkbox" checked={newIsProto} onChange={e => setNewIsProto(e.target.checked)} />
            Protagonista
          </label>
          <button className="btn-primary"  onClick={handleCreate}>Crear</button>
          <button className="btn-ghost"    onClick={() => { setCreating(false); setNewName('') }}>Cancelar</button>
        </div>
      )}

      <div className="char-library__content">
        {chars.length === 0 && !creating && (
          <div className="char-library__empty">
            <span>🧍</span>
            <p>Sin personajes</p>
            <small>Crea el protagonista y los NPCs de tu aventura</small>
            <button className="btn-primary" onClick={() => setCreating(true)}>＋ Crear personaje</button>
          </div>
        )}

        {protagonists.length > 0 && (
          <div className="char-section">
            <div className="char-section__title">🦸 Protagonistas</div>
            {protagonists.filter(c => !filter || getName(c).toLowerCase().includes(filter.toLowerCase())).map(c => (
              <CharCard key={c.id} char={c} name={getName(c)}
                isActive={activeChar?.id === c.id}
                onOpen={() => handleOpen(c)}
                onDelete={() => handleDelete(c)}
                onDuplicate={() => duplicateChar(gameDir, c.id)}
                gameDir={gameDir} palette={game?.palette || []} />
            ))}
          </div>
        )}

        {npcs.length > 0 && (
          <div className="char-section">
            <div className="char-section__title">🧍 NPCs</div>
            {npcs.filter(c => !filter || getName(c).toLowerCase().includes(filter.toLowerCase())).map(c => (
              <CharCard key={c.id} char={c} name={getName(c)}
                isActive={activeChar?.id === c.id}
                onOpen={() => handleOpen(c)}
                onDelete={() => handleDelete(c)}
                onDuplicate={() => duplicateChar(gameDir, c.id)}
                gameDir={gameDir} palette={game?.palette || []} />
            ))}
          </div>
        )}
      </div>
      </>}
    </div>
  )
}
