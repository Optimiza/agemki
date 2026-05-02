/**
 * Tests profundos del sceneStore.
 *
 * Cubre los invariantes críticos del Scene Editor:
 *   - El orden de shapes (add/sub) en un walkmap debe preservarse — el
 *     renderizado del walkmap depende del orden (sub solo afecta a add
 *     pintados encima).
 *   - Las selecciones (shape, instance, char, exit, entry, light) son
 *     mutuamente excluyentes: sólo una activa a la vez.
 *   - `pendingPolygon` se descarta al cambiar de herramienta y al cerrar
 *     la room.
 *   - `commitPendingPolygon` con menos de 3 puntos no crea shape.
 *   - El zoom se clamp a [1, 8].
 *   - `dirty` se marca al añadir/borrar/mover entidades; se limpia con
 *     `markClean()`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSceneStore, TOOLS, LAYERS } from '../../../src/renderer/src/store/sceneStore.js'
import { makeStoreReset } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useSceneStore)

const sampleRoom = () => ({
  id: 'room_001', name: 'taberna',
  backgroundSize: { w: 320, h: 144 },
  backgroundFile: 'BG.PCX',
  walkmaps: [{ id: 'wm_default', name: 'default', shapes: [] }],
  activeWalkmapId: 'wm_default',
  objects: [], characters: [], exits: [], entries: [],
})

beforeEach(() => reset())

describe('sceneStore — apertura y cierre de room', () => {
  it('openRoom resetea zoom, pan, herramienta y selecciones', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    const st = useSceneStore.getState()
    expect(st.activeRoom?.id).toBe('room_001')
    expect(st.zoom).toBe(2)
    expect(st.panX).toBe(0)
    expect(st.panY).toBe(0)
    expect(st.activeTool).toBe(TOOLS.SELECT)
    expect(st.selectedShapeId).toBeNull()
    expect(st.selectedInstanceId).toBeNull()
    expect(st.pendingPolygon).toBeNull()
    expect(st.dirty).toBe(false)
  })

  it('closeRoom limpia activeRoom y resetea pendingPolygon', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.setPendingPolygon([{ x: 0, y: 0 }, { x: 10, y: 10 }])
    s.closeRoom()
    const st = useSceneStore.getState()
    expect(st.activeRoom).toBeNull()
    expect(st.pendingPolygon).toBeNull()
    expect(st.selectedShapeId).toBeNull()
  })

  it('openRoom hidrata defaults para campos opcionales (lights, ambientLight)', () => {
    const s = useSceneStore.getState()
    s.openRoom({ ...sampleRoom() })
    const st = useSceneStore.getState()
    expect(st.activeRoom.ambientLight).toBe(100)
    expect(Array.isArray(st.activeRoom.lights)).toBe(true)
  })
})

describe('sceneStore — walkmap: orden de shapes (add/sub)', () => {
  it('addShape preserva el orden de inserción en el walkmap activo', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.addShape({ id: 'sh_a', type: 'rect', mode: 'add',
                 points: [{x:0,y:0},{x:10,y:10}] })
    s.addShape({ id: 'sh_b', type: 'rect', mode: 'sub',
                 points: [{x:5,y:5},{x:8,y:8}] })
    s.addShape({ id: 'sh_c', type: 'polygon', mode: 'add',
                 points: [{x:0,y:0},{x:10,y:0},{x:5,y:10}] })

    const wm = useSceneStore.getState().activeRoom.walkmaps[0]
    expect(wm.shapes.map(s => s.id)).toEqual(['sh_a', 'sh_b', 'sh_c'])
    expect(wm.shapes.map(s => s.mode)).toEqual(['add', 'sub', 'add'])
  })

  it('addShape solo modifica el walkmap activo, no los demás', () => {
    const s = useSceneStore.getState()
    s.openRoom({ ...sampleRoom(),
      walkmaps: [
        { id: 'wm_default', name: 'default', shapes: [] },
        { id: 'wm_alt',     name: 'alt',     shapes: [] },
      ],
    })
    s.addShape({ id: 'sh_x', type: 'rect', mode: 'add', points: [] })
    const room = useSceneStore.getState().activeRoom
    expect(room.walkmaps[0].shapes.length).toBe(1)
    expect(room.walkmaps[1].shapes.length).toBe(0)
  })

  it('deleteShape elimina solo el shape indicado y limpia selección si era el seleccionado', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.addShape({ id: 'sh_a', type: 'rect', mode: 'add', points: [] })
    s.addShape({ id: 'sh_b', type: 'rect', mode: 'sub', points: [] })
    s.selectShape('sh_a')
    s.deleteShape('sh_a')
    const st = useSceneStore.getState()
    expect(st.activeRoom.walkmaps[0].shapes.map(x => x.id)).toEqual(['sh_b'])
    expect(st.selectedShapeId).toBeNull()
  })

  it('deleteWalkmap respeta el invariante "siempre al menos un walkmap"', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.deleteWalkmap('wm_default')   // único — no debería borrar
    const room = useSceneStore.getState().activeRoom
    expect(room.walkmaps.length).toBe(1)
    expect(room.walkmaps[0].id).toBe('wm_default')
  })
})

describe('sceneStore — selecciones mutuamente excluyentes', () => {
  it('selectInstance limpia las demás selecciones', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    useSceneStore.setState({
      selectedShapeId:    'sh_a',
      selectedCharInstId: 'cinst_z',
      selectedExitId:     'exit_q',
      selectedEntryId:    'entry_p',
    })
    s.selectInstance('inst_001')
    const st = useSceneStore.getState()
    expect(st.selectedInstanceId).toBe('inst_001')
    expect(st.selectedShapeId).toBeNull()
    expect(st.selectedCharInstId).toBeNull()
  })

  it('selectExit limpia shape, instance y charInst', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    useSceneStore.setState({
      selectedShapeId:    'sh_a',
      selectedInstanceId: 'inst_001',
      selectedCharInstId: 'cinst_z',
    })
    s.selectExit('exit_n')
    const st = useSceneStore.getState()
    expect(st.selectedExitId).toBe('exit_n')
    expect(st.selectedShapeId).toBeNull()
    expect(st.selectedInstanceId).toBeNull()
    expect(st.selectedCharInstId).toBeNull()
  })

  it('selectLight limpia TODAS las demás selecciones (incluyendo entry)', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    useSceneStore.setState({
      selectedShapeId:    'sh_a',
      selectedInstanceId: 'inst_001',
      selectedCharInstId: 'cinst_z',
      selectedExitId:     'exit_n',
      selectedEntryId:    'entry_p',
    })
    s.selectLight('light_999')
    const st = useSceneStore.getState()
    expect(st.selectedLightId).toBe('light_999')
    expect(st.selectedShapeId).toBeNull()
    expect(st.selectedInstanceId).toBeNull()
    expect(st.selectedCharInstId).toBeNull()
    expect(st.selectedExitId).toBeNull()
    expect(st.selectedEntryId).toBeNull()
  })
})

describe('sceneStore — pendingPolygon (herramienta POLYGON)', () => {
  it('setTool descarta el pendingPolygon', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.setPendingPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    expect(useSceneStore.getState().pendingPolygon).toHaveLength(2)
    s.setTool(TOOLS.SELECT)
    expect(useSceneStore.getState().pendingPolygon).toBeNull()
  })

  it('commitPendingPolygon descarta si hay menos de 3 puntos (sin crear shape)', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.setPendingPolygon([{ x: 0, y: 0 }, { x: 10, y: 10 }])  // solo 2 puntos
    s.commitPendingPolygon('add')
    const st = useSceneStore.getState()
    expect(st.pendingPolygon).toBeNull()
    expect(st.activeRoom.walkmaps[0].shapes).toHaveLength(0)
  })

  it('commitPendingPolygon con >=3 puntos crea un shape polygon y limpia el pending', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    const pts = [{x:0,y:0},{x:10,y:0},{x:5,y:10}]
    s.setPendingPolygon(pts)
    s.commitPendingPolygon('sub')
    const st = useSceneStore.getState()
    expect(st.pendingPolygon).toBeNull()
    const shapes = st.activeRoom.walkmaps[0].shapes
    expect(shapes).toHaveLength(1)
    expect(shapes[0].type).toBe('polygon')
    expect(shapes[0].mode).toBe('sub')
    expect(shapes[0].points).toEqual(pts)
  })

  it('commitPendingPolygon usa el drawMode actual si no se le pasa modo', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.setDrawMode('sub')
    s.setPendingPolygon([{x:0,y:0},{x:10,y:0},{x:5,y:10}])
    s.commitPendingPolygon()  // sin argumento -> usa drawMode='sub'
    const shape = useSceneStore.getState().activeRoom.walkmaps[0].shapes[0]
    expect(shape.mode).toBe('sub')
  })
})

describe('sceneStore — vista (zoom, pan, layers)', () => {
  it('setZoom clamp a [1, 8]', () => {
    const s = useSceneStore.getState()
    s.setZoom(0.5)
    expect(useSceneStore.getState().zoom).toBe(1)
    s.setZoom(99)
    expect(useSceneStore.getState().zoom).toBe(8)
    s.setZoom(4)
    expect(useSceneStore.getState().zoom).toBe(4)
  })

  it('setPan acepta valores cualesquiera', () => {
    const s = useSceneStore.getState()
    s.setPan(-100, 250)
    const st = useSceneStore.getState()
    expect(st.panX).toBe(-100)
    expect(st.panY).toBe(250)
  })

  it('toggleLayer alterna la visibilidad de una capa', () => {
    const s = useSceneStore.getState()
    const before = useSceneStore.getState().layers[LAYERS.WALKMAP]
    s.toggleLayer(LAYERS.WALKMAP)
    expect(useSceneStore.getState().layers[LAYERS.WALKMAP]).toBe(!before)
  })
})

describe('sceneStore — invariante de dirty', () => {
  it('addShape y deleteShape marcan dirty; markClean lo limpia', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    expect(useSceneStore.getState().dirty).toBe(false)
    s.addShape({ id: 'sh_x', type: 'rect', mode: 'add', points: [] })
    expect(useSceneStore.getState().dirty).toBe(true)
    s.markClean()
    expect(useSceneStore.getState().dirty).toBe(false)
    s.deleteShape('sh_x')
    expect(useSceneStore.getState().dirty).toBe(true)
  })

  it('setZoom/setPan NO marcan dirty (son ajustes de vista, no del modelo)', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.markClean()
    s.setZoom(4)
    s.setPan(50, 50)
    expect(useSceneStore.getState().dirty).toBe(false)
  })

  it('toggleLayer NO marca dirty (preferencia de UI, no de la room)', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.markClean()
    s.toggleLayer(LAYERS.WALKMAP)
    expect(useSceneStore.getState().dirty).toBe(false)
  })
})

describe('sceneStore — instancias (objetos, personajes, exits, entries, lights)', () => {
  it('addObjectInstance / addCharInstance / addExit / addEntry generan id único y seleccionan', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())

    s.addObjectInstance('obj_key', 'Llave', 100, 100)
    const st1 = useSceneStore.getState()
    expect(st1.activeRoom.objects).toHaveLength(1)
    expect(st1.activeRoom.objects[0].objectId).toBe('obj_key')
    expect(st1.selectedInstanceId).toBe(st1.activeRoom.objects[0].id)

    s.addCharInstance('char_hero', 'Héroe', 80, 110)
    const st2 = useSceneStore.getState()
    expect(st2.activeRoom.characters).toHaveLength(1)
    expect(st2.selectedCharInstId).toBe(st2.activeRoom.characters[0].id)

    s.addExit()
    expect(useSceneStore.getState().activeRoom.exits).toHaveLength(1)

    s.addEntry()
    expect(useSceneStore.getState().activeRoom.entries).toHaveLength(1)
  })

  it('deleteObjectInstance limpia la selección si era la borrada', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.addObjectInstance('obj_x', 'X', 0, 0)
    const id = useSceneStore.getState().activeRoom.objects[0].id
    s.deleteObjectInstance(id)
    const st = useSceneStore.getState()
    expect(st.activeRoom.objects).toHaveLength(0)
    expect(st.selectedInstanceId).toBeNull()
  })

  it('addLight inicializa con valores por defecto razonables', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.addLight()
    const light = useSceneStore.getState().activeRoom.lights[0]
    expect(light.radius).toBe(80)
    expect(light.intensity).toBe(80)
    expect(light.coneAngle).toBe(360)
    expect(light.flicker).toEqual({ amplitude: 0, speed: 2.0, noise: 0.3 })
  })

  it('updateLightFlicker fusiona el patch sin perder otros campos', () => {
    const s = useSceneStore.getState()
    s.openRoom(sampleRoom())
    s.addLight()
    const id = useSceneStore.getState().activeRoom.lights[0].id
    s.updateLightFlicker(id, { amplitude: 50 })
    const f = useSceneStore.getState().activeRoom.lights[0].flicker
    expect(f.amplitude).toBe(50)
    expect(f.speed).toBe(2.0)         // preservado
    expect(f.noise).toBe(0.3)         // preservado
  })
})

describe('sceneStore — sin activeRoom (acciones idempotentes)', () => {
  it('add* sin activeRoom no lanzan ni modifican estado', () => {
    const s = useSceneStore.getState()
    expect(useSceneStore.getState().activeRoom).toBeNull()
    s.addShape({ id: 'x', type: 'rect', mode: 'add', points: [] })
    s.addObjectInstance('o', 'O', 0, 0)
    s.addExit()
    s.addEntry()
    s.addLight()
    expect(useSceneStore.getState().activeRoom).toBeNull()
    expect(useSceneStore.getState().dirty).toBe(false)
  })
})
