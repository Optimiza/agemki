import { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../../store/appStore'
import { useLocaleStore } from '../../store/localeStore'
import './EditorLayout.css'

// ── Botón ▶ Play ──────────────────────────────────────────────────────────────
// Atajo rápido para compilar en modo debug y lanzar DOSBox-X.
// Equivale al botón "Build + Run (F7)" del módulo Build.
function PlayButton({ gameDir }) {
  const [state, setState] = useState('idle') // 'idle' | 'building' | 'done' | 'error'

  async function handlePlay() {
    if (state === 'building' || !gameDir) return
    setState('building')
    try {
      const r = await window.api.buildRun(gameDir, 'run')
      setState(r.ok ? 'done' : 'error')
      // Volver a idle tras 3 segundos para permitir otro clic
      setTimeout(() => setState('idle'), 3000)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 3000)
    }
  }

  const label = { idle: '▶ Play', building: '⏳ Compilando…', done: '✓ Lanzado', error: '✗ Error' }[state]
  const disabled = state === 'building' || !gameDir

  return (
    <button
      className={`editor-play-btn editor-play-btn--${state}`}
      onClick={handlePlay}
      disabled={disabled}
      title="Compilar en modo debug y lanzar DOSBox-X (F7)"
    >
      {label}
    </button>
  )
}

const MODULES = [
  { id: 'rooms',        label: 'Rooms',      icon: '🏠' },
  { id: 'assets',       label: 'Assets',     icon: '🖼' },
  { id: 'objects',      label: 'Objetos',    icon: '📦' },
  { id: 'characters',   label: 'Personajes', icon: '🧍' },
  { id: 'verbsets',     label: 'Verbsets',   icon: '🖱' },
  { id: 'attributes',   label: 'Atributos',  icon: '⚔️' },
  { id: 'localization', label: 'Textos',     icon: '🌐' },
  { id: 'audio',        label: 'Audio',      icon: '🎵' },
  { id: 'dialogues',    label: 'Diálogos',   icon: '💬' },
  { id: 'sequences',    label: 'Secuencias', icon: '🎬' },
  { id: 'scripts',      label: 'Scripts',    icon: '📜' },
  { id: 'gameparams',   label: 'Juego',      icon: '🎮' },
  { id: 'build',        label: 'Build',      icon: '🔨' },
  { id: 'settings',     label: 'Ajustes',    icon: '⚙️' },
]

// ── Nombre del juego editable inline ─────────────────────────────────────────

function GameNameEditor() {
  const { activeGame, updateGame } = useAppStore()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  const name = activeGame?.game?.name || ''

  const start = () => {
    setValue(name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const confirm = async () => {
    const trimmed = value.trim()
    if (!trimmed || trimmed === name) { setEditing(false); return }
    const result = await window.api.renameGame(activeGame.gameDir, trimmed)
    if (result.ok) {
      updateGame(result.game)
      useAppStore.getState().updateRecentName(activeGame.gameDir, trimmed)
    }
    setEditing(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter') confirm()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="editor-toolbar__name-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={confirm}
        onKeyDown={handleKey}
      />
    )
  }

  return (
    <span
      className="editor-toolbar__game-name"
      onDoubleClick={start}
      title="Doble click para renombrar"
    >
      {name}
    </span>
  )
}

// ── EditorLayout ──────────────────────────────────────────────────────────────


// ── Selector de idioma global ─────────────────────────────────────────────────
function LangSelector() {
  const { langs, activeLang, setActiveLang } = useLocaleStore()
  if (!langs || langs.length <= 1) return null
  return (
    <div className="lang-selector">
      {langs.map(l => (
        <button key={l}
          className={'lang-selector__btn' + (activeLang === l ? ' active' : '')}
          onClick={() => setActiveLang(l)}
          title={'Editar textos en ' + l.toUpperCase()}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

// ── PaneHeader — barra de módulo dentro de cada panel ────────────────────────
function PaneHeader({ currentModule, onSwitch, onClose }) {
  return (
    <div className="editor-pane__header">
      <div className="editor-pane__tabs">
        {MODULES.map(m => (
          <button
            key={m.id}
            className={`editor-pane__tab ${currentModule === m.id ? 'active' : ''}`}
            onClick={() => onSwitch(m.id)}
            title={m.label}
          >
            <span>{m.icon}</span>
            <span className="editor-pane__tab-label">{m.label}</span>
          </button>
        ))}
      </div>
      {onClose && (
        <button className="editor-pane__close" onClick={onClose} title="Cerrar panel">✕</button>
      )}
    </div>
  )
}

export default function EditorLayout({ children, secondary }) {
  const {
    activeGame, activeModule, setActiveModule, closeGame, theme, toggleTheme,
    splitActive, toggleSplit, secondaryModule, setSecondaryModule,
  } = useAppStore()
  const workspaceRef = useRef(null)
  const dividerRef = useRef(null)
  const [splitRatio, setSplitRatio] = useState(0.5) // fracción para el panel izquierdo

  // Draggable divider
  const startDrag = useCallback((e) => {
    e.preventDefault()
    const container = workspaceRef.current
    if (!container) return
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect()
      const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width))
      setSplitRatio(ratio)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])


  // Antes de cambiar de módulo comprueba si hay cambios sin guardar en los stores
  function checkDirtyAndSwitch(newModule, currentModule, setter) {
    if (newModule === currentModule) return
    const dirty = []
    try { if (window._stores?.dialogue?.getState().dirty)           dirty.push('Diálogos')   } catch {}
    try { if (window._stores?.script?.getState().dirty)             dirty.push('Scripts')     } catch {}
    try { if (window._stores?.sequence?.getState().dirty)           dirty.push('Secuencias')  } catch {}
    try { if (window._stores?.char?.getState().dirty)               dirty.push('Personajes')  } catch {}
    try { if (window._stores?.locale?.getState().dirty?.size > 0)   dirty.push('Textos')      } catch {}
    if (dirty.length > 0 && !confirm(`Cambios sin guardar en: ${dirty.join(', ')}.\n¿Salir sin guardar?`)) return
    setter(newModule)
  }

  const handleModuleSwitch = (newModule) => checkDirtyAndSwitch(newModule, activeModule, setActiveModule)
  const handleSecondarySwitch = (newModule) => checkDirtyAndSwitch(newModule, secondaryModule, setSecondaryModule)

  const game = activeGame?.game

  return (
    <div className="editor-layout">
      <header className="editor-toolbar">
        <div className="editor-toolbar__left">
          <PlayButton gameDir={activeGame?.gameDir} />

          <button
            className="btn-ghost editor-toolbar__home"
            onClick={closeGame}
            title="Volver al gestor de juegos"
          >
            🕹
          </button>

          <GameNameEditor />
        <LangSelector />

          <div className="editor-toolbar__sep" />

          {MODULES.map(m => (
            <button
              key={m.id}
              className={`editor-toolbar__module-btn ${activeModule === m.id ? 'active' : ''}`}
              onClick={() => handleModuleSwitch(m.id)}
            >
              <span>{m.icon}</span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <div className="editor-toolbar__right">
          <button
            className={`editor-split-btn ${splitActive ? 'active' : ''}`}
            onClick={toggleSplit}
            title={splitActive ? 'Cerrar panel dividido' : 'Abrir panel dividido'}
          >
            ⊟
          </button>
          <button
            className="btn-ghost editor-help-btn"
            onClick={() => window.api.openHelp?.()}
            title="Abrir guía de usuario"
          >
            ❓ Ayuda
          </button>
          <button className="btn-icon" onClick={toggleTheme} title="Cambiar tema">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      <main className="editor-workspace" ref={workspaceRef}>
        {splitActive ? (
          <>
            <div className="editor-pane" style={{ flex: `0 0 ${(splitRatio * 100).toFixed(1)}%` }}>
              <PaneHeader currentModule={activeModule} onSwitch={handleModuleSwitch} />
              <div className="editor-pane__content">{children}</div>
            </div>
            <div className="editor-pane-divider" onMouseDown={startDrag} ref={dividerRef} />
            <div className="editor-pane" style={{ flex: 1 }}>
              <PaneHeader currentModule={secondaryModule} onSwitch={handleSecondarySwitch} onClose={toggleSplit} />
              <div className="editor-pane__content">{secondary}</div>
            </div>
          </>
        ) : children}
      </main>

      <footer className="editor-statusbar">
        <span>
          {MODULES.find(m => m.id === activeModule)?.label || '—'}
          {splitActive && <> <span className="editor-statusbar__sep">⊟</span> {MODULES.find(m => m.id === secondaryModule)?.label || '—'}</>}
        </span>
        <span className="editor-statusbar__sep">|</span>
        <span>{game?.name}</span>
        <span className="editor-statusbar__sep">|</span>
        <span className="editor-statusbar__path" title={activeGame?.gameDir}>
          {activeGame?.gameDir}
        </span>
      </footer>
    </div>
  )
}
