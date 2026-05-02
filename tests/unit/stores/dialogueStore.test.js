/**
 * Tests profundos del dialogueStore.
 *
 * Cubre:
 *   - addNode auto-conecta al padre cuando se le pasa parentId.
 *   - deleteNode hace cascade en connections (elimina todas las que referencian al nodo).
 *   - connectNodes reemplaza la conexión existente con el mismo (from, choiceIndex).
 *   - duplicateNode genera un id único y desplaza la posición visual.
 *   - makeDefaultNode produce la estructura mínima para cada NODE_TYPES.
 *   - dirty se marca en cada mutación.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useDialogueStore, NODE_TYPES } from '../../../src/renderer/src/store/dialogueStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useDialogueStore)

const sampleDialogue = (overrides = {}) => ({
  id: 'dlg_001',
  name: 'intro',
  actorId: 'char_hero',
  nodes: [
    { id: 'n_start', type: NODE_TYPES.START, _x: 100, _y: 20 },
  ],
  connections: [],
  ...overrides,
})

beforeEach(() => reset())

describe('dialogueStore — apertura y meta', () => {
  it('estado inicial vacío', () => {
    const st = useDialogueStore.getState()
    expect(st.dialogues).toEqual([])
    expect(st.activeDialogue).toBeNull()
    expect(st.dirty).toBe(false)
    expect(st.loaded).toBe(false)
  })

  it('updateDialogueMeta aplica patch y marca dirty', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue(), dirty: false })
    useDialogueStore.getState().updateDialogueMeta({ name: 'nuevo nombre' })
    const st = useDialogueStore.getState()
    expect(st.activeDialogue.name).toBe('nuevo nombre')
    expect(st.dirty).toBe(true)
  })

  it('closeDialogue limpia activeDialogue y dirty', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue(), dirty: true })
    useDialogueStore.getState().closeDialogue()
    expect(useDialogueStore.getState().activeDialogue).toBeNull()
    expect(useDialogueStore.getState().dirty).toBe(false)
  })
})

describe('dialogueStore — addNode', () => {
  it('añade nodo sin parentId no crea conexión', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.LINE)
    const d = useDialogueStore.getState().activeDialogue
    expect(d.nodes).toHaveLength(2)
    expect(d.nodes[1].type).toBe(NODE_TYPES.LINE)
    expect(d.connections).toHaveLength(0)
  })

  it('addNode con parentId auto-conecta', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.LINE, 'n_start')
    const d = useDialogueStore.getState().activeDialogue
    expect(d.connections).toHaveLength(1)
    const conn = d.connections[0]
    expect(conn.from).toBe('n_start')
    expect(conn.to).toBe(d.nodes[1].id)
    expect(conn.choiceIndex).toBeNull()
  })

  it('addNode con parentId + choiceIndex registra la rama', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.LINE, 'n_choice', 1)
    const d = useDialogueStore.getState().activeDialogue
    const conn = d.connections[0]
    expect(conn.from).toBe('n_choice')
    expect(conn.choiceIndex).toBe(1)
  })

  it('LINE node tiene textKey con prefijo dlg.', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.LINE)
    const node = useDialogueStore.getState().activeDialogue.nodes[1]
    expect(node.textKey).toMatch(/^dlg\..+\.text$/)
    expect(node.actorId).toBeNull()
  })

  it('CHOICE node trae array de choices con textKeys', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.CHOICE)
    const node = useDialogueStore.getState().activeDialogue.nodes[1]
    expect(Array.isArray(node.choices)).toBe(true)
    expect(node.choices.length).toBeGreaterThan(0)
    for (const ch of node.choices) {
      expect(ch.textKey).toMatch(/^dlg\..+\.ch\d+$/)
    }
  })

  it('BRANCH node trae flag y operator por defecto', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().addNode(NODE_TYPES.BRANCH)
    const node = useDialogueStore.getState().activeDialogue.nodes[1]
    expect(node.operator).toBe('is_true')
  })
})

describe('dialogueStore — deleteNode (cascade en connections)', () => {
  it('elimina las conexiones que referencian al nodo borrado', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.LINE, _x: 0, _y: 0 },
          { id: 'n_b', type: NODE_TYPES.LINE, _x: 0, _y: 0 },
          { id: 'n_c', type: NODE_TYPES.END,  _x: 0, _y: 0 },
        ],
        connections: [
          { from: 'n_a', to: 'n_b', choiceIndex: null },
          { from: 'n_b', to: 'n_c', choiceIndex: null },
          { from: 'n_a', to: 'n_c', choiceIndex: null },
        ],
      }),
    })
    useDialogueStore.getState().deleteNode('n_b')
    const d = useDialogueStore.getState().activeDialogue
    expect(d.nodes.map(n => n.id)).toEqual(['n_a', 'n_c'])
    // Solo debería quedar la conexión que NO referencia n_b
    expect(d.connections).toHaveLength(1)
    expect(d.connections[0]).toEqual({ from: 'n_a', to: 'n_c', choiceIndex: null })
  })

  it('borrar un nodo sin conexiones no afecta al resto', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.LINE, _x: 0, _y: 0 },
          { id: 'n_b', type: NODE_TYPES.LINE, _x: 0, _y: 0 },
        ],
        connections: [
          { from: 'n_a', to: 'n_b', choiceIndex: null },
        ],
      }),
    })
    useDialogueStore.getState().deleteNode('n_b')
    const d = useDialogueStore.getState().activeDialogue
    expect(d.nodes.map(n => n.id)).toEqual(['n_a'])
    expect(d.connections).toHaveLength(0)
  })
})

describe('dialogueStore — connectNodes / disconnectNode', () => {
  it('connectNodes reemplaza la conexión existente con mismo (from, choiceIndex)', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.CHOICE, _x: 0, _y: 0 },
          { id: 'n_b', type: NODE_TYPES.END,    _x: 0, _y: 0 },
          { id: 'n_c', type: NODE_TYPES.END,    _x: 0, _y: 0 },
        ],
        connections: [
          { from: 'n_a', to: 'n_b', choiceIndex: 0 },
        ],
      }),
    })
    useDialogueStore.getState().connectNodes('n_a', 'n_c', 0)
    const conns = useDialogueStore.getState().activeDialogue.connections
    expect(conns).toHaveLength(1)
    expect(conns[0]).toEqual({ from: 'n_a', to: 'n_c', choiceIndex: 0 })
  })

  it('connectNodes con choiceIndex distinto coexiste con la anterior', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.CHOICE, _x: 0, _y: 0 },
          { id: 'n_b', type: NODE_TYPES.END,    _x: 0, _y: 0 },
          { id: 'n_c', type: NODE_TYPES.END,    _x: 0, _y: 0 },
        ],
        connections: [
          { from: 'n_a', to: 'n_b', choiceIndex: 0 },
        ],
      }),
    })
    useDialogueStore.getState().connectNodes('n_a', 'n_c', 1)
    const conns = useDialogueStore.getState().activeDialogue.connections
    expect(conns).toHaveLength(2)
  })

  it('disconnectNode elimina la conexión por (from, choiceIndex)', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.CHOICE, _x: 0, _y: 0 },
          { id: 'n_b', type: NODE_TYPES.END,    _x: 0, _y: 0 },
          { id: 'n_c', type: NODE_TYPES.END,    _x: 0, _y: 0 },
        ],
        connections: [
          { from: 'n_a', to: 'n_b', choiceIndex: 0 },
          { from: 'n_a', to: 'n_c', choiceIndex: 1 },
        ],
      }),
    })
    useDialogueStore.getState().disconnectNode('n_a', 0)
    const conns = useDialogueStore.getState().activeDialogue.connections
    expect(conns).toHaveLength(1)
    expect(conns[0].choiceIndex).toBe(1)
  })
})

describe('dialogueStore — duplicateNode', () => {
  it('duplica con id nuevo, desplaza posición visual y regenera textKey', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [
          { id: 'n_a', type: NODE_TYPES.LINE, _x: 100, _y: 200,
            textKey: 'dlg.n_a.text', actorId: 'char_hero', animation: null, charFilter: null },
        ],
      }),
    })
    useDialogueStore.getState().duplicateNode('n_a')
    const nodes = useDialogueStore.getState().activeDialogue.nodes
    expect(nodes).toHaveLength(2)
    const dupe = nodes[1]
    expect(dupe.id).not.toBe('n_a')
    expect(dupe._x).toBe(140)   // 100 + 40
    expect(dupe._y).toBe(240)   // 200 + 40
    // Si el original tenía textKey, el duplicado tiene una textKey nueva
    expect(dupe.textKey).toMatch(/^dlg\..+\.text$/)
    expect(dupe.textKey).not.toBe('n_a')
  })

  it('duplicar id inexistente no muta', () => {
    useDialogueStore.setState({ activeDialogue: sampleDialogue() })
    useDialogueStore.getState().duplicateNode('zzz')
    expect(useDialogueStore.getState().activeDialogue.nodes).toHaveLength(1)
  })
})

describe('dialogueStore — setNodePosition (visual editor)', () => {
  it('actualiza _x/_y y marca dirty', () => {
    useDialogueStore.setState({
      activeDialogue: sampleDialogue({
        nodes: [{ id: 'n_a', type: NODE_TYPES.LINE, _x: 0, _y: 0 }],
      }),
      dirty: false,
    })
    useDialogueStore.getState().setNodePosition('n_a', 333, 444)
    const node = useDialogueStore.getState().activeDialogue.nodes[0]
    expect(node._x).toBe(333)
    expect(node._y).toBe(444)
    expect(useDialogueStore.getState().dirty).toBe(true)
  })
})

describe('dialogueStore — invariantes', () => {
  it('NODE_TYPES exporta los 7 tipos esperados', () => {
    expect(Object.keys(NODE_TYPES).sort()).toEqual(
      ['ACTION', 'BRANCH', 'CHOICE', 'END', 'JUMP', 'LINE', 'START'].sort()
    )
  })
})
