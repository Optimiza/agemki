/**
 * Tests del verbsetStore.
 * Cubre operaciones puras: open/close, updateVerb (incluyendo invariante
 * isMovement/isDefault únicos), deleteVerb, moveVerb, getGameVerbs.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useVerbsetStore } from '../../../src/renderer/src/store/verbsetStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useVerbsetStore)

const sampleVerbset = (overrides = {}) => ({
  id: 'vs_default',
  name: 'Default',
  verbs: [
    { id: 'vrb_walk',  isMovement: true,  order: 0 },
    { id: 'vrb_use',   isMovement: false, order: 1 },
    { id: 'vrb_look',  isMovement: false, order: 2 },
  ],
  ...overrides,
})

beforeEach(() => reset())

describe('verbsetStore — open / close / update', () => {
  it('openVerbset clona y resetea dirty', () => {
    const orig = sampleVerbset()
    useVerbsetStore.getState().openVerbset(orig)
    const av = useVerbsetStore.getState().activeVerbset
    av.name = 'X'
    expect(orig.name).toBe('Default')
    expect(useVerbsetStore.getState().dirty).toBe(false)
  })

  it('updateVerbset patchea y marca dirty', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset(), dirty: false })
    useVerbsetStore.getState().updateVerbset({ name: 'Custom' })
    expect(useVerbsetStore.getState().activeVerbset.name).toBe('Custom')
    expect(useVerbsetStore.getState().dirty).toBe(true)
  })

  it('closeVerbset limpia activo y dirty', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset(), dirty: true })
    useVerbsetStore.getState().closeVerbset()
    expect(useVerbsetStore.getState().activeVerbset).toBeNull()
    expect(useVerbsetStore.getState().dirty).toBe(false)
  })
})

describe('verbsetStore — updateVerb (invariantes únicos)', () => {
  it('al marcar un verbo isMovement=true, los demás se ponen a false', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset() })
    useVerbsetStore.getState().updateVerb('vrb_use', { isMovement: true })
    const verbs = useVerbsetStore.getState().activeVerbset.verbs
    expect(verbs.find(v => v.id === 'vrb_use').isMovement).toBe(true)
    expect(verbs.find(v => v.id === 'vrb_walk').isMovement).toBe(false)
    expect(verbs.find(v => v.id === 'vrb_look').isMovement).toBe(false)
  })

  it('al marcar isDefault=true, los demás se ponen a false', () => {
    useVerbsetStore.setState({
      activeVerbset: sampleVerbset({
        verbs: [
          { id: 'a', isDefault: true,  order: 0 },
          { id: 'b', isDefault: false, order: 1 },
          { id: 'c', isDefault: false, order: 2 },
        ],
      }),
    })
    useVerbsetStore.getState().updateVerb('b', { isDefault: true })
    const verbs = useVerbsetStore.getState().activeVerbset.verbs
    expect(verbs.find(v => v.id === 'a').isDefault).toBe(false)
    expect(verbs.find(v => v.id === 'b').isDefault).toBe(true)
    expect(verbs.find(v => v.id === 'c').isDefault).toBe(false)
  })

  it('updateVerb sin tocar isMovement/isDefault no toca otros verbos', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset() })
    useVerbsetStore.getState().updateVerb('vrb_use', { icon: '👀' })
    const verbs = useVerbsetStore.getState().activeVerbset.verbs
    expect(verbs.find(v => v.id === 'vrb_walk').isMovement).toBe(true)  // intacto
  })
})

describe('verbsetStore — moveVerb', () => {
  it('reordena dos verbos consecutivos y reasigna order', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset() })
    useVerbsetStore.getState().moveVerb('vrb_walk', +1)
    const verbs = useVerbsetStore.getState().activeVerbset.verbs
    expect(verbs.map(v => v.id)).toEqual(['vrb_use', 'vrb_walk', 'vrb_look'])
    expect(verbs.map(v => v.order)).toEqual([0, 1, 2])
  })

  it('en límite no hace nada', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset() })
    useVerbsetStore.getState().moveVerb('vrb_walk', -1)
    const verbs = useVerbsetStore.getState().activeVerbset.verbs
    expect(verbs.map(v => v.id)).toEqual(['vrb_walk', 'vrb_use', 'vrb_look'])
  })
})

describe('verbsetStore — getGameVerbs', () => {
  it('filtra isMovement, ordena por order y resuelve labels desde locales', () => {
    useVerbsetStore.setState({
      verbsets: [{
        id: 'vs1',
        name: 'VS',
        verbs: [
          { id: 'vrb_walk', isMovement: true,  order: 0, icon: '🚶' },
          { id: 'vrb_use',  isMovement: false, order: 2, icon: '✋' },
          { id: 'vrb_look', isMovement: false, order: 1, icon: '👀' },
        ],
      }],
    })
    const game = { activeVerbSet: 'vs1' }
    const locales = { es: { 'verb.vrb_use': 'Usar', 'verb.vrb_look': 'Mirar' } }
    const list = useVerbsetStore.getState().getGameVerbs(game, 'es', locales)
    expect(list.map(v => v.id)).toEqual(['vrb_look', 'vrb_use'])      // movement out + ordered
    expect(list[0].label).toBe('Mirar')
    expect(list[1].label).toBe('Usar')
  })

  it('cae a "es" si el lang pedido no existe', () => {
    useVerbsetStore.setState({
      verbsets: [{
        id: 'vs1', name: 'VS',
        verbs: [{ id: 'vrb_x', isMovement: false, order: 0 }],
      }],
    })
    const list = useVerbsetStore.getState().getGameVerbs(
      { activeVerbSet: 'vs1' },
      'fr',                      // no existe
      { es: { 'verb.vrb_x': 'En español' } },
    )
    expect(list[0].label).toBe('En español')
  })

  it('si el verbset activo no existe devuelve []', () => {
    useVerbsetStore.setState({ verbsets: [] })
    const list = useVerbsetStore.getState().getGameVerbs(
      { activeVerbSet: 'inexistente' }, 'es', { es: {} }
    )
    expect(list).toEqual([])
  })
})

describe('verbsetStore — addVerb (eliminado)', () => {
  it('addVerb es noop intencional', () => {
    useVerbsetStore.setState({ activeVerbset: sampleVerbset(), dirty: false })
    useVerbsetStore.getState().addVerb()
    expect(useVerbsetStore.getState().activeVerbset.verbs).toHaveLength(3)
    expect(useVerbsetStore.getState().dirty).toBe(false)
  })
})
