import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/appStore'
import { useObjectStore, OBJECT_TYPES } from '../../store/objectStore'
import { useVerbsetStore } from '../../store/verbsetStore'
import { useLocaleStore } from '../../store/localeStore'
import { useScriptStore } from '../../store/scriptStore'
import { useCharStore } from '../../store/charStore'

// ── PCX Preview (estático) ────────────────────────────────────────────────────

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
              <img src={url} alt={filename} style={{ imageRendering:'pixelated', maxWidth:'100%', maxHeight:'100%' }} />
            </div>
            {size && <span className="pcx-mini-preview__info">{size.w}×{size.h}px</span>}</>
        : <span className="pcx-mini-preview__loading">Cargando…</span>}
    </div>
  )
}

// ── PCX Preview animado ───────────────────────────────────────────────────────

function AnimatedPCXPreview({ filename, gameDir, palette, frameCount, fps, frameWidth }) {
  const canvasRef  = useRef(null)
  const imgRef     = useRef(null)
  const rafRef     = useRef(null)
  const frameRef   = useRef(0)
  const lastRef    = useRef(0)

  // Cargar spritesheet completo
  useEffect(() => {
    if (!filename || !gameDir || !palette) { imgRef.current = null; return }
    let cancelled = false
    ;(async () => {
      const result = await window.api.readBinary(`${gameDir}/assets/converted/objects/${filename}`)
      if (cancelled || !result.ok) return
      const { pcxFileToDataURL } = await import('../../utils/pcxConverter')
      const url = pcxFileToDataURL(new Uint8Array(result.buffer), palette)
      const img = new Image()
      img.onload = () => { if (!cancelled) { imgRef.current = img; frameRef.current = 0 } }
      img.src = url
    })()
    return () => { cancelled = true }
  }, [filename, gameDir])

  // Loop RAF — recorta y pinta el frame actual
  useEffect(() => {
    const nFrames = Math.max(1, frameCount || 1)
    const interval = 1000 / Math.max(1, fps || 8)

    const tick = (now) => {
      const canvas = canvasRef.current
      const img    = imgRef.current
      if (canvas && img) {
        const fw = frameWidth > 0 ? frameWidth : Math.floor(img.naturalWidth / nFrames)
        const fh = img.naturalHeight
        canvas.width  = fw
        canvas.height = fh
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, fw, fh)
        ctx.drawImage(img, frameRef.current * fw, 0, fw, fh, 0, 0, fw, fh)
        if (now - lastRef.current >= interval) {
          frameRef.current = (frameRef.current + 1) % nFrames
          lastRef.current  = now
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [frameCount, fps, frameWidth])

  if (!filename) return <div className="pcx-mini-preview pcx-mini-preview--empty"><span>Sin sprite</span></div>
  return (
    <div className="pcx-mini-preview pcx-mini-preview--anim">
      <div className="pcx-mini-preview__canvas-wrap">
        <canvas ref={canvasRef} style={{ imageRendering: 'pixelated', maxWidth: '100%', maxHeight: '100%' }} />
      </div>
      <span className="pcx-mini-preview__info">{frameCount}f · {fps}fps</span>
    </div>
  )
}

// ── Sprite Modal Picker ───────────────────────────────────────────────────────

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
          {assets?.length === 0 && <div className="sprite-modal__empty">Sin assets de objeto. Importa uno en Asset Studio.</div>}
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

// ── Sprite picker ─────────────────────────────────────────────────────────────

function SpritePicker({ value, gameDir, palette, label, onChange,
                        animated, frameCount, fps, frameWidth }) {
  const [showModal, setShowModal] = useState(false)
  const isAnim = animated && (frameCount || 1) > 1
  return (
    <div className="sprite-picker">
      <label className="obj-field-mini">{label}</label>
      <div className="sprite-picker__row">
        <span className="sprite-picker__current">{value || 'Sin sprite'}</span>
        <button className="btn-ghost sprite-picker__choose" onClick={() => setShowModal(true)}>
          {value ? '✏ Cambiar' : '＋ Elegir'}
        </button>
        {value && <button className="btn-icon sprite-picker__clear" onClick={() => onChange(null)} title="Quitar sprite">✕</button>}
      </div>
      {isAnim
        ? <AnimatedPCXPreview filename={value} gameDir={gameDir} palette={palette}
            frameCount={frameCount} fps={fps} frameWidth={frameWidth} />
        : <PCXPreview filename={value} gameDir={gameDir} palette={palette} />}
      {showModal && (
        <SpriteModalPicker gameDir={gameDir} palette={palette}
          onSelect={name => { onChange(name); setShowModal(false) }}
          onClose={() => setShowModal(false)} />
      )}
    </div>
  )
}

// ── Tab General ───────────────────────────────────────────────────────────────

function TabGeneral({ obj, gameDir, palette, langs, locales, onSetLocale }) {
  const { updateObject, updateState, addState, deleteState } = useObjectStore()

  return (
    <div className="obj-tab-body">
      <div className="obj-section-title">Nombre del objeto</div>
      <p className="obj-hint">
        Aparece en la barra de acción del juego (<em>"coger Llave oxidada"</em>).
        Clave: <code>obj.{obj.id}.name</code>
      </p>
      <div className="obj-locale-fields">
        {langs.map(lang => (
          <div key={lang} className="obj-locale-row">
            <span className="lang-badge">{lang.toUpperCase()}</span>
            <input type="text"
              value={(locales[lang] || {})['obj.' + obj.id + '.name'] || ''}
              onChange={e => onSetLocale(lang, 'obj.' + obj.id + '.name', e.target.value)}
              placeholder={`Nombre en ${lang}…`} />
          </div>
        ))}
      </div>

      <div className="obj-section-title" style={{ marginTop: 14 }}>Tipo</div>
      <div className="obj-type-grid">
        {OBJECT_TYPES.map(t => (
          <button key={t.id} className={`obj-type-btn ${obj.type === t.id ? 'active' : ''}`}
            onClick={() => updateObject({ type: t.id })} title={t.desc}>
            <span className="obj-type-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="obj-field-row obj-field-row--check" style={{ marginTop: 10 }}>
        <label>Detectable por cursor</label>
        <input type="checkbox" checked={obj.detectable}
          onChange={e => updateObject({ detectable: e.target.checked })} />
      </div>

      <div className="obj-section-title" style={{ marginTop: 14 }}>Estados visuales</div>
      <p className="obj-hint">Cada estado tiene un sprite de escenario y, si es cogible, uno de inventario.</p>

      <div className="obj-states-list">
        {obj.states.map(st => (
          <div key={st.id}
            className={`obj-state-card ${st.id === obj.activeStateId ? 'active' : ''}`}
            onClick={() => updateObject({ activeStateId: st.id })}>
            <div className="obj-state-card__header">
              <input type="text" value={st.name} onClick={e => e.stopPropagation()}
                onChange={e => updateState(st.id, { name: e.target.value })}
                className="obj-state-name" />
              {obj.states.length > 1 && (
                <button className="btn-icon obj-state-del"
                  onClick={e => { e.stopPropagation(); deleteState(st.id) }}>✕</button>
              )}
            </div>
            <div className="obj-state-sprites" onClick={e => e.stopPropagation()}>
              <SpritePicker label="Sprite escenario" value={st.spriteFile}
                gameDir={gameDir} palette={palette}
                onChange={v => updateState(st.id, { spriteFile: v })}
                animated={!!st.animated} frameCount={st.frameCount}
                fps={st.fps} frameWidth={st.frameWidth} />
              {obj.type === 'pickable' && (
                <SpritePicker label="Sprite inventario" value={st.inventorySprite}
                  gameDir={gameDir} palette={palette}
                  onChange={v => updateState(st.id, { inventorySprite: v })} />
              )}
            </div>
            <div className="obj-state-anim" onClick={e => e.stopPropagation()}>
              <label className="obj-anim-toggle">
                <input type="checkbox" checked={!!st.bgLayer}
                  onChange={e => updateState(st.id, { bgLayer: e.target.checked })} />
                <span className="obj-field-mini" title="Se dibuja encima del fondo pero antes del personaje (suelos, plataformas, muelles)">Capa fondo</span>
              </label>
              <label className="obj-anim-toggle">
                <input type="checkbox" checked={!!st.animated}
                  onChange={e => updateState(st.id, { animated: e.target.checked })} />
                <span className="obj-field-mini">Animado</span>
              </label>
              {st.animated && (<>
                <div className="obj-anim-fields">
                  <label className="obj-field-mini">Frames</label>
                  <input type="number" min={2} max={64} value={st.frameCount || 2}
                    onChange={e => updateState(st.id, { frameCount: Math.max(2, +e.target.value) })} />
                  <label className="obj-field-mini">FPS</label>
                  <input type="number" min={1} max={30} value={st.fps || 8}
                    onChange={e => updateState(st.id, { fps: Math.max(1, +e.target.value) })} />
                  <label className="obj-field-mini">Frame W <span className="obj-hint-inline">(0=auto)</span></label>
                  <input type="number" min={0} max={512} value={st.frameWidth || 0}
                    onChange={e => updateState(st.id, { frameWidth: Math.max(0, +e.target.value) })} />
                  <label className="obj-field-mini">Loop</label>
                  <input type="checkbox" checked={st.animLoop !== false}
                    onChange={e => updateState(st.id, { animLoop: e.target.checked })} />
                </div>
                <div className="obj-ambient-row">
                  <label className="obj-field-mini">Ambient cada</label>
                  <input type="number" min={0} max={9999} step={0.5}
                    value={st.ambientIntervalMin || 0}
                    onChange={e => updateState(st.id, { ambientIntervalMin: Math.max(0, +e.target.value) })}
                    title="Intervalo mínimo en segundos (0 = desactivado)" />
                  <span className="obj-hint-inline">–</span>
                  <input type="number" min={0} max={9999} step={0.5}
                    value={st.ambientIntervalMax || 0}
                    onChange={e => updateState(st.id, { ambientIntervalMax: Math.max(0, +e.target.value) })}
                    title="Intervalo máximo en segundos (0 = usar min×2)" />
                  <span className="obj-hint-inline">s</span>
                </div>
              </>)}
            </div>
          </div>
        ))}
        <button className="btn-ghost obj-add-state" onClick={addState}>＋ Añadir estado</button>
      </div>
    </div>
  )
}

// ── VerbResponseBlock — bloque reutilizable para respuestas por verbo ─────────
// mode: 'scene' | 'inv'

const ANIM_ROLE_OPTIONS = [
  { value: 'talk',       label: 'Hablar (lateral)' },
  { value: 'talk_left',  label: 'Hablar izquierda' },
  { value: 'talk_up',    label: 'Hablar arriba' },
  { value: 'talk_down',  label: 'Hablar abajo' },
  { value: 'idle',       label: 'Idle (lateral)' },
  { value: 'idle_up',    label: 'Idle arriba' },
  { value: 'idle_down',  label: 'Idle abajo' },
  { value: 'walk_right', label: 'Caminar derecha' },
  { value: 'walk_left',  label: 'Caminar izquierda' },
  { value: 'walk_up',    label: 'Caminar arriba' },
  { value: 'walk_down',  label: 'Caminar abajo' },
]

function VerbResponseBlock({ obj, gameVerbs, langs, locales, onSetLocale, activeLang,
                              setActiveLang, scripts, chars, mode }) {
  const { setVerbResponse, setInvVerbResponse } = useObjectStore()
  const setter = mode === 'inv' ? setInvVerbResponse : setVerbResponse
  const responses = mode === 'inv' ? (obj.invVerbResponses || []) : (obj.verbResponses || [])
  const [expandedChar, setExpandedChar] = useState({})  // verbId -> bool

  // Roles disponibles del protagonista (solo los que tienen asignación)
  const protagonist = (chars || []).find(c => c.isProtagonist)
  const availableRoles = ANIM_ROLE_OPTIONS.filter(opt =>
    protagonist?.animRoles?.[opt.value]
  )

  function getResp(verbId) {
    return responses.find(r => r.verbId === verbId) || { verbId, mode: 'text', scriptId: '' }
  }

  function setCharResp(verbId, charId, partial) {
    const resp = getResp(verbId)
    const existing = (resp.charResponses || []).find(cr => cr.charId === charId)
    let charResponses
    if (existing) {
      charResponses = resp.charResponses.map(cr => cr.charId === charId ? { ...cr, ...partial } : cr)
    } else {
      charResponses = [...(resp.charResponses || []), { charId, mode: 'text', scriptId: '', ...partial }]
    }
    setter(verbId, { charResponses })
  }

  function removeCharResp(verbId, charId) {
    const resp = getResp(verbId)
    setter(verbId, { charResponses: (resp.charResponses || []).filter(cr => cr.charId !== charId) })
  }

  function addCharResp(verbId) {
    const usedIds = (getResp(verbId).charResponses || []).map(cr => cr.charId)
    const free = (chars || []).find(c => !usedIds.includes(c.id))
    if (!free) return
    setCharResp(verbId, free.id, {})
    setExpandedChar(prev => ({ ...prev, [verbId]: true }))
  }

  if (!gameVerbs || gameVerbs.length === 0) {
    return <div className="vs-warning">⚠ No hay verbset activo. Ve a Verbsets y establece uno como activo.</div>
  }

  return (
    <div>
      <div className="lang-tabs" style={{ marginBottom: 10 }}>
        {langs.map(l => (
          <button key={l} className={`lang-tab ${activeLang === l ? 'active' : ''}`}
            onClick={() => setActiveLang(l)}>{l.toUpperCase()}</button>
        ))}
      </div>

      <div className="verb-responses-list">
        {gameVerbs.map(verb => {
          const resp = getResp(verb.id)
          const textKey = 'obj.' + obj.id + (mode === 'inv' ? '.inv_verb.' : '.verb.') + verb.id
          const loc = locales[activeLang] || {}
          return (
            <div key={verb.id} className="verb-response-row verb-response-row--extended">
              <span className="verb-response-row__verb">
                <span style={{ marginRight: 4 }}>{verb.icon}</span>
                {verb.label}
              </span>
              <div className="verb-response-row__mode">
                <label className="verb-mode-radio">
                  <input type="radio" name={`mode_${mode}_${obj.id}_${verb.id}`}
                    value="text" checked={resp.mode !== 'script'}
                    onChange={() => setter(verb.id, { mode: 'text' })} />
                  Texto
                </label>
                <label className="verb-mode-radio">
                  <input type="radio" name={`mode_${mode}_${obj.id}_${verb.id}`}
                    value="script" checked={resp.mode === 'script'}
                    onChange={() => setter(verb.id, { mode: 'script' })} />
                  Script
                </label>
              </div>
              {resp.mode === 'script' ? (
                <select className="verb-response-row__script"
                  value={resp.scriptId || ''}
                  onChange={e => setter(verb.id, { mode: 'script', scriptId: e.target.value })}>
                  <option value="">— Seleccionar script —</option>
                  {scripts.map(s => (
                    <option key={s.id} value={s.id}>{s.name || s.id}</option>
                  ))}
                </select>
              ) : (
                <div className="verb-response-row__text-group">
                  {/* Línea principal */}
                  <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                    <input type="text"
                      value={loc[textKey] || ''}
                      onChange={e => onSetLocale(activeLang, textKey, e.target.value)}
                      placeholder={`Respuesta en ${activeLang}…`} />
                    {availableRoles.length > 0 && (
                      <select className="verb-response-row__anim"
                        title="Animación al hablar"
                        value={resp.sayAnim || ''}
                        onChange={e => setter(verb.id, { sayAnim: e.target.value || undefined })}>
                        <option value="">↕ pos</option>
                        {availableRoles.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    )}
                    <button title="Añadir línea" style={{ padding:'0 5px', fontSize:13, lineHeight:1 }}
                      onClick={() => setter(verb.id, { extraLines: [...(resp.extraLines||[]), { sayAnim:'' }] })}>
                      +
                    </button>
                  </div>
                  {/* Líneas extra encadenadas */}
                  {(resp.extraLines || []).map((el, ei) => {
                    const ekKey = textKey + '.e' + ei
                    return (
                      <div key={ei} style={{ display:'flex', gap:4, alignItems:'center', marginTop:3 }}>
                        <span style={{ fontSize:10, opacity:.5, flexShrink:0 }}>↳</span>
                        <input type="text"
                          value={loc[ekKey] || ''}
                          onChange={e => onSetLocale(activeLang, ekKey, e.target.value)}
                          placeholder={`Línea ${ei+2} en ${activeLang}…`} />
                        {availableRoles.length > 0 && (
                          <select className="verb-response-row__anim"
                            title="Animación al hablar"
                            value={el.sayAnim || ''}
                            onChange={e => {
                              const nxt = (resp.extraLines||[]).map((x,i) => i===ei ? {...x, sayAnim: e.target.value||''} : x)
                              setter(verb.id, { extraLines: nxt })
                            }}>
                            <option value="">↕ pos</option>
                            {availableRoles.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        )}
                        <button title="Eliminar línea" style={{ padding:'0 5px', fontSize:11, opacity:.6 }}
                          onClick={() => setter(verb.id, { extraLines: (resp.extraLines||[]).filter((_,i) => i!==ei) })}>
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* Respuestas por personaje */}
              {(chars || []).length > 0 && (
                <div style={{ marginTop:4, borderTop:'1px solid rgba(255,255,255,0.06)', paddingTop:4 }}>
                  <button style={{ fontSize:10, opacity:.6, padding:'1px 6px', cursor:'pointer' }}
                    onClick={() => setExpandedChar(prev => ({ ...prev, [verb.id]: !prev[verb.id] }))}>
                    {expandedChar[verb.id] ? '▾' : '▸'} Por personaje ({(resp.charResponses||[]).length})
                  </button>
                  {expandedChar[verb.id] && (
                    <div style={{ paddingLeft:8, marginTop:4, display:'flex', flexDirection:'column', gap:4 }}>
                      {(resp.charResponses || []).map(cr => {
                        const crTextKey = textKey + '.' + cr.charId
                        return (
                          <div key={cr.charId} style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap', padding:'4px', background:'rgba(255,255,255,0.04)', borderRadius:4 }}>
                            <select style={{ fontSize:11, flex:'0 0 auto' }}
                              value={cr.charId}
                              onChange={e => {
                                removeCharResp(verb.id, cr.charId)
                                setCharResp(verb.id, e.target.value, { mode: cr.mode, scriptId: cr.scriptId })
                              }}>
                              {(chars || []).map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
                            </select>
                            <label style={{ fontSize:10 }}>
                              <input type="radio" name={`cr_mode_${mode}_${obj.id}_${verb.id}_${cr.charId}`}
                                value="text" checked={cr.mode !== 'script'}
                                onChange={() => setCharResp(verb.id, cr.charId, { mode: 'text' })} />
                              Texto
                            </label>
                            <label style={{ fontSize:10 }}>
                              <input type="radio" name={`cr_mode_${mode}_${obj.id}_${verb.id}_${cr.charId}`}
                                value="script" checked={cr.mode === 'script'}
                                onChange={() => setCharResp(verb.id, cr.charId, { mode: 'script' })} />
                              Script
                            </label>
                            {cr.mode === 'script' ? (
                              <select style={{ flex:1, fontSize:11 }}
                                value={cr.scriptId || ''}
                                onChange={e => setCharResp(verb.id, cr.charId, { mode: 'script', scriptId: e.target.value })}>
                                <option value="">— script —</option>
                                {scripts.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                              </select>
                            ) : (
                              <input type="text" style={{ flex:1, fontSize:11 }}
                                value={loc[crTextKey] || ''}
                                onChange={e => onSetLocale(activeLang, crTextKey, e.target.value)}
                                placeholder={`Respuesta para ${cr.charId}…`} />
                            )}
                            <button title="Eliminar" style={{ fontSize:10, padding:'0 4px' }}
                              onClick={() => removeCharResp(verb.id, cr.charId)}>✕</button>
                          </div>
                        )
                      })}
                      {(resp.charResponses||[]).length < (chars||[]).length && (
                        <button style={{ fontSize:10, alignSelf:'flex-start', padding:'2px 8px' }}
                          onClick={() => addCharResp(verb.id)}>+ Añadir personaje</button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Tab Respuestas (escena) ───────────────────────────────────────────────────

function TabVerbResponses({ obj, gameVerbs, langs, locales, onSetLocale,
                             activeLang, setActiveLang, scripts, chars }) {
  return (
    <div className="obj-tab-body">
      <div className="obj-section-title">Respuestas por verbo (objeto en escena)</div>
      <p className="obj-hint">
        Qué ocurre cuando el jugador aplica un verbo a este objeto en la escena.
        Elige texto (frase localizable) o script (lanza un script existente).
      </p>
      <VerbResponseBlock obj={obj} gameVerbs={gameVerbs} langs={langs} locales={locales}
        onSetLocale={onSetLocale} activeLang={activeLang} setActiveLang={setActiveLang}
        scripts={scripts} chars={chars} mode="scene" />
    </div>
  )
}

// ── Tab Respuestas Inventario ─────────────────────────────────────────────────

function TabInvResponses({ obj, gameVerbs, langs, locales, onSetLocale,
                            activeLang, setActiveLang, scripts, chars }) {
  return (
    <div className="obj-tab-body">
      <div className="obj-section-title">Respuestas por verbo (objeto en inventario)</div>
      <p className="obj-hint">
        Qué ocurre cuando el jugador aplica un verbo a este objeto desde el inventario.
        Si no se define, se usan las respuestas de escena como fallback.
      </p>
      <VerbResponseBlock obj={obj} gameVerbs={gameVerbs} langs={langs} locales={locales}
        onSetLocale={onSetLocale} activeLang={activeLang} setActiveLang={setActiveLang}
        scripts={scripts} chars={chars} mode="inv" />
    </div>
  )
}

// ── Tab Combinar ──────────────────────────────────────────────────────────────

function TabCombinations({ obj, allObjects, chars, scripts }) {
  const { addCombination, updateCombination, deleteCombination } = useObjectStore()

  return (
    <div className="obj-tab-body">
      <div className="obj-section-title">Combinar (Usar con...)</div>
      <p className="obj-hint">
        Qué ocurre al usar este objeto (desde inventario) con otro objeto o personaje.
        Se comprueba en orden al ejecutar "Usar X con Y".
      </p>
      {(obj.combinations || []).length === 0 && <div className="obj-empty">Sin combinaciones definidas.</div>}
      {(obj.combinations || []).map(c => (
        <div key={c.id} className="comb-card">
          <div className="comb-card__header">
            <label className="obj-field-mini">Usar con</label>
            <button className="btn-icon comb-del" onClick={() => deleteCombination(c.id)}>🗑</button>
          </div>
          <select value={c.withId || ''} onChange={e => updateCombination(c.id, { withId: e.target.value })}>
            <option value="">— Seleccionar objetivo —</option>
            <optgroup label="Objetos">
              {allObjects.filter(o => o.id !== obj.id).map(o => (
                <option key={o.id} value={o.id}>{o.name || o.id}</option>
              ))}
            </optgroup>
            <optgroup label="Personajes / NPCs">
              {(chars || []).map(c2 => (
                <option key={c2.id} value={c2.id}>{c2.name || c2.id}</option>
              ))}
            </optgroup>
          </select>
          <label className="obj-field-mini" style={{ marginTop: 8 }}>Script a ejecutar</label>
          <select value={c.scriptId || ''} onChange={e => updateCombination(c.id, { scriptId: e.target.value })}>
            <option value="">— Sin script —</option>
            {(scripts || []).map(s => (
              <option key={s.id} value={s.id}>{s.name || s.id}</option>
            ))}
          </select>
          <label className="obj-field-checkbox" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={!!c.requireBothInv}
              onChange={e => updateCombination(c.id, { requireBothInv: e.target.checked })}
            />
            Requiere ambos objetos en inventario
          </label>
        </div>
      ))}
      <button className="btn-ghost" style={{ marginTop: 8 }} onClick={addCombination}>
        ＋ Nueva combinación
      </button>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'general',   label: 'General' },
  { id: 'responses', label: 'Respuestas' },
  { id: 'inv',       label: 'Inv. respuestas' },
  { id: 'combos',    label: 'Combinar' },
]

export default function ObjectEditor({ allObjects }) {
  const { activeGame }                              = useAppStore()
  const { activeObject, dirty, saveActiveObject,
          closeObject, updateObject }               = useObjectStore()
  const { getGameVerbs, loadVerbsets, verbsets }    = useVerbsetStore()
  const { langs = [], activeLang = 'es', setActiveLang,
          locales = {}, setKey, saveAll,
          dirty: localeDirty, loadAll: loadLocales,
          loaded: localesLoaded }                   = useLocaleStore()
  const { scripts, loaded: scriptsLoaded,
          loadScripts }                             = useScriptStore()
  const { chars, loaded: charsLoaded,
          loadChars }                               = useCharStore()

  const [activeTab, setActiveTab] = useState('general')

  const gameDir = activeGame?.gameDir
  const palette = activeGame?.game?.palette || []
  const game    = activeGame?.game

  useEffect(() => {
    if (!gameDir) return
    if (verbsets.length === 0) loadVerbsets(gameDir)
    if (!localesLoaded)       loadLocales(gameDir)
    if (!scriptsLoaded)       loadScripts(gameDir)
    if (!charsLoaded)         loadChars(gameDir)
  }, [gameDir])

  const activeVerbSetId = game?.activeVerbSet
  const gameVerbs = useMemo(
    () => getGameVerbs(game, activeLang, locales),
    [activeVerbSetId, activeLang, verbsets, locales]
  )

  const mergedLocales = useMemo(() => locales, [locales])

  function handleSetLocale(lang, key, value) {
    setKey(lang, key, value)
  }

  async function handleSave() {
    await saveActiveObject(gameDir)
    await saveAll(gameDir)
  }

  const isDirty = dirty || localeDirty.size > 0

  if (!activeObject) return (
    <div className="obj-editor obj-editor--empty">
      Selecciona un objeto de la lista para editarlo
    </div>
  )

  const obj = activeObject

  return (
    <div className="obj-editor">
      <div className="obj-editor__header">
        <div className="obj-editor__title">
          <span className="obj-type-badge">
            {OBJECT_TYPES.find(t => t.id === obj.type)?.icon} {mergedLocales[activeLang]?.['obj.' + obj.id + '.name'] || obj.id}
          </span>
          {isDirty && <span className="dirty-dot">●</span>}
        </div>
        <div className="obj-editor__actions">
          <button className="btn-ghost" onClick={closeObject}>✕ Cerrar</button>
          <button className="btn-primary" disabled={!isDirty} onClick={handleSave}>
            💾 Guardar
          </button>
        </div>
      </div>

      <div className="obj-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`obj-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="obj-editor__body">
        {activeTab === 'general'   && <TabGeneral obj={obj} gameDir={gameDir} palette={palette}
                                        langs={langs} locales={mergedLocales} onSetLocale={handleSetLocale} />}
        {activeTab === 'responses' && <TabVerbResponses obj={obj} gameVerbs={gameVerbs}
                                        langs={langs} locales={mergedLocales} onSetLocale={handleSetLocale}
                                        activeLang={activeLang} setActiveLang={setActiveLang}
                                        scripts={scripts} chars={chars || []} />}
        {activeTab === 'inv'       && <TabInvResponses obj={obj} gameVerbs={gameVerbs}
                                        langs={langs} locales={mergedLocales} onSetLocale={handleSetLocale}
                                        activeLang={activeLang} setActiveLang={setActiveLang}
                                        scripts={scripts} chars={chars || []} />}
        {activeTab === 'combos'    && <TabCombinations obj={obj} allObjects={allObjects}
                                        chars={chars} scripts={scripts} />}
      </div>
    </div>
  )
}
