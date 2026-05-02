import { defineConfig } from 'vitest/config'

// Configuración de tests de AGEMKI: corre en entorno node, sin jsdom por defecto.
// Los stores que toquen `window` se marcan con `// @vitest-environment jsdom`
// en su propio fichero de test.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.{test,spec}.{js,mjs,jsx}'],
    setupFiles: ['./tests/helpers/store-stubs.js'],
    reporters: process.env.CI ? ['default'] : ['default'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/main/**/*.js', 'src/renderer/src/store/**/*.js'],
      exclude: ['**/node_modules/**', '**/out/**', '**/dist/**']
    }
  }
})
