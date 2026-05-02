/**
 * @fileoverview Stubs de globales del navegador para tests de stores.
 *
 * Los stores Zustand del editor viven en el proceso renderer (Electron) y
 * usan `window.api`, `localStorage`, `document`, `confirm` y `alert`. En
 * Node puro estos globales no existen.
 *
 * Este fichero monta unos stubs deterministas y mínimos antes de que se
 * importe ningún store. Se carga vía `vitest.config.js → test.setupFiles`.
 *
 * Cada test puede sobrescribir métodos concretos de `window.api` con
 * `mockApi(...)` para simular respuestas IPC específicas.
 */

// ── localStorage ──────────────────────────────────────────────────────────
class MemoryStorage {
  constructor() { this._data = new Map() }
  getItem(k)        { return this._data.has(k) ? this._data.get(k) : null }
  setItem(k, v)     { this._data.set(k, String(v)) }
  removeItem(k)     { this._data.delete(k) }
  clear()           { this._data.clear() }
  get length()      { return this._data.size }
  key(i)            { return [...this._data.keys()][i] ?? null }
}

// ── document mínimo ──────────────────────────────────────────────────────
const documentStub = {
  documentElement: {
    setAttribute: () => {},
    getAttribute: () => null,
  },
}

// ── window.api: cada método devuelve { ok: true } por defecto ──────────────
// Los tests sobrescriben los métodos que necesitan con respuestas reales.
function defaultApiResponse() { return { ok: true } }

const apiMethods = [
  // games
  'createGame', 'loadGame', 'saveGame', 'listGames',
  // verbsets
  'listVerbsets', 'createVerbset', 'saveVerbset', 'deleteVerbset', 'duplicateVerbset',
  // chars
  'listChars', 'createChar', 'saveChar', 'deleteChar', 'duplicateChar',
  // objects
  'listObjects', 'createObject', 'saveObject', 'deleteObject', 'duplicateObject',
  // dialogues
  'listDialogues', 'createDialogue', 'readDialogue', 'saveDialogue',
  'deleteDialogue', 'duplicateDialogue',
  // scripts
  'listScripts', 'createScript', 'readScript', 'saveScript',
  'deleteScript', 'duplicateScript',
  // sequences
  'listSequences', 'createSequence', 'readSequence', 'saveSequence',
  'deleteSequence', 'duplicateSequence',
  // locales
  'listLangs', 'readLocale', 'saveLocale', 'addLanguage', 'deleteLanguage',
]

function makeApi(overrides = {}) {
  const api = {}
  for (const m of apiMethods) {
    api[m] = overrides[m] ?? (async () => defaultApiResponse())
  }
  return api
}

// ── Aplicar globales ──────────────────────────────────────────────────────
function installGlobals() {
  if (typeof globalThis.window === 'undefined') globalThis.window = {}
  globalThis.window.api = makeApi()
  globalThis.localStorage = new MemoryStorage()
  globalThis.window.localStorage = globalThis.localStorage
  globalThis.document = documentStub
  globalThis.window.document = documentStub
  // alert / confirm: por defecto silencian; tests pueden sobrescribir
  globalThis.alert = () => {}
  globalThis.confirm = () => true
  globalThis.window.alert = globalThis.alert
  globalThis.window.confirm = globalThis.confirm
}

installGlobals()

// ── Helpers exportados para tests ─────────────────────────────────────────

/**
 * Sobrescribe parte de `window.api` con respuestas concretas. El resto sigue
 * devolviendo `{ ok: true }` por defecto. Vuelve a llamar `restoreApi()` o a
 * `mockApi({})` para limpiar.
 *
 * @param {Object} overrides - { listChars: async () => ({ ok: true, chars: [...] }), ... }
 */
export function mockApi(overrides) {
  globalThis.window.api = makeApi(overrides)
}

/** Restaura `window.api` a su forma por defecto ({ ok: true } en todo). */
export function restoreApi() {
  globalThis.window.api = makeApi()
}

/** Limpia el localStorage entre tests. */
export function clearLocalStorage() {
  globalThis.localStorage.clear()
}

/**
 * Helper para resetear un store Zustand a su estado inicial.
 * Captura el estado al primer uso y lo restaura en sucesivas llamadas.
 *
 * Uso:
 *   import { useFooStore } from '...'
 *   const reset = makeStoreReset(useFooStore)
 *   beforeEach(() => reset())
 */
export function makeStoreReset(useStore) {
  // structuredClone preserva tipos especiales (Set, Map, Date) — JSON roundtrip
  // los aplanaba a objetos vacíos, rompiendo stores que usan Set para dirty.
  const initialData = Object.fromEntries(
    Object.entries(useStore.getState()).filter(([, v]) => typeof v !== 'function')
  )
  const snapshot = structuredClone(initialData)

  return () => {
    const current = useStore.getState()
    const fns = Object.fromEntries(
      Object.entries(current).filter(([, v]) => typeof v === 'function')
    )
    // Re-clonar el snapshot en cada reset para no compartir referencias
    useStore.setState({ ...structuredClone(snapshot), ...fns }, true)
  }
}

// Mock de `confirm` que devuelve un valor controlable
let confirmResponse = true
globalThis.confirm = () => confirmResponse
globalThis.window.confirm = globalThis.confirm
export function mockConfirm(value) { confirmResponse = value }

// Mock de `alert` que registra llamadas
const alertCalls = []
globalThis.alert = (msg) => { alertCalls.push(String(msg)) }
globalThis.window.alert = globalThis.alert
export function getAlertCalls() { return [...alertCalls] }
export function clearAlertCalls() { alertCalls.length = 0 }
