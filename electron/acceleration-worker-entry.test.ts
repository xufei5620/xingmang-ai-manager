import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { accelerationEntryMode, accelerationWorkerArgument } from './acceleration-worker-entry'

function runEntry(argv: string[], connected: boolean, platform = 'win32') {
  const loaded: string[] = []
  const exit = vi.fn()
  const source = fs.readFileSync(path.join(__dirname, 'platform', 'entry.ts'), 'utf8')
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(compiled, {
    exports: {},
    process: { argv, connected, platform, send: connected ? () => undefined : undefined, exit, stderr: { on: () => undefined, write: () => { throw new Error('EPIPE') } } },
    require(name: string) {
      if (name === '../acceleration-worker-entry') return { accelerationEntryMode }
      loaded.push(name)
      return {}
    },
  })
  return { loaded, exit }
}

describe('packaged acceleration worker entry', () => {
  it('loads only the fixed worker for an IPC-connected Windows helper', () => {
    const result = runEntry(['app.exe', accelerationWorkerArgument], true)
    expect(result.loaded).toEqual(['../acceleration-development-worker'])
    expect(result.exit).not.toHaveBeenCalled()
  })

  it.each([['win32', false], ['darwin', true], ['linux', true]] as const)('rejects invalid helper invocation on %s with parent=%s without loading the desktop', (platform, connected) => {
    const result = runEntry(['app.exe', accelerationWorkerArgument], connected, platform)
    expect(result.loaded).toEqual([])
    expect(result.exit).toHaveBeenCalledWith(1)
  })

  it('preserves the ordinary desktop entry and does not treat arbitrary path arguments as scripts', () => {
    const result = runEntry(['app.exe', 'C:/untrusted/worker.js'], false)
    expect(result.loaded).toEqual(['./desktop-entry'])
    expect(result.exit).not.toHaveBeenCalled()
  })
})
