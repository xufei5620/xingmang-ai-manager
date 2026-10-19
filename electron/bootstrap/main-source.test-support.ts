import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// main.ts boots the whole app on import, and the bootstrap/ modules it hands
// startup work to need a running Electron, so wiring tests read their source.

const electronRoot = path.join(__dirname, '..')

/** main.ts followed by every bootstrap/ module, in a fixed order. */
export function mainWiringFiles(): string[] {
  const bootstrap = path.join(electronRoot, 'bootstrap')
  const modules = fs.readdirSync(bootstrap)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts'))
    .sort()
    .map((name) => path.join(bootstrap, name))
  return [path.join(electronRoot, 'main.ts'), ...modules]
}

/** The source text of every wiring file joined together, for checks that do not care which file holds a line. */
export function readMainWiringSource(): string {
  return mainWiringFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')
}

export function parseWiringFile(file: string): { file: string, sourceText: string, source: ts.SourceFile } {
  const sourceText = fs.readFileSync(file, 'utf8')
  return { file, sourceText, source: ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true) }
}

export function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent
  }
  return undefined
}

/** The `async () => { … }` handed to `app.whenReady().then(…)` in main.ts. */
export function startupCallback(source: ts.SourceFile): ts.ArrowFunction {
  let found: ts.ArrowFunction | undefined
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'app.whenReady().then') {
      const [callback] = node.arguments
      if (callback && ts.isArrowFunction(callback)) found = callback
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error('main.ts no longer starts from app.whenReady().then(async () => { … })')
  return found
}

/** The body of a top-level `function name(…) { … }` in a bootstrap module. */
export function moduleFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  ))
  if (!found) throw new Error(`${source.fileName} has no top-level function ${name}`)
  return found
}

/**
 * Where each callee is called straight from `owner`'s own body (not from a
 * callback inside it), in source order. A statement the owner runs directly
 * runs in source order, so this is also the order the calls happen in.
 */
export function directCallPositions(source: ts.SourceFile, owner: ts.Node, callees: readonly string[]): Array<{ callee: string, positions: number[] }> {
  const positions = new Map<string, number[]>(callees.map((callee) => [callee, []]))
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && enclosingFunction(node) === owner) {
      positions.get(node.expression.getText(source))?.push(node.getStart(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return callees.map((callee) => ({ callee, positions: positions.get(callee) ?? [] }))
}
