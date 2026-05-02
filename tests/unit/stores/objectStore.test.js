/**
 * Tests del objectStore.
 * Cubre la edición del objeto activo (estados, verbActions, combinations, flags,
 * verbResponses) y un pase rápido de carga IPC.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useObjectStore, OBJECT_TYPES } from '../../../src/renderer/src/store/objectStore.js'
import { makeStoreReset, mockApi, getAlertCalls, clearAlertCalls } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useObjectStore)

const sampleObject = (overrides = {}) => ({
  id: 'obj_001',
  name: 'Llave',
  type: 'pickable',
  states: [
    { id: 'st_default', name: 'estado_1', spriteFile: null, inventorySprite: null,
      animated: false, frameCount: 1, fps: 8, frameWidth: 0 },
  ],
  activeStateId: 'st_default',
  verbActions: [],
  combinations: [],
  flags: [],
  ...overrides,
})

beforeEach(() => { reset(); clearAlertCalls() })

describe('objectStore — apertura, cierre, update', () => {
  it('openObject hace deep clone (json roundtrip)', () => {
    const orig = sampleObject()
    useObjectStore.getState().openObject(orig)
    const ac = useObjectStore.getState().activeObject
    ac.states[0].name = 'mutado'
    expect(orig.states[0].name).toBe('estado_1')
  })

  it('updateObject marca dirty', () => {
    useObjectStore.setState({ activeObject: sampleObject(), dirty: false })
    useObjectStore.getState().updateObject({ name: 'X' })
    expect(useObjectStore.getState().dirty).toBe(true)
    expect(useObjectStore.getState().activeObject.name).toBe('X')
  })

  it('closeObject limpia', () => {
    useObjectStore.setState({ activeObject: sampleObject(), dirty: true })
    useObjectStore.getState().closeObject()
    expect(useObjectStore.getState().activeObject).toBeNull()
    expect(useObjectStore.getState().dirty).toBe(false)
  })
})

describe('objectStore — estados', () => {
  it('addState añade con id y nombre coherente', () => {
    useObjectStore.setState({ activeObject: sampleObject() })
    useObjectStore.getState().addState()
    const states = useObjectStore.getState().activeObject.states
    expect(states).toHaveLength(2)
    expect(states[1].name).toBe('estado_2')
  })

  it('updateState patchea por id', () => {
    useObjectStore.setState({
      activeObject: sampleObject({
        states: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      }),
    })
    useObjectStore.getState().updateState('b', { spriteFile: 'X.PCX' })
    expect(useObjectStore.getState().activeObject.states[1].spriteFile).toBe('X.PCX')
    expect(useObjectStore.getState().activeObject.states[0].spriteFile).toBeUndefined()
  })

  it('deleteState respeta invariante "siempre al menos un estado"', () => {
    useObjectStore.setState({
      activeObject: sampleObject({ states: [{ id: 'only' }] }),
    })
    useObjectStore.getState().deleteState('only')
    expect(useObjectStore.getState().activeObject.states).toHaveLength(1)  // no borrado
  })

  it('deleteState reasigna activeStateId si era el borrado', () => {
    useObjectStore.setState({
      activeObject: sampleObject({
        states: [{ id: 'a' }, { id: 'b' }],
        activeStateId: 'a',
      }),
    })
    useObjectStore.getState().deleteState('a')
    const ao = useObjectStore.getState().activeObject
    expect(ao.states.map(s => s.id)).toEqual(['b'])
    expect(ao.activeStateId).toBe('b')
  })
})

describe('objectStore — verbActions', () => {
  it('addVerbAction crea con id único', () => {
    useObjectStore.setState({ activeObject: sampleObject() })
    useObjectStore.getState().addVerbAction('vrb_use')
    const va = useObjectStore.getState().activeObject.verbActions[0]
    expect(va.verb).toBe('vrb_use')
    expect(va.id).toMatch(/^va_\d+$/)
  })

  it('deleteVerbAction elimina por id', () => {
    useObjectStore.setState({
      activeObject: sampleObject({
        verbActions: [{ id: 'va_a' }, { id: 'va_b' }],
      }),
    })
    useObjectStore.getState().deleteVerbAction('va_a')
    expect(useObjectStore.getState().activeObject.verbActions.map(v => v.id))
      .toEqual(['va_b'])
  })
})

describe('objectStore — verbResponses (room) e invVerbResponses (inventario)', () => {
  it('setVerbResponse crea si no existe, fusiona si existe', () => {
    useObjectStore.setState({ activeObject: sampleObject({ verbResponses: [] }) })
    useObjectStore.getState().setVerbResponse('vrb_look', { mode: 'text', textKey: 'k' })
    let vrs = useObjectStore.getState().activeObject.verbResponses
    expect(vrs).toHaveLength(1)
    expect(vrs[0].verbId).toBe('vrb_look')
    expect(vrs[0].textKey).toBe('k')

    useObjectStore.getState().setVerbResponse('vrb_look', { textKey: 'k2' })
    vrs = useObjectStore.getState().activeObject.verbResponses
    expect(vrs).toHaveLength(1)         // no duplica
    expect(vrs[0].textKey).toBe('k2')   // fusiona
  })

  it('setInvVerbResponse opera sobre invVerbResponses (no verbResponses)', () => {
    useObjectStore.setState({
      activeObject: sampleObject({ verbResponses: [], invVerbResponses: [] }),
    })
    useObjectStore.getState().setInvVerbResponse('vrb_use', { mode: 'script', scriptId: 's1' })
    const ao = useObjectStore.getState().activeObject
    expect(ao.invVerbResponses).toHaveLength(1)
    expect(ao.verbResponses).toHaveLength(0)
  })
})

describe('objectStore — combinations y flags', () => {
  it('addCombination/deleteCombination', () => {
    useObjectStore.setState({ activeObject: sampleObject() })
    useObjectStore.getState().addCombination()
    const c = useObjectStore.getState().activeObject.combinations[0]
    expect(c.id).toMatch(/^comb_\d+$/)
    useObjectStore.getState().deleteCombination(c.id)
    expect(useObjectStore.getState().activeObject.combinations).toHaveLength(0)
  })

  it('addFlag con defaults boolean false', () => {
    useObjectStore.setState({ activeObject: sampleObject() })
    useObjectStore.getState().addFlag()
    const f = useObjectStore.getState().activeObject.flags[0]
    expect(f.type).toBe('boolean')
    expect(f.defaultValue).toBe(false)
  })
})

describe('objectStore — IPC (mocks)', () => {
  it('saveActiveObject muestra alert si IPC falla', async () => {
    mockApi({ saveObject: async () => ({ ok: false, error: 'disk full' }) })
    useObjectStore.setState({ activeObject: sampleObject() })
    await useObjectStore.getState().saveActiveObject('/fake/dir')
    expect(getAlertCalls()).toHaveLength(1)
    expect(getAlertCalls()[0]).toContain('disk full')
  })

  it('loadObjects puebla la lista en éxito', async () => {
    mockApi({ listObjects: async () => ({ ok: true, objects: [{ id: 'a' }, { id: 'b' }] }) })
    await useObjectStore.getState().loadObjects('/fake/dir')
    expect(useObjectStore.getState().objects.map(o => o.id)).toEqual(['a', 'b'])
  })
})

describe('objectStore — invariantes', () => {
  it('OBJECT_TYPES exporta los 4 tipos', () => {
    expect(OBJECT_TYPES.map(t => t.id).sort())
      .toEqual(['animated_scenery', 'obstacle', 'pickable', 'scenery'])
  })
})
