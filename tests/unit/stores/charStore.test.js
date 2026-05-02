/**
 * Tests del charStore.
 *
 * Cubre principalmente la edición del personaje activo (animations, patrol,
 * inventario), donde vive la lógica pura. Las acciones IPC-heavy (createChar,
 * deleteChar, saveActiveChar) sólo se cubren con smoke.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCharStore } from '../../../src/renderer/src/store/charStore.js'
import { makeStoreReset, mockApi } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useCharStore)

const sampleChar = (overrides = {}) => ({
  id: 'char_001',
  name: 'Rodrigo',
  isProtagonist: true,
  walkSpeed: 4,
  animations: [
    { id: 'anim_idle', name: 'idle', spriteFile: 'IDLE.PCX',
      frameCount: 1, fps: 8, flipH: false, flipV: false },
  ],
  patrol: [],
  inventory: [],
  ...overrides,
})

beforeEach(() => reset())

describe('charStore — apertura, cierre, update', () => {
  it('openChar copia (no muta el original) y resetea dirty', () => {
    const orig = sampleChar()
    useCharStore.getState().openChar(orig)
    const ac = useCharStore.getState().activeChar
    ac.name = 'X'
    expect(orig.name).toBe('Rodrigo')           // intacto
    expect(useCharStore.getState().dirty).toBe(false)
  })

  it('updateChar fusiona el patch y marca dirty', () => {
    useCharStore.setState({ activeChar: sampleChar(), dirty: false })
    useCharStore.getState().updateChar({ walkSpeed: 6 })
    const st = useCharStore.getState()
    expect(st.activeChar.walkSpeed).toBe(6)
    expect(st.dirty).toBe(true)
  })

  it('closeChar limpia activeChar', () => {
    useCharStore.setState({ activeChar: sampleChar(), dirty: true })
    useCharStore.getState().closeChar()
    const st = useCharStore.getState()
    expect(st.activeChar).toBeNull()
    expect(st.dirty).toBe(false)
  })
})

describe('charStore — animations', () => {
  it('addAnimation inserta al principio (más reciente arriba)', () => {
    useCharStore.setState({ activeChar: sampleChar() })
    useCharStore.getState().addAnimation()
    const anims = useCharStore.getState().activeChar.animations
    expect(anims).toHaveLength(2)
    expect(anims[0].name).toBe('nueva_animacion')
    expect(anims[1].id).toBe('anim_idle')
  })

  it('updateAnimation patchea solo la animación indicada', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        animations: [
          { id: 'a', name: 'idle', frameCount: 1, fps: 8 },
          { id: 'b', name: 'walk', frameCount: 8, fps: 12 },
        ],
      }),
    })
    useCharStore.getState().updateAnimation('b', { fps: 24 })
    const anims = useCharStore.getState().activeChar.animations
    expect(anims[0].fps).toBe(8)
    expect(anims[1].fps).toBe(24)
    expect(useCharStore.getState().dirty).toBe(true)
  })

  it('deleteAnimation elimina y marca dirty', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        animations: [
          { id: 'a' }, { id: 'b' }, { id: 'c' },
        ],
      }),
    })
    useCharStore.getState().deleteAnimation('b')
    const anims = useCharStore.getState().activeChar.animations
    expect(anims.map(a => a.id)).toEqual(['a', 'c'])
  })

  it('moveAnimation arriba (-1) y abajo (+1)', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        animations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      }),
    })
    useCharStore.getState().moveAnimation('a', +1)
    expect(useCharStore.getState().activeChar.animations.map(a => a.id))
      .toEqual(['b', 'a', 'c'])
    useCharStore.getState().moveAnimation('a', -1)
    expect(useCharStore.getState().activeChar.animations.map(a => a.id))
      .toEqual(['a', 'b', 'c'])
  })

  it('moveAnimation en límite no muta', () => {
    useCharStore.setState({
      activeChar: sampleChar({ animations: [{ id: 'a' }, { id: 'b' }] }),
      dirty: false,
    })
    useCharStore.getState().moveAnimation('a', -1)
    expect(useCharStore.getState().activeChar.animations.map(a => a.id))
      .toEqual(['a', 'b'])
  })

  it('updateAnimRole asigna animId a un rol', () => {
    useCharStore.setState({ activeChar: sampleChar() })
    useCharStore.getState().updateAnimRole('walk_right', 'anim_walk_r')
    const ar = useCharStore.getState().activeChar.animRoles
    expect(ar.walk_right).toBe('anim_walk_r')
  })

  it('updateAnimRole con null limpia el rol', () => {
    useCharStore.setState({
      activeChar: sampleChar({ animRoles: { walk_right: 'anim_walk_r' } }),
    })
    useCharStore.getState().updateAnimRole('walk_right', null)
    expect(useCharStore.getState().activeChar.animRoles.walk_right).toBeNull()
  })
})

describe('charStore — patrol', () => {
  it('addPatrolPoint añade un punto con valores por defecto', () => {
    useCharStore.setState({ activeChar: sampleChar() })
    useCharStore.getState().addPatrolPoint({ x: 100, y: 50 })
    const p = useCharStore.getState().activeChar.patrol[0]
    expect(p.x).toBe(100)
    expect(p.y).toBe(50)
    expect(p.waitMs).toBe(0)
    expect(p.condition).toBeNull()
  })

  it('updatePatrolPoint patchea por id', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        patrol: [{ id: 'pp_a', x: 0, y: 0, waitMs: 0, condition: null }],
      }),
    })
    useCharStore.getState().updatePatrolPoint('pp_a', { waitMs: 1000 })
    expect(useCharStore.getState().activeChar.patrol[0].waitMs).toBe(1000)
  })

  it('clearPatrol vacía el array', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        patrol: [{ id: 'a' }, { id: 'b' }],
      }),
    })
    useCharStore.getState().clearPatrol()
    expect(useCharStore.getState().activeChar.patrol).toEqual([])
    expect(useCharStore.getState().dirty).toBe(true)
  })
})

describe('charStore — inventario inicial', () => {
  it('addInventoryItem evita duplicados', () => {
    useCharStore.setState({ activeChar: sampleChar() })
    useCharStore.getState().addInventoryItem('obj_key', 'Llave')
    useCharStore.getState().addInventoryItem('obj_key', 'Llave')   // duplicado
    expect(useCharStore.getState().activeChar.inventory).toHaveLength(1)
  })

  it('removeInventoryItem elimina por objectId', () => {
    useCharStore.setState({
      activeChar: sampleChar({
        inventory: [
          { objectId: 'obj_a', objectName: 'A' },
          { objectId: 'obj_b', objectName: 'B' },
        ],
      }),
    })
    useCharStore.getState().removeInventoryItem('obj_a')
    const inv = useCharStore.getState().activeChar.inventory
    expect(inv.map(i => i.objectId)).toEqual(['obj_b'])
  })
})

describe('charStore — loadChars (mock IPC)', () => {
  it('puebla chars desde la respuesta y marca loaded', async () => {
    mockApi({
      listChars: async () => ({ ok: true, chars: [
        { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
      ]}),
    })
    await useCharStore.getState().loadChars('/fake/dir')
    const st = useCharStore.getState()
    expect(st.chars.map(c => c.id)).toEqual(['a', 'b'])
    expect(st.loaded).toBe(true)
  })

  it('si IPC devuelve ok=false deja chars vacío pero marca loaded', async () => {
    mockApi({ listChars: async () => ({ ok: false, error: 'no dir' }) })
    await useCharStore.getState().loadChars('/fake/dir')
    const st = useCharStore.getState()
    expect(st.chars).toEqual([])
    expect(st.loaded).toBe(true)
  })
})
