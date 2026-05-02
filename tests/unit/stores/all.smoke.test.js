/**
 * Smoke tests de los 10 stores Zustand.
 *
 * Verifica para cada uno:
 *   1. El módulo se carga sin lanzar excepciones (los stubs globales bastan).
 *   2. La hook exporta `getState()` con un objeto plano.
 *   3. El estado inicial contiene las claves esperadas.
 *   4. Las acciones declaradas son funciones.
 *
 * Esta capa cubre regresiones de bajo nivel (renombre accidental de claves,
 * borrar acciones por error). Los tests profundos viven en ficheros aparte.
 */
import { describe, it, expect } from 'vitest'

const STORE_SPECS = [
  {
    name: 'appStore',
    path: '../../../src/renderer/src/store/appStore.js',
    hook: 'useAppStore',
    stateKeys:  ['activeGame', 'activeModule', 'splitActive', 'secondaryModule', 'recentGames', 'theme'],
    actionKeys: ['toggleTheme', 'openGame', 'closeGame', 'updateGame', 'setActiveModule',
                 'toggleSplit', 'setSecondaryModule', 'addRecent', 'removeRecent', 'updateRecentName'],
  },
  {
    name: 'attributeStore',
    path: '../../../src/renderer/src/store/attributeStore.js',
    hook: 'useAttributeStore',
    stateKeys:  ['enabled', 'attributes', 'dirty'],
    actionKeys: ['load', 'setEnabled', 'updateAttr', 'setDeathAttr', 'save'],
  },
  {
    name: 'charStore',
    path: '../../../src/renderer/src/store/charStore.js',
    hook: 'useCharStore',
    stateKeys:  ['chars', 'activeChar', 'dirty', 'loaded'],
    actionKeys: ['loadChars', 'createChar', 'deleteChar', 'duplicateChar',
                 'openChar', 'closeChar', 'updateChar',
                 'addAnimation', 'updateAnimation', 'updateAnimRole', 'deleteAnimation', 'moveAnimation',
                 'addPatrolPoint', 'updatePatrolPoint', 'deletePatrolPoint', 'clearPatrol',
                 'addInventoryItem', 'removeInventoryItem',
                 'saveActiveChar'],
  },
  {
    name: 'dialogueStore',
    path: '../../../src/renderer/src/store/dialogueStore.js',
    hook: 'useDialogueStore',
    stateKeys:  ['dialogues', 'activeDialogue', 'dirty', 'loaded'],
    actionKeys: ['loadDialogues', 'createDialogue', 'deleteDialogue', 'duplicateDialogue',
                 'openDialogue', 'closeDialogue', 'saveDialogue', 'updateDialogueMeta',
                 'addNode', 'updateNode', 'duplicateNode', 'deleteNode',
                 'connectNodes', 'disconnectNode', 'setNodePosition'],
  },
  {
    name: 'localeStore',
    path: '../../../src/renderer/src/store/localeStore.js',
    hook: 'useLocaleStore',
    stateKeys:  ['langs', 'activeLang', 'locales', 'dirty', 'loaded'],
    actionKeys: ['loadAll', 'reload',
                 'addLang', 'deleteLang', 'setActiveLang',
                 'setKey', 'setKeys', 'getKey',
                 'saveAll', 'saveLang',
                 'getCoverage', 'getOrphans'],
  },
  {
    name: 'objectStore',
    path: '../../../src/renderer/src/store/objectStore.js',
    hook: 'useObjectStore',
    stateKeys:  ['objects', 'activeObject', 'dirty'],
    actionKeys: ['loadObjects', 'createObject', 'saveActiveObject', 'deleteObject', 'duplicateObject',
                 'openObject', 'closeObject', 'updateObject',
                 'addState', 'updateState', 'deleteState',
                 'addVerbAction', 'updateVerbAction', 'deleteVerbAction',
                 'setVerbResponse', 'setInvVerbResponse',
                 'addCombination', 'updateCombination', 'deleteCombination',
                 'addFlag', 'updateFlag', 'deleteFlag'],
  },
  {
    name: 'sceneStore',
    path: '../../../src/renderer/src/store/sceneStore.js',
    hook: 'useSceneStore',
    stateKeys:  ['activeRoom', 'backgroundUrl', 'dirty', 'zoom', 'panX', 'panY',
                 'activeTool', 'layers',
                 'selectedShapeId', 'pendingPolygon', 'drawMode',
                 'selectedInstanceId', 'selectedCharInstId', 'selectedExitId', 'selectedEntryId', 'selectedLightId'],
    actionKeys: ['openRoom', 'closeRoom', 'setBackgroundUrl', 'updateRoom', 'markClean',
                 'setZoom', 'setPan',
                 'setTool', 'setDrawMode', 'toggleLayer',
                 'setActiveWalkmap', 'addWalkmap', 'deleteWalkmap',
                 'addShape', 'deleteShape', 'selectShape', 'setPendingPolygon', 'commitPendingPolygon',
                 'addObjectInstance', 'updateObjectInstance', 'deleteObjectInstance',
                 'addCharInstance', 'updateCharInstance', 'deleteCharInstance',
                 'addExit', 'updateExit', 'deleteExit',
                 'addEntry', 'updateEntry', 'deleteEntry',
                 'addLight', 'updateLight', 'updateLightFlicker', 'deleteLight',
                 'selectInstance', 'selectCharInst', 'selectExit', 'selectEntry', 'selectLight'],
  },
  {
    name: 'scriptStore',
    path: '../../../src/renderer/src/store/scriptStore.js',
    hook: 'useScriptStore',
    stateKeys:  ['scripts', 'activeScript', 'dirty', 'loaded'],
    actionKeys: ['loadScripts', 'createScript', 'deleteScript', 'duplicateScript',
                 'openScript', 'closeScript', 'saveScript', 'updateMeta',
                 'addInstruction', 'updateInstruction', 'deleteInstruction',
                 'duplicateInstruction', 'moveInstruction'],
  },
  {
    name: 'sequenceStore',
    path: '../../../src/renderer/src/store/sequenceStore.js',
    hook: 'useSequenceStore',
    stateKeys:  ['sequences', 'activeSequence', 'dirty', 'loaded'],
    actionKeys: ['loadSequences', 'createSequence', 'deleteSequence', 'duplicateSequence',
                 'openSequence', 'closeSequence', 'saveSequence', 'updateMeta',
                 'addStep', 'duplicateStep', 'updateStep', 'deleteStep', 'moveStep'],
  },
  {
    name: 'verbsetStore',
    path: '../../../src/renderer/src/store/verbsetStore.js',
    hook: 'useVerbsetStore',
    stateKeys:  ['verbsets', 'activeVerbset', 'dirty'],
    actionKeys: ['loadVerbsets', 'createVerbset', 'saveActiveVerbset', 'deleteVerbset', 'duplicateVerbset',
                 'openVerbset', 'closeVerbset', 'updateVerbset',
                 'setVerbLabel', 'getVerbLabel',
                 'addVerb', 'updateVerb', 'deleteVerb', 'moveVerb',
                 'getGameVerbs'],
  },
]

describe.each(STORE_SPECS)('store $name — smoke', ({ name, path, hook, stateKeys, actionKeys }) => {
  let mod
  let useStore

  it('se carga sin errores', async () => {
    mod = await import(path)
    useStore = mod[hook]
    expect(typeof useStore).toBe('function')
    expect(typeof useStore.getState).toBe('function')
  })

  it('estado inicial contiene las claves esperadas', () => {
    const state = useStore.getState()
    for (const key of stateKeys) {
      expect(state, `falta state key '${key}' en ${name}`).toHaveProperty(key)
    }
  })

  it('acciones declaradas son funciones', () => {
    const state = useStore.getState()
    for (const key of actionKeys) {
      expect(typeof state[key], `acción '${key}' debería ser función en ${name}`).toBe('function')
    }
  })
})
