import { create } from 'zustand'

export const NODE_TYPES = {
  START:   'start',    // Entry point — always first; one output, no content
  LINE:    'line',     // NPC or protagonist says something
  CHOICE:  'choice',  // Player picks from options
  BRANCH:  'branch',  // Condition check (flag)
  ACTION:  'action',  // Script call / give item / set flag
  JUMP:    'jump',    // Jump to another node or dialogue
  END:     'end',     // Dialogue ends
}

export const useDialogueStore = create((set, get) => ({
  dialogues:      [],   // list metadata [{id,name,actorId}]
  activeDialogue: null, // full dialogue JSON
  dirty:          false,
  loaded:         false,

  // ── CRUD list ────────────────────────────────────────────────────────────
  loadDialogues: async (gameDir) => {
    const r = await window.api.listDialogues(gameDir)
    if (r.ok) set({ dialogues: r.dialogues, loaded: true })
  },

  createDialogue: async (gameDir, name) => {
    const r = await window.api.createDialogue(gameDir, name)
    if (r.ok) {
      await get().loadDialogues(gameDir)
      return r.dialogue
    }
    return null
  },

  deleteDialogue: async (gameDir, id) => {
    await window.api.deleteDialogue(gameDir, id)
    await get().loadDialogues(gameDir)
    if (get().activeDialogue?.id === id) set({ activeDialogue: null })
  },

  duplicateDialogue: async (gameDir, id) => {
    await window.api.duplicateDialogue(gameDir, id)
    await get().loadDialogues(gameDir)
  },

  // ── Active dialogue ───────────────────────────────────────────────────────
  openDialogue: async (gameDir, id) => {
    const r = await window.api.readDialogue(gameDir, id)
    if (r.ok) set({ activeDialogue: r.dialogue, dirty: false })
  },

  closeDialogue: () => set({ activeDialogue: null, dirty: false }),

  saveDialogue: async (gameDir) => {
    const d = get().activeDialogue
    if (!d) return
    await window.api.saveDialogue(gameDir, d)
    set({ dirty: false })
    // Update metadata list
    set(s => ({ dialogues: s.dialogues.map(x => x.id === d.id ? { id: d.id, name: d.name, actorId: d.actorId } : x) }))
  },

  updateDialogueMeta: (partial) => set(s => ({
    activeDialogue: s.activeDialogue ? { ...s.activeDialogue, ...partial } : null,
    dirty: true,
  })),

  // ── Node operations ───────────────────────────────────────────────────────
  addNode: (type, parentId = null, choiceIndex = null) => set(s => {
    if (!s.activeDialogue) return {}
    const id   = `node_${Date.now()}`
    const node = makeDefaultNode(id, type)
    const nodes = [...s.activeDialogue.nodes, node]

    // Auto-connect: if parent given, append id to parent's next or choice branch
    let connections = [...(s.activeDialogue.connections || [])]
    if (parentId !== null) {
      connections = [...connections, { from: parentId, to: id, choiceIndex }]
    }

    return {
      activeDialogue: { ...s.activeDialogue, nodes, connections },
      dirty: true,
    }
  }),

  updateNode: (nodeId, partial) => set(s => {
    if (!s.activeDialogue) return {}
    const { _connections, ...nodePartial } = partial
    return {
      activeDialogue: {
        ...s.activeDialogue,
        nodes: s.activeDialogue.nodes.map(n => n.id === nodeId ? { ...n, ...nodePartial } : n),
        ...(_connections ? { connections: _connections } : {}),
      },
      dirty: true,
    }
  }),

  duplicateNode: (nodeId) => set(s => {
    if (!s.activeDialogue) return {}
    const src = s.activeDialogue.nodes.find(n => n.id === nodeId)
    if (!src) return {}
    const newId = `node_${Date.now()}`
    const newTextKey = src.textKey ? `dlg.${newId}.text` : undefined
    const dupe = {
      ...src,
      id: newId,
      _x: (src._x || 0) + 40,
      _y: (src._y || 0) + 40,
      ...(newTextKey ? { textKey: newTextKey } : {}),
    }
    return {
      activeDialogue: {
        ...s.activeDialogue,
        nodes: [...s.activeDialogue.nodes, dupe],
      },
      dirty: true,
    }
  }),

  deleteNode: (nodeId) => set(s => {
    if (!s.activeDialogue) return {}
    return {
      activeDialogue: {
        ...s.activeDialogue,
        nodes: s.activeDialogue.nodes.filter(n => n.id !== nodeId),
        connections: s.activeDialogue.connections.filter(c => c.from !== nodeId && c.to !== nodeId),
      },
      dirty: true,
    }
  }),

  connectNodes: (fromId, toId, choiceIndex = null) => set(s => {
    if (!s.activeDialogue) return {}
    // Remove existing connection from same source+choiceIndex
    const connections = s.activeDialogue.connections.filter(
      c => !(c.from === fromId && c.choiceIndex === choiceIndex)
    )
    return {
      activeDialogue: { ...s.activeDialogue, connections: [...connections, { from: fromId, to: toId, choiceIndex }] },
      dirty: true,
    }
  }),

  disconnectNode: (fromId, choiceIndex = null) => set(s => {
    if (!s.activeDialogue) return {}
    return {
      activeDialogue: {
        ...s.activeDialogue,
        connections: s.activeDialogue.connections.filter(
          c => !(c.from === fromId && c.choiceIndex === choiceIndex)
        ),
      },
      dirty: true,
    }
  }),

  // Node position (for visual editor)
  setNodePosition: (nodeId, x, y) => set(s => {
    if (!s.activeDialogue) return {}
    return {
      activeDialogue: {
        ...s.activeDialogue,
        nodes: s.activeDialogue.nodes.map(n => n.id === nodeId ? { ...n, _x: x, _y: y } : n),
      },
      dirty: true,
    }
  }),
}))

function makeDefaultNode(id, type) {
  const base = { id, type, _x: 100, _y: 100 }
  switch (type) {
    case NODE_TYPES.START:
      return { ...base, _x: 100, _y: 20 }
    case NODE_TYPES.LINE:
      return { ...base, actorId: null, textKey: `dlg.${id}.text`, animation: null, charFilter: null }
    case NODE_TYPES.CHOICE:
      return { ...base, promptKey: `dlg.${id}.prompt`, choices: [
        { id: `ch_${Date.now()}_0`, textKey: `dlg.${id}.ch0`, condition: null, charFilter: null },
        { id: `ch_${Date.now()}_1`, textKey: `dlg.${id}.ch1`, condition: null, charFilter: null },
      ]}
    case NODE_TYPES.BRANCH:
      return { ...base, flag: '', operator: 'is_true', valueTrue: null, valueFalse: null }
    case NODE_TYPES.ACTION:
      return { ...base, actions: [{ type: 'set_flag', flag: '', value: true }] }
    case NODE_TYPES.JUMP:
      return { ...base, targetDialogueId: null, targetNodeId: null }
    case NODE_TYPES.END:
      return { ...base }
    default:
      return base
  }
}
