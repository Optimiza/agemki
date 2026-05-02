/**
 * Tests profundos del sequenceStore.
 *
 * Cubre:
 *   - addStep con afterIndex null vs número.
 *   - updateStep / deleteStep / moveStep / duplicateStep.
 *   - moveStep respeta límites.
 *   - Defaults aplicados por tipo (`makeDefaultStep`).
 *   - dirty marcado en cada mutación.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSequenceStore, STEPS, STEP_CATS } from '../../../src/renderer/src/store/sequenceStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useSequenceStore)

const sampleSequence = (steps = []) => ({
  id: 'seq_001',
  name: 'intro',
  steps,
})

beforeEach(() => reset())

describe('sequenceStore — apertura y meta', () => {
  it('estado inicial vacío', () => {
    const st = useSequenceStore.getState()
    expect(st.sequences).toEqual([])
    expect(st.activeSequence).toBeNull()
    expect(st.dirty).toBe(false)
    expect(st.loaded).toBe(false)
  })

  it('updateMeta marca dirty', () => {
    useSequenceStore.setState({ activeSequence: sampleSequence(), dirty: false })
    useSequenceStore.getState().updateMeta({ name: 'nuevo' })
    const st = useSequenceStore.getState()
    expect(st.activeSequence.name).toBe('nuevo')
    expect(st.dirty).toBe(true)
  })
})

describe('sequenceStore — addStep', () => {
  it('añade al final cuando afterIndex es null', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 's_a', type: 'wait', seconds: 1 },
      ]),
    })
    useSequenceStore.getState().addStep('play_midi')
    const list = useSequenceStore.getState().activeSequence.steps
    expect(list.map(s => s.type)).toEqual(['wait', 'play_midi'])
  })

  it('inserta después del índice indicado', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 'a', type: 'wait', seconds: 1 },
        { id: 'b', type: 'wait', seconds: 2 },
        { id: 'c', type: 'wait', seconds: 3 },
      ]),
    })
    useSequenceStore.getState().addStep('play_midi', 0)
    const list = useSequenceStore.getState().activeSequence.steps
    expect(list.map(s => s.type)).toEqual(['wait', 'play_midi', 'wait', 'wait'])
  })

  it('aplica defaults: wait → seconds 1.0', () => {
    useSequenceStore.setState({ activeSequence: sampleSequence() })
    useSequenceStore.getState().addStep('wait')
    expect(useSequenceStore.getState().activeSequence.steps[0].seconds).toBe(1.0)
  })

  it('aplica defaults: show_text → estructura completa con localeKey vacío', () => {
    useSequenceStore.setState({ activeSequence: sampleSequence() })
    useSequenceStore.getState().addStep('show_text')
    const step = useSequenceStore.getState().activeSequence.steps[0]
    expect(step.type).toBe('show_text')
    expect(step.localeKey).toBe('')
    expect(step.font).toBe('medium')
    expect(step.duration).toBe(3.0)
  })

  it('marca dirty', () => {
    useSequenceStore.setState({ activeSequence: sampleSequence(), dirty: false })
    useSequenceStore.getState().addStep('wait')
    expect(useSequenceStore.getState().dirty).toBe(true)
  })

  it('sin activeSequence es idempotente', () => {
    useSequenceStore.getState().addStep('wait')
    expect(useSequenceStore.getState().activeSequence).toBeNull()
  })
})

describe('sequenceStore — moveStep', () => {
  it('hacia abajo (+1)', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 'a', type: 'wait' }, { id: 'b', type: 'wait' }, { id: 'c', type: 'wait' },
      ]),
    })
    useSequenceStore.getState().moveStep('a', +1)
    const ids = useSequenceStore.getState().activeSequence.steps.map(s => s.id)
    expect(ids).toEqual(['b', 'a', 'c'])
  })

  it('hacia arriba (-1)', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 'a', type: 'wait' }, { id: 'b', type: 'wait' }, { id: 'c', type: 'wait' },
      ]),
    })
    useSequenceStore.getState().moveStep('c', -1)
    const ids = useSequenceStore.getState().activeSequence.steps.map(s => s.id)
    expect(ids).toEqual(['a', 'c', 'b'])
  })

  it('en límite no muta', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 'a', type: 'wait' }, { id: 'b', type: 'wait' },
      ]),
      dirty: false,
    })
    useSequenceStore.getState().moveStep('a', -1)
    expect(useSequenceStore.getState().activeSequence.steps.map(s => s.id))
      .toEqual(['a', 'b'])
    expect(useSequenceStore.getState().dirty).toBe(false)
  })
})

describe('sequenceStore — duplicateStep', () => {
  it('inserta clon justo después con id nuevo', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([
        { id: 'a', type: 'play_midi', midiId: 'BG.MID' },
      ]),
    })
    useSequenceStore.getState().duplicateStep('a')
    const list = useSequenceStore.getState().activeSequence.steps
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('a')
    expect(list[1].id).not.toBe('a')
    expect(list[1].midiId).toBe('BG.MID')
  })

  it('id inexistente no muta', () => {
    useSequenceStore.setState({
      activeSequence: sampleSequence([{ id: 'a', type: 'wait' }]),
      dirty: false,
    })
    useSequenceStore.getState().duplicateStep('zzz')
    expect(useSequenceStore.getState().activeSequence.steps).toHaveLength(1)
  })
})

describe('sequenceStore — invariantes', () => {
  it('STEPS exporta diccionario no vacío y cada entry tiene cat/label/fields', () => {
    expect(Object.keys(STEPS).length).toBeGreaterThan(20)
    for (const [type, def] of Object.entries(STEPS)) {
      expect(typeof def.cat, `STEPS.${type}.cat`).toBe('string')
      expect(typeof def.label, `STEPS.${type}.label`).toBe('string')
      expect(Array.isArray(def.fields), `STEPS.${type}.fields`).toBe(true)
      // La cat debe estar registrada en STEP_CATS
      expect(STEP_CATS[def.cat], `STEPS.${type}.cat='${def.cat}' no está en STEP_CATS`).toBeDefined()
    }
  })
})
