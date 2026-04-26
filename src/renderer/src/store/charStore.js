/**
 * @fileoverview charStore — Gestión del módulo Personajes/NPCs
 *
 * Gestiona la biblioteca de personajes del juego y el personaje abierto
 * actualmente en el editor (activeChar).
 *
 * ESTRUCTURA DE UN PERSONAJE (char.json):
 * ```json
 * {
 *   "id": "char_001",
 *   "name": "Rodrigo",          // nombre interno (no localizado)
 *   "isProtagonist": true,
 *   "speed": 4,                 // velocidad de caminar 1-10
 *   "animations": [
 *     { "id": "anim_001", "name": "walk", "spriteFile": "RODWALK.PCX",
 *       "frameCount": 8, "fps": 12, "frameWidth": null }
 *   ],
 *   "patrol": [                 // solo NPCs — lista de puntos de patrulla
 *     { "id": "pp_001", "x": 80, "y": 110, "waitMs": 2000, "condition": null }
 *   ],
 *   "inventory": [              // objetos que el personaje lleva al inicio
 *     { "objectId": "obj_001", "objectName": "Espada" }
 *   ],
 *   "dialogues": []             // diálogos condicionales del NPC (evaluados en orden)
 * }
 * ```
 *
 * NOMBRE LOCALIZADO:
 *   El nombre visible en el juego se guarda en locales con la clave char.ID.name.
 *   El campo name del JSON es solo para identificación interna en el editor.
 *
 * INTERACCIÓN CON localeStore:
 *   createChar, deleteChar y duplicateChar llaman a localeStore para mantener
 *   sincronizadas las claves de localización. Este import dinámico evita
 *   dependencias circulares entre stores.
 *
 * PATROL (solo NPCs):
 *   Lista ordenada de puntos por los que el NPC camina en bucle cuando no
 *   está involucrado en ningún diálogo o script. Cada punto puede tener
 *   waitMs (espera en ese punto) y condition (flag que debe ser true para pasar).
 *
 * ANIMACIONES:
 *   frameWidth: si null, el motor usa el ancho total del PCX (sprite de un frame).
 *   Si tiene valor, el motor calcula frameCount = totalWidth / frameWidth.
 *   El editor muestra el primer frame del PCX como preview.
 *
 * @module charStore
 */
import { create } from 'zustand' 

export const useCharStore = create((set, get) => ({

  /** @type {Array<Object>} Lista de todos los personajes del juego (resumen sin animaciones completas) */
  chars: [],

  /** @type {Object|null} Personaje completo abierto en el editor. null si ninguno. */
  activeChar: null,

  /** @type {boolean} true si activeChar tiene cambios sin guardar */
  dirty: false,

  /** @type {boolean} true si chars[] ya fue cargado desde disco */
  loaded: false,

  // ── CRUD de personajes ──────────────────────────────────────────────────────

  /**
   * Carga la lista de personajes desde disco.
   * @param {string} gameDir
   */
  loadChars: async (gameDir) => {
    const r = await window.api.listChars(gameDir)
    set({ chars: r.ok ? r.chars : [], loaded: true })
  },

  /**
   * Crea un personaje nuevo en disco.
   * También recarga el localeStore para que la clave char.ID.name esté disponible
   * inmediatamente en el editor de textos.
   *
   * @param {string} gameDir
   * @param {string} name - Nombre interno (no localizado)
   * @param {boolean} [isProtagonist=false]
   * @returns {Object|null} El personaje creado
   */
  createChar: async (gameDir, name, isProtagonist = false) => {
    const r = await window.api.createChar(gameDir, name, isProtagonist)
    if (!r.ok) return null
    // Importación dinámica para evitar dependencia circular charStore ↔ localeStore
    const { useLocaleStore } = await import('./localeStore')
    await useLocaleStore.getState().reload(gameDir)
    set(s => ({ chars: [...s.chars, r.char] }))
    return r.char
  },

  /**
   * Elimina un personaje del disco.
   * También elimina todas sus claves de localización (char.ID.*) de todos los idiomas
   * y guarda los locales inmediatamente para mantener consistencia.
   *
   * @param {string} gameDir
   * @param {string} charId
   */
  deleteChar: async (gameDir, charId) => {
    await window.api.deleteChar(gameDir, charId)
    // Limpiar claves locales char.charId.* de todos los idiomas
    const { useLocaleStore } = await import('./localeStore')
    const ls = useLocaleStore.getState()
    ls.langs.forEach(lang => {
      const loc = { ...(ls.locales[lang] || {}) }
      Object.keys(loc).filter(k => k.startsWith(`char.${charId}.`)).forEach(k => delete loc[k])
      useLocaleStore.setState(s => ({
        locales: { ...s.locales, [lang]: loc },
        dirty: new Set([...s.dirty, lang]),
      }))
    })
    await ls.saveAll(gameDir)
    set(s => ({
      chars: s.chars.filter(c => c.id !== charId),
      // Si el personaje eliminado era el activo, cerrarlo
      activeChar: s.activeChar?.id === charId ? null : s.activeChar,
      dirty: s.activeChar?.id === charId ? false : s.dirty,
    }))
  },

  /**
   * Duplica un personaje (nuevo id, nombre con " (copia)").
   * Recarga locales para capturar las claves copiadas.
   * @param {string} gameDir
   * @param {string} charId
   */
  duplicateChar: async (gameDir, charId) => {
    const r = await window.api.duplicateChar(gameDir, charId)
    if (!r.ok) return
    const { useLocaleStore } = await import('./localeStore')
    await useLocaleStore.getState().reload(gameDir)
    set(s => ({ chars: [...s.chars, r.char] }))
  },

  // ── Editor — abrir/cerrar/modificar ────────────────────────────────────────

  /**
   * Abre un personaje en el editor. Hace una copia shallow para no mutar la lista.
   * @param {Object} char - Objeto personaje completo
   */
  openChar: (char) => set({ activeChar: { ...char }, dirty: false }),

  /** Cierra el editor sin guardar. */
  closeChar: () => set({ activeChar: null, dirty: false }),

  /**
   * Actualiza campos del personaje activo.
   * @param {Partial<Object>} patch
   */
  updateChar: (patch) => set(s => ({
    activeChar: s.activeChar ? { ...s.activeChar, ...patch } : null,
    dirty: true,
  })),

  // ── Animaciones ─────────────────────────────────────────────────────────────

  /**
   * Añade una animación nueva con valores por defecto.
   * El usuario debe asignar el spriteFile después desde el Asset Studio.
   */
  addAnimation: () => set(s => {
    if (!s.activeChar) return {}
    const id = `anim_${Date.now()}`
    const anim = { id, name: 'nueva_animacion', spriteFile: null, frameCount: 1, fps: 8, flipH: false, flipV: false }
    return {
      activeChar: { ...s.activeChar, animations: [anim, ...s.activeChar.animations] },
      dirty: true,
    }
  }),

  /**
   * @param {string} animId
   * @param {Partial<{name:string, spriteFile:string, frameCount:number, fps:number, frameWidth:number|null}>} patch
   */
  updateAnimation: (animId, patch) => set(s => {
    if (!s.activeChar) return {}
    return {
      activeChar: {
        ...s.activeChar,
        animations: s.activeChar.animations.map(a => a.id === animId ? { ...a, ...patch } : a),
      },
      dirty: true,
    }
  }),

  /** @param {string} animId */
  /**
   * Asigna una animación a un rol del motor (idle, walk_right, walk_left, walk_up, walk_down).
   * null = comportamiento por defecto (espejo / fallback).
   * @param {'idle'|'walk_right'|'walk_left'|'walk_up'|'walk_down'} role
   * @param {string|null} animId
   */
  updateAnimRole: (role, animId) => set(s => {
    if (!s.activeChar) return {}
    const animRoles = { ...(s.activeChar.animRoles || {}), [role]: animId || null }
    return { activeChar: { ...s.activeChar, animRoles }, dirty: true }
  }),

  deleteAnimation: (animId) => set(s => {
    if (!s.activeChar) return {}
    return {
      activeChar: { ...s.activeChar, animations: s.activeChar.animations.filter(a => a.id !== animId) },
      dirty: true,
    }
  }),

  /**
   * Reordena una animación en la lista.
   * @param {string} animId
   * @param {-1|1} dir - -1 = subir, +1 = bajar
   */
  moveAnimation: (animId, dir) => set(s => {
    if (!s.activeChar) return {}
    const anims = [...s.activeChar.animations]
    const idx = anims.findIndex(a => a.id === animId)
    const to  = idx + dir
    if (to < 0 || to >= anims.length) return {}
    ;[anims[idx], anims[to]] = [anims[to], anims[idx]]
    return { activeChar: { ...s.activeChar, animations: anims }, dirty: true }
  }),

  // ── Patrol (solo NPCs) ──────────────────────────────────────────────────────
  //
  // El motor recorre los puntos de patrulla en orden, en bucle infinito.
  // Si condition != null, el punto solo se visita si esa flag es true.
  // waitMs = 0 significa que el NPC pasa por ese punto sin detenerse.

  /**
   * Añade un punto de patrulla en las coordenadas indicadas.
   * @param {{x:number, y:number}} point - Coords room
   */
  addPatrolPoint: (point) => set(s => {
    if (!s.activeChar) return {}
    const id = `pp_${Date.now()}`
    const pp = { id, x: point.x, y: point.y, waitMs: 0, condition: null }
    return {
      activeChar: { ...s.activeChar, patrol: [...(s.activeChar.patrol || []), pp] },
      dirty: true,
    }
  }),

  /**
   * @param {string} ppId
   * @param {Partial<{x:number, y:number, waitMs:number, condition:string|null}>} patch
   */
  updatePatrolPoint: (ppId, patch) => set(s => {
    if (!s.activeChar) return {}
    return {
      activeChar: {
        ...s.activeChar,
        patrol: s.activeChar.patrol.map(p => p.id === ppId ? { ...p, ...patch } : p),
      },
      dirty: true,
    }
  }),

  /** @param {string} ppId */
  deletePatrolPoint: (ppId) => set(s => {
    if (!s.activeChar) return {}
    return {
      activeChar: { ...s.activeChar, patrol: s.activeChar.patrol.filter(p => p.id !== ppId) },
      dirty: true,
    }
  }),

  // ── Inventario inicial ──────────────────────────────────────────────────────
  //
  // Objetos que el personaje lleva al inicio de la partida.
  // El motor los carga en el inventario del personaje al arrancar una nueva partida.

  /**
   * Añade un objeto al inventario inicial. Si ya existe, no hace nada (evita duplicados).
   * @param {string} objectId
   * @param {string} objectName - Nombre legible para mostrar en el editor
   */
  addInventoryItem: (objectId, objectName) => set(s => {
    if (!s.activeChar) return {}
    if ((s.activeChar.inventory || []).find(i => i.objectId === objectId)) return {}
    return {
      activeChar: { ...s.activeChar, inventory: [...(s.activeChar.inventory || []), { objectId, objectName }] },
      dirty: true,
    }
  }),

  /** @param {string} objectId */
  removeInventoryItem: (objectId) => set(s => {
    if (!s.activeChar) return {}
    return {
      activeChar: { ...s.activeChar, inventory: (s.activeChar.inventory || []).filter(i => i.objectId !== objectId) },
      dirty: true,
    }
  }),

  /** Borra todos los puntos de patrulla del personaje activo. */
  clearPatrol: () => set(s => ({
    activeChar: s.activeChar ? { ...s.activeChar, patrol: [] } : null,
    dirty: true,
  })),

  // ── Guardar ─────────────────────────────────────────────────────────────────

  /**
   * Guarda el personaje activo en disco y los locales si tienen cambios pendientes.
   * Actualiza la lista de personajes con el resumen devuelto por el servidor.
   * @param {string} gameDir
   */
  saveActiveChar: async (gameDir) => {
    const { activeChar } = get()
    if (!activeChar) return
    const r = await window.api.saveChar(gameDir, activeChar)
    if (r.ok) {
      set(s => ({
        chars:      s.chars.map(c => c.id === r.char.id ? r.char : c),
        activeChar: r.char,
        dirty:      false,
      }))
      // Guardar locales: el nombre del personaje puede haber cambiado
      const { useLocaleStore } = await import('./localeStore')
      await useLocaleStore.getState().saveAll(gameDir)
    }
  },
}))
