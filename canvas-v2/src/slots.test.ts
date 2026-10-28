import { readdirSync, readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { noCanvasSlots } from './slots'

function parse(name: string): ts.SourceFile {
  return ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
const app = parse('./App.tsx'), inspector = parse('./components/RunInspector.tsx'), slots = parse('./slots.ts')

function find<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  function visit(node: ts.Node) { if (match(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return found
}
function mentions(node: ts.Node, name: string): boolean {
  return find(node, ts.isIdentifier).some((identifier) => identifier.text === name)
}
// True when the node only evaluates after a `slot && …` or `slot ? … :` on the way up.
function guardedBy(node: ts.Node, name: string): boolean {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === current && mentions(parent.left, name)) return true
    if (ts.isConditionalExpression(parent) && parent.whenTrue === current && mentions(parent.condition, name)) return true
  }
  return false
}
function insideJsx(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) if (ts.isJsxAttribute(current) || ts.isJsxExpression(current)) return true
  return false
}
function jsxTag(node: ts.Node): string | undefined {
  return ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node) ? node.tagName.getText(node.getSourceFile()) : undefined
}

const slotNames = find(slots, ts.isInterfaceDeclaration).find((declaration) => declaration.name.text === 'CanvasKernelSlots')!.members.map((member) => {
  expect(member.questionToken, member.getText(slots)).toBeDefined()
  return member.name!.getText(slots)
})

describe('kernel slots for cloud interfaces', () => {
  it('declares the ten cloud interfaces as optional slots and defaults to none', () => {
    expect(slotNames.sort()).toEqual(['CanvasAgentPanel', 'CanvasWorkshopLibraryDialog', 'ProjectCollaborationPanel', 'SaveCanvasWorkshopDialog', 'VideoTaskRecovery', 'WorkshopAssetPickerDialog', 'WorkshopContentRecoveryNotice', 'WorkshopCreationRecoveryNotice', 'WorkshopModelMappingDialog', 'WorkshopSetupPanel'])
    expect(Object.isFrozen(noCanvasSlots)).toBe(true)
    expect(Object.keys(noCanvasSlots)).toEqual([])
  })

  it('keeps every cloud interface component out of the kernel source', () => {
    const root = new URL('./', import.meta.url)
    function files(directory: URL): URL[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(new URL(`${entry.name}/`, directory)) : /\.(?:ts|tsx)$/.test(entry.name) ? [new URL(entry.name, directory)] : [])
    }
    const kernel = files(root)
    expect(kernel.length).toBeGreaterThan(400)
    for (const file of kernel) expect(readFileSync(file, 'utf8'), file.pathname).not.toMatch(/(?:from|import|require)\s*\(?\s*['"][^'"]*canvas-slots/)
    const names = new Set(kernel.map((file) => file.pathname.split('/').at(-1)!.replace(/\.tsx?$/, '')))
    for (const name of slotNames) expect(names.has(name), name).toBe(false)
    expect(names.has('CanvasWorkshopDialog')).toBe(false)
  })

  it('renders every slot only behind a check that the shell passed it', () => {
    const rendered = new Set<string>()
    for (const source of [app, inspector]) {
      for (const element of find(source, (node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement => jsxTag(node) !== undefined)) {
        const tag = jsxTag(element)!
        if (!slotNames.includes(tag)) continue
        rendered.add(tag)
        expect(guardedBy(element, tag), `${source.fileName}: ${element.getText(source).slice(0, 80)}`).toBe(true)
      }
    }
    expect([...rendered].sort()).toEqual([...slotNames].sort())
  })

  it('offers no workshop or agent entry when the matching slot is missing', () => {
    const openLibrary = find(app, ts.isCallExpression).filter((call) => call.expression.getText(app) === 'setWorkshopCatalog' && call.arguments[0]?.getText(app) === '{}' && insideJsx(call))
    expect(openLibrary.length).toBeGreaterThanOrEqual(2)
    for (const call of openLibrary) expect(guardedBy(call, 'CanvasWorkshopLibraryDialog'), call.getText(app)).toBe(true)

    const saveSelection = find(app, ts.isCallExpression).filter((call) => call.expression.getText(app) === 'saveWorkshopSelection' && insideJsx(call))
    expect(saveSelection.length).toBeGreaterThanOrEqual(3)
    for (const call of saveSelection) expect(guardedBy(call, 'SaveCanvasWorkshopDialog'), call.getText(app)).toBe(true)
    const contextMenu = find(app, ts.isPropertyAssignment).filter((property) => property.name.getText(app) === 'canSaveWorkshop')
    expect(contextMenu).toHaveLength(1)
    expect(guardedBy(find(contextMenu[0].initializer, ts.isCallExpression).find((call) => call.expression.getText(app) === 'hostBridge')!, 'SaveCanvasWorkshopDialog')).toBe(true)

    // Every agent entry (toolbar button, selection toolbar, run inspector) waits for agentScope.
    const scope = find(app, ts.isVariableDeclaration).find((declaration) => declaration.name.getText(app) === 'agentScope')!
    const factory = (scope.initializer as ts.CallExpression).arguments[0].getText(app)
    const evaluate = (panel: unknown) => new Function('activeProject', 'currentDraftProjectEpoch', 'creationOwnerId', 'window', 'CanvasAgentPanel', 'agentMountedRef', 'draftActionsEnabledRef', 'activeProjectIdRef', 'projectEpochRef',
      ts.transpileModule(`return (${factory})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)({ id: 'project-a' }, 1, 'owner-a', { xingmangCanvasHost: { agent() {} } }, panel, {}, {}, {}, {})
    expect(evaluate(undefined)).toBeNull()
    expect(evaluate(() => null)).toMatchObject({ projectId: 'project-a', ownerId: 'owner-a' })
    for (const use of find(app, ts.isIdentifier).filter((identifier) => identifier.text === 'setAgentOpen' && ts.isCallExpression(identifier.parent) && identifier.parent.arguments[0]?.getText(app) === 'true' && insideJsx(identifier))) {
      expect(guardedBy(use.parent, 'agentScope'), use.parent.getText(app)).toBe(true)
    }
  })
})
