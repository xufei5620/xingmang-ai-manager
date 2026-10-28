// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/nodes/node-toolbar-markup.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, 'WorkflowNodes.tsx'), 'utf8')

describe('single-node toolbar markup', () => {
  it('uses the React Flow toolbar and keeps both run directions explicit', () => {
    expect(source).toContain('<NodeToolbar')
    expect(source).toContain('handlers.onRunToNode(id)')
    expect(source).toContain('handlers.onRunFromNode(id)')
    // 「运行到此」挪到选中工具条里（selection-toolbar-model.ts）。
    expect(fs.readFileSync(path.join(import.meta.dirname, '..', 'components', 'selection-toolbar-model.ts'), 'utf8')).toContain('运行到此')
    expect(source).toContain('从此向后')
  })

  it('shows an elapsed timer from runtime-only node state', () => {
    expect(source).toContain('<RunningElapsed startedAt={data.runStartedAt} />')
  })
})
