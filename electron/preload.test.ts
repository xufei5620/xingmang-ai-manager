import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ipcEventChannels, ipcInvokeChannels, type XingmangApi } from './ipc-contract'

function preloadSource() {
  const file = path.join(__dirname, 'preload.ts')
  const sourceText = fs.readFileSync(file, 'utf8')
  return { sourceText, source: ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true) }
}

describe('main-window sandbox preload', () => {
  it('keeps both literal channel inventories aligned with the IPC contract', () => {
    const { source, sourceText } = preloadSource()
    const tables: Record<string, Record<string, string>> = {}
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.initializer
        && ['ipcInvokeChannels', 'ipcEventChannels'].includes(node.name.getText(source))) {
        let expression: ts.Expression = node.initializer
        while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
        if (!ts.isObjectLiteralExpression(expression)) throw new Error('Unexpected channel table')
        tables[node.name.getText(source)] = Object.fromEntries(expression.properties.map((property) => {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
            throw new Error('Unexpected channel property')
          }
          return [property.name.getText(source), property.initializer.text]
        }))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(tables.ipcInvokeChannels).toEqual(ipcInvokeChannels)
    expect(tables.ipcEventChannels).toEqual(ipcEventChannels)
    const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    expect(compiled).not.toMatch(/require\(["']\.\//)
  })

  it('subscribes to account usage hints without invoking privileges and removes its own listener', () => {
    const handlers = new Map<string, (_event: unknown, payload: unknown) => void>()
    let bridge: XingmangApi | undefined
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => { handlers.set(channel, handler) }),
      removeListener: vi.fn((channel: string, handler: unknown) => {
        if (handlers.get(channel) === handler) handlers.delete(channel)
      }),
    }
    const compiled = ts.transpileModule(preloadSource().sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    vm.runInNewContext(compiled, {
      exports: {},
      require: (name: string) => {
        if (name !== 'electron') throw new Error('Sandbox cannot load runtime modules')
        return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, api: XingmangApi) => { bridge = api } } }
      },
    })
    const listener = vi.fn()
    const unsubscribe = bridge!.onAccountUsageChanged(listener)
    handlers.get('account:usage-changed')?.({ sender: 'must-not-leak' }, { scope: 'api-account:7' })
    expect(listener.mock.calls).toEqual([[{ scope: 'api-account:7' }]])
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    unsubscribe()
    expect(handlers.size).toBe(0)
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('account:usage-changed', expect.any(Function))
  })
})
