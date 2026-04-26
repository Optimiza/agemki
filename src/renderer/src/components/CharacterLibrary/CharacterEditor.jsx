import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore }    from '../../store/appStore'
import { useDialogueStore } from '../../store/dialogueStore'
import { useCharStore }   from '../../store/charStore'
import { useLocaleStore } from '../../store/localeStore'
import { pcxFileToDataURL, getPcxDimensions } from '../../utils/pcxConverter'

// ── PCX thumbnail helper ──────────────────────────────────────────────────────
// pcxFileToFirstFrameDataURL — renders only the first frame of a spritesheet
function pcxFileToFirstFrameDataURL(buf, palette, frameWidth) {
  try {
    const dv = new DataView(buf.buffer, buf.byteOffset)
    const totalW = dv.getUint16(8, true) + 1
    const h = dv.getUint16(10, true) + 1
    const bytesPerLine = dv.getUint16(66, true)
    const fw = frameWidth && frameWidth > 0 ? Math.min(frameWidth, totalW) : totalW

    const pixels = new Uint8Array(bytesPerLine * h)
    let pos = 128, out = 0
    while (out < pixels.length && pos < buf.length - 769) {
      const byte = buf[pos++]
      if ((byte & 0xC0) === 0xC0) {
        const count = byte & 0x3F
        const val = buf[pos++]
        for (let i = 0; i < count && out < pixels.length; i++) pixels[out++] = val
      } else { pixels[out++] = byte }
    }
    const palOffset = buf.length - 769
    const usePalette = buf[palOffset] === 0x0C
      ? Array.from({ length: 256 }, (_, i) => [buf[palOffset+1+i*3], buf[palOffset+2+i*3], buf[palOffset+3+i*3]])
      : palette

    const canvas = document.createElement('canvas')
    canvas.width = fw; canvas.height = h
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(fw, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < fw; x++) {
        const idx = pixels[y * bytesPerLine + x]
        const [r, g, b] = usePalette[idx] || [0, 0, 0]
        const p = (y * fw + x) * 4
        imgData.data[p]=r; imgData.data[p+1]=g; imgData.data[p+2]=b
        imgData.data[p+3] = idx === 0 ? 0 : 255
      }
    }
    ctx.putImageData(imgData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch { return null }
}

// ── AnimPreview — reproduce la animacion frame a frame ───────────────────────
function AnimPreview({ filename, gameDir, palette, frameWidth, frameCount, fps, scale = 2, flipH = false, flipV = false }) {
  const canvasRef = useRef(null)
  const stateRef  = useRef({ frame: 0, lastTime: 0, rafId: null, frames: null })

  useEffect(() => {
    const st = stateRef.current
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null }
    st.frames = null; st.frame = 0; st.lastTime = 0

    if (!filename || !gameDir || !frameWidth || !frameCount || frameCount < 1) return

    window.api.readBinary(`${gameDir}/assets/converted/sprites/${filename}`).then(r => {
      if (!r.ok) return
      const buf = new Uint8Array(r.buffer)
      try {
        const dv = new DataView(buf.buffer, buf.byteOffset)
        const totalW       = dv.getUint16(8,  true) + 1
        const h            = dv.getUint16(10, true) + 1
        const bytesPerLine = dv.getUint16(66, true)
        const fw = Math.min(frameWidth, totalW)

        // Decodificar pixels completos
        const pixels = new Uint8Array(bytesPerLine * h)
        let pos = 128, out = 0
        while (out < pixels.length && pos < buf.length - 769) {
          const byte = buf[pos++]
          if ((byte & 0xC0) === 0xC0) {
            const count = byte & 0x3F, val = buf[pos++]
            for (let i = 0; i < count && out < pixels.length; i++) pixels[out++] = val
          } else { pixels[out++] = byte }
        }
        const palOff = buf.length - 769
        const pal = buf[palOff] === 0x0C
          ? Array.from({ length: 256 }, (_, i) => [buf[palOff+1+i*3], buf[palOff+2+i*3], buf[palOff+3+i*3]])
          : palette

        // Pre-renderizar cada frame a ImageData — respetando flipH/flipV
        const frames = []
        for (let f = 0; f < frameCount; f++) {
          const offX = f * fw
          if (offX + fw > totalW) break
          const imgData = new ImageData(fw, h)
          for (let y = 0; y < h; y++) {
            const srcY = flipV ? (h - 1 - y) : y
            for (let x = 0; x < fw; x++) {
              const srcX = flipH ? (fw - 1 - x) : x
              const idx = pixels[srcY * bytesPerLine + offX + srcX]
              const [rv, gv, bv] = pal[idx] || [0,0,0]
              const p = (y * fw + x) * 4
              imgData.data[p]=rv; imgData.data[p+1]=gv; imgData.data[p+2]=bv
              imgData.data[p+3] = idx === 0 ? 0 : 255
            }
          }
          frames.push(imgData)
        }
        if (!frames.length) return
        st.frames = frames

        // Ajustar canvas al tamaño real del sprite
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width  = fw * scale
        canvas.height = h  * scale

        // Dibujar frame 0 inmediatamente (sin esperar el primer tick de FPS)
        const drawFrame = (fi) => {
          const ctx = canvasRef.current?.getContext('2d')
          if (!ctx || !st.frames) return
          ctx.fillStyle = '#444'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          for (let ty = 0; ty < canvas.height; ty += 8)
            for (let tx = 0; tx < canvas.width; tx += 8)
              if ((Math.floor(ty/8)+Math.floor(tx/8)) % 2 === 0) {
                ctx.fillStyle = '#333'
                ctx.fillRect(tx, ty, 8, 8)
              }
          const tmp = document.createElement('canvas')
          tmp.width = st.frames[fi].width; tmp.height = st.frames[fi].height
          tmp.getContext('2d').putImageData(st.frames[fi], 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
        }
        drawFrame(0)

        if (frames.length <= 1) return  // 1 frame: no animar

        // Loop de animacion
        const msPerFrame = 1000 / Math.max(1, fps || 8)
        function tick(now) {
          if (!st.frames) return
          if (now - st.lastTime >= msPerFrame) {
            st.lastTime = now
            st.frame = (st.frame + 1) % st.frames.length
            drawFrame(st.frame)
          }
          st.rafId = requestAnimationFrame(tick)
        }
        st.rafId = requestAnimationFrame(tick)
      } catch(e) { console.error('AnimPreview decode error', e) }
    })
    return () => { if (st.rafId) cancelAnimationFrame(st.rafId); st.rafId = null }
  }, [filename, gameDir, frameWidth, frameCount, fps, scale, flipH, flipV])

  const fw = frameWidth || 32
  return (
    <canvas ref={canvasRef}
      width={fw * scale} height={32 * scale}
      style={{ imageRendering:'pixelated', border:'1px solid #334', borderRadius:3, background:'#333', display:'block' }}
      title={`${frameCount} frames @ ${fps} fps — ${fw}px/frame${flipH?' ↔':''}${flipV?' ↕':''}`}
    />
  )
}

// ── CharLightPreview — sprite idle animado + overlay de la fuente de luz ────
function CharLightPreview({ char, gameDir, palette }) {
  const canvasRef = useRef(null)
  const stateRef  = useRef({ rafId: null, frames: null, frame: 0, lastTime: 0 })

  const roles = char.animRoles || {}
  const anims = char.animations || []
  const idleAnim = anims.find(a => a.id === roles.idle) || null
  const light = char.light || {}

  const SCALE = 3  // px de canvas por px de sprite

  // Decodifica el PCX idle y arranca el loop
  useEffect(() => {
    const st = stateRef.current
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null }
    st.frames = null; st.frame = 0

    if (!idleAnim?.spriteFile || !gameDir) return
    const { spriteFile, frameWidth, frameCount = 1, fps = 8 } = idleAnim

    window.api.readBinary(`${gameDir}/assets/converted/sprites/${spriteFile}`).then(r => {
      if (!r.ok) return
      const buf = new Uint8Array(r.buffer)
      try {
        const dv = new DataView(buf.buffer, buf.byteOffset)
        const totalW       = dv.getUint16(8,  true) + 1
        const h            = dv.getUint16(10, true) + 1
        const bytesPerLine = dv.getUint16(66, true)
        const fw = frameWidth && frameWidth > 0 ? Math.min(frameWidth, totalW) : totalW
        const fc = frameCount || 1

        const pixels = new Uint8Array(bytesPerLine * h)
        let pos = 128, out = 0
        while (out < pixels.length && pos < buf.length - 769) {
          const byte = buf[pos++]
          if ((byte & 0xC0) === 0xC0) {
            const count = byte & 0x3F, val = buf[pos++]
            for (let i = 0; i < count && out < pixels.length; i++) pixels[out++] = val
          } else { pixels[out++] = byte }
        }
        const palOff = buf.length - 769
        const pal = buf[palOff] === 0x0C
          ? Array.from({ length: 256 }, (_, i) => [buf[palOff+1+i*3], buf[palOff+2+i*3], buf[palOff+3+i*3]])
          : palette

        const frames = []
        for (let f = 0; f < fc; f++) {
          const offX = f * fw
          if (offX + fw > totalW) break
          const id = new ImageData(fw, h)
          for (let y = 0; y < h; y++) for (let x = 0; x < fw; x++) {
            const idx = pixels[y * bytesPerLine + offX + x]
            const [rv, gv, bv] = pal[idx] || [0,0,0]
            const p = (y * fw + x) * 4
            id.data[p]=rv; id.data[p+1]=gv; id.data[p+2]=bv
            id.data[p+3] = idx === 0 ? 0 : 255
          }
          frames.push({ id, fw, h })
        }
        if (!frames.length) return
        st.frames = frames

        const canvas = canvasRef.current
        if (!canvas) return
        // Canvas: sprite + halo de luz encima
        const fw0 = frames[0].fw, h0 = frames[0].h
        const padding = Math.round((light.radius || 60) * SCALE * 1.1)
        canvas.width  = fw0 * SCALE + padding * 2
        canvas.height = h0  * SCALE + padding * 2
        st.fw0 = fw0; st.h0 = h0; st.padding = padding

        function draw(fi) {
          const canvas = canvasRef.current
          if (!canvas || !st.frames) return
          const ctx = canvas.getContext('2d')
          const { fw, h, id } = st.frames[fi]
          const W = canvas.width, H = canvas.height
          const pad = st.padding

          // Fondo damero
          ctx.clearRect(0, 0, W, H)
          for (let ty = 0; ty < H; ty += 8)
            for (let tx = 0; tx < W; tx += 8) {
              ctx.fillStyle = (Math.floor(ty/8)+Math.floor(tx/8)) % 2 === 0 ? '#2a2a2a' : '#1e1e1e'
              ctx.fillRect(tx, ty, 8, 8)
            }

          if (light.enabled) {
            const ox  = (light.offsetX ?? 0) * SCALE
            const oy  = (light.offsetY ?? -16) * SCALE
            const r   = (light.radius  ?? 60)  * SCALE
            // Sprite center (pies = bottom-center)
            const spriteCX = pad + fw * SCALE / 2
            const spriteCY = pad + h  * SCALE
            const lx = spriteCX + ox
            const ly = spriteCY + oy
            const angle = light.coneAngle ?? 360
            const isCone = angle < 360

            ctx.save()
            if (isCone) {
              const half = (angle / 2) * (Math.PI / 180)
              // dirección: omni → apunta a la derecha (el motor usa char.dir)
              const baseA = 0
              const grad = ctx.createRadialGradient(lx, ly, 0, lx, ly, r)
              grad.addColorStop(0,   'rgba(255,220,80,0.55)')
              grad.addColorStop(0.6, 'rgba(255,180,40,0.20)')
              grad.addColorStop(1,   'rgba(255,180,40,0)')
              ctx.beginPath()
              ctx.moveTo(lx, ly)
              ctx.arc(lx, ly, r, baseA - half, baseA + half)
              ctx.closePath()
              ctx.fillStyle = grad
              ctx.fill()
              ctx.strokeStyle = 'rgba(255,210,60,0.7)'
              ctx.lineWidth = 1; ctx.setLineDash([3,3])
              ctx.stroke(); ctx.setLineDash([])
              ctx.beginPath()
              ctx.moveTo(lx, ly)
              ctx.lineTo(lx + Math.cos(baseA) * r, ly + Math.sin(baseA) * r)
              ctx.strokeStyle = 'rgba(255,220,80,0.6)'; ctx.lineWidth = 1
              ctx.stroke()
            } else {
              const grad = ctx.createRadialGradient(lx, ly, 0, lx, ly, r)
              grad.addColorStop(0,   'rgba(255,220,80,0.50)')
              grad.addColorStop(0.6, 'rgba(255,180,40,0.18)')
              grad.addColorStop(1,   'rgba(255,180,40,0)')
              ctx.beginPath()
              ctx.arc(lx, ly, r, 0, Math.PI * 2)
              ctx.fillStyle = grad; ctx.fill()
              ctx.strokeStyle = 'rgba(255,210,60,0.6)'
              ctx.lineWidth = 1; ctx.setLineDash([3,3])
              ctx.stroke(); ctx.setLineDash([])
            }
            // Punto de origen de la luz
            ctx.beginPath()
            ctx.arc(lx, ly, 4, 0, Math.PI * 2)
            ctx.fillStyle = '#ffe040'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5
            ctx.fill(); ctx.stroke()
            // Cruz
            ctx.beginPath()
            ctx.moveTo(lx-7, ly); ctx.lineTo(lx+7, ly)
            ctx.moveTo(lx, ly-7); ctx.lineTo(lx, ly+7)
            ctx.strokeStyle = 'rgba(255,230,80,0.8)'; ctx.lineWidth = 1; ctx.stroke()
            ctx.restore()
          }

          // Sprite encima del halo
          const tmp = document.createElement('canvas')
          tmp.width = fw; tmp.height = h
          tmp.getContext('2d').putImageData(id, 0, 0)
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(tmp, pad, pad, fw * SCALE, h * SCALE)

          // Marco del sprite (referencia)
          ctx.strokeStyle = 'rgba(100,100,255,0.3)'
          ctx.lineWidth = 1
          ctx.strokeRect(pad, pad, fw * SCALE, h * SCALE)
        }

        st.draw = draw
        draw(0)
        if (frames.length <= 1) return
        const msPerFrame = 1000 / Math.max(1, fps)
        function tick(now) {
          if (!st.frames) return
          if (now - st.lastTime >= msPerFrame) {
            st.lastTime = now
            st.frame = (st.frame + 1) % st.frames.length
            st.draw && st.draw(st.frame)
          }
          st.rafId = requestAnimationFrame(tick)
        }
        st.rafId = requestAnimationFrame(tick)
      } catch(e) { console.error('CharLightPreview error', e) }
    })
    return () => { if (st.rafId) cancelAnimationFrame(st.rafId); st.rafId = null }
  }, [idleAnim?.spriteFile, idleAnim?.frameWidth, idleAnim?.frameCount, idleAnim?.fps,
      light.enabled, light.offsetX, light.offsetY, light.radius, light.coneAngle,
      gameDir])

  if (!idleAnim?.spriteFile) return (
    <div className="char-light-preview char-light-preview--empty">
      Sin animación idle asignada
    </div>
  )
  return (
    <div className="char-light-preview">
      <canvas ref={canvasRef} style={{ imageRendering: 'pixelated', display: 'block', maxWidth: '100%' }} />
      {light.enabled && (
        <div className="char-light-preview__legend">
          Radio {light.radius ?? 60}px · Int. {light.intensity ?? 80}% · {(light.coneAngle ?? 360) >= 360 ? 'Omni' : `Cono ${light.coneAngle}°`}
          {(light.flicker?.amplitude ?? 0) > 0 ? ` · Parpadeo ${light.flicker.amplitude}%` : ''}
        </div>
      )}
    </div>
  )
}

function PCXThumb({ filename, gameDir, palette, size = 48, frameWidth = null }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!filename || !gameDir) return
    setUrl(null)
    window.api.readBinary(`${gameDir}/assets/converted/sprites/${filename}`)
      .then(r => {
        if (!r.ok) return
        const buf = new Uint8Array(r.buffer)
        setUrl(frameWidth
          ? pcxFileToFirstFrameDataURL(buf, palette, frameWidth)
          : pcxFileToDataURL(buf, palette))
      })
  }, [filename, gameDir, frameWidth])
  if (!url) return <div className="pcx-thumb pcx-thumb--empty" style={{ width: size, height: size }}>?</div>
  return <img className="pcx-thumb" src={url} alt={filename}
    style={{ width: size, height: size, imageRendering: 'pixelated', objectFit: 'contain', background: '#111' }} />
}

// ── Sprite picker para animaciones (inline select) ────────────────────────────
function SpritePicker({ value, gameDir, palette, onChange }) {
  const [assets, setAssets] = useState(null)
  const [open, setOpen]     = useState(false)
  const [thumbs, setThumbs] = useState({})
  const overlayRef = useRef(null)

  useEffect(() => {
    if (!open) return
    if (assets) return
    window.api.listAssets(gameDir, 'sprites').then(r => {
      const files = r.ok ? r.files : []
      setAssets(files)
      files.forEach(a => {
        window.api.readBinary(a.path).then(br => {
          if (br.ok) setThumbs(prev => ({
            ...prev,
            [a.name]: pcxFileToDataURL(new Uint8Array(br.buffer), palette)
          }))
        })
      })
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    function close(e) { if (!overlayRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="anim-sprite-picker" ref={overlayRef}>
      <button className="btn-ghost anim-sprite-picker__btn" onClick={() => setOpen(o => !o)}>
        {value ? <><PCXThumb filename={value} gameDir={gameDir} palette={palette} size={24} /> {value}</> : '＋ Elegir sprite'}
      </button>
      {value && <button className="btn-icon" onClick={() => onChange(null)} title="Quitar">✕</button>}
      {open && (
        <div className="anim-sprite-picker__dropdown">
          <div className="anim-sprite-picker__grid">
            {assets === null && <div className="anim-sprite-picker__empty">Cargando…</div>}
            {assets?.length === 0 && <div className="anim-sprite-picker__empty">Sin sprites importados</div>}
            {assets?.map(a => (
              <div key={a.name} className={'anim-sprite-picker__item' + (value === a.name ? ' active' : '')}
                onClick={() => { onChange(a.name); setOpen(false) }}>
                <div className="anim-sprite-picker__thumb">
                  {thumbs[a.name]
                    ? <img src={thumbs[a.name]} alt={a.name} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
                    : <span>⏳</span>}
                </div>
                <span className="anim-sprite-picker__name">{a.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Panel de roles de animación ───────────────────────────────────────────────
// Asigna qué animación hace cada rol que el motor necesita (idle, walk_*).
// El motor genera código C con constantes hardcodeadas — sin búsqueda en runtime.
const ANIM_ROLES = [
  { key: 'idle',       label: '😴 Idle',               hint: 'Parado mirando derecha/izquierda — obligatorio. Se espeja si el personaje va hacia la izquierda.' },
  { key: 'walk_right', label: '→ Walk derecha',         hint: 'Caminar derecha — obligatorio' },
  { key: 'walk_left',  label: '← Walk izquierda',       hint: 'null = espejo horizontal de walk_right' },
  { key: 'walk_up',    label: '↑ Walk arriba',          hint: 'null = usa walk_right' },
  { key: 'walk_down',  label: '↓ Walk abajo',           hint: 'null = usa walk_right' },
  { key: 'idle_up',    label: '↑😴 Idle arriba',        hint: 'Al parar tras caminar hacia arriba. null = usa idle lateral' },
  { key: 'idle_down',  label: '↓😴 Idle abajo',         hint: 'Al parar tras caminar hacia abajo. null = usa idle lateral' },
  { key: 'talk',       label: '💬→ Hablar derecha',     hint: 'Animación de boca mirando derecha. Si talk_left está vacío, el motor la espeja automáticamente para la izquierda.' },
  { key: 'talk_left',  label: '💬← Hablar izquierda',  hint: 'Sprite explícito mirando izquierda. Si vacío, se usa espejo de talk.' },
  { key: 'talk_up',    label: '💬↑ Hablar arriba',      hint: 'Animación de boca al hablar mirando arriba. null = usa talk lateral si existe' },
  { key: 'talk_down',  label: '💬↓ Hablar abajo',       hint: 'Animación de boca al hablar mirando abajo. null = usa talk lateral si existe' },
  { key: 'give',       label: '🤝 Dar objeto',           hint: 'Animación al dar un objeto a otro personaje. null = usa talk si existe, sino idle' },
]

function AnimRolesPanel({ char }) {
  const { updateAnimRole } = useCharStore()
  const roles   = char.animRoles || {}
  const anims   = char.animations || []
  const missing = !roles.idle || !roles.walk_right

  return (
    <div className="anim-roles-panel">
      <div className="anim-roles-panel__header">
        <span>🎭 Roles de animación</span>
        {missing && <span className="anim-roles-warn">⚠ idle y walk_right son obligatorios</span>}
      </div>
      <p className="anim-roles-hint">
        El motor genera código C con estas asignaciones hardcodeadas.
        Asigna primero las animaciones en el panel inferior, luego selecciona aquí qué rol hace cada una.
      </p>
      <div className="anim-roles-grid">
        {ANIM_ROLES.map(({ key, label, hint }) => {
          const val = roles[key] || ''
          const missing_role = (key === 'idle' || key === 'walk_right') && !val
          return (
            <div key={key} className={`anim-role-row${missing_role ? ' anim-role-row--missing' : ''}`}>
              <div className="anim-role-row__label" title={hint}>{label}</div>
              <select
                value={val}
                onChange={e => updateAnimRole(key, e.target.value || null)}
                className={missing_role ? 'anim-role-select--missing' : ''}
              >
                <option value="">{key === 'walk_left' || key === 'walk_up' || key === 'walk_down' || key === 'idle_up' || key === 'idle_down' || key === 'talk' || key === 'talk_left' || key === 'talk_up' || key === 'talk_down' ? '— fallback automático —' : '— sin asignar —'}</option>
                {anims.map(a => (
                  <option key={a.id} value={a.id}>{a.name || a.id}</option>
                ))}
              </select>
              {key === 'walk_left' && !val && roles.walk_right && (
                <span className="anim-role-row__badge">espejo →</span>
              )}
              {(key === 'walk_up' || key === 'walk_down') && !val && (
                <span className="anim-role-row__badge">usa walk_right</span>
              )}
              {(key === 'idle_up' || key === 'idle_down') && !val && (
                <span className="anim-role-row__badge">usa idle</span>
              )}
              {(key === 'talk_up' || key === 'talk_down') && !val && (
                <span className="anim-role-row__badge">usa talk</span>
              )}
              {key === 'talk_left' && !val && (
                <span className="anim-role-row__badge">espejo talk</span>
              )}
              {key === 'talk' && !val && (
                <span className="anim-role-row__badge">sin anim</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Panel de animaciones ──────────────────────────────────────────────────────
function AnimationsPanel({ char, gameDir, palette }) {
  const { addAnimation, updateAnimation, deleteAnimation, moveAnimation } = useCharStore()
  const listRef = useRef(null)

  function handleAddAnimation() {
    addAnimation()
    // La nueva animación se inserta al principio — scroll al top
    if (listRef.current) listRef.current.scrollTop = 0
  }

  return (
    <div className="anim-panel">
      <div className="anim-panel__header">
        <span>Animaciones <span className="char-count">{char.animations?.length || 0}</span></span>
        <button className="btn-primary" onClick={handleAddAnimation}>＋ Añadir</button>
      </div>

      {(!char.animations || char.animations.length === 0) && (
        <div className="anim-panel__empty">
          <p>Sin animaciones definidas.</p>
          <small>Añade animaciones con nombre libre: idle_frente, walk_der, talk, etc.</small>
        </div>
      )}

      <div className="anim-list" ref={listRef}>
        {char.animations?.map((anim, idx) => (
          <div key={anim.id} className="anim-row">
            <div className="anim-row__order">
              <button className="btn-icon tiny" disabled={idx === 0}
                onClick={() => moveAnimation(anim.id, -1)}>▲</button>
              <button className="btn-icon tiny" disabled={idx === char.animations.length - 1}
                onClick={() => moveAnimation(anim.id, 1)}>▼</button>
            </div>

            <div className="anim-row__sprite">
              {anim.spriteFile && anim.frameWidth && (
                <PCXThumb filename={anim.spriteFile} gameDir={gameDir} palette={palette}
                  size={32} frameWidth={anim.frameWidth} />
              )}
              <SpritePicker value={anim.spriteFile} gameDir={gameDir} palette={palette}
                onChange={async v => {
                  if (!v) { updateAnimation(anim.id, { spriteFile: null, frameWidth: null, frameCount: 1 }); return }
                  const r = await window.api.readBinary(`${gameDir}/assets/converted/sprites/${v}`)
                  if (r.ok) {
                    const dims = getPcxDimensions(new Uint8Array(r.buffer))
                    if (dims) {
                      // Auto-detect frameCount: assume square frames (width/height)
                      const autoFc = Math.max(1, Math.round(dims.w / dims.h))
                      const fw     = Math.round(dims.w / autoFc)
                      updateAnimation(anim.id, { spriteFile: v, frameCount: autoFc, frameWidth: fw })
                    } else {
                      updateAnimation(anim.id, { spriteFile: v, frameWidth: null })
                    }
                  } else {
                    updateAnimation(anim.id, { spriteFile: v, frameWidth: null })
                  }
                }} />
            </div>

            <div className="anim-row__fields">
              <input type="text" className="anim-row__name" value={anim.name} placeholder="nombre_animacion"
                onChange={e => updateAnimation(anim.id, { name: e.target.value })} />
              <div className="anim-row__nums">
                <label>Frames
                  <input type="number" min={1} max={256} value={anim.frameCount}
                    onChange={async e => {
                      const fc = Math.max(1, parseInt(e.target.value) || 1)
                      let fw = anim.frameWidth || null
                      if (anim.spriteFile) {
                        const r = await window.api.readBinary(`${gameDir}/assets/converted/sprites/${anim.spriteFile}`)
                        if (r.ok) { const d = getPcxDimensions(new Uint8Array(r.buffer)); fw = d ? Math.round(d.w / fc) : fw }
                      }
                      updateAnimation(anim.id, { frameCount: fc, frameWidth: fw })
                    }} />
                </label>
                <label>FPS
                  <input type="number" min={1} max={60} value={anim.fps}
                    onChange={e => updateAnimation(anim.id, { fps: Math.max(1, parseInt(e.target.value) || 8) })} />
                </label>
                {anim.frameWidth && (
                  <span className="anim-framewidth-info" title="Ancho de frame calculado automáticamente (ancho PCX ÷ frames)">
                    {anim.frameWidth} px/frame
                  </span>
                )}
                <label>Loop
                  <input type="checkbox" checked={anim.loop !== false}
                    onChange={e => updateAnimation(anim.id, { loop: e.target.checked })} />
                </label>
                <label title="Espejo horizontal del spritesheet">↔ FlipH
                  <input type="checkbox" checked={anim.flipH === true}
                    onChange={e => updateAnimation(anim.id, { flipH: e.target.checked })} />
                </label>
                <label title="Espejo vertical del spritesheet">↕ FlipV
                  <input type="checkbox" checked={anim.flipV === true}
                    onChange={e => updateAnimation(anim.id, { flipV: e.target.checked })} />
                </label>
              </div>
              {anim.spriteFile && anim.frameWidth && anim.frameCount > 0 && (
                <div className="anim-row__preview">
                  <AnimPreview
                    filename={anim.spriteFile}
                    gameDir={gameDir}
                    palette={palette}
                    frameWidth={anim.frameWidth}
                    frameCount={anim.frameCount}
                    fps={anim.fps || 8}
                    scale={3}
                    flipH={anim.flipH === true}
                    flipV={anim.flipV === true}
                  />
                </div>
              )}
            </div>

            <button className="btn-icon danger" onClick={() => deleteAnimation(anim.id)} title="Eliminar">🗑</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Panel de patrulla ─────────────────────────────────────────────────────────
function PatrolPanel({ char }) {
  const { addPatrolPoint, updatePatrolPoint, deletePatrolPoint, clearPatrol } = useCharStore()
  const patrol = char.patrol || []

  return (
    <div className="patrol-panel">
      <div className="patrol-panel__header">
        <span>Ruta de patrulla <span className="char-count">{patrol.length} puntos</span></span>
        <div style={{ display: 'flex', gap: 4 }}>
          {patrol.length > 0 && (
            <button className="btn-ghost danger" onClick={() => {
              if (confirm('¿Limpiar todos los puntos de patrulla?')) clearPatrol()
            }}>🗑 Limpiar</button>
          )}
        </div>
      </div>

      <div className="patrol-info">
        <p>💡 Los puntos de patrulla se ordenan secuencialmente. El NPC los recorre en loop.
           También puedes añadirlos desde el <strong>Scene Editor → capa Personajes</strong>.</p>
      </div>

      {patrol.length === 0 && (
        <div className="patrol-empty">Sin puntos de patrulla — este NPC permanecerá estático.</div>
      )}

      <div className="patrol-list">
        {patrol.map((pp, idx) => (
          <div key={pp.id} className="patrol-row">
            <span className="patrol-row__idx">{idx + 1}</span>
            <label>X <input type="number" value={pp.x} min={0} max={9999}
              onChange={e => updatePatrolPoint(pp.id, { x: parseInt(e.target.value) || 0 })} /></label>
            <label>Y <input type="number" value={pp.y} min={0} max={9999}
              onChange={e => updatePatrolPoint(pp.id, { y: parseInt(e.target.value) || 0 })} /></label>
            <label>Espera (ms)
              <input type="number" value={pp.waitMs} min={0} max={60000} step={100}
                onChange={e => updatePatrolPoint(pp.id, { waitMs: parseInt(e.target.value) || 0 })} />
            </label>
            <button className="btn-icon danger" onClick={() => deletePatrolPoint(pp.id)}>🗑</button>
          </div>
        ))}
      </div>

      {patrol.length < 20 && (
        <button className="btn-ghost patrol-add" onClick={() => addPatrolPoint({ x: 160, y: 100 })}>
          ＋ Añadir punto
        </button>
      )}
    </div>
  )
}


// ── LocationInventoryPanel ────────────────────────────────────────────────────
function LocationInventoryPanel({ char, gameDir, onAddItem, onRemoveItem }) {
  const [objects, setObjects] = useState(null)
  const [objFilter, setObjFilter] = useState('')
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    if (!gameDir) return
    window.api.listObjects(gameDir).then(r => setObjects(r.ok ? r.objects : []))
  }, [gameDir])

  const inventory = char.inventory || []
  const { locales, activeLang } = useLocaleStore()

  function getObjName(obj) {
    return (locales[activeLang] || {})[`obj.${obj.id}.name`]
        || (locales['es']        || {})[`obj.${obj.id}.name`]
        || obj.name || obj.id
  }

  const pickableObjects = (objects || []).filter(o =>
    o.type === 'pickable' &&
    !inventory.find(i => i.objectId === o.id) &&
    (!objFilter || getObjName(o).toLowerCase().includes(objFilter.toLowerCase()))
  )

  return (
    <div className="loc-inv-panel">

      {/* ── Inventario inicial ── */}
      <div className="loc-inv-section">
        <div className="loc-inv-section__title">
          🎒 Inventario inicial
          <span className="char-count">{inventory.length} objeto{inventory.length !== 1 ? 's' : ''}</span>
        </div>
        <p className="loc-inv-hint">Objetos que el personaje lleva al empezar el juego. Solo se pueden añadir objetos de tipo <strong>pickable</strong>.</p>

        {/* Lista actual */}
        {inventory.length === 0
          ? <div className="loc-inv-empty">Sin objetos en el inventario inicial</div>
          : (
            <div className="loc-inv-list">
              {inventory.map(item => (
                <div key={item.objectId} className="loc-inv-item">
                  <span className="loc-inv-item__icon">📦</span>
                  <span className="loc-inv-item__name">{item.objectName}</span>
                  <span className="loc-inv-item__id">{item.objectId}</span>
                  <button className="btn-icon danger" title="Quitar del inventario"
                    onClick={() => onRemoveItem(item.objectId)}>✕</button>
                </div>
              ))}
            </div>
          )
        }

        {/* Picker de objetos */}
        <button className="btn-ghost loc-inv-add-btn"
          onClick={() => setShowPicker(s => !s)}>
          {showPicker ? '▲ Cerrar selector' : '＋ Añadir objeto al inventario'}
        </button>

        {showPicker && (
          <div className="loc-inv-picker">
            <input type="text" placeholder="Filtrar objetos pickable…"
              value={objFilter} onChange={e => setObjFilter(e.target.value)} />
            {objects === null && <div className="loc-inv-picker__empty">Cargando objetos…</div>}
            {objects !== null && pickableObjects.length === 0 && (
              <div className="loc-inv-picker__empty">
                {(objects || []).filter(o => o.type === 'pickable').length === 0
                  ? 'No hay objetos pickable en el juego. Crea uno en Object Library.'
                  : 'Sin resultados para ese filtro'}
              </div>
            )}
            {pickableObjects.map(obj => (
              <div key={obj.id} className="loc-inv-picker__item"
                onClick={() => { onAddItem(obj.id, getObjName(obj)); setObjFilter('') }}>
                <span>📦</span>
                <span className="loc-inv-picker__name">{getObjName(obj)}</span>
                <span className="loc-inv-picker__id">{obj.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
// ── DialoguePicker — selector de diálogo del proyecto ────────────────────────
// Muestra un <select> con todos los diálogos disponibles.
// Carga la lista via dialogueStore (o directamente via IPC si el store no está cargado).

function DialoguePicker({ gameDir, value, onChange }) {
  const { dialogues, loaded, loadDialogues } = useDialogueStore()

  useEffect(() => {
    if (gameDir && !loaded) loadDialogues(gameDir)
  }, [gameDir, loaded])

  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value || null)}
      className="char-dialogue-select"
    >
      <option value="">— ninguno —</option>
      {dialogues.map(d => (
        <option key={d.id} value={d.id}>{d.name || d.id}</option>
      ))}
    </select>
  )
}

// ── DialogueConditionList — lista de diálogos condicionales ──────────────────
// Cada condición tiene: { flag: string, value: bool, dialogueId: string }
// El motor evalúa la lista en orden y activa el primer diálogo cuya condición se cumple.
// Si ninguna condición se cumple, se usa el diálogo por defecto (dialogueId del char).

function DialogueConditionList({ conditions, gameDir, onChange }) {
  const { dialogues, loaded, loadDialogues } = useDialogueStore()

  useEffect(() => {
    if (gameDir && !loaded) loadDialogues(gameDir)
  }, [gameDir, loaded])

  function addCondition() {
    onChange([...conditions, { flag: '', value: true, dialogueId: '' }])
  }

  function removeCondition(idx) {
    onChange(conditions.filter((_, i) => i !== idx))
  }

  function updateCondition(idx, partial) {
    onChange(conditions.map((c, i) => i === idx ? { ...c, ...partial } : c))
  }

  function moveCondition(idx, dir) {
    const next = [...conditions]
    const to = idx + dir
    if (to < 0 || to >= next.length) return
    ;[next[idx], next[to]] = [next[to], next[idx]]
    onChange(next)
  }

  return (
    <div className="char-cond-list">
      {conditions.length === 0 && (
        <div className="char-cond-empty">
          Sin condiciones — siempre se usa el diálogo por defecto.
        </div>
      )}

      {conditions.map((cond, idx) => (
        <div key={idx} className="char-cond-row">
          <span className="char-cond-num">{idx + 1}</span>

          <label className="char-cond-label">Si flag</label>
          <input
            type="text"
            className="char-cond-flag"
            placeholder="nombre_flag"
            value={cond.flag || ''}
            onChange={e => updateCondition(idx, { flag: e.target.value })}
          />

          <select
            className="char-cond-bool"
            value={String(cond.value ?? true)}
            onChange={e => updateCondition(idx, { value: e.target.value === 'true' })}
          >
            <option value="true">= verdadero</option>
            <option value="false">= falso</option>
          </select>

          <label className="char-cond-label">→ diálogo</label>
          <select
            className="char-cond-dlg"
            value={cond.dialogueId || ''}
            onChange={e => updateCondition(idx, { dialogueId: e.target.value })}
          >
            <option value="">— ninguno —</option>
            {dialogues.map(d => (
              <option key={d.id} value={d.id}>{d.name || d.id}</option>
            ))}
          </select>

          <div className="char-cond-controls">
            <button className="btn-icon btn-tiny" onClick={() => moveCondition(idx, -1)} disabled={idx === 0} title="Subir">▲</button>
            <button className="btn-icon btn-tiny" onClick={() => moveCondition(idx, 1)} disabled={idx === conditions.length - 1} title="Bajar">▼</button>
            <button className="btn-icon btn-tiny char-cond-del" onClick={() => removeCondition(idx)} title="Eliminar">✕</button>
          </div>
        </div>
      ))}

      <button className="btn-secondary btn-sm char-cond-add" onClick={addCondition}>
        ＋ Añadir condición
      </button>
    </div>
  )
}

// ── Editor root ───────────────────────────────────────────────────────────────
export default function CharacterEditor() {
  const { activeGame, updateGame } = useAppStore()
  const { activeChar, dirty, closeChar, updateChar, saveActiveChar,
          addInventoryItem, removeInventoryItem } = useCharStore()
  const { langs, activeLang, setActiveLang, locales, setKey, dirty: localeDirty } = useLocaleStore()

  const [activeTab, setActiveTab] = useState('general')

  const gameDir = activeGame?.gameDir
  const palette = activeGame?.game?.palette || []
  const game    = activeGame?.game

  const charName = (locales[activeLang] || {})[`char.${activeChar?.id}.name`]
               || (locales['es']        || {})[`char.${activeChar?.id}.name`]
               || activeChar?.id || ''

  const isDirty = dirty || localeDirty.size > 0

  async function handleSave() {
    await saveActiveChar(gameDir)
  }

  async function handleToggleProtagonist(val) {
    updateChar({ isProtagonist: val })
    // Update game.json protagonists array
    let protagonists = [...(game?.protagonists || [])]
    if (val) {
      if (!protagonists.includes(activeChar.id)) protagonists.push(activeChar.id)
    } else {
      protagonists = protagonists.filter(id => id !== activeChar.id)
    }
    const updatedGame = { ...game, protagonists }
    await window.api.saveGame(gameDir, updatedGame)
    updateGame(updatedGame)
  }

  if (!activeChar) return null

  const TABS = [
    { id: 'general',    label: '⚙ General' },
    { id: 'animations', label: `🎞 Animaciones (${activeChar.animations?.length || 0})` },
    { id: 'patrol',     label: `🔄 Patrulla (${activeChar.patrol?.length || 0})` },
    { id: 'location',   label: '🏠 Sala e Inventario' },
  ]

  return (
    <div className="char-editor">
      {/* Header */}
      <div className="char-editor__header">
        <button className="btn-ghost char-editor__back" onClick={closeChar}>← Personajes</button>
        <div className="char-editor__title">
          <span className="char-editor__icon">{activeChar.isProtagonist ? '🦸' : '🧍'}</span>
          <span>{charName}</span>
          {isDirty && <span className="dirty-dot">●</span>}
        </div>
        <div className="char-editor__header-actions">
          {langs.length > 1 && (
            <div className="lang-tabs">
              {langs.map(l => (
                <button key={l} className={'lang-tab' + (activeLang === l ? ' active' : '')}
                  onClick={() => setActiveLang(l)}>{l.toUpperCase()}</button>
              ))}
            </div>
          )}
          <button className="btn-primary" disabled={!isDirty} onClick={handleSave}>💾 Guardar</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="char-editor__tabs">
        {TABS.map(t => (
          <button key={t.id} className={'char-tab' + (activeTab === t.id ? ' active' : '')}
            onClick={() => setActiveTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Content */}
      <div className="char-editor__body">

        {/* ── General ── */}
        {activeTab === 'general' && (
          <div className="char-general">
            <div className="field-group">
              <label>Nombre ({activeLang.toUpperCase()})</label>
              <input type="text" value={charName}
                onChange={e => setKey(activeLang, `char.${activeChar.id}.name`, e.target.value)} />
            </div>

            <div className="field-group field-group--row">
              <label className="toggle-label">
                <input type="checkbox" checked={activeChar.isProtagonist}
                  onChange={e => handleToggleProtagonist(e.target.checked)} />
                <span>Es protagonista</span>
              </label>
              <small>El protagonista es controlado por el jugador</small>
            </div>

            {activeChar.isProtagonist && (
              <div className="field-group">
                <label>Sprite de cara
                  <span className="field-hint-inline"> — selector de protagonistas en juego</span>
                </label>
                <div className="face-sprite-row">
                  {activeChar.faceSprite && (
                    <PCXThumb filename={activeChar.faceSprite} gameDir={gameDir} palette={palette} size={52} />
                  )}
                  <div className="face-sprite-picker">
                    <SpritePicker
                      value={activeChar.faceSprite || null}
                      gameDir={gameDir}
                      palette={palette}
                      onChange={v => updateChar({ faceSprite: v || null })}
                    />
                  </div>
                </div>
                <small>PCX de 20–40 px — cara o busto del personaje (sin fondo)</small>
              </div>
            )}

            <div className="field-group">
              <label>Velocidad de movimiento</label>
              <div className="field-row">
                <input type="range" min={1} max={10} step={1} value={activeChar.walkSpeed || 2}
                  onChange={e => updateChar({ walkSpeed: parseInt(e.target.value) })} />
                <span className="field-value">{activeChar.walkSpeed || 2}</span>
              </div>
              <small>Píxeles por tick — 1 lento, 10 muy rápido</small>
            </div>

            <div className="field-group">
              <label>Color de subtítulo</label>
              <div className="field-row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="number" min={0} max={255}
                  value={activeChar.subtitleColor ?? 15}
                  style={{ width: 60 }}
                  onChange={e => updateChar({ subtitleColor: parseInt(e.target.value) || 0 })} />
                <div style={{
                  width: 24, height: 24, borderRadius: 4, border: '1px solid #334155',
                  background: (() => {
                    const pal = palette
                    const idx = activeChar.subtitleColor ?? 15
                    if (pal && pal[idx]) { const [r,g,b] = pal[idx]; return `rgb(${r},${g},${b})` }
                    return '#ffffff'
                  })()
                }} />
              </div>
              <small>Índice de paleta (0-255) para el texto de diálogo de este personaje</small>
            </div>

            <div className="field-group">
              <label>Diálogo por defecto</label>
              <DialoguePicker gameDir={gameDir} value={activeChar.dialogueId || null}
                onChange={v => updateChar({ dialogueId: v })} />
              <small>Se activa al usar el verbo Hablar si ninguna condición se cumple</small>
            </div>

            <div className="field-group">
              <label>Diálogos condicionales
                <span className="field-hint-inline"> — se evalúan en orden, el primero que se cumpla gana</span>
              </label>
              <DialogueConditionList
                conditions={activeChar.dialogueConditions || []}
                gameDir={gameDir}
                onChange={v => updateChar({ dialogueConditions: v })}
              />
            </div>

            {activeChar.isProtagonist && (
              <div className="proto-info">
                <strong>🦸 Protagonista activo</strong>
                <p>Este personaje aparece en game.json → protagonists[].
                   El motor lo controlará mediante la interfaz de verbos e inventario.</p>
              </div>
            )}

            {/* ── Preview con overlay de luz ── */}
            <CharLightPreview char={activeChar} gameDir={gameDir} palette={palette} />

            {/* ── Linterna / antorcha ── */}
            <div className="field-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox"
                  checked={!!(activeChar.light?.enabled)}
                  onChange={e => {
                    const enabled = e.target.checked
                    const base = activeChar.light || {}
                    updateChar({ light: { ...base, enabled,
                      offsetX: base.offsetX ?? 0, offsetY: base.offsetY ?? -16,
                      radius: base.radius ?? 60, intensity: base.intensity ?? 80,
                      coneAngle: base.coneAngle ?? 360,
                      flicker: base.flicker ?? { amplitude: 0, speed: 2 }
                    }})
                  }} />
                Linterna / antorcha
              </label>
              <small>La luz sigue al personaje y apunta en su dirección de movimiento</small>
            </div>
            {activeChar.light?.enabled && (() => {
              const lt = activeChar.light
              const upd = (partial) => updateChar({ light: { ...lt, ...partial } })
              const updFlicker = (partial) => updateChar({ light: { ...lt, flicker: { ...(lt.flicker||{}), ...partial } } })
              return (
                <div className="char-light-panel">
                  <div className="char-light-row">
                    <label>Offset X</label>
                    <input type="number" value={lt.offsetX ?? 0}
                      onChange={e => upd({ offsetX: +e.target.value })} />
                    <label>Offset Y</label>
                    <input type="number" value={lt.offsetY ?? -16}
                      onChange={e => upd({ offsetY: +e.target.value })} />
                  </div>
                  <div className="char-light-row">
                    <label>Radio</label>
                    <input type="number" min={8} max={320} value={lt.radius ?? 60}
                      onChange={e => upd({ radius: +e.target.value })} />
                    <label>Int.</label>
                    <input type="number" min={0} max={100} value={lt.intensity ?? 80}
                      onChange={e => upd({ intensity: +e.target.value })} />
                  </div>
                  <div className="char-light-row">
                    <label>Ángulo</label>
                    <input type="number" min={10} max={360} value={lt.coneAngle ?? 360}
                      onChange={e => upd({ coneAngle: +e.target.value })} />
                    <span className="char-light-unit">° (360=omni)</span>
                  </div>
                  <div className="char-light-section">Parpadeo</div>
                  <div className="char-light-row">
                    <label>Amp.</label>
                    <input type="number" min={0} max={100} value={lt.flicker?.amplitude ?? 0}
                      onChange={e => updFlicker({ amplitude: +e.target.value })} />
                    <label>Hz</label>
                    <input type="number" min={0} max={20} step={0.5} value={lt.flicker?.speed ?? 2}
                      onChange={e => updFlicker({ speed: +e.target.value })} />
                  </div>
                </div>
              )
            })()}

          </div>
        )}

        {/* ── Animaciones ── */}
        {activeTab === 'animations' && (
          <div>
            <AnimRolesPanel char={activeChar} />
            <AnimationsPanel char={activeChar} gameDir={gameDir} palette={palette} />

          </div>
        )}

        {/* ── Patrulla ── */}
        {activeTab === 'patrol' && (
          <PatrolPanel char={activeChar} />
        )}

        {/* ── Sala e Inventario ── */}
        {activeTab === 'location' && (
          <LocationInventoryPanel
            char={activeChar}
            gameDir={gameDir}
            onAddItem={addInventoryItem}
            onRemoveItem={removeInventoryItem}
          />
        )}
      </div>
    </div>
  )
}
