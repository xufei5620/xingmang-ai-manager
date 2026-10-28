import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function actualRead(environment: Record<string, unknown>) {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'readCanvasAssetOrigin' && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing actual source navigation callback')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as (id: string, signal: AbortSignal) => Promise<unknown>
}

describe('actual App source lookup handler', () => {
  function fixture() {
    const read = vi.fn().mockResolvedValue({ version: 1, assetId: 'a'.repeat(43), state: 'unavailable', code: 'no-origin', reason: '无可核对来源' })
    const owner = { current: { ownerId: 1, accountId: 'account-a' } }, project = { current: 'copied-project' }, epoch = { current: 2 }, enabled = { current: true }, mounted = { current: true }, transition = { current: false }, access = { denied: false }
    const forbidden = vi.fn()
    const bridge = { readAssetOrigin: read, getProjectAccess: () => access, openProject: forbidden, listRuns: forbidden, resumeRun: forbidden }
    const call = actualRead({ hostBridge: () => bridge, layerEditorOwnerRef: owner, projectEpochRef: epoch, activeProjectIdRef: project, agentMountedRef: mounted, draftActionsEnabledRef: enabled, projectTransitionRef: transition, locateNode: forbidden })
    return { call, read, owner, project, epoch, enabled, mounted, transition, access, forbidden }
  }

  it('passes the full owned asset identity without focusing a same-id node in the current copy', async () => {
    const f = fixture(), signal = new AbortController().signal
    await f.call('a'.repeat(43), signal)
    expect(f.read).toHaveBeenCalledExactlyOnceWith('a'.repeat(43), signal)
    expect(f.forbidden).not.toHaveBeenCalled()
  })

  it.each(['owner', 'project', 'epoch', 'permission', 'unmounted', 'transition'] as const)('does not publish a stale source after %s changes', async (change) => {
    const f = fixture()
    let finish: (value: object) => void = () => undefined
    f.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = f.call('a'.repeat(43), new AbortController().signal)
    if (change === 'owner') f.owner.current.accountId = 'account-b'
    if (change === 'project') f.project.current = 'another-project'
    if (change === 'epoch') f.epoch.current++
    if (change === 'permission') f.access.denied = true
    if (change === 'unmounted') f.mounted.current = false
    if (change === 'transition') f.transition.current = true
    finish({})
    await expect(pending).rejects.toThrow('已变化')
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})
