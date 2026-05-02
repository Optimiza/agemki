/**
 * Tests del localeStore.
 * Cubre setKey/setKeys/getKey, dirty tracking, getCoverage y getOrphans.
 * Las funciones IPC (loadAll, saveAll, addLang, deleteLang) se cubren con mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useLocaleStore } from '../../../src/renderer/src/store/localeStore.js'
import { makeStoreReset, mockApi, mockConfirm } from '../../helpers/store-stubs.js'

const reset = makeStoreReset(useLocaleStore)
beforeEach(() => { reset(); mockConfirm(true) })

describe('localeStore — setKey / setKeys / getKey', () => {
  it('setKey establece valor y marca el lang como dirty', () => {
    useLocaleStore.getState().setKey('es', 'msg.hello', 'Hola')
    const st = useLocaleStore.getState()
    expect(st.locales.es['msg.hello']).toBe('Hola')
    expect(st.dirty.has('es')).toBe(true)
  })

  it('setKeys aplica varias claves en una sola operación', () => {
    useLocaleStore.getState().setKeys('en', { 'a': '1', 'b': '2', 'c': '3' })
    const loc = useLocaleStore.getState().locales.en
    expect(loc.a).toBe('1')
    expect(loc.b).toBe('2')
    expect(loc.c).toBe('3')
  })

  it('getKey devuelve string vacío si la clave no existe', () => {
    expect(useLocaleStore.getState().getKey('es', 'no_existe')).toBe('')
  })

  it('getKey devuelve el valor cuando existe', () => {
    useLocaleStore.getState().setKey('es', 'k', 'V')
    expect(useLocaleStore.getState().getKey('es', 'k')).toBe('V')
  })
})

describe('localeStore — addLang / deleteLang (con mocks)', () => {
  it('addLang añade el código si no existe y crea fichero', async () => {
    const r = await useLocaleStore.getState().addLang('/dir', 'fr')
    expect(r.ok).toBe(true)
    const langs = useLocaleStore.getState().langs
    expect(langs).toContain('fr')
  })

  it('addLang rechaza si ya existe', async () => {
    const r = await useLocaleStore.getState().addLang('/dir', 'es')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/existe/i)
  })

  it('deleteLang rechaza el idioma base es', async () => {
    const r = await useLocaleStore.getState().deleteLang('/dir', 'es')
    expect(r.ok).toBe(false)
  })

  it('deleteLang sin traducciones procede sin confirm', async () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: { es: { a: 'A' }, en: {} },
    })
    const r = await useLocaleStore.getState().deleteLang('/dir', 'en')
    expect(r.ok).toBe(true)
    expect(useLocaleStore.getState().langs).not.toContain('en')
  })

  it('deleteLang con traducciones pide confirm; si user cancela, no borra', async () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: { es: { a: 'A' }, en: { a: 'A_en' } },
    })
    mockConfirm(false)
    const r = await useLocaleStore.getState().deleteLang('/dir', 'en')
    expect(r.ok).toBe(false)
    expect(useLocaleStore.getState().langs).toContain('en')
  })
})

describe('localeStore — saveAll (mocks)', () => {
  it('limpia dirty al guardar correctamente', async () => {
    useLocaleStore.setState({ langs: ['es'], locales: { es: { x: 'X' } }, dirty: new Set(['es']) })
    const r = await useLocaleStore.getState().saveAll('/dir')
    expect(r.ok).toBe(true)
    expect(useLocaleStore.getState().dirty.size).toBe(0)
  })

  it('no limpia dirty si alguna escritura falla', async () => {
    let n = 0
    mockApi({
      saveLocale: async () => {
        n++
        return n === 1 ? { ok: true } : { ok: false, error: 'falló' }
      },
    })
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: { es: { x: 'X' }, en: { x: 'X' } },
      dirty: new Set(['es', 'en']),
    })
    const r = await useLocaleStore.getState().saveAll('/dir')
    expect(r.ok).toBe(false)
    expect(useLocaleStore.getState().dirty.size).toBe(2)   // dirty intacto
  })
})

describe('localeStore — getCoverage', () => {
  it('100% si todos los idiomas tienen las claves del base', () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: {
        es: { 'verb.a.name': 'A', 'obj.x.name': 'X' },
        en: { 'verb.a.name': 'A_en', 'obj.x.name': 'X_en' },
      },
    })
    const cov = useLocaleStore.getState().getCoverage()
    const en = cov.find(c => c.lang === 'en')
    expect(en.pct).toBe(100)
    expect(en.totalMissing).toBe(0)
  })

  it('cuenta missing por grupo (verbs/objects/...)', () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: {
        es: { 'verb.a.name': 'A', 'obj.x.name': 'X', 'msg.foo': 'F' },
        en: { 'verb.a.name': 'A_en' },         // faltan obj y msg
      },
    })
    const cov = useLocaleStore.getState().getCoverage()
    const en = cov.find(c => c.lang === 'en')
    expect(en.totalMissing).toBe(2)
    expect(en.missing.objects.count).toBe(1)
    expect(en.missing.other.count).toBe(1)
  })

  it('claves con string vacío cuentan como missing', () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: {
        es: { 'verb.a.name': 'A' },
        en: { 'verb.a.name': '   ' },          // sólo espacios -> missing
      },
    })
    const cov = useLocaleStore.getState().getCoverage()
    const en = cov.find(c => c.lang === 'en')
    expect(en.totalMissing).toBe(1)
  })
})

describe('localeStore — getOrphans', () => {
  it('devuelve claves que existen en lang pero no en base es', () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: {
        es: { 'verb.a.name': 'A' },
        en: { 'verb.a.name': 'A_en', 'huerfana.x': 'X' },
      },
    })
    const orph = useLocaleStore.getState().getOrphans('en')
    expect(orph).toEqual(['huerfana.x'])
  })

  it('devuelve [] si no hay huérfanas', () => {
    useLocaleStore.setState({
      langs: ['es', 'en'],
      locales: {
        es: { a: 'A' },
        en: { a: 'A_en' },
      },
    })
    expect(useLocaleStore.getState().getOrphans('en')).toEqual([])
  })
})

describe('localeStore — setActiveLang', () => {
  it('cambia el idioma activo', () => {
    useLocaleStore.getState().setActiveLang('en')
    expect(useLocaleStore.getState().activeLang).toBe('en')
  })
})
