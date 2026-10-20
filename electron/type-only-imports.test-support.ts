import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// The main process is CommonJS. When two modules require each other, one of
// them gets the other half-initialised, so a split-out module that hands
// values back to its parent may only take types from it. A line-by-line check
// misses multi-line imports, require() and import(); this walks the syntax
// tree instead.

// `import type { A }`, or `import { type A, type B }` where every name is a
// type: the CommonJS build (no verbatimModuleSyntax) erases both.
function erasedImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  return !clause.name && !!bindings && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
}

function erasedExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
}

function sameModule(fromFile: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = path.resolve(path.dirname(fromFile), specifier).replace(/\.(?:[cm]?js|ts)$/, '')
  return resolved === target.replace(/\.ts$/, '')
}

/**
 * Every place in `sourceText` that pulls a runtime value from `target`, as the
 * text of the offending statement or call. Empty means only types are taken.
 */
export function valueReferencesInSource(fileName: string, sourceText: string, target: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  function pointsAtTarget(node: ts.Expression | undefined): boolean {
    return !!node && ts.isStringLiteralLike(node) && sameModule(fileName, node.text, target)
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && pointsAtTarget(node.moduleSpecifier)) {
      if (!erasedImport(node.importClause)) found.push(node.getText(source))
    } else if (ts.isExportDeclaration(node) && pointsAtTarget(node.moduleSpecifier)) {
      if (!erasedExport(node)) found.push(node.getText(source))
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (pointsAtTarget(node.moduleReference.expression) && !node.isTypeOnly) found.push(node.getText(source))
    } else if (ts.isCallExpression(node) && pointsAtTarget(node.arguments[0])) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) found.push(node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Same as {@link valueReferencesInSource}, for a file on disk. */
export function valueReferences(file: string, target: string): string[] {
  return valueReferencesInSource(file, fs.readFileSync(file, 'utf8'), target)
}

/** How many type-only imports from target the file has, so a gate can tell it still looks at the right import. */
export function typeImportCount(file: string, target: string): number {
  const sourceText = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  return source.statements.filter((statement) => (
    ts.isImportDeclaration(statement)
    && erasedImport(statement.importClause)
    && ts.isStringLiteralLike(statement.moduleSpecifier)
    && sameModule(file, statement.moduleSpecifier.text, target)
  )).length
}
