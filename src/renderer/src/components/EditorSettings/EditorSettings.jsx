/**
 * @fileoverview EditorSettings — Configuración del editor (por máquina)
 *
 * Persiste en userData/agemki-settings.json, NO dentro del proyecto.
 * Cada desarrollador tiene su propia configuración de rutas.
 */
import { useState, useEffect } from 'react'
import './EditorSettings.css'

const DEFAULTS = {
  watcomDir:  '',   // directorio raíz de Open Watcom (contiene binl/wcc386)
  dosboxPath: '',   // ejecutable de DOSBox-X
  buildDir:   '',   // directorio de salida del build (vacío = <gameDir>/build)
  dosboxConf: '',   // fichero .conf personalizado para DOSBox-X (opcional)
  theme:      'dark',
  useMidpak: false,   // usar MIDPAK para audio MIDI (MIDPAK.OBJ + drivers .ADV)
  audioDriver: 'ADLIB.ADV', // driver activo
  audioDriverAd: 'ADLIB.AD', // banco FM (solo AdLib)
}

// Candidatos por defecto para la detección automática
const WATCOM_CANDIDATES = [
  'C:\\WATCOM',
  'C:\\Program Files\\Open Watcom',
  'C:\\Program Files (x86)\\Open Watcom',
  '/usr/watcom',
  '/opt/watcom',
]
const DOSBOX_CANDIDATES = [
  'C:\\Program Files\\DOSBox-X\\dosbox-x.exe',
  'C:\\Program Files (x86)\\DOSBox-X\\dosbox-x.exe',
  '/usr/bin/dosbox-x',
  // /usr/local es el prefijo de Homebrew en Mac Intel y /opt/homebrew el de los
  // Apple Silicon: sin el segundo no se encontraba en ningun Mac ARM.
  '/usr/local/bin/dosbox-x',
  '/opt/homebrew/bin/dosbox-x',
  '/Applications/dosbox-x.app/Contents/MacOS/dosbox-x',
]

export default function EditorSettings() {
  const [settings, setSettings] = useState(DEFAULTS)
  const [status,   setStatus]   = useState(null)  // null | 'checking' | {watcom, dosbox}
  const [saved,    setSaved]    = useState(false)
  const [dirty,    setDirty]    = useState(false)

  useEffect(() => {
    window.api.settingsLoad?.().then(r => {
      if (r?.ok && r.settings) {
        setSettings(s => ({ ...s, ...r.settings }))
      }
    })
  }, [])

  function up(key, val) {
    setSettings(s => ({ ...s, [key]: val }))
    setDirty(true)
    setSaved(false)
  }

  async function handleSave() {
    const r = await window.api.settingsSave?.(settings)
    if (r?.ok) {
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    }
  }

  async function handleDetect() {
    setStatus('checking')
    try {
      const r = await window.api.buildCheckTools?.(settings.watcomDir, settings.dosboxPath)
      setStatus(r || { watcom: false, dosbox: false })
    } catch {
      setStatus({ watcom: false, dosbox: false })
    }
  }

  const Field = ({ label, settingKey, placeholder, hint }) => (
    <div className="es-field">
      <label className="es-label">{label}</label>
      <input
        className="es-input"
        type="text"
        value={settings[settingKey] || ''}
        onChange={e => up(settingKey, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {hint && <p className="es-hint">{hint}</p>}
    </div>
  )

  return (
    <div className="es-root">
      <div className="es-header">
        <div>
          <h2>⚙️ Ajustes del editor</h2>
          <p className="es-subtitle">Configuración local de la máquina — no se incluye en el proyecto.</p>
        </div>
        <div className="es-header__actions">
          {dirty && <span className="es-dirty">● sin guardar</span>}
          {saved && <span className="es-saved">✓ guardado</span>}
          <button className="btn-primary" onClick={handleSave} disabled={!dirty}>💾 Guardar</button>
        </div>
      </div>

      <div className="es-body">

        {/* ── Open Watcom ─────────────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">
            🔧 Open Watcom 2.0
            <a className="es-link" href="https://github.com/open-watcom/open-watcom-v2/releases" target="_blank" rel="noreferrer">Descargar ↗</a>
          </div>

          <Field
            label="Directorio raíz de Watcom"
            settingKey="watcomDir"
            placeholder="C:\WATCOM"
            hint={`Carpeta que contiene binnt/ y binl/. Ejemplos: ${WATCOM_CANDIDATES.slice(0,2).join(', ')}`}
          />

          <div className="es-candidates">
            <span className="es-candidates__label">Ubicaciones habituales:</span>
            {WATCOM_CANDIDATES.map(c => (
              <button key={c} className="es-candidate-btn"
                onClick={() => up('watcomDir', c)}>
                {c}
              </button>
            ))}
          </div>
        </section>

        {/* ── DOSBox-X ─────────────────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">
            🖥 DOSBox-X
            <a className="es-link" href="https://dosbox-x.com" target="_blank" rel="noreferrer">Descargar ↗</a>
          </div>

          <Field
            label="Ejecutable de DOSBox-X"
            settingKey="dosboxPath"
            placeholder="C:\Program Files\DOSBox-X\dosbox-x.exe"
            hint={`Ruta completa al ejecutable. Ejemplos: ${DOSBOX_CANDIDATES.slice(0,2).join(', ')}`}
          />

          <div className="es-candidates">
            <span className="es-candidates__label">Ubicaciones habituales:</span>
            {DOSBOX_CANDIDATES.map(c => (
              <button key={c} className="es-candidate-btn"
                onClick={() => up('dosboxPath', c)}>
                {c}
              </button>
            ))}
          </div>

          <Field
            label="Fichero de configuración DOSBox-X (opcional)"
            settingKey="dosboxConf"
            placeholder="C:\Users\usuario\dosbox-x.conf"
            hint="Si se especifica, se pasa con -conf al lanzar DOSBox-X. Deja vacío para usar la configuración por defecto."
          />
        </section>

        {/* ── Directorio de build ──────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">📁 Directorios</div>

          <Field
            label="Directorio de salida del build"
            settingKey="buildDir"
            placeholder="(vacío = <proyecto>/build/)"
            hint="Deja vacío para usar la carpeta build/ dentro del directorio del proyecto. Útil si quieres compilar en un ramdisk."
          />
        </section>

        {/* ── Audio ───────────────────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">🔊 Audio</div>
          <label className="es-checkbox-row">
            <input
              type="checkbox"
              checked={!!settings.useMidpak}
              onChange={e => up('useMidpak', e.target.checked)}
            />
            <span>Usar MIDPAK para audio MIDI</span>
          </label>
          <p className="es-hint">
            Activa MIDPAK (John W. Ratcliff). Los <code>.mid</code> se convierten a XMI automáticamente.
            Sin conflictos de timers con DOS4GW. Si está desactivado, el audio es silencioso.
          </p>
          {!!settings.useMidpak && (
            <div style={{marginTop:8}}>
              <label className="es-label">Driver de sonido</label>
              <select
                className="es-input"
                value={settings.audioDriver || 'ADLIB.ADV'}
                onChange={e => up('audioDriver', e.target.value)}
              >
                <option value="ADLIB.ADV">AdLib / OPL2 (ADLIB.ADV)</option>
                <option value="SBPFM.ADV">Sound Blaster FM (SBPFM.ADV)</option>
                <option value="GENMID.ADV">General MIDI / MPU-401 (GENMID.ADV)</option>
                <option value="MT32MPU.ADV">Roland MT-32 (MT32MPU.ADV)</option>
                <option value="PCSPKR.ADV">PC Speaker (PCSPKR.ADV)</option>
              </select>
              {(settings.audioDriver === 'ADLIB.ADV' || !settings.audioDriver) && (
                <p className="es-hint" style={{marginTop:4}}>
                  AdLib requiere también <code>ADLIB.AD</code> (banco FM). Se copiará automáticamente como <code>MUSIC.AD</code>.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Detectar herramientas ────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">🔍 Estado de herramientas</div>
          <p className="es-hint">Comprueba si Watcom y DOSBox-X son accesibles con la configuración actual.</p>

          <button className="btn-secondary" onClick={handleDetect} disabled={status === 'checking'}>
            {status === 'checking' ? '⏳ Comprobando…' : '🔍 Detectar herramientas'}
          </button>

          {status && status !== 'checking' && (
            <div className="es-tool-status">
              <div className={`es-tool-row ${status.watcom ? 'es-tool-row--ok' : 'es-tool-row--err'}`}>
                <span className="es-tool-icon">{status.watcom ? '✅' : '❌'}</span>
                <span className="es-tool-name">Open Watcom (wcc386)</span>
                <span className="es-tool-path">{status.watcomPath || (settings.watcomDir || 'no configurado')}</span>
              </div>
              <div className={`es-tool-row ${status.dosbox ? 'es-tool-row--ok' : 'es-tool-row--err'}`}>
                <span className="es-tool-icon">{status.dosbox ? '✅' : '❌'}</span>
                <span className="es-tool-name">DOSBox-X</span>
                <span className="es-tool-path">{status.dosboxPath || (settings.dosboxPath || 'no configurado')}</span>
              </div>
              {!status.watcom && (
                <p className="es-tool-tip">
                  💡 Instala Open Watcom 2.0 y apunta el directorio raíz arriba (ej: <code>C:\WATCOM</code>).
                </p>
              )}
              {!status.dosbox && (
                <p className="es-tool-tip">
                  💡 Instala DOSBox-X y especifica la ruta completa al ejecutable arriba.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Apariencia ───────────────────────────────────────────────────── */}
        <section className="es-section">
          <div className="es-section__title">🎨 Apariencia</div>
          <div className="es-row">
            <label className="es-label">Tema del editor</label>
            <div className="es-theme-btns">
              {['dark','light'].map(t => (
                <button
                  key={t}
                  className={`es-theme-btn ${settings.theme === t ? 'es-theme-btn--active' : ''}`}
                  onClick={() => up('theme', t)}
                >
                  {t === 'dark' ? '🌙 Oscuro' : '☀️ Claro'}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── Acerca de ────────────────────────────────────────────────────── */}
        <section className="es-section es-section--about">
          <div className="es-section__title">ℹ️ Acerca de AGEMKI</div>
          <div className="es-about">
            <div className="es-about__name">ACHUS Game Engine Mark I</div>
            <div className="es-about__abbr">AGEMKI</div>
            <p>Motor y editor visual para crear aventuras gráficas en modo 13h VGA (320×200, 256 colores) para MS-DOS.</p>
            <p>Compilador: Open Watcom 2.0 · Runtime: DOSBox-X</p>
          </div>
        </section>

      </div>
    </div>
  )
}
