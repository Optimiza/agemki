/**
 * Tests del appStore.
 * Cubre la gestión de juegos recientes con localStorage stub, el toggle de
 * tema y los cambios de módulo activo / panel partido.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { clearLocalStorage } from '../../helpers/store-stubs.js'

// Importamos el módulo dinámicamente en cada test para que recargue
// `loadRecent()` desde el localStorage stub limpio.
async function importAppStore() {
  // Evitar el cache de módulos de vitest entre tests independientes
  return await import(
    '../../../src/renderer/src/store/appStore.js?ts=' + Date.now()
  )
}

beforeEach(() => clearLocalStorage())

describe('appStore — estado inicial', () => {
  it('activeGame y activeModule son null al arrancar sin recientes', async () => {
    const { useAppStore } = await importAppStore()
    const st = useAppStore.getState()
    expect(st.activeGame).toBeNull()
    expect(st.activeModule).toBeNull()
    expect(st.recentGames).toEqual([])
    expect(st.theme).toBe('dark')
    expect(st.splitActive).toBe(false)
    expect(st.secondaryModule).toBe('scripts')
  })

  it('lee recientes válidos del localStorage al cargar', async () => {
    globalThis.localStorage.setItem('scumm-editor:recent-games', JSON.stringify([
      { gameDir: '/a', name: 'A', openedAt: 1 },
      { gameDir: '/b', name: 'B', openedAt: 2 },
    ]))
    const { useAppStore } = await importAppStore()
    const list = useAppStore.getState().recentGames
    expect(list).toHaveLength(2)
    expect(list[0].gameDir).toBe('/a')
  })

  it('localStorage corrupto (JSON inválido) → recientes = []', async () => {
    globalThis.localStorage.setItem('scumm-editor:recent-games', 'no-es-json')
    const { useAppStore } = await importAppStore()
    expect(useAppStore.getState().recentGames).toEqual([])
  })
})

describe('appStore — recientes (CRUD)', () => {
  it('addRecent inserta al principio y limita a MAX_RECENT (10)', async () => {
    const { useAppStore } = await importAppStore()
    for (let i = 0; i < 12; i++) {
      useAppStore.getState().addRecent('/g_' + i, 'G' + i)
    }
    const list = useAppStore.getState().recentGames
    expect(list).toHaveLength(10)              // capped
    expect(list[0].name).toBe('G11')           // último insertado al principio
    expect(list[list.length - 1].name).toBe('G2')  // los 2 más antiguos cayeron
  })

  it('addRecent re-añadiendo el mismo gameDir lo mueve arriba (sin duplicar)', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.getState().addRecent('/a', 'A')
    useAppStore.getState().addRecent('/b', 'B')
    useAppStore.getState().addRecent('/a', 'A')          // re-add
    const list = useAppStore.getState().recentGames
    expect(list).toHaveLength(2)
    expect(list[0].gameDir).toBe('/a')                   // ahora el primero
  })

  it('addRecent persiste a localStorage', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.getState().addRecent('/x', 'X')
    const stored = JSON.parse(globalThis.localStorage.getItem('scumm-editor:recent-games'))
    expect(stored).toHaveLength(1)
    expect(stored[0].gameDir).toBe('/x')
  })

  it('removeRecent elimina y persiste', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.getState().addRecent('/a', 'A')
    useAppStore.getState().addRecent('/b', 'B')
    useAppStore.getState().removeRecent('/a')
    const list = useAppStore.getState().recentGames
    expect(list.map(r => r.gameDir)).toEqual(['/b'])
  })

  it('updateRecentName cambia el nombre por gameDir', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.getState().addRecent('/a', 'A original')
    useAppStore.getState().updateRecentName('/a', 'A renombrado')
    expect(useAppStore.getState().recentGames[0].name).toBe('A renombrado')
  })
})

describe('appStore — módulo activo y panel partido', () => {
  it('setActiveModule y closeGame', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.setState({ activeGame: { gameDir: '/d', game: { name: 'X' } }, activeModule: 'rooms' })
    useAppStore.getState().setActiveModule('scripts')
    expect(useAppStore.getState().activeModule).toBe('scripts')

    useAppStore.getState().closeGame()
    expect(useAppStore.getState().activeGame).toBeNull()
    expect(useAppStore.getState().activeModule).toBeNull()
  })

  it('toggleSplit alterna y setSecondaryModule cambia el módulo del panel', async () => {
    const { useAppStore } = await importAppStore()
    useAppStore.getState().toggleSplit()
    expect(useAppStore.getState().splitActive).toBe(true)
    useAppStore.getState().toggleSplit()
    expect(useAppStore.getState().splitActive).toBe(false)
    useAppStore.getState().setSecondaryModule('characters')
    expect(useAppStore.getState().secondaryModule).toBe('characters')
  })
})

describe('appStore — tema', () => {
  it('toggleTheme alterna dark <-> light', async () => {
    const { useAppStore } = await importAppStore()
    expect(useAppStore.getState().theme).toBe('dark')
    useAppStore.getState().toggleTheme()
    expect(useAppStore.getState().theme).toBe('light')
    useAppStore.getState().toggleTheme()
    expect(useAppStore.getState().theme).toBe('dark')
  })
})
