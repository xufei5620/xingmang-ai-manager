import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const legacyRequire = createRequire(new URL('./tooling/legacy-renderer/package.json', import.meta.url))
const legacyAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-dom/server.browser', 'react-dom/server.node']
  .map((name) => ({ find: new RegExp(`^${name.replaceAll('.', '\\.')}$`), replacement: legacyRequire.resolve(name) }))

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias: [...legacyAliases, { find: /^lucide-react$/, replacement: fileURLToPath(new URL('./node_modules/lucide-react/dist/esm/lucide-react.js', import.meta.url)) }] },
        test: {
          name: 'legacy',
          include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.{ts,tsx}'],
          exclude: ['src/renderer-v2/**'],
          server: { deps: { inline: [/lucide-react/, /react-markdown/] } },
        },
      },
      { plugins: [react()], test: { name: 'renderer-v2', include: ['src/renderer-v2/**/*.test.{ts,tsx}'] } },
      { plugins: [react()], test: { name: 'canvas', include: ['canvas-v2/src/**/*.test.{ts,tsx}'] } },
    ],
  },
})
