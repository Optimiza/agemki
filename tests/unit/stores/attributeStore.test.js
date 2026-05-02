/**
 * Tests del attributeStore.
 * Cubre setEnabled, updateAttr, setDeathAttr y el contenido de DEFAULT_ATTRIBUTES.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useAttributeStore, DEFAULT_ATTRIBUTES, DEFAULT_ATTR_NAMES } from '../../../src/renderer/src/store/attributeStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useAttributeStore)
beforeEach(() => reset())

describe('attributeStore — estado inicial', () => {
  it('arranca con enabled=false, dirty=false y DEFAULT_ATTRIBUTES', () => {
    const st = useAttributeStore.getState()
    expect(st.enabled).toBe(false)
    expect(st.dirty).toBe(false)
    expect(st.attributes).toEqual(DEFAULT_ATTRIBUTES)
  })

  it('DEFAULT_ATTRIBUTES contiene los 12 atributos esperados', () => {
    expect(DEFAULT_ATTRIBUTES).toHaveLength(12)
    expect(DEFAULT_ATTRIBUTES.find(a => a.id === 'attr_vida').isDeathAttr).toBe(true)
    expect(DEFAULT_ATTRIBUTES.find(a => a.id === 'attr_vida').defaultValue).toBe(100)
    // Solo uno marcado como deathAttr
    expect(DEFAULT_ATTRIBUTES.filter(a => a.isDeathAttr)).toHaveLength(1)
  })

  it('DEFAULT_ATTR_NAMES tiene es y en con las mismas claves', () => {
    const esKeys = Object.keys(DEFAULT_ATTR_NAMES.es).sort()
    const enKeys = Object.keys(DEFAULT_ATTR_NAMES.en).sort()
    expect(esKeys).toEqual(enKeys)
    expect(esKeys.length).toBe(12)
  })
})

describe('attributeStore — setEnabled / updateAttr', () => {
  it('setEnabled marca dirty', () => {
    useAttributeStore.getState().setEnabled(true)
    const st = useAttributeStore.getState()
    expect(st.enabled).toBe(true)
    expect(st.dirty).toBe(true)
  })

  it('updateAttr fusiona el patch en el atributo indicado', () => {
    useAttributeStore.getState().updateAttr('attr_fuerza', { defaultValue: 99 })
    const a = useAttributeStore.getState().attributes.find(x => x.id === 'attr_fuerza')
    expect(a.defaultValue).toBe(99)
    // Los demás siguen igual
    const b = useAttributeStore.getState().attributes.find(x => x.id === 'attr_carisma')
    expect(b.defaultValue).toBe(10)
  })

  it('updateAttr con id inexistente no muta el array', () => {
    useAttributeStore.getState().updateAttr('attr_inventado', { defaultValue: 0 })
    expect(useAttributeStore.getState().attributes).toHaveLength(12)
  })
})

describe('attributeStore — setDeathAttr (mutuamente excluyente)', () => {
  it('marca un atributo como deathAttr y desmarca el resto', () => {
    useAttributeStore.getState().setDeathAttr('attr_poder')
    const list = useAttributeStore.getState().attributes
    expect(list.filter(a => a.isDeathAttr)).toHaveLength(1)
    expect(list.find(a => a.id === 'attr_poder').isDeathAttr).toBe(true)
    expect(list.find(a => a.id === 'attr_vida').isDeathAttr).toBe(false)
  })

  it('marca dirty', () => {
    useAttributeStore.getState().setDeathAttr('attr_fuerza')
    expect(useAttributeStore.getState().dirty).toBe(true)
  })
})
