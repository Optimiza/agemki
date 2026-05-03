#!/usr/bin/env node
/**
 * Dev server SOLO del renderer (React UI), sin Electron.
 *
 * Útil para inspeccionar la UI cuando el main process no arranca por
 * algún issue de Electron / electron-vite (ver F-02 en tests/FINDINGS.md).
 *
 * Limitaciones:
 *   - window.api no existe → cualquier llamada IPC falla.
 *   - localStorage funciona (en Chrome).
 *   - No puedes abrir/crear juegos (necesitan main process).
 *
 * Lo que SÍ verás:
 *   - Componentes y navegación.
 *   - Estilos.
 *   - Estado inicial de stores Zustand (algunos toman datos de window.api,
 *     verás errores en consola y placeholders, pero la UI renderiza).
 *
 * Uso:
 *   node tools/dev-renderer-only.mjs
 *   # luego abrir http://localhost:5173/ en el navegador
 */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = resolve(__dirname, '..', 'src', 'renderer')

const server = await createServer({
  configFile: false,
  root: RENDERER_ROOT,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
})

await server.listen()
console.log('')
console.log('🚀 Renderer dev server (sin Electron):')
server.printUrls()
console.log('')
console.log('AVISO: window.api no existe en este modo, los IPC fallarán en consola.')
console.log('Es solo para inspeccionar la UI. Ctrl+C para parar.')
