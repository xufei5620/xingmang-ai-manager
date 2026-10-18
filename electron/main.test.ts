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
