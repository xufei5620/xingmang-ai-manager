import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

// The entries a host without the methods or switches must not see (#4,
// host-entry-points.ts). Each prop the App passes for them has to consult the
// host first, or a click ends in "please update".
const gatedProps: Record<string, readonly string[]> = {
  AssetTray: ['onAddMany', 'onDownloadMany', 'onReadAssetOrigin'],
  RunInspector: ['onAddMany', 'onDownloadMany', 'onOpenCollection'],
  SelectionToolbar: ['onSelectVideoFrame', 'onCreateFrameSequence'],
  CanvasTextEditor: ['onDownload'],
  ImageAnnotationEditor: ['onDownload'],
  ImageMaskEditor: ['allowDownload'],
  ResourceTree: ['canExport'],
}

function attributes(): Array<{ tag: string; name: string; value: string }> {
  const found: Array<{ tag: string; name: string; value: string }> = []
  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const owner = node.parent.parent
      if (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) found.push({ tag: owner.tagName.getText(source), name: node.name.getText(source), value: node.initializer.getText(source) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function nodeHandlerRegistrations(): string[] {
  const found: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'registerNodeChangeHandlers') {
      const [handlers] = node.arguments
      found.push(ts.isCallExpression(handlers) ? `${handlers.expression.getText(source)}(…, ${handlers.arguments[1]?.getText(source)})` : handlers.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('App entries that depend on the host', () => {
  it('consults the host before passing each gated entry', () => {
    const all = attributes()
    for (const [tag, names] of Object.entries(gatedProps)) {
      for (const name of names) {
        const passed = all.filter((entry) => entry.tag === tag && entry.name === name)
        expect(passed.length, `${tag}.${name}`).toBeGreaterThan(0)
        for (const entry of passed) expect(entry.value, `${tag}.${name}`).toContain('hostEntryPoints.')
      }
    }
  })

  it('gives nodes annotation and frame selection only through the host check', () => {
    expect(nodeHandlerRegistrations()).toEqual(['withoutUnavailableNodeEntries(…, hostEntryPoints)'])
  })

  it('shows the menu paste only with clipboard reading and the setup list only with its panel', () => {
    const text = source.getFullText()
    expect(text).toContain("{hostEntryPoints.menuPaste && <button type=\"button\" disabled={!projectCanEdit || projectTransition} onClick={() => { setMoreActionsOpen(false); void pasteSelection() }}>从系统剪贴板粘贴</button>}")
    expect(text).toMatch(/\{WorkshopSetupPanel && <button[^\n]*创作准备清单<\/button>\}/)
  })

  it('shows version history and the package export only when the host has their methods', () => {
    const text = source.getFullText()
    expect(text).toMatch(/\{hostEntryPoints\.projectHistory && <button[^\n]*>版本历史<\/button>\}/)
    expect(text).toMatch(/\{hostEntryPoints\.projectPackageExport && <button[^\n]*>导出项目（含素材）<\/button>\}/)
  })

  it('tells a host without asset mutations or clipboard checks what is unavailable, without asking for an update', () => {
    const text = source.getFullText()
    expect(text).toContain("assetMutationSupported ? <AssetMutationRecoveryPanel journal={assetMutationRecovery} onChanged={() => void refreshAssets()} /> : <p role=\"status\">收藏、改名、标签和回收暂不可用。彻底删除仍按原来的确认流程处理。</p>")
    expect(text).toContain("if (!bridge.inspectClipboardWorkflow) throw new Error('这些节点带着素材或固定的模型来源，当前客户端核对不了，没有粘贴；可以用「创建副本」')")
  })

  it('reports the source keys the host created while preparing models', () => {
    expect(source.getFullText()).toContain('const created = mediaKeyCreatedNotice(prepared.keyCreatedGroups.map((group) => canvasGroupDisplayName(group, groupsRef.current)))')
  })
})
