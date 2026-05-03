/**
 * PartyBallPanel — configura los sprites de la bola de cambio de protagonista.
 *
 * Almacena 2 sprites en game.json bajo `partyBall`:
 *   closed — bola con el popup de selección cerrado
 *   open   — bola con el popup de selección abierto
 *
 * El DAT Generator los empaqueta como chunks PCX_ con IDs:
 *   party_btn, party_btn_open
 *
 * El engine carga estos sprites en init. Si no se asigna sprite se usa
 * un círculo de fallback. La bola solo se renderiza cuando g_party_count > 1.
 */
import { useState, useEffect } from 'react'
import { useAppStore } from '../../store/appStore'

// ── Preview mínima de un PCX ──────────────────────────────────────────────────
function PCXPreview({ filename, gameDir, palette }) {
  const [url, setUrl]   = useState(null)
  const [size, setSize] = useState(null)

  useEffect(() => {
    if (!filename || !gameDir || !palette) { setUrl(null); setSize(null); return }
    let cancelled = false
    ;(async () => {
      const result = await window.api.readBinary(`${gameDir}/assets/converted/objects/${filename}`)
      if (cancelled || !result.ok) return
      const { pcxFileToDataURL } = await import('../../utils/pcxConverter')
      const u = pcxFileToDataURL(new Uint8Array(result.buffer), palette)
      if (cancelled) return
      setUrl(u)
      const img = new Image()
      img.onload = () => { if (!cancelled) setSize({ w: img.naturalWidth, h: img.naturalHeight }) }
      img.src = u
    })()
    return () => { cancelled = true }
  }, [filename, gameDir])

  if (!filename) return <div className="pcx-mini-preview pcx-mini-preview--empty"><span>Sin sprite</span></div>
  return (
    <div className="pcx-mini-preview">
      {url
        ? <><div className="pcx-mini-preview__canvas-wrap">
              <img src={url} alt={filename} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
            </div>
            {size && <span className="pcx-mini-preview__info">{size.w}×{size.h}px</span>}</>
        : <span className="pcx-mini-preview__loading">Cargando…</span>}
    </div>
  )
}

// ── Modal de selección de sprite ─────────────────────────────────────────────
function SpriteModalPicker({ gameDir, palette, onSelect, onClose }) {
  const [assets, setAssets] = useState(null)
  const [thumbs, setThumbs] = useState({})

  useEffect(() => {
    window.api.listAssets(gameDir, 'objects').then(r => {
      const files = r.ok ? r.files : []
      setAssets(files)
      files.forEach(a => {
        window.api.readBinary(a.path).then(br => {
          if (br.ok) {
            import('../../utils/pcxConverter').then(({ pcxFileToDataURL }) => {
              const url = pcxFileToDataURL(new Uint8Array(br.buffer), palette)
              setThumbs(prev => ({ ...prev, [a.name]: url }))
            })
          }
        })
      })
    })
  }, [])

  return (
    <div className="sprite-modal-overlay" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose() }}>
      <div className="sprite-modal" onClick={e => e.stopPropagation()}>
        <div className="sprite-modal__header">
          <span>Seleccionar sprite</span>
          <div className="sprite-modal__header-btns">
            <button className="btn-ghost" onClick={onClose}>Cancelar</button>
          </div>
        </div>
        <div className="sprite-modal__grid">
          {assets === null && <div className="sprite-modal__empty">Cargando…</div>}
          {assets?.length === 0 && <div className="sprite-modal__empty">Sin assets. Importa uno en Asset Studio.</div>}
          {assets?.map(a => (
            <div key={a.name} className="sprite-modal__item"
              onDoubleClick={() => onSelect(a.name)}
              onClick={e => e.currentTarget.classList.toggle('selected')}>
              <div className="sprite-modal__thumb">
                {thumbs[a.name]
                  ? <img src={thumbs[a.name]} alt={a.name} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
                  : <span>⏳</span>}
              </div>
              <div className="sprite-modal__name" title={a.name}>{a.name}</div>
              <button className="sprite-modal__select-btn btn-primary" onClick={() => onSelect(a.name)}>✓ Usar</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Picker individual ─────────────────────────────────────────────────────────
function BallSpritePicker({ label, value, gameDir, palette, onChange }) {
  const [showModal, setShowModal] = useState(false)
  return (
    <div className="arrow-sprite-picker">
      <div className="arrow-sprite-picker__label">{label}</div>
      <div className="arrow-sprite-picker__row">
        <span className="arrow-sprite-picker__current">{value || 'Sin sprite (círculo fallback)'}</span>
        <button className="btn-ghost" onClick={() => setShowModal(true)}>
          {value ? '✏ Cambiar' : '＋ Elegir'}
        </button>
        {value && (
          <button className="btn-icon" onClick={() => onChange(null)} title="Quitar sprite">✕</button>
        )}
      </div>
      <PCXPreview filename={value} gameDir={gameDir} palette={palette} />
      {showModal && (
        <SpriteModalPicker gameDir={gameDir} palette={palette}
          onSelect={name => { onChange(name); setShowModal(false) }}
          onClose={() => setShowModal(false)} />
      )}
    </div>
  )
}

// ── Panel principal ───────────────────────────────────────────────────────────
export default function PartyBallPanel() {
  const { activeGame, updateGame } = useAppStore()
  const gameDir = activeGame?.gameDir
  const game    = activeGame?.game
  const palette = game?.palette || []

  const [ball,  setBall]  = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!game) return
    setBall(game.partyBall || { closed: null, open: null })
    setDirty(false)
    setSaved(false)
  }, [game])

  function up(key, val) {
    setBall(b => ({ ...b, [key]: val }))
    setDirty(true)
    setSaved(false)
  }

  async function handleSave() {
    if (!dirty || !gameDir) return
    const updatedGame = { ...game, partyBall: ball }
    const r = await window.api.saveGame(gameDir, updatedGame)
    if (r?.ok) {
      updateGame(updatedGame)
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    }
  }

  if (!game) return (
    <div className="inv-arrows-panel inv-arrows-panel--empty">
      Abre un juego para configurar la bola de party.
    </div>
  )

  return (
    <div className="inv-arrows-panel">
      <div className="inv-arrows-panel__header">
        <div>
          <div className="inv-arrows-panel__title">Bola de cambio de personaje</div>
          <div className="inv-arrows-panel__subtitle">
            Sprites para el botón de selección de protagonista (esquina izquierda del HUD).
            Solo visible cuando hay 2 o más personajes en la party.
            Si no se asigna sprite se usa un círculo de color por defecto.
          </div>
        </div>
        <div className="inv-arrows-panel__actions">
          {dirty && <span className="dirty-dot">● sin guardar</span>}
          {saved && <span className="inv-arrows-panel__saved">✓ guardado</span>}
          <button className="btn-primary" disabled={!dirty} onClick={handleSave}>
            Guardar
          </button>
        </div>
      </div>

      {ball && (
        <div className="inv-arrows-panel__body">
          <div className="inv-arrows-group">
            <div className="inv-arrows-group__title">Selección cerrada</div>
            <div className="inv-arrows-group__pickers">
              <BallSpritePicker
                label="Estado normal"
                value={ball.closed}
                gameDir={gameDir}
                palette={palette}
                onChange={v => up('closed', v)}
              />
            </div>
          </div>

          <div className="inv-arrows-group">
            <div className="inv-arrows-group__title">Selección abierta</div>
            <div className="inv-arrows-group__pickers">
              <BallSpritePicker
                label="Estado popup visible"
                value={ball.open}
                gameDir={gameDir}
                palette={palette}
                onChange={v => up('open', v)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
