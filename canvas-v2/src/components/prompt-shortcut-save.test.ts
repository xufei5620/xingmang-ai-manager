import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = ts.createSourceFile('PromptShortcutMenu.tsx', readFileSync(new URL('./PromptShortcutMenu.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source)
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) expression = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error('Missing real menu implementation: ' + name)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(environment)) as T
}
function fixture(editing: { id: string; version: number } | null = null) {
  const prompt = '\t  # 完整正文\r\n\n☕  \n'
  const catalog = { items: [], enabled: true, create: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined) }
  const environment = { name: '  名称  ', prompt, group: ' 分组 ', description: ' 简介 ', editing, catalog,
    lifetime: { current: { saving: false, active: true } }, recovering: false, menu: { current: null }, pendingFocus: { current: null },
    workshopItemPermissions: () => ({ canEdit: true }), setBusy: vi.fn(), setSaveError: vi.fn(), setEditReadRequested: vi.fn(), setCreating: vi.fn(),
    props: { onSource: vi.fn(), onGroup: vi.fn(), onQuery: vi.fn() },
  }
  return { ...environment, save: actual<() => Promise<void>>('save', environment), environment }
}
describe('actual prompt shortcut save and receipt matching', () => {
  it.each([null, { id: 'existing-preset', version: 3 }])('keeps raw prose when creating or updating a shortcut', async (editing) => {
    const f = fixture(editing)
    await f.save()
    const fields = { name: '名称', prompt: f.prompt, group: '分组', description: '简介' }
    if (editing) expect(f.catalog.update).toHaveBeenCalledWith({ ...fields, id: editing.id, expectedVersion: 3 })
    else expect(f.catalog.create).toHaveBeenCalledWith(fields)
    expect(f.lifetime.current.saving).toBe(false)
  })
  it('treats whitespace as part of the exact uncertain-save receipt', () => {
    const f = fixture(), item = { id: 'saved', name: '名称', prompt: f.prompt, group: '分组', description: '简介' }
    expect(actual('match', { ...f.environment, recovering: true, catalog: { items: [item] } })).toEqual(item)
    expect(actual('match', { ...f.environment, recovering: true, catalog: { items: [{ ...item, prompt: item.prompt.trim() }] } })).toBeUndefined()
  })
  it('does not submit a whitespace-only shortcut body', async () => {
    const f = fixture()
    await actual<() => Promise<void>>('save', { ...f.environment, prompt: ' \r\n\t ' })()
    expect(f.catalog.create).not.toHaveBeenCalled(); expect(f.catalog.update).not.toHaveBeenCalled()
  })
})
