import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ipcEventChannels } from './ipc-contract'

// main.ts boots the whole app on import, so these read its source instead.
function mainSource() {
  const file = path.join(__dirname, 'main.ts')
  const sourceText = fs.readFileSync(file, 'utf8')
  return { sourceText, source: ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true) }
}

describe('main process window events', () => {
  it('never sends an IPC event to every open window', () => {
    // 画布跑第三方前端代码，支付窗口是支付商的网页：挨个窗口发，订单号、账号就送到了它们手边（#1069）。
    const { source } = mainSource()
    const broadcasts: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isForOfStatement(node) && /\bBrowserWindow\.getAllWindows\(\)/.test(node.expression.getText(source))
        && /\.send\(/.test(node.statement.getText(source))) {
        broadcasts.push(`main.ts:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(broadcasts).toEqual([])
  })

  it('delivers account, payment and update events to the main window only', () => {
    const { source, sourceText } = mainSource()
    const helpers: string[] = []
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sendToMainWindow' && node.initializer) {
        helpers.push(node.initializer.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(helpers).toHaveLength(1)
    expect(helpers[0]).toContain('managedMainWindow')
    expect(helpers[0]).not.toContain('getAllWindows')
    expect(sourceText.match(/sendToMainWindow\('onAccountSessionChanged', /g)).toHaveLength(2)
    expect(sourceText.match(/sendToMainWindow\('onAccountPaymentWindowTerminal', /g)).toHaveLength(1)
    expect(sourceText.match(/sendToMainWindow\('onUpdateState', /g)).toHaveLength(1)
    for (const event of ['onAccountSessionChanged', 'onAccountPaymentWindowTerminal', 'onUpdateState'] as const) {
      expect(sourceText).not.toContain(`ipcEventChannels.${event}`)
      expect(sourceText).not.toContain(`'${ipcEventChannels[event]}'`)
    }
  })
})

// Every `quitCleanup.add` in main.ts with what a reader needs to check its place:
// the function it runs in and the `if` it sits behind, if any.
function quitCleanupSteps() {
  const { source } = mainSource()
  const steps: Array<{ name: string, body: string, owner: ts.Node | undefined, guard: string | null }> = []
  function enclosingFunction(node: ts.Node): ts.Node | undefined {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return parent
    }
    return undefined
  }
  function enclosingGuard(node: ts.Node): string | null {
    for (let child = node, parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && parent.thenStatement === child) return parent.expression.getText(source)
    }
    return null
  }
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'quitCleanup.add') {
      const [name, step] = node.arguments
      if (!name || !ts.isStringLiteral(name) || !step) throw new Error(`quitCleanup.add needs a literal name: ${node.getText(source)}`)
      steps.push({ name: name.text, body: step.getText(source), owner: enclosingFunction(node), guard: enclosingGuard(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return steps
}

describe('main process quit cleanup', () => {
  it('hangs the whole quit cleanup on a single will-quit listener', () => {
    const { sourceText } = mainSource()
    expect(sourceText.match(/'will-quit'/g)).toHaveLength(1)
    expect(sourceText).toContain("app.once('will-quit', () => quitCleanup.run())")
  })

  it('registers the steps in the order the separate will-quit listeners used to run', () => {
    const steps = quitCleanupSteps()
    expect(steps.map((step) => step.name)).toEqual([
      'acceleration-power',
      'cli-hook-events',
      'keep-awake',
      'routes',
      'acceleration-notices',
      'acceleration',
      'acceleration-host',
      'runtime-log-hooks',
      'updates-and-notifications',
      'ipc',
      'business-services',
      'asset-protocol-and-windows',
      'updater',
      'display-watch',
      'power-off-watch',
      'unexpected-exit-flag',
      'unexpected-exit-handler',
      'window-lifecycle-and-tray',
    ])
    // Source order is run order only while every step is registered straight
    // from the startup callback, never from a callback that fires later.
    expect(steps[0].owner).toBeDefined()
    for (const step of steps) expect(step.owner).toBe(steps[0].owner)
  })

  it('keeps the steps that only exist on some machines behind the same guards', () => {
    const guards = Object.fromEntries(quitCleanupSteps().map((step) => [step.name, step.guard]))
    expect(guards['acceleration-power']).toBe('developmentAcceleration')
    expect(guards['power-off-watch']).toBe("process.platform === 'darwin'")
    for (const [name, guard] of Object.entries(guards)) {
      if (name !== 'acceleration-power' && name !== 'power-off-watch') expect({ name, guard }).toEqual({ name, guard: null })
    }
  })

  it('disconnects acceleration after its notices, then lets the worker go exactly once', () => {
    // 独立加速进程被放掉后自己还原系统代理，失败按次数上限重试（#1265）：它必须排在加速服务之后，
    // 而且整个退出只放一次。
    const steps = quitCleanupSteps()
    const names = steps.map((step) => step.name)
    expect(names.indexOf('acceleration-notices')).toBeLessThan(names.indexOf('acceleration'))
    expect(names.indexOf('acceleration')).toBeLessThan(names.indexOf('acceleration-host'))
    const bodies = Object.fromEntries(steps.map((step) => [step.name, step.body]))
    expect(bodies.acceleration).toContain("void acceleration?.dispose().catch((error) => runtimeLog.exception('network', 'acceleration.shutdown.failed', error))")
    expect(bodies['acceleration-host']).toContain('void developmentAcceleration?.dispose().catch(() => undefined)')
    const all = steps.map((step) => step.body).join('\n')
    expect(all.match(/(?<![\w.])acceleration\?\.dispose\(\)/g)).toHaveLength(1)
    expect(all.match(/developmentAcceleration\?\.dispose\(\)/g)).toHaveLength(1)
  })
})
