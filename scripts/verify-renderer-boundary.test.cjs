const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const projectRoot = path.resolve(__dirname, '..')

// R-B1: the renderer bundle must not grow a main-process code path. vite.config.ts
// already fails a v2 build that pulls in legacy UI, but that guard can only see
// what Rollup kept: `import type` is erased long before getModuleIds() runs, it
// never looks at electron/, it is skipped during `vite dev`, and it returns early
// for the legacy renderer. Reading the sources catches what the module graph drops.
//
// Every module listed below is bundled into the renderer, so it must stay as free
// of Node as catalog.ts is (I6). The two lists are deliberately separate: a module
// that is only ever `import type`d is erased and never reaches the bundle, so
// promoting one to a value import has to be a deliberate edit of this file.
const valueImportable = [
  'electron/acceleration-contract',
  'electron/account-key-quota',
  'electron/ai-chat-protocol',
  'electron/catalog',
  'electron/cli-model-defaults',
  'electron/git-runtime',
  'electron/ipc-contract',
  'electron/network-failure',
  'electron/relay-sites',
  'electron/usage-date-range',
  'electron/versions',
]
const typeImportableOnly = [
  'electron/platform/contract',
  'electron/relay-backend',
]

const sourceExtensions = ['.ts', '.tsx']
// Brand assets and the version manifest are inlined as data, never executed.
const assetExtensions = new Set(['.css', '.gif', '.jpeg', '.jpg', '.json', '.png', '.svg', '.webp'])
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

function rendererSourceFiles(directory, collected = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) rendererSourceFiles(candidate, collected)
    // Tests run in Node rather than in the bundle, so they may reach for anything.
    else if (sourceExtensions.includes(path.extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) collected.push(candidate)
  }
  return collected
}

function moduleId(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll('\\', '/').replace(/\.tsx?$/, '')
}

function resolveModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [...sourceExtensions.map((extension) => `${base}${extension}`), ...sourceExtensions.map((extension) => path.join(base, `index${extension}`))]
  return moduleId(candidates.find((candidate) => fs.existsSync(candidate)) ?? base)
}

// `import { type A }` erases exactly like `import type { A }`, and a default or
// namespace binding never does, so the clause decides -- not the keyword alone.
function namedBindingsAreTypeOnly(clause) {
  if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false
  const elements = clause.namedBindings.elements
  return elements.length > 0 && elements.every((element) => element.isTypeOnly)
}

function collectImports(file) {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind)
  const found = []
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: Boolean(node.importClause?.isTypeOnly) || namedBindingsAreTypeOnly(node.importClause) })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly || (named.length > 0 && named.every((element) => element.isTypeOnly)) })
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      const deferred = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      if (deferred) found.push({ specifier: node.arguments[0].text, typeOnly: false })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function describeViolation(origin, specifier, typeOnly, target) {
  if (nodeBuiltins.has(specifier) || specifier === 'electron') return `${origin} imports the main-process module ${specifier}`
  if (!specifier.startsWith('.') || assetExtensions.has(path.extname(specifier))) return null
  if (target.startsWith('electron/')) {
    if (typeImportableOnly.includes(target)) return typeOnly ? null : `${origin} value-imports ${target}; audit it for Node dependencies and move it to valueImportable in scripts/verify-renderer-boundary.test.cjs first`
    if (!valueImportable.includes(target)) return `${origin} imports ${target}, which is not on the renderer import allow list in scripts/verify-renderer-boundary.test.cjs`
    return null
  }
  if (!target.startsWith('src/')) return `${origin} imports ${target} from outside the renderer tree`
  // The legacy UI is frozen and resolves React through tooling/legacy-renderer,
  // so a v2 module reaching into it would bundle a second React copy.
  if (origin.startsWith('src/renderer-v2/') && !target.startsWith('src/renderer-v2/')) return `${origin} imports the legacy renderer module ${target}`
  return null
}

test('keeps the renderer sources inside the modules the bundle may carry', () => {
  for (const file of rendererSourceFiles(path.join(projectRoot, 'src'))) {
    const origin = moduleId(file)
    for (const { specifier, typeOnly } of collectImports(file)) {
      const target = specifier.startsWith('.') ? resolveModule(file, specifier) : specifier
      assert.equal(describeViolation(origin, specifier, typeOnly, target), null)
    }
  }
})

test('keeps every renderer-importable main-process module free of Node dependencies', () => {
  const pending = [...valueImportable]
  const visited = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (visited.has(current)) continue
    visited.add(current)
    const file = sourceExtensions.map((extension) => path.join(projectRoot, `${current}${extension}`)).find((candidate) => fs.existsSync(candidate))
    assert.ok(file, `${current} is on the renderer import allow list but does not exist`)
    for (const { specifier, typeOnly } of collectImports(file)) {
      // Type-only edges are erased, so they carry no Node dependency into the bundle.
      if (typeOnly) continue
      if (specifier.startsWith('.')) pending.push(resolveModule(file, specifier))
      else assert.ok(!nodeBuiltins.has(specifier) && specifier !== 'electron', `${current} reaches the renderer bundle but depends on ${specifier}`)
    }
  }
})

test('keeps the type-only allow list pointing at real modules', () => {
  for (const current of typeImportableOnly) {
    const file = sourceExtensions.map((extension) => path.join(projectRoot, `${current}${extension}`)).find((candidate) => fs.existsSync(candidate))
    assert.ok(file, `${current} is on the renderer type-only allow list but does not exist`)
  }
})

test('rejects the imports the vite guard cannot see', () => {
  const rejected = [
    ['src/renderer-v2/App', '../../electron/system-service', false, 'electron/system-service'],
    ['src/renderer-v2/App', '../../electron/system-service', true, 'electron/system-service'],
    ['src/renderer-v2/App', '../../electron/relay-backend', false, 'electron/relay-backend'],
    ['src/renderer-v2/App', 'node:fs', false, 'node:fs'],
    ['src/renderer-v2/App', 'electron', false, 'electron'],
    ['src/renderer-v2/App', '../types', false, 'src/types'],
    ['src/renderer-v2/App', '../../canvas-v2/src/state', false, 'canvas-v2/src/state'],
  ]
  for (const [origin, specifier, typeOnly, target] of rejected) {
    assert.match(describeViolation(origin, specifier, typeOnly, target) ?? '', /imports/, `${origin} -> ${specifier} should be rejected`)
  }
  const accepted = [
    ['src/renderer-v2/App', '../../electron/relay-sites', false, 'electron/relay-sites'],
    ['src/renderer-v2/App', '../../electron/relay-backend', true, 'electron/relay-backend'],
    ['src/renderer-v2/App', './features/app/api', false, 'src/renderer-v2/features/app/api'],
    ['src/App', '../package.json', false, 'package.json'],
    ['src/components/AppFrame', '../../assets/brand/v3/symbol-micro32-standard.svg', false, 'assets/brand/v3/symbol-micro32-standard.svg'],
    ['src/App', 'react', false, 'react'],
    ['src/components/Dashboard', '../types', false, 'src/types'],
  ]
  for (const [origin, specifier, typeOnly, target] of accepted) {
    assert.equal(describeViolation(origin, specifier, typeOnly, target), null, `${origin} -> ${specifier} should be accepted`)
  }
})

test('reads a type-only import the same way the bundler does', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-renderer-boundary-'))
  const fixture = path.join(directory, 'fixture.ts')
  try {
    fs.writeFileSync(fixture, [
      "import type { A } from './a'",
      "import { type B } from './b'",
      "import { type C, D } from './c'",
      "import DefaultOnly, { type E } from './d'",
      "import * as namespace from './e'",
      "import './f'",
      "export type { G } from './g'",
      "export { type H } from './h'",
      "export { I } from './i'",
      "const later = await import('./j')",
      'export { namespace, DefaultOnly, D, I, later }',
    ].join('\n'))
    const byModule = new Map(collectImports(fixture).map((entry) => [entry.specifier, entry.typeOnly]))
    assert.deepEqual([...byModule.entries()], [
      ['./a', true],
      ['./b', true],
      ['./c', false],
      ['./d', false],
      ['./e', false],
      ['./f', false],
      ['./g', true],
      ['./h', true],
      ['./i', false],
      ['./j', false],
    ])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
