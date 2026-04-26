/**
 * @fileoverview GameParams — Parámetros globales del juego
 *
 * Configura cómo arranca el juego:
 *   1. startSequence (obligatorio) — secuencia de inicio que controla todo el flujo
 *   2. activeVerbSet (obligatorio) — verbset activo al inicio
 *
 * Las rooms se cargan desde la secuencia activa mediante pasos load_room.
 * No existe "room de inicio" — la secuencia de inicio es el punto de entrada.
 *
 * FLUJO DE ARRANQUE:
 *   startSequence → [load_room → gameplay → load_room → …]
 */
import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../../store/appStore'
import { useLocaleStore } from '../../store/localeStore'
import PalettePicker from '../shared/PalettePicker'
import './GameParams.css'

// ── FontSlot — gestión de una fuente individual ───────────────────────────────
// slot: 'small' | 'medium' | 'large'
// desc: descripción del tamaño de glifo
function FontSlot({ gameDir, slot, desc, current, onImported }) {
  const [importing, setImporting] = useState(false)

  async function handleImport() {
    setImporting(true)
    try {
      const r = await window.api.importFontSlot(gameDir, slot)
      if (r?.ok) onImported()
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="gp-font-slot">
      <div className="gp-font-slot__name">{slot}.pcx</div>
      <div className="gp-font-slot__desc">{desc}</div>
      <div className="gp-font-slot__status">
        {current
          ? <span className="gp-font-slot__ok">✓ personalizada</span>
          : <span className="gp-font-slot__default">generada automáticamente</span>}
      </div>
      <button className="btn-ghost gp-font-slot__btn"
        disabled={importing || !gameDir}
        onClick={handleImport}>
        {importing ? '⏳…' : current ? '✏ Reemplazar' : '＋ Importar PCX'}
      </button>
    </div>
  )
}

export default function GameParams() {
  const { activeGame, updateGame } = useAppStore()
  const gameDir = activeGame?.gameDir
  const game    = activeGame?.game
  const { loadAll } = useLocaleStore()

  const palette = game?.palette || []

  const [sequences, setSequences] = useState([])
  const [verbsets,  setVerbsets]  = useState([])
  const [params,    setParams]    = useState(null)
  const [dirty,     setDirty]     = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [fontFiles, setFontFiles] = useState([])  /* ficheros PCX en assets/fonts/ */

  useEffect(() => {
    if (!game) return
    setParams({ ...game })
    setDirty(false)
    setSaved(false)
  }, [game])

  /* Cargar lista de fuentes actuales */
  const refreshFonts = useCallback(() => {
    if (!gameDir) return
    window.api.listFonts(gameDir).then(r => { if (r?.ok) setFontFiles(r.files || []) })
  }, [gameDir])

  useEffect(() => {
    if (!gameDir) return
    window.api.listSequences(gameDir).then(r => { if (r?.ok) setSequences(r.sequences || []) })
    window.api.listVerbsets(gameDir).then(r =>  { if (r?.ok) setVerbsets(r.verbsets   || []) })
    loadAll(gameDir)
    refreshFonts()
  }, [gameDir])

  if (!params) {
    return <div className="gp-root"><div className="gp-empty">Abre un juego para configurar sus parámetros.</div></div>
  }

  function up(partial) {
    setParams(p => ({ ...p, ...partial }))
    setDirty(true)
    setSaved(false)
  }

  async function handleSave() {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const r = await window.api.saveGame(gameDir, params)
      if (r?.ok) {
        updateGame(params)
        setDirty(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      }
    } finally {
      setSaving(false)
    }
  }

  const startSeqName = sequences.find(s => s.id === params.startSequence)?.name
  const hasStartSeq  = !!params.startSequence

  return (
    <div className="gp-root">
      <div className="gp-header">
        <div>
          <h2>🎮 Parámetros del juego</h2>
          <p className="gp-subtitle">Configuración de arranque de <strong>{params.name || params.id}</strong>.</p>
        </div>
        <div className="gp-header__actions">
          {dirty && <span className="gp-dirty">● sin guardar</span>}
          {saved && <span className="gp-saved">✓ guardado</span>}
          <button className="btn-primary" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? '⏳ Guardando…' : '💾 Guardar'}
          </button>
        </div>
      </div>

      <div className="gp-body">

        {/* ── Validación global ────────────────────────────────────────────── */}
        {!hasStartSeq && (
          <div className="gp-alert">
            ⚠️ El juego no puede arrancar sin una <strong>secuencia de inicio</strong>. Crea una en el módulo Secuencias y selecciónala abajo.
          </div>
        )}

        {/* ── 1. Secuencia de inicio (obligatoria) ─────────────────────────── */}
        <section className={`gp-section ${!hasStartSeq ? 'gp-section--required' : ''}`}>
          <div className="gp-section__title">🎬 Secuencia de inicio <span className="gp-required-badge">obligatorio</span></div>
          <p className="gp-hint">
            Controla todo el flujo del juego desde el principio: logos, intro cinemática, carga de la primera room…
            Las rooms se cargan desde la secuencia con el paso <code>load_room</code>.
            Esta secuencia es el único punto de entrada del juego.
          </p>
          <div className="gp-field">
            <label className="gp-label">Secuencia</label>
            <select value={params.startSequence || ''} onChange={e => up({ startSequence: e.target.value || null })}>
              <option value="">— selecciona una secuencia —</option>
              {sequences.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
            </select>
            {sequences.length === 0 && <p className="gp-warn">No hay secuencias. Crea una en el módulo Secuencias.</p>}
          </div>
        </section>

        {/* ── 2. Verbset inicial (obligatorio) ────────────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">🖱 Verbset activo al inicio <span className="gp-required-badge">obligatorio</span></div>
          <p className="gp-hint">
            Conjunto de verbos con el que el jugador empieza la partida.
            Los scripts pueden cambiarlo en cualquier momento.
          </p>
          <div className="gp-field">
            <label className="gp-label">Verbset</label>
            <select value={params.activeVerbSet || ''} onChange={e => up({ activeVerbSet: e.target.value || null })}>
              <option value="">— primer verbset disponible —</option>
              {verbsets.map(v => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
            </select>
            {verbsets.length === 0 && <p className="gp-warn">No hay verbsets. Crea uno en el módulo Verbsets.</p>}
          </div>
        </section>

        {/* ── 3. Audio (AIL2 / MIDPAK) ────────────────────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">🎵 Audio — AIL/32</div>
          <p className="gp-hint">
            El juego usa <strong>AIL/32</strong> (Miles Sound System 32-bit, compatible con Watcom/DOS4GW).
            El driver seleccionado se copia automáticamente al directorio de build junto al ejecutable.<br/>
            <strong>Sin driver</strong>: el juego funciona igualmente, sin música ni SFX.
          </p>

          {/* Driver preset selector */}
          <div className="gp-field">
            <label className="gp-label">Hardware objetivo</label>
            <select
              value={(() => {
                const drv = (params.audio?.audioDriver || params.audio?.driver_adv || '').toLowerCase()
                if (!drv) return 'none'
                if (drv.includes('adlib')) return 'adlib'
                if (drv.includes('sbfm') || drv === 'a32sbfm.dll') return 'sb'
                if (drv.includes('mt32')) return 'mt32'
                if (drv.includes('spkr')) return 'pcspkr'
                return 'custom'
              })()}
              onChange={e => {
                const presets = {
                  none:   { audioDriver: '' },
                  adlib:  { audioDriver: 'a32adlib.dll' },
                  sb:     { audioDriver: 'a32sbfm.dll'  },
                  mt32:   { audioDriver: 'a32mt32.dll'  },
                  pcspkr: { audioDriver: 'a32spkr.dll'  },
                }
                const preset = presets[e.target.value]
                if (preset) up({ audio: { ...(params.audio || {}), ...preset }})
              }}
            >
              <option value="none">🔇 Sin audio</option>
              <option value="adlib">🎹 AdLib / OPL2 — a32adlib.dll (recomendado)</option>
              <option value="sb">🔊 Sound Blaster FM — a32sbfm.dll</option>
              <option value="mt32">🎹 Roland MT-32 — a32mt32.dll</option>
              <option value="pcspkr">📢 PC Speaker — a32spkr.dll</option>
              <option value="custom">⚙️ Personalizado</option>
            </select>
          </div>

          {/* Driver custom */}
          <div className="gp-field">
            <label className="gp-label">Driver <code>.dll</code></label>
            <input
              type="text"
              value={params.audio?.audioDriver || ''}
              placeholder="a32adlib.dll"
              onChange={e => up({ audio: { ...(params.audio || {}), audioDriver: e.target.value }})}
            />
            <small className="gp-hint">Banco de timbres SAMPLE.AD se copia automáticamente para drivers OPL2/OPL3.</small>
          </div>

          {/* Volúmenes por defecto */}
          <div className="gp-field-row">
            <div className="gp-field">
              <label className="gp-label">Volumen música por defecto <span className="gp-optional">(0-127)</span></label>
              <div className="gp-slider-row">
                <input
                  type="range" min="0" max="127"
                  value={params.audio?.music_volume ?? 100}
                  onChange={e => up({ audio: { ...(params.audio || {}), music_volume: +e.target.value }})}
                />
                <span className="gp-slider-val">{params.audio?.music_volume ?? 100}</span>
              </div>
            </div>
            <div className="gp-field">
              <label className="gp-label">Volumen SFX por defecto <span className="gp-optional">(0-127)</span></label>
              <div className="gp-slider-row">
                <input
                  type="range" min="0" max="127"
                  value={params.audio?.sfx_volume ?? 100}
                  onChange={e => up({ audio: { ...(params.audio || {}), sfx_volume: +e.target.value }})}
                />
                <span className="gp-slider-val">{params.audio?.sfx_volume ?? 100}</span>
              </div>
            </div>
          </div>

          {/* Info de distribución */}
          {params.audio?.driver_adv && (
            <div className="gp-audio-info">
              <strong>📦 Distribuir junto al .EXE:</strong>
              <code>{params.audio.driver_adv}</code>
              {params.audio.driver_patches && <code>{params.audio.driver_patches}</code>}
              <code>GRAPHICS.DAT</code>
              <code>AUDIO.DAT</code>
              <code>SCRIPTS.DAT</code>
            </div>
          )}
        </section>


        <section className="gp-section gp-section--flow">
          <div className="gp-section__title">📋 Flujo de arranque</div>
          <div className="gp-flow">
            <div className={`gp-flow__node ${hasStartSeq ? 'gp-flow__node--seq' : 'gp-flow__node--missing'}`}>
              🎬 {hasStartSeq
                ? <strong>{startSeqName || params.startSequence}</strong>
                : <em>⚠ secuencia de inicio no definida</em>}
              <span className="gp-flow__sub">punto de entrada del juego</span>
            </div>
            <div className="gp-flow__arrow">↓</div>
            <div className="gp-flow__node gp-flow__node--room">
              🏠 <code>load_room</code> dentro de la secuencia
              <span className="gp-flow__sub">la secuencia controla cuándo y qué room cargar</span>
            </div>
            <div className="gp-flow__arrow">↕</div>
            <div className="gp-flow__node gp-flow__node--scripts">
              📜 Scripts + Gameplay
              <span className="gp-flow__sub">verbset: {verbsets.find(v => v.id === params.activeVerbSet)?.name || params.activeVerbSet || '(primer disponible)'}</span>
            </div>
          </div>
        </section>


        {/* ── 4. Motor — opciones de compilación ──────────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">⚙️ Motor</div>
          <p className="gp-hint">
            Opciones que afectan al tamaño y rendimiento del ejecutable compilado.
            Requieren recompilar para tener efecto.
          </p>
          <div className="gp-prop-row">
            <label title="Tamaño de celda del walkmap. 4×4 px: mayor precisión (+270 KB RAM estática). 8×8 px: menor uso de RAM (defecto).">
              Grid walkmap
            </label>
            <select
              value={params.walkmapCellSize || 8}
              onChange={e => up({ walkmapCellSize: +e.target.value })}
            >
              <option value={8}>8×8 px — ligero (defecto)</option>
              <option value={4}>4×4 px — preciso (+270 KB RAM)</option>
            </select>
          </div>
        </section>

        {/* ── 5. Fuentes del juego ────────────────────────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">🔤 Fuentes del juego</div>
          <p className="gp-hint">
            El motor usa tres fuentes bitmap PCX: <strong>small</strong> (8×8 px),{' '}
            <strong>medium</strong> (8×16 px) y <strong>large</strong> (16×16 px).
            Si no se importa ninguna, se generan automáticamente al compilar.
            Para personalizar una fuente, importa un PCX con el mapa de caracteres adecuado
            (112 glifos en fila, índice 0=transparente, índice 1=color de texto).
          </p>
          <div className="gp-fonts-list">
            {[
              { slot: 'small',  desc: '8×8 px — textos de UI e inventario' },
              { slot: 'medium', desc: '8×16 px — diálogos y narración' },
              { slot: 'large',  desc: '16×16 px — títulos y créditos' },
            ].map(({ slot, desc }) => (
              <FontSlot
                key={slot}
                gameDir={gameDir}
                slot={slot}
                desc={desc}
                current={fontFiles.some(f => f.name.toLowerCase() === `${slot}.pcx`)}
                onImported={refreshFonts}
              />
            ))}
          </div>
        </section>

        {/* ── 6. Party selector — colores del popup ───────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">👥 Party selector — colores del popup</div>
          <p className="gp-hint">
            Índices de paleta VGA (0–255) usados en el popup de selección de protagonistas.
            El índice 0 suele ser negro, 8 gris oscuro, 4 azul oscuro, 15 blanco.
          </p>
          <div className="gp-party-colors">
            {[
              { key: 'colorBg',     label: 'Fondo panel',     def: 1 },
              { key: 'colorBorder', label: 'Borde panel',     def: 8 },
              { key: 'colorActive', label: 'Celda activa',    def: 8 },
              { key: 'colorHover',  label: 'Celda hover',     def: 4 },
            ].map(({ key, label, def }) => (
              <div key={key} className="gp-party-color-row">
                <span className="gp-party-color-label">{label}</span>
                <PalettePicker
                  palette={palette}
                  value={params.partyPopup?.[key] ?? def}
                  onChange={v => up({ partyPopup: { ...(params.partyPopup || {}), [key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ── 7. Diálogos — colores del panel de opciones ─────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">💬 Diálogos — colores del panel de opciones</div>
          <p className="gp-hint">
            Colores por defecto del panel de elección de diálogo. Cada diálogo puede sobreescribirlos individualmente desde el editor de diálogos.
          </p>
          <div className="gp-party-colors">
            {[
              { key: 'colorBg',  label: 'Fondo panel',  def: 16 },
              { key: 'colorBrd', label: 'Borde panel',  def: 0  },
              { key: 'colorTxt', label: 'Texto normal', def: 15 },
              { key: 'colorSel', label: 'Fila hover',   def: 26 },
            ].map(({ key, label, def }) => (
              <div key={key} className="gp-party-color-row">
                <span className="gp-party-color-label">{label}</span>
                <PalettePicker
                  palette={palette}
                  value={params.dialogueColors?.[key] ?? def}
                  onChange={v => up({ dialogueColors: { ...(params.dialogueColors || {}), [key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ── 8. Menú de juego — colores de la barra de verbos ───────────── */}
        <section className="gp-section">
          <div className="gp-section__title">🎮 Menú de juego — colores de la barra de verbos</div>
          <p className="gp-hint">
            Colores de la banda UI inferior (verbos, línea de acción, inventario).
            Índices de paleta VGA (0–255). El índice 1 es negro, 8 gris oscuro, 14 amarillo, 15 blanco.
          </p>
          <div className="gp-party-colors">
            {[
              { key: 'colorBg',     label: 'Fondo UI',              def: 1  },
              { key: 'colorAction', label: 'Texto línea de acción', def: 15 },
              { key: 'colorSel',    label: 'Verbo seleccionado',    def: 14 },
              { key: 'colorInvHov', label: 'Inv. hover/selección',  def: 8  },
            ].map(({ key, label, def }) => (
              <div key={key} className="gp-party-color-row">
                <span className="gp-party-color-label">{label}</span>
                <PalettePicker
                  palette={palette}
                  value={params.uiColors?.[key] ?? def}
                  onChange={v => up({ uiColors: { ...(params.uiColors || {}), [key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ── 9. Menú ESC — colores del menú de pausa ────────────────────── */}
        <section className="gp-section">
          <div className="gp-section__title">⏸ Menú ESC — colores del menú de pausa</div>
          <p className="gp-hint">
            Colores del menú que aparece al pulsar ESC durante el juego (Continuar, Guardar, Configuración, Salir).
            Índices de paleta VGA (0–255). Por defecto usa azul oscuro (16), gris medio (20) y cyan (26).
          </p>
          <div className="gp-party-colors">
            {[
              { key: 'colorBg',  label: 'Fondo / overlay dithered', def: 16 },
              { key: 'colorBtn', label: 'Botón normal',             def: 20 },
              { key: 'colorSel', label: 'Botón hover / selección',  def: 26 },
              { key: 'colorBrd', label: 'Borde de panel y botones', def: 0  },
              { key: 'colorTxt', label: 'Texto de botones',         def: 15 },
              { key: 'colorAct', label: 'Ítem activo (resaltado)',  def: 12 },
            ].map(({ key, label, def }) => (
              <div key={key} className="gp-party-color-row">
                <span className="gp-party-color-label">{label}</span>
                <PalettePicker
                  palette={palette}
                  value={params.menuColors?.[key] ?? def}
                  onChange={v => up({ menuColors: { ...(params.menuColors || {}), [key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ── JSON preview ────────────────────────────────────────────────── */}
        <section className="gp-section gp-section--code">
          <div className="gp-section__title">📄 Campos en game.json</div>
          <pre className="gp-json">{JSON.stringify({
            startSequence:    params.startSequence || null,
            activeVerbSet:    params.activeVerbSet || null,
            walkmapCellSize:  params.walkmapCellSize || 8,
            partyPopup:       params.partyPopup || null,
            dialogueColors:   params.dialogueColors || null,
            uiColors:         params.uiColors || null,
            menuColors:       params.menuColors || null,
          }, null, 2)}</pre>
        </section>

      </div>
    </div>
  )
}
