import { useState, useRef, useCallback, useEffect } from 'react'
import { useAppStore } from '../../store/appStore'
import { convertToPCX, loadImageFile, normalizePcxName, pcxFileToDataURL } from '../../utils/pcxConverter'
import AssetEditor from './AssetEditor'
import './AssetStudio.css'

const ASSET_TYPES = [
  { id: 'backgrounds', label: 'Fondo',   icon: '🏞' },
  { id: 'sprites',     label: 'Sprite',  icon: '🧍' },
  { id: 'objects',     label: 'Objeto',  icon: '📦' },
  { id: 'fonts',       label: 'Fuente',  icon: '🔤' },
]

const STUDIO_TABS = [
  { id: 'assets',       label: 'Assets',       icon: '🖼' },
  { id: 'editor',       label: 'Editor',        icon: '✏' },
  { id: 'herramientas', label: 'Herramientas',  icon: '🔧' },
]

const TOOLS = [
  { id: 'spritesheet', label: 'Spritesheet', icon: '✂' },
]

// ── Selector de crop ──────────────────────────────────────────────────────────

function CropSelector({ srcImage, crop, onCropChange }) {
  const canvasRef = useRef(null)
  const dragRef   = useRef(null)
  const MAX_DISPLAY = 340

  const scale = Math.min(1, MAX_DISPLAY / Math.max(srcImage.width, srcImage.height))
  const dispW = Math.round(srcImage.width  * scale)
  const dispH = Math.round(srcImage.height * scale)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const tmp = document.createElement('canvas')
    tmp.width = srcImage.width; tmp.height = srcImage.height
    tmp.getContext('2d').putImageData(srcImage.imageData, 0, 0)
    ctx.clearRect(0, 0, dispW, dispH)
    ctx.drawImage(tmp, 0, 0, dispW, dispH)
    if (crop) {
      const cx = crop.x * scale, cy = crop.y * scale
      const cw = crop.w * scale, ch = crop.h * scale
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, dispW, dispH)
      ctx.clearRect(cx, cy, cw, ch)
      ctx.drawImage(tmp, crop.x, crop.y, crop.w, crop.h, cx, cy, cw, ch)
      ctx.strokeStyle = '#5a9fd4'
      ctx.lineWidth = 1.5
      ctx.strokeRect(cx, cy, cw, ch)
    }
  }, [srcImage, crop, dispW, dispH, scale])

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.round((e.clientX - rect.left) / scale),
      y: Math.round((e.clientY - rect.top)  / scale),
    }
  }
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

  const onDown = (e) => { e.preventDefault(); dragRef.current = getPos(e) }
  const onMove = (e) => {
    if (!dragRef.current) return
    const { x, y } = getPos(e)
    const { x: sx, y: sy } = dragRef.current
    const x1 = clamp(Math.min(sx, x), 0, srcImage.width)
    const y1 = clamp(Math.min(sy, y), 0, srcImage.height)
    const x2 = clamp(Math.max(sx, x), 0, srcImage.width)
    const y2 = clamp(Math.max(sy, y), 0, srcImage.height)
    if (x2 - x1 > 2 && y2 - y1 > 2) onCropChange({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
  }
  const onUp = () => { dragRef.current = null }

  return (
    <div className="crop-selector">
      <div className="crop-selector__label">
        {srcImage.width}×{srcImage.height}px
        {crop && <span className="crop-accent"> · sel: {crop.w}×{crop.h}</span>}
      </div>
      <div className="crop-selector__wrap">
        <canvas ref={canvasRef} width={dispW} height={dispH}
          style={{ cursor: 'crosshair', display: 'block' }}
          onMouseDown={onDown} onMouseMove={onMove}
          onMouseUp={onUp} onMouseLeave={onUp}
        />
      </div>
      <button className="btn-ghost crop-reset"
        onClick={() => onCropChange({ x: 0, y: 0, w: srcImage.width, h: srcImage.height })}>
        Resetear selección
      </button>
    </div>
  )
}

// ── Panel izquierdo: importador ───────────────────────────────────────────────

function Importer({ palette, gameDir, onSaved, onPreviewChange }) {
  const [srcImage, setSrcImage]   = useState(null)
  const [crop, setCrop]           = useState(null)
  const [outW, setOutW]           = useState(320)
  const [outH, setOutH]           = useState(144)
  const [lockRatio, setLockRatio] = useState(true)
  const [dithering, setDithering] = useState(false)
  const [assetType, setAssetType] = useState('backgrounds')
  const [pcxName, setPcxName]     = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')
  const [dragOver, setDragOver]   = useState(false)

  // Regenerar preview cuando cambia algo relevante
  useEffect(() => {
    if (!srcImage) return
    const timer = setTimeout(() => regeneratePreview(), 80)
    return () => clearTimeout(timer)
  }, [srcImage, crop, outW, outH, dithering, palette])

  function getCropRegion() {
    const { imageData, width, height } = srcImage
    const c = crop || { x: 0, y: 0, w: width, h: height }
    const tmp = document.createElement('canvas')
    tmp.width = c.w; tmp.height = c.h
    const ctx = tmp.getContext('2d')
    const full = document.createElement('canvas')
    full.width = width; full.height = height
    full.getContext('2d').putImageData(imageData, 0, 0)
    ctx.drawImage(full, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h)
    return ctx.getImageData(0, 0, c.w, c.h)
  }

  function regeneratePreview() {
    try {
      const region = getCropRegion()
      const { previewUrl } = convertToPCX(region, outW, outH, palette, dithering)
      onPreviewChange({ url: previewUrl, w: outW, h: outH })
      setError('')
    } catch (e) { setError('Error preview: ' + e.message) }
  }

  async function loadFile(file) {
    setError('')
    try {
      const { imageData, width, height } = await loadImageFile(file)
      setSrcImage({ imageData, width, height, fileName: file.name })
      setCrop({ x: 0, y: 0, w: width, h: height })
      // Suggest normalized name but let user edit freely
      const suggested = normalizePcxName(file.name)
      setPcxName(suggested)
      setOutW(width); setOutH(height)
    } catch (e) { setError('No se pudo cargar: ' + e.message) }
  }

  const handleDrop = useCallback(async (e) => {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }, [])

  function handleOutW(val) {
    const w = Math.max(1, Math.min(9999, Number(val) || 1))
    setOutW(w)
    if (lockRatio && srcImage) {
      const region = crop || { w: srcImage.width, h: srcImage.height }
      setOutH(Math.round(w * (region.h / region.w)))
    }
  }

  function handleOutH(val) {
    const h = Math.max(1, Math.min(9999, Number(val) || 1))
    setOutH(h)
    if (lockRatio && srcImage) {
      const region = crop || { w: srcImage.width, h: srcImage.height }
      setOutW(Math.round(h * (region.w / region.h)))
    }
  }

  async function handleSave() {
    if (!srcImage) return
    const nameToUse = pcxName || normalizePcxName(srcImage.fileName)
    if (!/^[A-Z0-9_]+\.PCX$/.test(nameToUse)) {
      setError('El nombre solo puede contener letras (A-Z), números y _ seguido de .PCX')
      return
    }
    setSaving(true); setError('')
    try {
      const region = getCropRegion()
      const { pcxBuffer } = convertToPCX(region, outW, outH, palette, dithering)
      const rawName = nameToUse
      const resolved = await window.api.resolvePcxName(gameDir, assetType, rawName)
      if (!resolved.ok) throw new Error(resolved.error)
      const result = await window.api.writeBinary(resolved.path, Array.from(pcxBuffer))
      if (!result.ok) throw new Error(result.error)
      onSaved({ type: assetType, name: resolved.name, path: resolved.path })
      // Reset so user can import another asset — drop zone gets focus
      setSrcImage(null)
      setPcxName('')
    } catch (e) { setError('Error al guardar: ' + e.message) }
    setSaving(false)
  }

  return (
    <div className="importer">
      {!srcImage ? (
        <div
          className={`drop-zone ${dragOver ? 'drop-zone--over' : ''}`}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
        >
          <span className="drop-zone__icon">🖼</span>
          <p>Arrastra una imagen aquí</p>
          <p className="drop-zone__sub">PNG · JPG · BMP · PCX</p>
          <label className="btn-secondary drop-zone__btn">
            Examinar...
            <input type="file" accept=".png,.jpg,.jpeg,.bmp,.pcx"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = '' }}
            />
          </label>
        </div>
      ) : (
        <>
          <CropSelector srcImage={srcImage} crop={crop} onCropChange={setCrop} />

          <div className="importer__controls">
            {/* Tipo */}
            <div className="ctrl-group">
              <label className="ctrl-label">Tipo</label>
              <div className="type-selector">
                {ASSET_TYPES.map(t => (
                  <button key={t.id}
                    className={`type-btn ${assetType === t.id ? 'active' : ''}`}
                    onClick={() => setAssetType(t.id)}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Nombre */}
            <div className="ctrl-group">
              <label className="ctrl-label">Nombre PCX</label>
              <input type="text" value={pcxName} maxLength={64} placeholder="NOMBRE.PCX"
                onChange={e => setPcxName(e.target.value.toUpperCase())} />
              {pcxName && !/^[A-Z0-9_]+\.PCX$/.test(pcxName) && (
                <span className="field-warn">⚠ Solo A-Z, 0-9, _ seguido de .PCX</span>
              )}
            </div>

            {/* Tamaño */}
            <div className="ctrl-group">
              <label className="ctrl-label">Tamaño salida (px)</label>
              <div className="size-controls">
                <input type="number" value={outW} min={1} max={9999}
                  onChange={e => handleOutW(e.target.value)} />
                <span className="size-sep">×</span>
                <input type="number" value={outH} min={1} max={9999}
                  onChange={e => handleOutH(e.target.value)} />
                <button className={`btn-icon lock-btn ${lockRatio ? 'active' : ''}`}
                  onClick={() => setLockRatio(v => !v)}
                  title={lockRatio ? 'Ratio bloqueado' : 'Ratio libre'}>
                  {lockRatio ? '🔒' : '🔓'}
                </button>
              </div>
            </div>

            {/* Dithering */}
            <div className="ctrl-group ctrl-group--row">
              <label className="ctrl-label">Floyd-Steinberg</label>
              <input type="checkbox" checked={dithering}
                onChange={e => setDithering(e.target.checked)} />
            </div>

            {error && <div className="form-error">{error}</div>}

            <div className="ctrl-group ctrl-group--actions">
              <button className="btn-secondary"
                onClick={() => { setSrcImage(null); onPreviewChange(null) }}>
                Limpiar
              </button>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Guardando...' : '💾 Guardar PCX'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Panel derecho arriba: miniaturas de assets ────────────────────────────────

function AssetList({ gameDir, palette, refreshKey }) {
  const [type, setType]     = useState('backgrounds')
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { load() }, [type, gameDir, refreshKey])

  async function load() {
    setLoading(true)
    const result = await window.api.listAssets(gameDir, type)
    if (result.ok) setAssets(result.files)
    setLoading(false)
  }

  async function handleDelete(asset) {
    // Solo comprobar usos si es un background
    if (type === 'backgrounds') {
      const res = await window.api.findAssetUses(gameDir, asset.name)
      if (res.ok && res.uses.length > 0) {
        const seqNames = [...new Set(res.uses.map(u => u.seqName))].join(', ')
        const msg = `"${asset.name}" se usa en ${res.uses.length} paso(s) de las secuencias: ${seqNames}.\n\n¿Eliminar el asset y los pasos que lo usan?`
        if (!confirm(msg)) return
        await window.api.removeSeqSteps(gameDir, res.uses.map(u => ({ seqId: u.seqId, stepId: u.stepId })))
      } else {
        if (!confirm(`¿Eliminar ${asset.name}?`)) return
      }
    } else {
      if (!confirm(`¿Eliminar ${asset.name}?`)) return
    }
    await window.api.deleteAsset(asset.path)
    load()
  }

  return (
    <div className="asset-list">
      <div className="asset-list__tabs">
        {ASSET_TYPES.map(t => (
          <button key={t.id}
            className={`asset-tab ${type === t.id ? 'active' : ''}`}
            onClick={() => setType(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="asset-list__grid">
        {loading && <div className="asset-list__empty">Cargando...</div>}
        {!loading && assets.length === 0 && (
          <div className="asset-list__empty">Sin assets. Importa uno.</div>
        )}
        {!loading && assets.map(asset => (
          <AssetCard key={asset.path} asset={asset} palette={palette}
            onDelete={() => handleDelete(asset)}
            onRenamed={load} />
        ))}
      </div>
    </div>
  )
}

function AssetCard({ asset, palette, onDelete, onRenamed }) {
  const [thumbUrl, setThumbUrl]   = useState(null)
  const [renaming, setRenaming]   = useState(false)
  const [newName, setNewName]     = useState(asset.name)
  const [renameErr, setRenameErr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    window.api.readBinary(asset.path).then(r => {
      if (r.ok) setThumbUrl(pcxFileToDataURL(new Uint8Array(r.buffer), palette))
    })
  }, [asset.path])

  useEffect(() => {
    if (renaming) { setNewName(asset.name); inputRef.current?.select() }
  }, [renaming])

  async function handleRename() {
    const name = newName.trim().toUpperCase()
    if (!/^[A-Z0-9_]{1,8}\.PCX$/.test(name)) {
      setRenameErr('Formato inválido: máx. 8 caracteres (A-Z 0-9 _) + .PCX')
      return
    }
    if (name === asset.name) { setRenaming(false); return }
    const result = await window.api.renameAsset(asset.path, name)
    if (result.ok) { setRenaming(false); setRenameErr(''); onRenamed() }
    else setRenameErr(result.error)
  }

  return (
    <div className="asset-card">
      <div className="asset-card__thumb">
        {thumbUrl
          ? <img src={thumbUrl} alt={asset.name} style={{ imageRendering: 'pixelated' }} />
          : <span>⏳</span>}
      </div>
      {renaming ? (
        <div className="asset-card__rename">
          <input ref={inputRef} type="text" value={newName}
            onChange={e => { setNewName(e.target.value.toUpperCase()); setRenameErr('') }}
            onKeyDown={e => { if (e.key==='Enter') handleRename(); if (e.key==='Escape') { setRenaming(false); setRenameErr('') } }}
            maxLength={12} />
          {renameErr && <span className="field-warn">{renameErr}</span>}
          <div className="asset-card__rename-btns">
            <button className="btn-primary" onClick={handleRename}>✓</button>
            <button className="btn-ghost"   onClick={() => { setRenaming(false); setRenameErr('') }}>✕</button>
          </div>
        </div>
      ) : (
        <div className="asset-card__name" title={asset.name}
          onDoubleClick={() => setRenaming(true)}>{asset.name}</div>
      )}
      <div className="asset-card__actions">
        <button className="btn-icon" title="Renombrar (doble clic en nombre)" onClick={() => setRenaming(true)}>✏</button>
        <button className="btn-icon asset-card__del" title="Eliminar" onClick={onDelete}>🗑</button>
      </div>
    </div>
  )
}

// ── Panel derecho abajo: preview PCX ─────────────────────────────────────────

function PCXPreview({ preview }) {
  const [zoom, setZoom] = useState(1)

  if (!preview) return (
    <div className="pcx-preview pcx-preview--empty">
      <span>Sin preview — importa una imagen</span>
    </div>
  )

  return (
    <div className="pcx-preview">
      <div className="pcx-preview__header">
        <span>Preview PCX — {preview.w}×{preview.h}px</span>
        <div className="pcx-preview__zoom-row">
          <span className="ctrl-label">Zoom</span>
          <input
            type="range"
            min={0.25} max={5} step={0.25}
            value={zoom}
            onChange={e => setZoom(Number(e.target.value))}
            className="zoom-slider"
          />
          <span className="zoom-val">{zoom % 1 === 0 ? zoom : zoom.toFixed(2)}x</span>
        </div>
      </div>
      <div className="pcx-preview__canvas-wrap">
        <img
          src={preview.url}
          alt="Preview PCX"
          style={{
            imageRendering: 'pixelated',
            width:  preview.w * zoom,
            height: preview.h * zoom,
          }}
        />
      </div>
    </div>
  )
}

// ── Spritesheet tool (HTML embebido via Blob URL) ─────────────────────────────

function SpritesheetTool() {
  const [blobUrl, setBlobUrl] = useState(null)
  const [error, setError]    = useState('')

  useEffect(() => {
    let url = null
    window.api.readToolHtml('recorte_pro.html').then(r => {
      if (!r.ok) { setError(r.error || 'No se pudo cargar la herramienta'); return }
      const blob = new Blob([r.content], { type: 'text/html' })
      url = URL.createObjectURL(blob)
      setBlobUrl(url)
    })
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [])

  if (error)   return <div className="tool-status tool-error">{error}</div>
  if (!blobUrl) return <div className="tool-status">Cargando herramienta...</div>

  return <iframe src={blobUrl} className="tool-iframe" title="Spritesheet Tool" />
}

// ── Panel de herramientas ─────────────────────────────────────────────────────

function ToolsPanel() {
  const [activeTool, setActiveTool] = useState('spritesheet')

  return (
    <div className="tools-panel">
      <div className="asset-list__tabs">
        {TOOLS.map(t => (
          <button key={t.id}
            className={`asset-tab ${activeTool === t.id ? 'active' : ''}`}
            onClick={() => setActiveTool(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="tools-panel__body">
        {activeTool === 'spritesheet' && <SpritesheetTool />}
      </div>
    </div>
  )
}

// ── AssetStudio root ──────────────────────────────────────────────────────────

export default function AssetStudio() {
  const { activeGame } = useAppStore()
  const [activeTab, setActiveTab]   = useState('assets')
  const [refreshKey, setRefreshKey] = useState(0)
  const [preview, setPreview]       = useState(null)

  const palette = activeGame?.game?.palette || []
  const gameDir = activeGame?.gameDir

  return (
    <div className="asset-studio">
      {/* Tabs de nivel superior */}
      <div className="studio-tabs">
        {STUDIO_TABS.map(t => (
          <button key={t.id}
            className={`studio-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Cuerpo: assets o herramientas */}
      <div className="asset-studio__body">
        {activeTab === 'assets' && (
          <>
            {/* Columna izquierda: importador */}
            <div className="asset-studio__left">
              <div className="panel-header">Importar imagen</div>
              <div className="asset-studio__left-scroll">
                <Importer
                  palette={palette}
                  gameDir={gameDir}
                  onSaved={() => setRefreshKey(k => k + 1)}
                  onPreviewChange={setPreview}
                />
              </div>
            </div>

            {/* Columna derecha: miniaturas arriba + preview abajo */}
            <div className="asset-studio__right">
              <div className="asset-studio__right-top">
                <div className="panel-header">Assets del juego</div>
                <AssetList gameDir={gameDir} palette={palette} refreshKey={refreshKey} />
              </div>
              <div className="asset-studio__right-bottom">
                <div className="panel-header">Preview PCX</div>
                <PCXPreview preview={preview} />
              </div>
            </div>
          </>
        )}

        {activeTab === 'editor' && (
          <AssetEditor gameDir={gameDir} palette={palette} />
        )}

        {activeTab === 'herramientas' && <ToolsPanel />}
      </div>
    </div>
  )
}
