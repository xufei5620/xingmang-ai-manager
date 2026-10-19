import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import react from '@vitejs/plugin-react'
import { dealTestFiles } from './scripts/vitest-shards.mjs'

const legacyRequire = createRequire(new URL('./tooling/legacy-renderer/package.json', import.meta.url))
const legacyAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-dom/server.browser', 'react-dom/server.node']
  .map((name) => ({ find: new RegExp(`^${name.replaceAll('.', '\\.')}$`), replacement: legacyRequire.resolve(name) }))

// --shard deals the files by their measured time on Windows instead of slicing
// a hash-sorted list into equal counts; scripts/vitest-shards.mjs says why.
// Only shard() changes, and vitest calls it only when --shard is given, so a
// whole run and the order files run in within a shard are vitest's own.
class MeasuredShardSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { root, shard } = this.ctx.config
    if (!shard) return files
    const paths = files.map((file) => path.relative(root, file.moduleId).replaceAll('\\', '/'))
    const shards = dealTestFiles(paths, shard.count)
    return files.filter((_, position) => shards[position] === shard.index)
  }
}

export default defineConfig({
  test: {
    sequence: { sequencer: MeasuredShardSequencer },
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
