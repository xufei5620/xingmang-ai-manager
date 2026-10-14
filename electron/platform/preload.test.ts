import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function exposedNamesFor(url: string, isMainFrame = true): string[] {
  const sourceText = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exposed: string[] = []
  vm.runInNewContext(compiled, {
    exports: {},
    process: { isMainFrame },
    window: { location: new URL(url) },
    require: (name: string) => {
      if (name !== 'electron') throw new Error('Sandbox cannot load runtime modules')
      return {
        ipcRenderer: { invoke: () => undefined, on: () => undefined, removeListener: () => undefined },
        contextBridge: { exposeInMainWorld: (key: string) => { exposed.push(key) } },
      }
    },
  })
  return exposed
}

describe('platform sandbox preload', () => {
  it('exposes the platform bridge to the packaged main window and the loopback dev server', () => {
    expect(exposedNamesFor('xingmang://app/index.html?theme=dark')).toEqual(['xingmangPlatform'])
    expect(exposedNamesFor('http://127.0.0.1:5173/?theme=dark')).toEqual(['xingmangPlatform'])
    expect(exposedNamesFor('http://localhost:5175/')).toEqual(['xingmangPlatform'])
  })

  it('never exposes the platform bridge to the infinite-canvas window sharing the session', () => {
    expect(exposedNamesFor('xingmang-canvas://app/?theme=dark')).toEqual([])
    // The canvas sandbox probe loads a blank page in the same session.
    expect(exposedNamesFor('about:blank')).toEqual([])
  })

  it('rejects look-alike origins and subframes', () => {
    expect(exposedNamesFor('xingmang://evil/index.html')).toEqual([])
    expect(exposedNamesFor('https://127.0.0.1:5173/')).toEqual([])
    expect(exposedNamesFor('http://127.0.0.1.evil.example/')).toEqual([])
    expect(exposedNamesFor('https://xm.solov.cc/')).toEqual([])
    expect(exposedNamesFor('xingmang://app/index.html', false)).toEqual([])
  })
})
