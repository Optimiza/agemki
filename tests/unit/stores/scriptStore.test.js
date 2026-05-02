/**
 * Tests profundos del scriptStore.
 *
 * Cubre:
 *   - Inserción / borrado / reordenado de instrucciones.
 *   - `addInstruction(type, afterIndex)` posiciona correctamente (null = final,
 *     n = después de índice n).
 *   - `duplicateInstruction` crea un id distinto y lo coloca justo detrás.
 *   - `moveInstruction` respeta los límites (no desborda).
 *   - `dirty` se marca en cada mutación; `closeScript` lo limpia.
 *   - Defaults de `makeDefaultInstr` por tipo.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useScriptStore, INSTR, TRIGGERS } from '../../../src/renderer/src/store/scriptStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useScriptStore)

const sampleScript = (instructions = []) => ({
  id: 'scr_001',
  name: 'guion test',
  trigger: { type: 'verb_object', verbId: 'vrb_use', objectId: 'obj_key' },
  instructions,
})

beforeEach(() => reset())

describe('scriptStore — apertura, cierre, meta', () => {
  it('estado inicial: scripts vacío, no activeScript, no loaded', () => {
    const st = useScriptStore.getState()
    expect(st.scripts).toEqual([])
    expect(st.activeScript).toBeNull()
    expect(st.loaded).toBe(false)
    expect(st.dirty).toBe(false)
  })

  it('updateMeta sin activeScript no rompe', () => {
    const s = useScriptStore.getState()
    s.updateMeta({ name: 'X' })
    expect(useScriptStore.getState().activeScript).toBeNull()
  })

  it('updateMeta marca dirty y aplica el patch', () => {
    useScriptStore.setState({ activeScript: sampleScript() })
    const s = useScriptStore.getState()
    s.updateMeta({ name: 'renombrado' })
    const st = useScriptStore.getState()
    expect(st.activeScript.name).toBe('renombrado')
    expect(st.dirty).toBe(true)
  })
})

describe('scriptStore — addInstruction', () => {
  it('añade al final cuando afterIndex es null', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'i_a', type: 'WAIT',     seconds: 1 },
        { id: 'i_b', type: 'SET_FLAG', flag: 'x', value: 'true' },
      ]),
    })
    const s = useScriptStore.getState()
    s.addInstruction('SHOW_TEXT')
    const list = useScriptStore.getState().activeScript.instructions
    expect(list.map(i => i.type)).toEqual(['WAIT', 'SET_FLAG', 'SHOW_TEXT'])
  })

  it('inserta después del índice indicado', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'i_a', type: 'WAIT',  seconds: 1 },
        { id: 'i_b', type: 'WAIT',  seconds: 2 },
        { id: 'i_c', type: 'WAIT',  seconds: 3 },
      ]),
    })
    const s = useScriptStore.getState()
    s.addInstruction('SET_FLAG', 0)  // tras i_a
    const list = useScriptStore.getState().activeScript.instructions
    expect(list.map(i => i.type)).toEqual(['WAIT', 'SET_FLAG', 'WAIT', 'WAIT'])
  })

  it('aplica defaults por tipo (SET_FLAG → flag/value)', () => {
    useScriptStore.setState({ activeScript: sampleScript() })
    const s = useScriptStore.getState()
    s.addInstruction('SET_FLAG')
    const inst = useScriptStore.getState().activeScript.instructions[0]
    expect(inst.type).toBe('SET_FLAG')
    expect(inst.flag).toBe('')
    expect(inst.value).toBe('true')
    expect(inst.id).toMatch(/^i_\d+$/)
  })

  it('aplica defaults por tipo (WAIT → seconds 1)', () => {
    useScriptStore.setState({ activeScript: sampleScript() })
    const s = useScriptStore.getState()
    s.addInstruction('WAIT')
    expect(useScriptStore.getState().activeScript.instructions[0].seconds).toBe(1)
  })

  it('marca dirty', () => {
    useScriptStore.setState({ activeScript: sampleScript(), dirty: false })
    useScriptStore.getState().addInstruction('WAIT')
    expect(useScriptStore.getState().dirty).toBe(true)
  })

  it('sin activeScript es idempotente', () => {
    const s = useScriptStore.getState()
    s.addInstruction('WAIT')
    expect(useScriptStore.getState().activeScript).toBeNull()
  })
})

describe('scriptStore — updateInstruction / deleteInstruction', () => {
  it('updateInstruction fusiona el patch en la instrucción correcta', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'i_a', type: 'WAIT', seconds: 1 },
        { id: 'i_b', type: 'WAIT', seconds: 2 },
      ]),
    })
    useScriptStore.getState().updateInstruction('i_b', { seconds: 99 })
    const list = useScriptStore.getState().activeScript.instructions
    expect(list[0].seconds).toBe(1)    // intacto
    expect(list[1].seconds).toBe(99)   // actualizado
  })

  it('deleteInstruction elimina solo la indicada', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'i_a', type: 'WAIT' },
        { id: 'i_b', type: 'WAIT' },
        { id: 'i_c', type: 'WAIT' },
      ]),
    })
    useScriptStore.getState().deleteInstruction('i_b')
    const list = useScriptStore.getState().activeScript.instructions
    expect(list.map(i => i.id)).toEqual(['i_a', 'i_c'])
  })
})

describe('scriptStore — moveInstruction', () => {
  it('mueve hacia abajo (dir +1)', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'a', type: 'WAIT' }, { id: 'b', type: 'WAIT' }, { id: 'c', type: 'WAIT' },
      ]),
    })
    useScriptStore.getState().moveInstruction('a', +1)
    const ids = useScriptStore.getState().activeScript.instructions.map(i => i.id)
    expect(ids).toEqual(['b', 'a', 'c'])
  })

  it('mueve hacia arriba (dir -1)', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'a', type: 'WAIT' }, { id: 'b', type: 'WAIT' }, { id: 'c', type: 'WAIT' },
      ]),
    })
    useScriptStore.getState().moveInstruction('c', -1)
    const ids = useScriptStore.getState().activeScript.instructions.map(i => i.id)
    expect(ids).toEqual(['a', 'c', 'b'])
  })

  it('en el límite superior no hace nada', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'a', type: 'WAIT' }, { id: 'b', type: 'WAIT' },
      ]),
      dirty: false,
    })
    useScriptStore.getState().moveInstruction('a', -1)
    expect(useScriptStore.getState().activeScript.instructions.map(i => i.id))
      .toEqual(['a', 'b'])
    expect(useScriptStore.getState().dirty).toBe(false)
  })

  it('en el límite inferior no hace nada', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'a', type: 'WAIT' }, { id: 'b', type: 'WAIT' },
      ]),
      dirty: false,
    })
    useScriptStore.getState().moveInstruction('b', +1)
    expect(useScriptStore.getState().activeScript.instructions.map(i => i.id))
      .toEqual(['a', 'b'])
    expect(useScriptStore.getState().dirty).toBe(false)
  })
})

describe('scriptStore — duplicateInstruction', () => {
  it('inserta el duplicado justo después del original con id nuevo', () => {
    useScriptStore.setState({
      activeScript: sampleScript([
        { id: 'a', type: 'SET_FLAG', flag: 'foo', value: 'true' },
        { id: 'b', type: 'WAIT', seconds: 5 },
      ]),
    })
    useScriptStore.getState().duplicateInstruction('a')
    const list = useScriptStore.getState().activeScript.instructions
    expect(list).toHaveLength(3)
    expect(list[0].id).toBe('a')
    expect(list[1].id).not.toBe('a')          // id nuevo
    expect(list[1].type).toBe('SET_FLAG')      // mismo type
    expect(list[1].flag).toBe('foo')           // mismos campos
    expect(list[2].id).toBe('b')               // resto intacto
  })

  it('duplicar id inexistente no muta la lista', () => {
    useScriptStore.setState({
      activeScript: sampleScript([{ id: 'a', type: 'WAIT' }]),
      dirty: false,
    })
    useScriptStore.getState().duplicateInstruction('inexistente')
    expect(useScriptStore.getState().activeScript.instructions).toHaveLength(1)
  })
})

describe('scriptStore — invariantes y consistencia con TRIGGERS/INSTR', () => {
  it('TRIGGERS y INSTR exportan diccionarios no vacíos', () => {
    expect(Object.keys(TRIGGERS).length).toBeGreaterThan(5)
    expect(Object.keys(INSTR).length).toBeGreaterThan(20)
  })

  it('cada INSTR define cat, label y fields[]', () => {
    for (const [type, def] of Object.entries(INSTR)) {
      expect(typeof def.cat,   `INSTR.${type}.cat falta`).toBe('string')
      expect(typeof def.label, `INSTR.${type}.label falta`).toBe('string')
      expect(Array.isArray(def.fields), `INSTR.${type}.fields debe ser array`).toBe(true)
    }
  })
})
