/**
 * @fileoverview DialogueEditor — Editor visual de árboles de diálogo
 *
 * Permite crear y editar árboles de diálogo como grafos de nodos conectados.
 * Cada nodo tiene un tipo (line, choice, branch, action, jump, end) y un
 * conjunto de conexiones salientes.
 *
 * ARQUITECTURA (3 componentes principales):
 *
 *   DialogueLibrary
 *     Lista de diálogos del juego con CRUD. Doble clic → abre editor.
 *
 *   DialogueGraphEditor
 *     Vista de edición de un diálogo concreto. Contiene:
 *       - NodeGraph: canvas 2D con nodos arrastrables y conexiones bezier.
 *       - NodeInspector: panel derecho con los campos del nodo seleccionado.
 *
 *   NodeGraph (canvas-based)
 *     Renderiza el grafo completo en un <canvas>. Gestiona:
 *       - Arrastrar nodos para reposicionarlos (setNodePosition en el store).
 *       - Crear conexiones: clic en el puerto de salida de un nodo → clic en el nodo destino.
 *       - Seleccionar nodos con clic.
 *     Las posiciones se guardan en node._x, node._y (coords del canvas en px).
 *
 * DATOS — localización:
 *   El texto de los nodos NUNCA se guarda en el JSON del diálogo.
 *   Solo se guardan claves de localización (textKey, promptKey).
 *   El texto real vive en locales/es.json, locales/en.json, etc.
 *   El inspector edita el texto directamente en los locales via setKey().
 *
 * CONEXIONES:
 *   { from: nodeId, to: nodeId, choiceIndex: number|null }
 *   choiceIndex != null → la conexión sale de una opción específica del nodo choice.
 *   Las conexiones se dibujan como curvas bezier cúbicas con flechas al final.
 *   Las conexiones de choice se dibujan en violeta con etiqueta [N].
 *
 * TIPOS DE NODO:
 *   line   → Una línea de diálogo de un actor. Campos: actorId, textKey, animation.
 *   choice → Opciones del jugador. Campos: promptKey, choices[{textKey, condition}].
 *   branch → Bifurcación condicional. Salida [0]=true, [1]=false.
 *   action → Ejecuta acciones (set_flag, give_item, call_script, etc.).
 *   jump   → Salta a otro diálogo o nodo.
 *   end    → Termina el árbol de diálogo.
 *
 * @module DialogueEditor
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../store/appStore'
import { useDialogueStore, NODE_TYPES } from '../../store/dialogueStore'
import { useCharStore } from '../../store/charStore'
import { useLocaleStore } from '../../store/localeStore'
import { useObjectStore } from '../../store/objectStore'
import PalettePicker from '../shared/PalettePicker'
import './DialogueEditor.css'

// ── Metadatos visuales de los tipos de nodo ───────────────────────────────────
// Cada tipo tiene color propio para la barra superior del nodo y las conexiones.
/** @type {Record<string, {label:string, color:string, icon:string}>} */
const NODE_META = {
  start:  { label: 'Inicio',    color: '#22c55e', icon: '▶',  palette: false }, // verde — único por diálogo
  line:   { label: 'Línea',     color: '#3b82f6', icon: '💬', palette: true  },
  choice: { label: 'Opciones',  color: '#8b5cf6', icon: '🔀', palette: true  },
  branch: { label: 'Condición', color: '#f59e0b', icon: '⟨⟩', palette: true  },
  action: { label: 'Acción',    color: '#10b981', icon: '⚙',  palette: true  },
  jump:   { label: 'Salto',     color: '#6366f1', icon: '↗',  palette: true  },
  end:    { label: 'Fin',       color: '#ef4444', icon: '■',  palette: true  },
}

// ── DialogueLibrary ───────────────────────────────────────────────────────────
function DialogueLibrary({ gameDir, onOpen }) {
  const { dialogues, loaded, loadDialogues, createDialogue, deleteDialogue, duplicateDialogue } = useDialogueStore()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName]   = useState('')
  const [filter, setFilter]     = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (gameDir && !loaded) loadDialogues(gameDir) }, [gameDir])
  useEffect(() => { if (creating) inputRef.current?.focus() }, [creating])

  async function handleCreate() {
    const name = newName.trim()
    if (!name) { setCreating(false); return }
    const d = await createDialogue(gameDir, name)
    setNewName(''); setCreating(false)
    if (d) onOpen(d.id)
  }

  const filtered = dialogues.filter(d =>
    !filter || d.name.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <div className="dlg-library">
      <div className="dlg-library__toolbar">
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ Nuevo diálogo</button>
        <input type="search" placeholder="Buscar…" value={filter}
          onChange={e => setFilter(e.target.value)} />
        <span className="dlg-library__count">{dialogues.length} diálogo{dialogues.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="dlg-library__list">
        {creating && (
          <div className="dlg-card dlg-card--new">
            <span className="dlg-card__icon">💬</span>
            <input ref={inputRef} className="dlg-card__name-input"
              value={newName} placeholder="Nombre del diálogo"
              onChange={e => setNewName(e.target.value)}
              onBlur={handleCreate}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') { setCreating(false); setNewName('') }
              }} />
          </div>
        )}

        {filtered.length === 0 && !creating && (
          <div className="dlg-empty">
            {dialogues.length === 0
              ? 'Sin diálogos. Crea uno con el botón de arriba.'
              : 'Sin resultados.'}
          </div>
        )}

        {filtered.map(d => (
          <div key={d.id} className="dlg-card" onDoubleClick={() => onOpen(d.id)}>
            <span className="dlg-card__icon">💬</span>
            <div className="dlg-card__info">
              <span className="dlg-card__name">{d.name}</span>
              {d.actorId && <span className="dlg-card__actor">{d.actorId}</span>}
            </div>
            <div className="dlg-card__actions">
              <button className="btn-icon" title="Editar" onClick={() => onOpen(d.id)}>✏</button>
              <button className="btn-icon" title="Duplicar" onClick={() => duplicateDialogue(gameDir, d.id)}>⧉</button>
              <button className="btn-icon dlg-card__del" title="Eliminar"
                onClick={() => confirm(`¿Eliminar "${d.name}"?`) && deleteDialogue(gameDir, d.id)}>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── NodeGraph (canvas-based) ──────────────────────────────────────────────────
//
// Dimensiones fijas de los nodos en el canvas. Todos los nodos tienen el mismo
// tamaño para simplificar la detección de clics y el cálculo de puertos.
const NODE_W = 200  // ancho del nodo en px
const NODE_H = 72   // alto del nodo en px

/**
 * Grafo visual de nodos del diálogo renderizado en un <canvas>.
 *
 * INTERACCIÓN:
 *   - Clic en nodo: selecciona (llama onSelectNode)
 *   - Arrastrar nodo: reposiciona (store.setNodePosition)
 *   - Clic en puerto de salida (⊕, círculo en la parte inferior del nodo):
 *     activa modo "conectando"; el siguiente clic en cualquier nodo crea la conexión.
 *   - Las conexiones son bezier cúbicas. El punto de control vertical se calcula
 *     como cy = (startY + endY) / 2 para ambos extremos → S-curve vertical.
 *
 * ESTADO INTERNO DEL DRAG:
 *   dragRef.current puede ser:
 *     null → no hay drag activo
 *     { type: 'move', nodeId, offsetX, offsetY } → arrastrando nodo
 *     { type: 'connect', fromId, fromIndex? }    → creando conexión
 *
 * @param {Object} props
 * @param {Object} props.dialogue       - Diálogo completo con nodes[] y connections[]
 * @param {Function} props.onSelectNode - Callback(nodeId) cuando se selecciona un nodo
 * @param {string|null} props.selectedNodeId
 * @param {Object} props.locales        - locales[lang][key] = texto
 * @param {string} props.activeLang     - Idioma activo para mostrar preview de texto
 */
function NodeGraph({ dialogue, onSelectNode, selectedNodeId, locales, activeLang }) {
  const canvasRef = useRef(null)
  const { setNodePosition, connectNodes, disconnectNode } = useDialogueStore()
  // dragRef: null | { type:'move', nodeId, offX, offY }
  //                | { type:'connect', fromId, choiceIndex, mx, my }
  const dragRef   = useRef(null)
  const [, forceUpdate] = useState(0)

  // Draw
  useEffect(() => { draw() }, [dialogue, selectedNodeId, locales, activeLang])

  function draw() {
    const canvas = canvasRef.current
    if (!canvas || !dialogue) return
    const loc = locales?.[activeLang] || {}
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Grid dots
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    for (let x = 0; x < W; x += 24) for (let y = 0; y < H; y += 24) {
      ctx.fillRect(x, y, 1.5, 1.5)
    }

    // Connections
    for (const conn of (dialogue.connections || [])) {
      const src = dialogue.nodes.find(n => n.id === conn.from)
      const dst = dialogue.nodes.find(n => n.id === conn.to)
      if (!src || !dst) continue
      const sx = (src._x || 0) + NODE_W / 2, sy = (src._y || 0) + NODE_H
      const dx = (dst._x || 0) + NODE_W / 2, dy = (dst._y || 0)
      const cy = (sy + dy) / 2

      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.bezierCurveTo(sx, cy, dx, cy, dx, dy)
      ctx.strokeStyle = conn.choiceIndex !== null ? '#8b5cf6' : 'rgba(148,163,184,0.5)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.stroke()

      // Arrowhead
      const angle = Math.atan2(dy - (cy + (dy - cy) * 0.1), dx - sx)
      ctx.fillStyle = conn.choiceIndex !== null ? '#8b5cf6' : 'rgba(148,163,184,0.6)'
      ctx.beginPath()
      ctx.moveTo(dx, dy)
      ctx.lineTo(dx - 8 * Math.cos(angle - 0.4), dy - 8 * Math.sin(angle - 0.4))
      ctx.lineTo(dx - 8 * Math.cos(angle + 0.4), dy - 8 * Math.sin(angle + 0.4))
      ctx.closePath(); ctx.fill()

      // Choice index label
      if (conn.choiceIndex !== null) {
        ctx.font = '10px monospace'
        ctx.fillStyle = '#a78bfa'
        ctx.textAlign = 'center'
        ctx.fillText(`[${conn.choiceIndex}]`, (sx + dx) / 2, (sy + dy) / 2 - 6)
        ctx.textAlign = 'left'
      }
    }

    // Nodes
    for (const node of dialogue.nodes) {
      drawNode(ctx, node, node.id === selectedNodeId)
    }

    // Connect-mode preview line
    const dr = dragRef.current
    if (dr?.type === 'connect') {
      const src = dialogue.nodes.find(n => n.id === dr.fromId)
      if (src) {
        const sx = (src._x || 0) + NODE_W / 2, sy = (src._y || 0) + NODE_H
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(dr.mx ?? sx, dr.my ?? sy)
        ctx.strokeStyle = '#a78bfa'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }

  function drawNode(ctx, node, selected) {
    const x = node._x || 0, y = node._y || 0
    const meta = NODE_META[node.type] || NODE_META.line
    const color = meta.color

    ctx.save()
    // Shadow
    if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 14 }

    // Body
    ctx.fillStyle   = selected ? '#1e293b' : '#0f172a'
    ctx.strokeStyle = color
    ctx.lineWidth   = selected ? 2 : 1.5
    roundRect(ctx, x, y, NODE_W, NODE_H, 8)
    ctx.fill(); ctx.stroke()

    // Top color bar
    ctx.fillStyle = color
    ctx.globalAlpha = 0.25
    roundRectTop(ctx, x, y, NODE_W, 22, 8)
    ctx.fill()
    ctx.globalAlpha = 1

    // Icon + type label
    ctx.font = '11px monospace'
    ctx.fillStyle = color
    ctx.fillText(`${meta.icon} ${meta.label.toUpperCase()}`, x + 8, y + 15)

    // Node ID (small)
    ctx.font = '8px monospace'
    ctx.fillStyle = 'rgba(148,163,184,0.4)'
    ctx.textAlign = 'right'
    ctx.fillText(node.id.slice(-8), x + NODE_W - 6, y + 15)
    ctx.textAlign = 'left'

    // Content preview
    ctx.font = '11px sans-serif'
    ctx.fillStyle = 'rgba(226,232,240,0.85)'
    const preview = getNodePreview(node)
    ctx.fillText(truncate(preview, 26), x + 8, y + 38)

    // Secondary preview
    if (node.type === NODE_TYPES.CHOICE && node.choices?.length) {
      ctx.font = '10px sans-serif'
      ctx.fillStyle = 'rgba(148,163,184,0.6)'
      ctx.fillText(`${node.choices.length} opciones`, x + 8, y + 54)
    }

    // Output port dot (bottom center)
    if (node.type !== NODE_TYPES.END) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x + NODE_W / 2, y + NODE_H, 5, 0, Math.PI * 2)
      ctx.fill()
    }

    // Input port dot (top center)
    ctx.fillStyle = 'rgba(148,163,184,0.5)'
    ctx.beginPath()
    ctx.arc(x + NODE_W / 2, y, 4, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }

  function getNodePreview(node) {
    const l = locales?.[activeLang] || {}
    const t = (key) => key ? (l[key] || '') : ''
    switch (node.type) {
      case NODE_TYPES.LINE:   return t(node.textKey) || '(sin texto)'
      case NODE_TYPES.CHOICE: return t(node.promptKey) || (node.choices?.length ? `${node.choices.length} opciones` : '(sin prompt)')
      case NODE_TYPES.BRANCH: return node.flag ? `flag: ${node.flag}` : '(sin condición)'
      case NODE_TYPES.ACTION: return node.actions?.[0] ? `${node.actions[0].type}` : '(sin acción)'
      case NODE_TYPES.JUMP:   return node.targetDialogueId ? `→ ${node.targetDialogueId}` : '(sin destino)'
      case NODE_TYPES.END:    return '— fin del diálogo —'
      default: return ''
    }
  }

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 1) + '…' : str
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r)
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  function roundRectTop(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  function hitNode(x, y) {
    if (!dialogue) return null
    for (let i = dialogue.nodes.length - 1; i >= 0; i--) {
      const n = dialogue.nodes[i]
      if (x >= (n._x||0) && x <= (n._x||0) + NODE_W && y >= (n._y||0) && y <= (n._y||0) + NODE_H)
        return n.id
    }
    return null
  }

  function hitOutputPort(x, y, node) {
    const px = (node._x || 0) + NODE_W / 2
    const py = (node._y || 0) + NODE_H
    return Math.hypot(x - px, y - py) < 10
  }

  // Bezier hit-test: sample puntos de cada curva y comprueba distancia al click
  function hitConnection(mx, my) {
    const THRESHOLD = 8
    for (const conn of (dialogue?.connections || [])) {
      const src = dialogue.nodes.find(n => n.id === conn.from)
      const dst = dialogue.nodes.find(n => n.id === conn.to)
      if (!src || !dst) continue
      const sx = (src._x || 0) + NODE_W / 2, sy = (src._y || 0) + NODE_H
      const dx = (dst._x || 0) + NODE_W / 2, dy = (dst._y || 0)
      const cy = (sy + dy) / 2
      for (let t = 0; t <= 1; t += 0.04) {
        const u = 1 - t
        const bx = u*u*u*sx + 3*u*u*t*sx + 3*u*t*t*dx + t*t*t*dx
        const by = u*u*u*sy + 3*u*u*t*cy + 3*u*t*t*cy + t*t*t*dy
        if (Math.hypot(bx - mx, by - my) < THRESHOLD) return conn
      }
    }
    return null
  }

  function getPos(e) {
    const r = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return
    const { x, y } = getPos(e)

    // En modo conectar: clic en nodo destino → crear conexión
    if (dragRef.current?.type === 'connect') {
      const hit = hitNode(x, y)
      const hitNode_ = hit ? dialogue.nodes.find(n => n.id === hit) : null
      if (hit && hit !== dragRef.current.fromId && hitNode_?.type !== NODE_TYPES.START) {
        connectNodes(dragRef.current.fromId, hit, dragRef.current.choiceIndex)
        onSelectNode(hit)
      }
      dragRef.current = null
      draw()
      return
    }

    // Comprobar clic en puerto de salida (prioridad sobre arrastrar nodo)
    if (dialogue?.nodes) {
      for (const node of dialogue.nodes) {
        if (node.type === NODE_TYPES.END) continue
        if (hitOutputPort(x, y, node)) {
          dragRef.current = { type: 'connect', fromId: node.id, choiceIndex: null, mx: x, my: y }
          onSelectNode(node.id)
          draw()
          return
        }
      }
    }

    // Arrastrar nodo o deseleccionar
    const hit = hitNode(x, y)
    if (hit) {
      onSelectNode(hit)
      const node = dialogue.nodes.find(n => n.id === hit)
      dragRef.current = { type: 'move', nodeId: hit, offX: x - (node._x || 0), offY: y - (node._y || 0) }
    } else {
      onSelectNode(null)
      dragRef.current = null
    }
  }

  function handleMouseMove(e) {
    const { x, y } = getPos(e)
    if (dragRef.current?.type === 'move') {
      setNodePosition(dragRef.current.nodeId, Math.round(x - dragRef.current.offX), Math.round(y - dragRef.current.offY))
    } else if (dragRef.current?.type === 'connect') {
      dragRef.current = { ...dragRef.current, mx: x, my: y }
      draw()
    }
  }

  function handleMouseUp(e) {
    if (dragRef.current?.type === 'move') dragRef.current = null
    // connect mode se cancela con clic derecho, no con mouseup
  }

  function handleContextMenu(e) {
    e.preventDefault()
    // Cancelar modo conectar con clic derecho
    if (dragRef.current?.type === 'connect') {
      dragRef.current = null
      draw()
      return
    }
    // Borrar conexión bajo el cursor
    const { x, y } = getPos(e)
    const conn = hitConnection(x, y)
    if (conn) disconnectNode(conn.from, conn.choiceIndex)
  }

  // Resize canvas to parent
  useEffect(() => {
    function resize() {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width  = canvas.parentElement?.clientWidth  || 800
      canvas.height = canvas.parentElement?.clientHeight || 600
      draw()
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [dialogue])

  return (
    <canvas ref={canvasRef} className="dlg-graph"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu} />
  )
}

// ── NodeInspector ─────────────────────────────────────────────────────────────
function NodeInspector({ node, dialogue, gameDir, chars, objects, onUpdate, onDelete, onDuplicate, onAddChild, onDisconnect }) {
  const { locales, langs, activeLang, setActiveLang, setKey } = useLocaleStore()
  const { dialogues } = useDialogueStore()

  // Helper: read localized text for a key in active lang
  function t(key) { return key ? (locales[activeLang] || {})[key] || '' : '' }
  // Helper: write localized text
  function setT(key, value) { if (key) setKey(activeLang, key, value) }

  function getCharName(id) {
    if (!id) return ''
    const c = chars.find(x => x.id === id)
    return (locales[activeLang] || {})[`char.${id}.name`] || c?.name || c?.id || id
  }

  if (!node) return (
    <div className="dlg-inspector dlg-inspector--empty">
      <p>Selecciona un nodo para editarlo</p>
      <p className="dlg-inspector__hint">Arrastra los nodos para reorganizar</p>
    </div>
  )

  const meta = NODE_META[node.type] || {}

  return (
    <div className="dlg-inspector">
      <div className="dlg-inspector__header" style={{ borderColor: meta.color }}>
        <span style={{ color: meta.color }}>{meta.icon} {meta.label}</span>
        <div className="dlg-lang-tabs">
          {langs.map(l => (
            <button key={l} className={`dlg-lang-tab ${l === activeLang ? 'dlg-lang-tab--active' : ''}`}
              onClick={() => setActiveLang(l)}>{l.toUpperCase()}</button>
          ))}
        </div>
        <button className="btn-icon" title="Duplicar nodo" onClick={() => onDuplicate(node.id)}>⧉</button>
        <button className="btn-icon dlg-card__del" onClick={() => onDelete(node.id)}>🗑</button>
      </div>

      <div className="dlg-inspector__body">
        {/* START */}
        {node.type === NODE_TYPES.START && (
          <p className="dlg-inspector__hint">Punto de entrada del diálogo. Conecta su salida al primer nodo de contenido.</p>
        )}

        {/* LINE */}
        {node.type === NODE_TYPES.LINE && (
          <>
            <label>Actor
              <select value={node.actorId || ''} onChange={e => onUpdate(node.id, { actorId: e.target.value || null })}>
                <option value="">— Narrador —</option>
                {chars.map(c => <option key={c.id} value={c.id}>{getCharName(c.id)}</option>)}
              </select>
            </label>
            <label>
              Texto <span className="dlg-lang-badge">[{activeLang}]</span>
              <textarea rows={4} value={t(node.textKey)} placeholder="Lo que dice el personaje…"
                onChange={e => setT(node.textKey, e.target.value)} />
            </label>
            <label className="dlg-key-hint">
              Clave: <code>{node.textKey}</code>
            </label>
            <label>Animación (opcional)
              {(() => {
                const actor = chars.find(c => c.id === node.actorId)
                const anims = actor?.animations || []
                const roles = actor?.animRoles || {}
                const roleNames = ['idle','walk_right','walk_left','walk_up','walk_down','idle_up','idle_down']
                return (
                  <select value={node.animation || ''} onChange={e => onUpdate(node.id, { animation: e.target.value || null })}>
                    <option value="">— sin cambio —</option>
                    {anims.length > 0 && (
                      <optgroup label="Animaciones">
                        {anims.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Roles del motor">
                      {roleNames.map(r => <option key={r} value={r}>{r}</option>)}
                    </optgroup>
                  </select>
                )
              })()}
            </label>
            <label>Animación final (opcional)
              {(() => {
                const actor = chars.find(c => c.id === node.actorId)
                const anims = actor?.animations || []
                const roleNames = ['idle','walk_right','walk_left','walk_up','walk_down','idle_up','idle_down']
                return (
                  <select value={node.direction || ''} onChange={e => onUpdate(node.id, { direction: e.target.value || null })}>
                    <option value="">— sin cambio —</option>
                    {anims.length > 0 && (
                      <optgroup label="Animaciones">
                        {anims.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                      </optgroup>
                    )}
                    <optgroup label="Roles del motor">
                      {roleNames.map(r => <option key={r} value={r}>{r}</option>)}
                    </optgroup>
                  </select>
                )
              })()}
            </label>
            <label title="Solo muestra esta línea si el protagonista activo es el seleccionado">
              Visible solo para protagonista
              <select value={node.charFilter || ''}
                onChange={e => onUpdate(node.id, { charFilter: e.target.value || null })}>
                <option value="">— todos —</option>
                {chars.map(c => <option key={c.id} value={c.id}>{getCharName(c.id)}</option>)}
              </select>
            </label>
          </>
        )}

        {/* CHOICE */}
        {node.type === NODE_TYPES.CHOICE && (() => {
          const MAX_CHARS = 38 // ~1 línea fuente small en DOS 320px
          return (
            <>
              <label>
                Texto introductorio <span className="dlg-lang-badge">[{activeLang}]</span>
                <input type="text" placeholder="¿Qué quieres decir? (opcional)"
                  value={t(node.promptKey)}
                  onChange={e => setT(node.promptKey, e.target.value)} />
              </label>
              <div className="dlg-choices">
                {(node.choices || []).map((ch, idx) => {
                  const chText  = t(ch.textKey)
                  const chLen   = chText.length
                  const over    = chLen > MAX_CHARS
                  const warn    = !over && chLen > MAX_CHARS * 0.8
                  const countColor = over ? '#ef4444' : warn ? '#f59e0b' : 'rgba(148,163,184,0.4)'
                  const connected  = (dialogue.connections || []).find(
                    c => c.from === node.id && c.choiceIndex === idx
                  )
                  return (
                    <div key={ch.id} className="dlg-choice-row">
                      <span className="dlg-choice-idx">{idx}</span>
                      <div className="dlg-choice-fields">
                        <div style={{ position: 'relative' }}>
                          <input type="text" placeholder={`Opción ${idx + 1} [${activeLang}]`}
                            value={chText}
                            style={over ? { borderColor: '#ef4444', paddingRight: '3.2rem' } : { paddingRight: '3.2rem' }}
                            onChange={e => setT(ch.textKey, e.target.value)} />
                          <span style={{
                            position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)',
                            fontSize: '10px', fontFamily: 'monospace', color: countColor, pointerEvents: 'none',
                          }}>{chLen}/{MAX_CHARS}</span>
                        </div>
                        {/* Selector de tipo de condición */}
                        {(() => {
                          let cond = null
                          if (ch.condition) {
                            try { cond = typeof ch.condition === 'string' ? JSON.parse(ch.condition) : ch.condition } catch { cond = null }
                          }
                          // FIX: detectar 'flag' aunque name sea string vacío
                          const condType = cond?.type === 'prot_has_item' ? 'prot_has_item'
                                         : cond?.type === 'has_item'      ? 'has_item'
                                         : (cond && 'name' in cond)       ? 'flag'
                                         : 'none'
                          function setCond(next) {
                            const choices = node.choices.map((c, i) => i === idx ? { ...c, condition: next ? JSON.stringify(next) : null } : c)
                            onUpdate(node.id, { choices })
                          }
                          // Objetos cogibles disponibles en el juego
                          const pickable = (objects || []).filter(o => o.type === 'pickable')
                          const itemPicker = (type) => (
                            <select style={{ flex:1, fontSize:'10px' }}
                              value={cond?.itemId || ''}
                              onChange={e => setCond({ type, itemId: e.target.value })}>
                              <option value="">— elegir objeto —</option>
                              {pickable.map(o => (
                                <option key={o.id} value={o.id}>{o.name || o.id}</option>
                              ))}
                              {pickable.length === 0 && (
                                <option disabled>No hay objetos cogibles definidos</option>
                              )}
                            </select>
                          )
                          return (
                            <div style={{ display:'flex', gap:'4px', alignItems:'center', flexWrap:'wrap' }}>
                              <select style={{ flex:'0 0 auto', fontSize:'10px' }}
                                value={condType}
                                onChange={e => {
                                  const t = e.target.value
                                  if (t === 'none')           setCond(null)
                                  else if (t === 'flag')           setCond({ name:'', value:'true' })
                                  else if (t === 'has_item')       setCond({ type:'has_item', itemId:'' })
                                  else if (t === 'prot_has_item')  setCond({ type:'prot_has_item', itemId:'' })
                                }}>
                                <option value="none">sin condición</option>
                                <option value="flag">flag</option>
                                <option value="prot_has_item">personaje tiene objeto</option>
                                <option value="has_item">grupo tiene objeto</option>
                              </select>

                              {condType === 'flag' && (
                                <>
                                  <input type="text" placeholder="nombre_flag" style={{ flex:1, minWidth:'80px' }}
                                    value={cond?.name ?? ''}
                                    onChange={e => setCond({ name: e.target.value, value: cond?.value ?? 'true' })} />
                                  <select style={{ flex:'0 0 auto', fontSize:'10px' }}
                                    value={cond?.value ?? 'true'}
                                    onChange={e => setCond({ name: cond?.name ?? '', value: e.target.value })}>
                                    <option value="true">= true</option>
                                    <option value="false">= false</option>
                                  </select>
                                </>
                              )}

                              {condType === 'prot_has_item' && itemPicker('prot_has_item')}
                              {condType === 'has_item'      && itemPicker('has_item')}
                            </div>
                          )
                        })()}
                        <div style={{ display:'flex', gap:'4px', alignItems:'center', marginTop:'2px' }}>
                          <span style={{ fontSize:'10px', opacity:.5, flexShrink:0 }}>Protagonista:</span>
                          <select style={{ flex:1, fontSize:'10px' }}
                            value={ch.charFilter || ''}
                            onChange={e => {
                              const choices = node.choices.map((c, i) => i === idx ? { ...c, charFilter: e.target.value || null } : c)
                              onUpdate(node.id, { choices })
                            }}>
                            <option value="">— todos —</option>
                            {chars.map(c => <option key={c.id} value={c.id}>{getCharName(c.id)}</option>)}
                          </select>
                        </div>
                        {/* Opciones de uso único */}
                        <div style={{ display:'flex', gap:'8px', alignItems:'center', marginTop:'4px', flexWrap:'wrap' }}>
                          <label style={{ display:'flex', alignItems:'center', gap:'4px', fontSize:'10px', cursor:'pointer', userSelect:'none' }}>
                            <input type="checkbox"
                              checked={!!ch.once}
                              onChange={e => {
                                const choices = node.choices.map((c, i) => i === idx ? { ...c, once: e.target.checked } : c)
                                onUpdate(node.id, { choices })
                              }} />
                            <span style={{ color: ch.once ? '#f59e0b' : 'inherit' }}>una sola vez (desaparece)</span>
                          </label>
                        </div>
                        {/* Texto primera vez — solo si no es once puro */}
                        {!ch.once && (
                          <div style={{ marginTop:'4px' }}>
                            <div style={{ fontSize:'10px', color:'rgba(148,163,184,0.6)', marginBottom:'2px' }}>
                              Texto primera vez (vacío = sin alternativo):
                            </div>
                            <input type="text"
                              placeholder={`Primera vez [${activeLang}]`}
                              value={t(ch.onceTextKey || `dlg.${dialogue.id}.${ch.id}.once`)}
                              onChange={e => {
                                const key = ch.onceTextKey || `dlg.${dialogue.id}.${ch.id}.once`
                                setT(key, e.target.value)
                                if (!ch.onceTextKey) {
                                  const choices = node.choices.map((c, i) => i === idx ? { ...c, onceTextKey: key } : c)
                                  onUpdate(node.id, { choices })
                                }
                              }} />
                          </div>
                        )}
                        {connected ? (
                          <div style={{ fontSize: '11px', color: '#a78bfa', padding: '2px 4px' }}>
                            → nodo <code style={{ fontSize: '10px' }}>{connected.to.slice(-8)}</code>
                          </div>
                        ) : (
                          <div className="dlg-choice-addnext">
                            <span style={{ fontSize: '10px', color: 'rgba(148,163,184,0.5)', marginRight: '4px' }}>sig.:</span>
                            {Object.entries(NODE_META).map(([nt, m]) => (
                              <button key={nt} className="dlg-add-node-btn dlg-add-node-btn--xs"
                                style={{ '--node-color': m.color }}
                                title={`Añadir nodo ${m.label} para opción ${idx}`}
                                onClick={() => onAddChild(node.id, nt, idx)}>
                                {m.icon}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div style={{ display:'flex', flexDirection:'column', gap:'1px' }}>
                        <button className="btn-icon" style={{ fontSize:'9px', padding:'1px 4px' }}
                          disabled={idx === 0}
                          title="Subir opción"
                          onClick={() => {
                            if (idx === 0) return
                            const choices = [...node.choices]
                            ;[choices[idx - 1], choices[idx]] = [choices[idx], choices[idx - 1]]
                            // Remap choiceIndex en conexiones: swap idx y idx-1
                            const connections = (dialogue.connections || []).map(c => {
                              if (c.from !== node.id) return c
                              if (c.choiceIndex === idx)     return { ...c, choiceIndex: idx - 1 }
                              if (c.choiceIndex === idx - 1) return { ...c, choiceIndex: idx }
                              return c
                            })
                            onUpdate(node.id, { choices, _connections: connections })
                          }}>▲</button>
                        <button className="btn-icon" style={{ fontSize:'9px', padding:'1px 4px' }}
                          disabled={idx === node.choices.length - 1}
                          title="Bajar opción"
                          onClick={() => {
                            if (idx === node.choices.length - 1) return
                            const choices = [...node.choices]
                            ;[choices[idx], choices[idx + 1]] = [choices[idx + 1], choices[idx]]
                            const connections = (dialogue.connections || []).map(c => {
                              if (c.from !== node.id) return c
                              if (c.choiceIndex === idx)     return { ...c, choiceIndex: idx + 1 }
                              if (c.choiceIndex === idx + 1) return { ...c, choiceIndex: idx }
                              return c
                            })
                            onUpdate(node.id, { choices, _connections: connections })
                          }}>▼</button>
                      </div>
                      <button className="btn-icon" onClick={() => {
                        const choices = node.choices.filter((_, i) => i !== idx)
                        onUpdate(node.id, { choices })
                      }}>✕</button>
                    </div>
                  )
                })}
                <button className="btn-ghost dlg-add-choice" onClick={() => {
                  const chId = `ch_${Date.now()}`
                  const newCh = {
                    id: chId,
                    textKey: `dlg.${dialogue.id}.${chId}`,
                    onceTextKey: `dlg.${dialogue.id}.${chId}.once`,
                    once: false,
                    condition: null,
                  }
                  onUpdate(node.id, { choices: [...(node.choices || []), newCh] })
                }}>＋ Añadir opción</button>
              </div>
            </>
          )
        })()}

        {/* BRANCH */}
        {node.type === NODE_TYPES.BRANCH && (
          <>
            <label>Flag a comprobar
              <input type="text" placeholder="nombre_del_flag" value={node.flag || ''}
                onChange={e => onUpdate(node.id, { flag: e.target.value })} />
            </label>
            <label>Operador
              <select value={node.operator || 'is_true'} onChange={e => onUpdate(node.id, { operator: e.target.value })}>
                <option value="is_true">es verdadero</option>
                <option value="is_false">es falso</option>
                <option value="equals">igual a valor</option>
                <option value="greater">mayor que</option>
                <option value="less">menor que</option>
              </select>
            </label>
            {(node.operator === 'equals' || node.operator === 'greater' || node.operator === 'less') && (
              <label>Valor
                <input type="text" value={node.compareValue || ''}
                  onChange={e => onUpdate(node.id, { compareValue: e.target.value })} />
              </label>
            )}
            <p className="dlg-branch-hint">Conexiones: [0] = verdadero · [1] = falso</p>
          </>
        )}

        {/* ACTION */}
        {node.type === NODE_TYPES.ACTION && (
          <div className="dlg-actions-list">
            {(node.actions || []).map((act, idx) => (
              <div key={idx} className="dlg-action-row">
                <select value={act.type} onChange={e => {
                  const actions = node.actions.map((a, i) => i === idx ? { ...a, type: e.target.value } : a)
                  onUpdate(node.id, { actions })
                }}>
                  <option value="set_flag">Activar flag</option>
                  <option value="clear_flag">Desactivar flag</option>
                  <option value="give_item">Dar objeto</option>
                  <option value="remove_item">Quitar objeto</option>
                  <option value="call_script">Llamar script</option>
                </select>
                <input type="text"
                  placeholder={act.type === 'call_script' ? 'nombre_script' : act.type.includes('flag') ? 'nombre_flag' : 'objeto_id'}
                  value={act.flag || act.script || act.itemId || ''}
                  onChange={e => {
                    const key = act.type === 'call_script' ? 'script' : act.type.includes('flag') ? 'flag' : 'itemId'
                    const actions = node.actions.map((a, i) => i === idx ? { ...a, [key]: e.target.value } : a)
                    onUpdate(node.id, { actions })
                  }} />
                <button className="btn-icon" onClick={() => {
                  onUpdate(node.id, { actions: node.actions.filter((_, i) => i !== idx) })
                }}>✕</button>
              </div>
            ))}
            <button className="btn-ghost dlg-add-choice" onClick={() => {
              onUpdate(node.id, { actions: [...(node.actions || []), { type: 'set_flag', flag: '' }] })
            }}>＋ Añadir acción</button>
          </div>
        )}

        {/* JUMP */}
        {node.type === NODE_TYPES.JUMP && (
          <>
            <label>Diálogo destino
              <select value={node.targetDialogueId || ''}
                onChange={e => onUpdate(node.id, { targetDialogueId: e.target.value || null, targetNodeId: null })}>
                <option value="">— mismo diálogo —</option>
                {dialogues.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label>Nodo destino (ID)
              <input type="text" placeholder="node_start (vacío = inicio)"
                value={node.targetNodeId || ''}
                onChange={e => onUpdate(node.id, { targetNodeId: e.target.value || null })} />
            </label>
          </>
        )}

        {/* END */}
        {node.type === NODE_TYPES.END && (
          <p className="dlg-inspector__hint">Este nodo termina el diálogo.</p>
        )}
      </div>

      {/* Conexión saliente + botón ✕ para nodos no-CHOICE */}
      {node.type !== NODE_TYPES.END && node.type !== NODE_TYPES.CHOICE && (() => {
        const outConn = (dialogue.connections || []).filter(c => c.from === node.id && c.choiceIndex === null)
        if (outConn.length === 0) return null
        return (
          <div className="dlg-inspector__connections">
            {outConn.map(c => (
              <div key={c.to} className="dlg-inspector__conn-row">
                <span style={{ color: '#a78bfa', fontSize: '11px' }}>
                  → <code style={{ fontSize: '10px' }}>{c.to.slice(-8)}</code>
                </span>
                <button className="btn-icon" title="Eliminar conexión"
                  onClick={() => onDisconnect(node.id, null)}>✕</button>
              </div>
            ))}
          </div>
        )
      })()}

      {/* Add child node buttons — oculto para CHOICE (conexiones son por opción) */}
      {node.type !== NODE_TYPES.END && node.type !== NODE_TYPES.JUMP && node.type !== NODE_TYPES.CHOICE && (
        <div className="dlg-inspector__add-child">
          <span className="dlg-inspector__add-label">Añadir nodo siguiente:</span>
          <div className="dlg-inspector__add-btns">
            {Object.entries(NODE_META).map(([t, m]) => (
              <button key={t} className="dlg-add-node-btn"
                style={{ '--node-color': m.color }}
                onClick={() => onAddChild(node.id, t, null)}>
                {m.icon} {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── DialogueGraphEditor (main editing view) ───────────────────────────────────
function DialogueGraphEditor({ gameDir, dialogueId, onBack }) {
  function handleBack() {
    const { dirty: dDirty } = useDialogueStore.getState()
    const { dirty: lDirty } = useLocaleStore.getState()
    if (dDirty || lDirty?.size > 0) {
      if (!confirm('Hay cambios sin guardar. ¿Salir sin guardar?')) return
    }
    onBack()
  }
  const { activeDialogue, dirty, openDialogue, saveDialogue, closeDialogue,
          updateNode, deleteNode, duplicateNode, addNode, updateDialogueMeta, disconnectNode } = useDialogueStore()
  const { chars, loadChars } = useCharStore()
  const { objects, loadObjects } = useObjectStore()
  const { activeGame } = useAppStore()
  const palette = activeGame?.game?.palette || []
  const { locales, activeLang, dirty: localeDirty, saveAll: saveLocales, loadAll: loadLocales } = useLocaleStore()
  const [selectedNodeId, setSelectedNodeId] = useState(null)

  useEffect(() => {
    openDialogue(gameDir, dialogueId)
    return () => closeDialogue()
  }, [dialogueId])

  useEffect(() => {
    if (gameDir) {
      loadChars(gameDir)
      loadObjects(gameDir)
      loadLocales(gameDir)   // always reload — locales may have changed since last visit
    }
  }, [gameDir])

  function getCharName(id) {
    if (!id) return '?'
    const c = chars.find(x => x.id === id)
    return (locales[activeLang] || {})[`char.${id}.name`] || c?.name || id
  }

  const selectedNode = activeDialogue?.nodes?.find(n => n.id === selectedNodeId)

  if (!activeDialogue) return <div className="dlg-loading">Cargando diálogo…</div>

  return (
    <div className="dlg-editor">
      {/* Toolbar */}
      <div className="dlg-editor__toolbar">
        <button className="btn-ghost" onClick={handleBack}>← Diálogos</button>
        <span className="dlg-editor__title">
          {activeDialogue.name}
          {(dirty || localeDirty?.size > 0) && <span className="dlg-dirty"> ●</span>}
        </span>
        {/* Colores del panel de opciones — override por diálogo */}
        {(() => {
          const hasOverride = !!activeDialogue.colors
          const dc = activeDialogue.colors || {}
          const setDC = (k, v) => updateDialogueMeta({ colors: { ...dc, [k]: v } })
          const clearColors = () => updateDialogueMeta({ colors: null })
          const enableColors = () => updateDialogueMeta({ colors: { bg:16, brd:0, txt:15, sel:26 } })
          return (
            <div style={{ display:'flex', gap:'6px', alignItems:'center', padding:'0 6px',
                          borderLeft:'1px solid #444', marginLeft:'4px' }}>
              <label style={{ display:'flex', alignItems:'center', gap:'4px', fontSize:'11px', cursor:'pointer' }}>
                <input type="checkbox" checked={hasOverride}
                  onChange={e => e.target.checked ? enableColors() : clearColors()} />
                <span style={{ opacity:.7 }}>colores propios</span>
              </label>
              {hasOverride && [
                { k:'bg',  label:'fondo', def:16 },
                { k:'brd', label:'borde', def:0  },
                { k:'txt', label:'texto', def:15 },
                { k:'sel', label:'hover', def:26 },
              ].map(({ k, label, def }) => (
                <label key={k} style={{ display:'flex', alignItems:'center', gap:'3px', fontSize:'10px' }}>
                  <span style={{ opacity:.6 }}>{label}</span>
                  <PalettePicker palette={palette} value={dc[k] ?? def} onChange={v => setDC(k, v)} />
                </label>
              ))}
            </div>
          )
        })()}
        <div style={{ flex: 1 }} />
        <button className={`btn-primary ${(!dirty && !localeDirty?.size) ? 'btn-primary--disabled' : ''}`}
          onClick={async () => { await saveDialogue(gameDir); await saveLocales(gameDir) }} disabled={!dirty && !localeDirty?.size}>
          💾 Guardar
        </button>
      </div>

      {/* Workspace: palette | inspector | graph */}
      <div className="dlg-workspace">
        <div className="dlg-palette">
          <div className="dlg-palette__label">Añadir nodo</div>
          {Object.entries(NODE_META).filter(([t, m]) => {
            if (!m.palette) return false
            if (t === NODE_TYPES.START) return !activeDialogue?.nodes?.some(n => n.type === NODE_TYPES.START)
            return true
          }).map(([t, m]) => (
            <button key={t} className="dlg-palette-btn"
              style={{ '--node-color': m.color }}
              onClick={() => addNode(t)}>
              <span className="dlg-palette-btn__icon">{m.icon}</span>
              <span className="dlg-palette-btn__name">{m.label}</span>
            </button>
          ))}
        </div>
        <NodeInspector
          node={selectedNode}
          dialogue={activeDialogue}
          gameDir={gameDir}
          chars={chars}
          objects={objects}
          onUpdate={updateNode}
          onDelete={(id) => { deleteNode(id); setSelectedNodeId(null) }}
          onDuplicate={(id) => { duplicateNode(id) }}
          onAddChild={(parentId, type, choiceIndex) => { addNode(type, parentId, choiceIndex) }}
          onDisconnect={(fromId, choiceIndex) => { disconnectNode(fromId, choiceIndex) }}
        />
        <div className="dlg-graph-area">
          <NodeGraph
            dialogue={activeDialogue}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            locales={locales}
            activeLang={activeLang}
          />
        </div>
      </div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function DialogueEditor() {
  const { activeGame } = useAppStore()
  const [editingId, setEditingId] = useState(null)
  const gameDir = activeGame?.gameDir

  if (editingId) {
    return <DialogueGraphEditor
      gameDir={gameDir}
      dialogueId={editingId}
      onBack={() => setEditingId(null)}
    />
  }

  return (
    <div className="dlg-module">
      <div className="dlg-module__header">
        <h2>💬 Diálogos</h2>
        <p>Árboles de conversación. Doble clic para editar un diálogo.</p>
      </div>
      <DialogueLibrary gameDir={gameDir} onOpen={setEditingId} />
    </div>
  )
}
