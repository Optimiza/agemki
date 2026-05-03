/**
 * @fileoverview SequenceEditor — Editor del módulo Secuencias
 *
 * Permite crear y editar secuencias: listas ordenadas de pasos que se
 * ejecutan de forma lineal y bloqueante (cutscenes, intros, transiciones).
 *
 * DIFERENCIA CON SCRIPTS:
 *   Scripts → reaccionan a interacciones del jugador. Tienen disparador.
 *   Secuencias → narrativas predefinidas, sin input del jugador. Sin disparador.
 *
 * ARQUITECTURA:
 *
 *   SequenceLibrary
 *     Lista de secuencias con CRUD. Doble clic → abre editor.
 *
 *   SequenceEditorView
 *     Vista de edición de una secuencia. Contiene:
 *       - StepPalette: paleta de tipos de paso agrupados por categoría.
 *       - Lista de StepRow: pasos reordenables con ▲▼ + añadir después de.
 *
 *   StepRow
 *     Un paso en la lista. Al expandir muestra sus campos editables.
 *     Los pasos de tipo show_text y scroll_text tienen layout especial
 *     (editor multiidioma + preview 320×200 de pantalla MS-DOS).
 *
 *   FieldPicker (local)
 *     Renderiza el widget correcto según el tipo de campo del paso.
 *     Tipos especiales: locale_text (editor multiidioma), font_size, text_pos,
 *     text_effect. El resto igual que en ScriptEditor.
 *
 *   LocaleTextEditor
 *     Editor multiidioma inline con tabs por idioma. El texto se guarda
 *     directamente en el JSON de la secuencia como { lang: texto } —
 *     NO usa claves de localización (diferencia con los diálogos y scripts).
 *
 *   TextPreview
 *     Canvas 320×200 que simula cómo se verá el texto en MS-DOS. Se actualiza
 *     en tiempo real al cambiar texto, fuente, posición o efecto. Muestra:
 *       - Fondo azul oscuro estilo MS-DOS + scanlines
 *       - Texto renderizado con la fuente y posición seleccionadas
 *       - Indicador de efecto (typewriter speed, scroll speed)
 *
 * DATOS — cache de módulo:
 *   useGameData() usa el mismo patrón de cache a nivel de módulo que ScriptEditor.
 *   _cache sobrevive remounts y se invalida al cambiar gameDir.
 *
 * DIRTY STATE:
 *   Al pulsar "← Secuencias" con cambios sin guardar, pregunta si guardar.
 *   EditorLayout también pregunta al cambiar de módulo.
 *
 * @module SequenceEditor
 */
import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/appStore'
import { useSequenceStore, STEPS, STEP_CATS } from '../../store/sequenceStore'
import { useCharStore } from '../../store/charStore'
import { useLocaleStore } from '../../store/localeStore'
import { useDialogueStore } from '../../store/dialogueStore'
import { useAttributeStore } from '../../store/attributeStore'
import './SequenceEditor.css'
import PalettePicker, { DEFAULT_VGA_PALETTE, palIdx2css } from '../shared/PalettePicker'

// ── Shared game data cache (survives remounts within session) ─────────────────
const _cache = { gameDir: null, rooms: [], audios: [], scripts: [], sequences: [], backgrounds: [], objects: [] }

function useGameData(gameDir) {
  const chars      = useCharStore(s => s.chars)
  const dialogues  = useDialogueStore(s => s.dialogues)
  const langs      = useLocaleStore(s => s.langs)
  const locales    = useLocaleStore(s => s.locales)
  const activeLang = useLocaleStore(s => s.activeLang)
  const attributes = useAttributeStore(s => s.attributes)
  const attrsEnabled = useAttributeStore(s => s.enabled)
  const palette    = useAppStore(s => s.activeGame?.game?.palette || [])
  const [rooms,       setRooms]       = useState(_cache.rooms)
  const [audios,      setAudios]      = useState(_cache.audios)
  const [scripts,     setScripts]     = useState(_cache.scripts)
  const [sequences,   setSequences]   = useState(_cache.sequences)
  const [backgrounds, setBackgrounds] = useState(_cache.backgrounds)
  const [objects,     setObjects]     = useState(_cache.objects)

  useEffect(() => {
    if (!gameDir || _cache.gameDir === gameDir) return
    _cache.gameDir = gameDir
    useCharStore.getState().loadChars(gameDir)
    useDialogueStore.getState().loadDialogues(gameDir)
    useLocaleStore.getState().loadAll(gameDir)
    useAttributeStore.getState().load(gameDir)
    window.api.listRooms(gameDir).then(r => { const v = r.ok ? r.rooms||[] : []; _cache.rooms=v; setRooms(v) })
    Promise.all([
      window.api.listAudioFiles(gameDir, 'music'),
      window.api.listAudioFiles(gameDir, 'sfx'),
    ]).then(([midi, sfx]) => {
      const getName = f => f.name || f
      const v = [
        ...(midi.ok ? midi.files||[] : []).map(f => `midi:${getName(f)}`),
        ...(sfx.ok  ? sfx.files||[]  : []).map(f => `sfx:${getName(f)}`),
      ]
      _cache.audios = v; setAudios(v)
    })
    window.api.listScripts(gameDir).then(r => { const v = r.ok ? r.scripts||[] : []; _cache.scripts=v; setScripts(v) })
    window.api.listSequences(gameDir).then(r => { const v = r.ok ? r.sequences||[] : []; _cache.sequences=v; setSequences(v) })
    window.api.listAssets(gameDir, 'backgrounds').then(r => { const v = r.ok ? r.files||[] : []; _cache.backgrounds=v; setBackgrounds(v) })
    window.api.listObjects(gameDir).then(r => { const v = r.ok ? r.objects||[] : []; _cache.objects=v; setObjects(v) })
  }, [gameDir])

  function charName(id) {
    const c = chars.find(x => x.id === id)
    return (locales[activeLang]||{})[`char.${id}.name`] || c?.name || id
  }

  function objectName(id) {
    const o = objects.find(x => x.id === id)
    return (locales[activeLang]||{})[`obj.${id}.name`] || o?.name || id
  }

  return { chars, rooms, audios, scripts, sequences, dialogues, langs, locales, activeLang, charName, palette, backgrounds, objects, objectName, attributes, attrsEnabled }
}

// ── SeqLocaleTextEditor ───────────────────────────────────────────────────────
// Editor de texto de secuencia que escribe directamente en localeStore.
// Recibe la localeKey auto-generada, permite editar el texto por idioma,
// y muestra preview 320x200.
function SeqLocaleTextEditor({ localeKey, step, gameDir, isScroll = false, palette = [] }) {
  const { langs, locales, setKey, saveAll } = useLocaleStore()
  const allLangs = langs?.length ? langs : ['es']
  const [activeLang, setActiveLang] = useState(allLangs[0])

  const previewText = (locales[activeLang] || {})[localeKey] || ''

  function handleChange(text) {
    setKey(activeLang, localeKey, text)
    if (gameDir) saveAll(gameDir)
  }

  return (
    <div className="seq-field-locale-wrap">
      <div className="seq-locale-editor">
        <div style={{ display:'flex', gap:4, alignItems:'center', marginBottom:4 }}>
          <div className="seq-locale-tabs" style={{ flex:1 }}>
            {allLangs.map(l => (
              <button key={l} className={`seq-locale-tab ${l === activeLang ? 'seq-locale-tab--active' : ''}`}
                onClick={() => setActiveLang(l)}>{l.toUpperCase()}</button>
            ))}
          </div>
          <span style={{ fontSize:'10px', color:'#64748b', fontFamily:'monospace' }}>{localeKey}</span>
        </div>
        {isScroll
          ? <textarea className="seq-locale-textarea" rows={4}
              value={(locales[activeLang] || {})[localeKey] || ''}
              placeholder={`Texto en ${activeLang.toUpperCase()} (\n para nueva línea)`}
              onChange={e => handleChange(e.target.value)} />
          : <textarea className="seq-locale-textarea seq-locale-textarea--show" rows={3}
              value={(locales[activeLang] || {})[localeKey] || ''}
              placeholder={`Texto en ${activeLang.toUpperCase()} (\n para nueva línea)`}
              onChange={e => handleChange(e.target.value)} />
        }
      </div>
      <TextPreview
        text={previewText}
        font={step.font}
        position={step.position}
        align={step.align}
        effect={step.effect}
        typewriterSpeed={step.typewriterSpeed}
        isScroll={isScroll}
        speed={step.speed}
        colorIdx={step.color}
        bgColorIdx={step.type === 'move_text' ? step.bgColor : step.bgColor}
        palette={palette}
        moveText={step.type === 'move_text' ? { x0: step.x0, y0: step.y0, x1: step.x1, y1: step.y1, bgType: step.bgType, bgColor: step.bgColor } : null}
      />
    </div>
  )
}

// ── Preview 320×200 estilo MS-DOS ─────────────────────────────────────────────

/**
 * Tipos de fuente disponibles.
 * gw = ancho glifo DOS (px), gh = alto glifo DOS (px).
 * La fuente small usa el PCX small.PCX (8×8), medium usa medium.PCX (8×16), large usa large.PCX (16×16).
 */
const FONT_SIZES = {
  small:  { label: 'Pequeña  (8×8px)',   gw: 8,  gh: 8  },
  medium: { label: 'Mediana  (8×16px)',  gw: 8,  gh: 16 },
  large:  { label: 'Grande  (16×16px)',  gw: 16, gh: 16 },
}

//
// Simula cómo se verá el texto en pantalla en el juego real.
// Renderiza en un <canvas> con:
//   - Fondo azul oscuro + scanlines (una línea negra cada 2px, opacidad baja)
//   - Texto con ctx.font = `bold ${fdef.h}px "Courier New"` como aproximación
//     a las fuentes bitmap del juego
//   - Outline: dibuja el texto 4 veces desplazado ±1px en negro, luego encima en blanco
//   - Posición: top=y:8, center=y:(H-totalH)/2, bottom=y:H-totalH-8
//   - Indicadores: velocidad typewriter (abajo-izquierda), posición (abajo-derecha)
//
// LIMITACIÓN: la fuente del canvas (Courier New) es una aproximación visual.
// Las fuentes reales del motor son bitmaps PCX definidas en assets/fonts/.
// El preview es orientativo, no pixel-perfect.

/**
 * @param {Object} props
 * @param {string} props.text           - Texto a mostrar (saltos de línea con \n)
 * @param {string} props.font           - ID de fuente (ej: 'medium_solid')
 * @param {'top'|'center'|'bottom'} props.position
 * @param {'none'|'typewriter'|'fade'} props.effect
 * @param {number} props.typewriterSpeed - Chars/seg (para el indicador)
 * @param {boolean} [props.isScroll=false] - Si true, muestra indicador de scroll en lugar de posición
 * @param {number} [props.speed]        - Píxeles/seg de scroll (para el indicador)
 */
/**
 * Preview 320×200 estilo MS-DOS.
 * bgColor rellena toda la pantalla (igual que el motor: memset antes del texto).
 * Texto con fillText de Canvas API usando Courier New como aproximación a la fuente bitmap.
 * Canvas interno 640×400 (2× DOS), CSS 320×200 via transform scale(0.5).
 */
function TextPreview({ text, font, position, align, effect, typewriterSpeed,
                       isScroll = false, speed, colorIdx, bgColorIdx, palette,
                       moveText = null }) {
  const canvasRef = useRef(null)
  const fdef = FONT_SIZES[font] || FONT_SIZES.medium

  const textColor = palIdx2css(palette, colorIdx != null ? Number(colorIdx) : (isScroll ? 14 : 15))
  const hasBg = bgColorIdx !== undefined && bgColorIdx !== '' && bgColorIdx !== null
  const bgColor = hasBg ? palIdx2css(palette, Number(bgColorIdx)) : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = 640, H = 400
    const S = 2

    ctx.fillStyle = hasBg ? bgColor : (isScroll ? '#000010' : '#1a1a5e')
    ctx.fillRect(0, 0, W, H)

    // Estrellas decorativas solo en scroll sin bgColor
    if (isScroll && !hasBg) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      for (let i = 0; i < 60; i++)
        ctx.fillRect(((i*73+17)%320)*S, ((i*113+41)%200)*S, S, S)
    }

    // Scanlines sutiles
    ctx.fillStyle = 'rgba(0,0,0,0.10)'
    for (let y = 0; y < H; y += S*2) ctx.fillRect(0, y, W, S)

    if (!text) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '18px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(isScroll ? '↑ scroll preview' : 'sin texto', W/2, H/2)
      return
    }

    const gh = fdef.gh
    const gw = fdef.gw
    const lineH = (gh + 2) * S
    const lines = text.split('\n')
    const totalH = lines.length * lineH

    ctx.font = `bold ${gh * S}px "Courier New", monospace`
    ctx.textBaseline = 'top'

    let startY
    switch (position) {
      case 'top':    startY = 8 * S; break
      case 'center': startY = Math.floor((H - totalH) / 2); break
      default:       startY = H - totalH - 8 * S
    }

    const lineX = (line) => {
      const tw = line.length * gw * S
      const al = align || 'center'
      if (al === 'left')  return 8 * S
      if (al === 'right') return W - tw - 8 * S
      return Math.floor((W - tw) / 2)
    }

    ctx.fillStyle = textColor
    lines.forEach((line, i) => {
      ctx.fillText(line, lineX(line), startY + i * lineH)
    })

    // Indicadores
    ctx.font = '16px monospace'
    if (isScroll) {
      ctx.fillStyle = 'rgba(255,255,100,0.85)'; ctx.textAlign = 'left'
      ctx.fillText(`↑ ${speed || 40}px/s`, 8, H - 20)
    } else {
      if (effect === 'typewriter' && typewriterSpeed) {
        ctx.fillStyle = 'rgba(255,255,100,0.85)'; ctx.textAlign = 'left'
        ctx.fillText(`✏ ${typewriterSpeed} ch/s`, 8, H - 20)
      } else if (effect === 'fade') {
        ctx.fillStyle = 'rgba(100,200,255,0.85)'; ctx.textAlign = 'left'
        ctx.fillText('✦ fade in', 8, H - 20)
      }
      ctx.fillStyle = 'rgba(200,200,255,0.6)'; ctx.textAlign = 'right'
      ctx.fillText(position || 'bottom', W - 8, H - 20)
    }
  }, [text, font, position, align, effect, typewriterSpeed, isScroll, speed, textColor, bgColor, hasBg, fdef, moveText])

  return (
    <div className="seq-text-preview">
      <div className="seq-text-preview__label">
        Preview 320×200 · {fdef.gw}×{fdef.gh}px{isScroll ? ' · scroll' : ''}
      </div>
      <div className="seq-text-preview__wrap">
        <canvas ref={canvasRef} width={640} height={400} className="seq-text-preview__canvas" />
      </div>
    </div>
  )
}

// ── Field picker ──────────────────────────────────────────────────────────────
function FieldPicker({ fd, value, onChange, data, step = {}, gameDir = '', seqId = '' }) {
  const { k, t, ph } = fd
  const { chars, rooms, audios, scripts, sequences, dialogues, charName, palette, backgrounds, objects, objectName, attributes, attrsEnabled } = data

  switch (t) {
    case 'seq_locale_text': {
      const localeKey = `seq_${seqId.replace(/[^a-zA-Z0-9_]/g,'_')}_${(step.id||'').replace(/[^a-zA-Z0-9_]/g,'_')}`
      return (
        <SeqLocaleTextEditor
          localeKey={localeKey}
          step={step}
          gameDir={gameDir}
          isScroll={step.type === 'scroll_text'}
          palette={palette}
        />
      )
    }

    case 'pal_color':
      return <PalettePicker palette={palette} value={value ?? 15} onChange={onChange} />

    case 'pal_color_opt':
      return (
        <div style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
          <PalettePicker palette={palette} value={value !== '' && value !== undefined ? value : 0} onChange={onChange} />
          <span style={{ fontSize:10, color:'#667', fontStyle:'italic' }}>
            idx 0 = transparente · first color is transparent
          </span>
        </div>
      )

    case 'pal_color_or_screen': {
      const isScreen = (value === -1 || value === undefined || value === null)
      const colorVal = isScreen ? 0 : (value|0)
      const textVal  = isScreen ? '-1' : String(colorVal)
      return (
        <div style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
          <input type="text"
            style={{ width:36, textAlign:'center' }}
            value={textVal}
            onChange={e => {
              const v = e.target.value.trim()
              if (v === '-1' || v === '') onChange(-1)
              else { const n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 254) onChange(n) }
            }} />
          <PalettePicker palette={palette} value={colorVal}
            onChange={v => onChange(v)} />
          <span style={{ fontSize:10, color:'#666' }}>-1=pantalla</span>
        </div>
      )
    }

    case 'fade_effect':
      return (
        <select value={value||'palette'} onChange={e => onChange(e.target.value)}>
          <option value="palette">Paleta (suave)</option>
          <option value="dissolve">Dissolve (píxeles)</option>
        </select>
      )

    case 'move_text_bg':
      return (
        <select value={String(value ?? 0)} onChange={e => onChange(Number(e.target.value))}>
          <option value="0">Color sólido</option>
          <option value="1">PCX de fondo</option>
        </select>
      )

    case 'attr_id':
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">— atributo —</option>
          {(attributes || []).map(a => (
            <option key={a.id} value={a.id}>
              {(locales[activeLang] || {})[a.nameKey] || a.id}
              {a.isDeathAttr ? ' 💀' : ''}
            </option>
          ))}
        </select>
      )

    case 'attr_mode':
      return (
        <select value={value || 'set'} onChange={e => onChange(e.target.value)}>
          <option value="set">= Asignar</option>
          <option value="add">+ Sumar</option>
          <option value="sub">− Restar</option>
        </select>
      )

    case 'bg_asset':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— sin fondo PCX —</option>
          {backgrounds.map(b => {
            const name = typeof b === 'string' ? b : b.name
            return <option key={name} value={name}>{name}</option>
          })}
        </select>
      )

    case 'sequence':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— secuencia —</option>
          {sequences.map(s => <option key={s.id} value={s.id}>{s.name||s.id}</option>)}
        </select>
      )

    case 'font_size':
      return (
        <select value={value || 'medium'} onChange={e => onChange(e.target.value)}>
          {Object.entries(FONT_SIZES).map(([k, v]) =>
            <option key={k} value={k}>{v.label}</option>
          )}
        </select>
      )

    case 'text_pos':
      return (
        <select value={value || 'bottom'} onChange={e => onChange(e.target.value)}>
          <option value="top">Arriba</option>
          <option value="center">Centro</option>
          <option value="bottom">Abajo</option>
        </select>
      )

    case 'text_align':
      return (
        <select value={value || 'center'} onChange={e => onChange(e.target.value)}>
          <option value="left">Izquierda</option>
          <option value="center">Centrado</option>
          <option value="right">Derecha</option>
          <option value="justify">Justificado</option>
        </select>
      )

    case 'text_effect':
      return (
        <select value={value || 'none'} onChange={e => onChange(e.target.value)}>
          <option value="none">Sin efecto (aparición instantánea)</option>
          <option value="typewriter">Máquina de escribir (carácter a carácter)</option>
          <option value="fade">Fundido de entrada</option>
        </select>
      )

    case 'char':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— personaje —</option>
          <option value="@">@ protagonista activo</option>
          {chars.map(c => <option key={c.id} value={c.id}>{charName(c.id)}</option>)}
        </select>
      )
    case 'object':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— objeto —</option>
          {(objects||[]).map(o => <option key={o.id} value={o.id}>{objectName ? objectName(o.id) : (o.name||o.id)}</option>)}
        </select>
      )
    case 'attr':
      return attrsEnabled
        ? (
          <select value={value||''} onChange={e => onChange(e.target.value)}>
            <option value="">— atributo —</option>
            {(attributes||[]).map(a => <option key={a.id} value={a.id}>{a.nameKey}</option>)}
          </select>
        )
        : <input type="text" value={value||''} placeholder="nombre atributo" onChange={e => onChange(e.target.value)} />
    case 'room':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— room —</option>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.name||r.id}</option>)}
        </select>
      )
    case 'entry': {
      // entries del roomId hermano en el mismo step
      const roomId = step.roomId || ''
      const roomObj = rooms.find(r => r.id === roomId)
      // rooms from listRooms may include entries if loaded fully, otherwise show generic option
      const entries = roomObj?.entries || []
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— entry_default —</option>
          {entries.map(en => <option key={en.id} value={en.id}>{en.id}</option>)}
          {entries.length === 0 && roomId && <option disabled>Carga la room para ver entries</option>}
          {!roomId && <option disabled>— selecciona room primero —</option>}
        </select>
      )
    }
    case 'dialogue':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— diálogo —</option>
          {dialogues.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      )
    case 'script':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— script —</option>
          {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )
    case 'audio':
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— audio —</option>
          {audios.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      )
    case 'char_anim': {
      const charId = step.charId || ''
      const char   = chars.find(c => c.id === charId)
      const anims  = char?.animations || []
      return (
        <select value={value||''} onChange={e => onChange(e.target.value)}>
          <option value="">— animación por defecto —</option>
          {anims.map(a => <option key={a.id} value={a.id}>{a.name||a.id}</option>)}
          {!charId && <option disabled>— selecciona personaje primero —</option>}
        </select>
      )
    }
    case 'bool':
      return (
        <select value={String(value??true)} onChange={e => onChange(e.target.value === 'true')}>
          <option value="true">sí / activo</option>
          <option value="false">no / inactivo</option>
        </select>
      )
    case 'dir':
      return (
        <select value={value||'front'} onChange={e => onChange(e.target.value)}>
          {['front','back','left','right'].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      )
    case 'number':
      return <input type="number" value={value??0} step="0.1" onChange={e => onChange(Number(e.target.value))} style={{ width: 80 }} />

    case 'prot_input_mode':
      return (
        <select value={value||'text'} onChange={e => onChange(e.target.value)}>
          <option value="text">Texto libre</option>
          <option value="digits">Solo dígitos (0-9)</option>
          <option value="alphanum">Alfanumérico</option>
        </select>
      )

    case 'prot_img_mode':
      return (
        <select value={value||'none'} onChange={e => onChange(e.target.value)}>
          <option value="none">Sin imagen</option>
          <option value="single">Una imagen centrada</option>
          <option value="halves">Mitades (pcxA sup + pcxB inf)</option>
          <option value="two">Dos imágenes (izq + dcha)</option>
        </select>
      )

    case 'prot_bg_mode':
      return (
        <select value={value||'black'} onChange={e => onChange(e.target.value)}>
          <option value="black">Negro</option>
          <option value="color">Color sólido</option>
          <option value="pcx">PCX de fondo</option>
        </select>
      )

    case 'prot_fail_action':
      return (
        <select value={value||'same'} onChange={e => onChange(e.target.value)}>
          <option value="same">Misma pregunta</option>
          <option value="new">Pregunta siguiente</option>
          <option value="quit">Salir del juego</option>
        </select>
      )

    default:
      return <input type="text" value={value||''} placeholder={ph||k} onChange={e => onChange(e.target.value)} />
  }
}

// ── Step row ──────────────────────────────────────────────────────────────────
function StepRow({ step, idx, total, data, onUpdate, onDelete, onMove, onDuplicate, gameDir, seqId }) {
  const [open, setOpen] = useState(true)
  const def = STEPS[step.type] || {}
  const cat = STEP_CATS[def.cat] || { color: '#64748b', label: '' }
  const isTextStep = step.type === 'show_text' || step.type === 'scroll_text'

  function handleFieldChange(k, v) {
    onUpdate(step.id, { [k]: v })
  }

  return (
    <div className="seq-step" style={{ '--step-color': cat.color }}>
      <div className="seq-step__header" onClick={() => def.fields?.length && setOpen(o => !o)}>
        <div className="seq-step__order">
          <button className="btn-icon btn-tiny" onClick={e => { e.stopPropagation(); onMove(step.id, -1) }} disabled={idx === 0}>▲</button>
          <span className="seq-step__idx">{idx + 1}</span>
          <button className="btn-icon btn-tiny" onClick={e => { e.stopPropagation(); onMove(step.id, 1) }} disabled={idx === total - 1}>▼</button>
        </div>
        <span className="seq-step__cat" style={{ background: cat.color + '22', color: cat.color }}>{cat.label}</span>
        <span className="seq-step__type">{def.label || step.type}</span>
        {def.note && <span className="seq-step__note">{def.note}</span>}
        <div className="seq-step__actions">
          <button className="btn-icon btn-tiny" title="Duplicar paso (copia exacta justo después)"
            onClick={e => { e.stopPropagation(); onDuplicate(step.id) }}>⧉</button>
          <button className="btn-icon btn-tiny seq-del"
            onClick={e => { e.stopPropagation(); onDelete(step.id) }}>✕</button>
        </div>
      </div>

      {open && def.fields?.length > 0 && (
        <div className={`seq-step__fields ${isTextStep ? 'seq-step__fields--text' : ''}`}>
          {def.fields.map(fd => {
            if (fd.k === 'typewriterSpeed' && step.effect !== 'typewriter') return null
            /* Campos condicionales de protection_screen */
            if (step.type === 'protection_screen') {
              const imgMode = step.imgMode || 'none'
              const bgMode  = step.bgMode  || 'black'
              if (fd.k === 'pcxA'    && imgMode === 'none')   return null
              if (fd.k === 'pcxB'    && (imgMode === 'none' || imgMode === 'single')) return null
              if (fd.k === 'bgColor' && bgMode  !== 'color')  return null
              if (fd.k === 'pcxBg'   && bgMode  !== 'pcx')    return null
            }
            const isFull = fd.t === 'seq_locale_text'
            return (
              <label key={fd.k} className={`seq-field-row ${isFull ? 'seq-field-row--full' : ''}`}>
                {!isFull && <span className="seq-field-label">{fd.k}</span>}
                <FieldPicker
                  fd={fd}
                  value={step[fd.k]}
                  onChange={v => handleFieldChange(fd.k, v)}
                  data={data}
                  step={step}
                  gameDir={gameDir}
                  seqId={seqId}
                />
              </label>
            )
          })}
        </div>
      )}

      {open && step.type === 'parallel_block' && (
        <div style={{
          marginLeft: 24, marginTop: 4, marginBottom: 4,
          borderLeft: '3px solid #3b82f6', paddingLeft: 8
        }}>
          <div style={{ fontSize: 10, color: '#3b82f6', marginBottom: 4, fontWeight: 600 }}>
            ⟳ PARALELO — los pasos siguientes se ejecutan a la vez:
          </div>
          {(step.steps || []).map((ps, pi) => {
            const pdef = STEPS[ps.type] || {}
            const pcat = STEP_CATS[pdef.cat] || { color: '#64748b', label: '' }
            return (
              <div key={ps.id} className="seq-step" style={{ '--step-color': pcat.color, marginBottom: 4 }}>
                <div className="seq-step__header" style={{ background: '#1e293b' }}>
                  <div className="seq-step__order">
                    <button className="btn-icon btn-tiny"
                      onClick={e => { e.stopPropagation()
                        const arr = [...(step.steps||[])]; if(pi>0){const t=arr[pi-1];arr[pi-1]=arr[pi];arr[pi]=t; onUpdate(step.id,{steps:arr})} }}
                      disabled={pi === 0}>▲</button>
                    <span className="seq-step__idx">{pi + 1}</span>
                    <button className="btn-icon btn-tiny"
                      onClick={e => { e.stopPropagation()
                        const arr = [...(step.steps||[])]; if(pi<arr.length-1){const t=arr[pi+1];arr[pi+1]=arr[pi];arr[pi]=t; onUpdate(step.id,{steps:arr})} }}
                      disabled={pi === (step.steps||[]).length - 1}>▼</button>
                  </div>
                  <span className="seq-step__cat" style={{ background: pcat.color+'22', color: pcat.color }}>{pcat.label}</span>
                  <span className="seq-step__type">{pdef.label || ps.type}</span>
                  <div className="seq-step__actions">
                    <button className="btn-icon btn-tiny seq-del"
                      onClick={e => { e.stopPropagation()
                        onUpdate(step.id, { steps: (step.steps||[]).filter((_,i)=>i!==pi) })
                      }}>✕</button>
                  </div>
                </div>
                {pdef.fields?.length > 0 && (
                  <div className="seq-step__fields">
                    {pdef.fields.map(fd => (
                      <label key={fd.k} className="seq-field-row">
                        <span className="seq-field-label">{fd.k}</span>
                        <FieldPicker
                          fd={fd}
                          value={ps[fd.k]}
                          onChange={v => {
                            const arr = (step.steps||[]).map((s,i) => i===pi ? {...s,[fd.k]:v} : s)
                            onUpdate(step.id, { steps: arr })
                          }}
                          data={data}
                          step={ps}
                          gameDir={gameDir}
                          seqId={seqId}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:4 }}>
            {['walk_char','face_dir','set_anim','move_text'].map(t => (
              <button key={t} className="seq-palette__btn" style={{ fontSize:10, padding:'2px 6px' }}
                onClick={() => {
                  const pdef = STEPS[t] || {}
                  const defaults = pdef.fields?.reduce((a,f)=>({...a,[f.k]:''}),{}) || {}
                  const newStep = { id: `ps_${Date.now()}`, type: t, ...defaults }
                  onUpdate(step.id, { steps: [...(step.steps||[]), newStep] })
                }}>
                + {STEPS[t]?.label || t}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Palette ───────────────────────────────────────────────────────────────────
function StepPalette({ onAdd }) {
  return (
    <div className="seq-palette">
      <div className="seq-palette__title">Pasos</div>
      {Object.entries(STEP_CATS).map(([catKey, catMeta]) => (
        <div key={catKey} className="seq-palette__cat">
          <div className="seq-palette__cat-label" style={{ color: catMeta.color }}>{catMeta.label}</div>
          {Object.entries(STEPS)
            .filter(([, d]) => d.cat === catKey && !d.hidden)
            .map(([type, d]) => (
              <button key={type} className="seq-palette__btn"
                style={{ '--cat-color': catMeta.color }}
                onClick={() => onAdd(type)}>
                {d.label}
              </button>
            ))}
        </div>
      ))}
    </div>
  )
}

// ── Sequence library ──────────────────────────────────────────────────────────
function SequenceLibrary({ gameDir, onOpen }) {
  const { sequences, loaded, loadSequences, createSequence, deleteSequence, duplicateSequence } = useSequenceStore()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName]   = useState('')
  const [filter, setFilter]     = useState('')
  const inputRef     = useRef(null)
  const containerRef = useRef(null)

  function refocus() { setTimeout(() => containerRef.current?.focus(), 0) }

  useEffect(() => { if (gameDir && !loaded) loadSequences(gameDir) }, [gameDir])
  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  async function handleDelete(id, name) {
    if (!confirm(`¿Eliminar "${name}"?`)) return
    await deleteSequence(gameDir, id)
    refocus()
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) { setCreating(false); refocus(); return }
    const s = await createSequence(gameDir, name)
    setNewName(''); setCreating(false)
    if (s) onOpen(s.id)
  }

  const filtered = sequences.filter(s => !filter || s.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="seq-library" ref={containerRef} tabIndex={-1} style={{ outline: 'none' }}>
      <div className="seq-library__toolbar">
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ Nueva secuencia</button>
        <input type="search" placeholder="Buscar…" value={filter} onChange={e => setFilter(e.target.value)} />
        <span className="seq-library__count">{sequences.length} secuencia{sequences.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="seq-library__list">
        {creating && (
          <div className="seq-card seq-card--new">
            <span>🎬</span>
            <input ref={inputRef} className="seq-card__name-input" value={newName}
              placeholder="Nombre de la secuencia"
              onChange={e => setNewName(e.target.value)}
              onBlur={handleCreate}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') { setCreating(false); setNewName(''); refocus() }
              }} />
          </div>
        )}
        {filtered.length === 0 && !creating && (
          <div className="seq-empty">
            {sequences.length === 0 ? 'Sin secuencias. Crea una arriba.' : 'Sin resultados.'}
          </div>
        )}
        {filtered.map(s => (
          <div key={s.id} className="seq-card" onDoubleClick={() => onOpen(s.id)}>
            <span className="seq-card__icon">🎬</span>
            <div className="seq-card__info">
              <span className="seq-card__name">{s.name}</span>
            </div>
            <div className="seq-card__actions">
              <button className="btn-icon" onClick={() => onOpen(s.id)}>✏</button>
              <button className="btn-icon" onClick={() => duplicateSequence(gameDir, s.id)}>⧉</button>
              <button className="btn-icon seq-del" onClick={() => handleDelete(s.id, s.name)}>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Sequence editor view ──────────────────────────────────────────────────────
function SequenceEditorView({ gameDir, sequenceId, onBack }) {
  const { activeSequence, dirty, openSequence, saveSequence, closeSequence,
          updateMeta, addStep, updateStep, deleteStep, moveStep, duplicateStep } = useSequenceStore()
  const data = useGameData(gameDir)

  useEffect(() => {
    openSequence(gameDir, sequenceId)
    return () => closeSequence()
  }, [sequenceId])

  function handleBack() {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Guardar antes de salir?')) {
      // User pressed Cancel → stay
      // If we want "discard" option we'd need a custom modal; confirm() is binary
      return
    }
    if (dirty) saveSequence(gameDir)
    onBack()
  }

  function handleAddStep(type) {
    addStep(type)
  }

  if (!activeSequence) return <div className="seq-loading">Cargando secuencia…</div>

  return (
    <div className="seq-editor">
      <div className="seq-editor__toolbar">
        <button className="btn-ghost" onClick={handleBack}>← Secuencias</button>
        <input className="seq-editor__name" value={activeSequence.name}
          onChange={e => updateMeta({ name: e.target.value })} />
        {dirty && <span className="seq-dirty" title="Cambios sin guardar">●</span>}
        <div style={{ flex: 1 }} />
        <button className={`btn-primary ${!dirty ? 'btn-primary--disabled' : ''}`}
          disabled={!dirty} onClick={() => saveSequence(gameDir)}>
          💾 Guardar
        </button>
      </div>

      <div className="seq-workspace">
        <StepPalette onAdd={handleAddStep} />
        <div className="seq-main">
          <div className="seq-section">
            <div className="seq-section__title">
              📋 Pasos
              <span className="seq-section__count">{activeSequence.steps?.length || 0}</span>
            </div>
            {(!activeSequence.steps || activeSequence.steps.length === 0) && (
              <div className="seq-step-empty">Sin pasos — selecciona uno del panel izquierdo.</div>
            )}
            {(activeSequence.steps || []).map((step, idx) => (
              <StepRow key={step.id} step={step} idx={idx}
                total={activeSequence.steps.length}
                data={data}
                gameDir={gameDir}
                seqId={activeSequence.id}
                onUpdate={updateStep}
                onDelete={deleteStep}
                onMove={moveStep}
                onDuplicate={duplicateStep}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function SequenceEditor() {
  const { activeGame } = useAppStore()
  const [editingId, setEditingId] = useState(null)
  const gameDir = activeGame?.gameDir

  if (editingId) {
    return <SequenceEditorView gameDir={gameDir} sequenceId={editingId} onBack={() => setEditingId(null)} />
  }

  return (
    <div className="seq-module">
      <div className="seq-module__header">
        <h2>🎬 Secuencias</h2>
        <p>Cutscenes y cinemáticas — lista ordenada de pasos ejecutados de forma lineal y bloqueante.</p>
      </div>
      <SequenceLibrary gameDir={gameDir} onOpen={setEditingId} />
    </div>
  )
}
