const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

// U06: a canvas-v2/ that once ran its own `npm install` holds a second React
// (possibly the old 18) next to the root's 19. The root Vite dependency scan
// treats every .html in the repository as an entry, canvas-v2/index.html
// included, and pre-bundles one copy per bare name - whichever it reached
// first, which changed from run to run on the same directory. The main
// renderer's dev page and its browser fixtures could then get the canvas
// lucide-react, which pulls the canvas React, and the first icon threw "A React
// Element from an older version of React was rendered". canvas-v2/ itself is
// not ours to change (AGENTS.md T13), so the root side resolves those packages
// from the repository root no matter which directory the importer sits in.
//
// The stale copy is reproduced in a temporary directory outside the repository
// rather than in canvas-v2/node_modules, so the suite neither writes under
// canvas-v2/ nor depends on whether this machine ever installed it.

const root = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const canvasPackageJson = JSON.parse(fs.readFileSync(path.join(root, 'canvas-v2', 'package.json'), 'utf8'))

async function singleCopyPackages() {
  const { rendererSingleCopyPackages } = await import(pathToFileURL(path.join(root, 'scripts', 'renderer-single-copy.mjs')).href)
  return rendererSingleCopyPackages
}

function staleCopies(t, packages) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-stale-react-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const name of packages) {
    const packageRoot = path.join(directory, 'node_modules', ...name.split('/'))
    fs.mkdirSync(packageRoot, { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.0.0-stale', main: 'index.js' }))
    fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = {}\n')
  }
  const importer = path.join(directory, 'entry.tsx')
  fs.writeFileSync(importer, packages.map((name) => `import '${name}'\n`).join(''))
  return { directory, importer }
}

function underRootCopy(resolved, name) {
  const normalized = resolved.replaceAll('\\', '/')
  const rootCopy = path.join(root, 'node_modules', ...name.split('/')).replaceAll('\\', '/')
  return normalized.startsWith(`${rootCopy}/`)
}

// The dependency scan resolves bare names through createIdResolver with
// `scan: true`; asking the same resolver checks the path that picked the
// canvas copy, without the optimizer's cache answering first.
async function resolveFromStaleImporter(server, packages, importer) {
  const { createIdResolver } = await import('vite')
  const resolve = createIdResolver(server.config, { scan: true })
  const resolved = {}
  for (const name of packages) resolved[name] = (await resolve(server.environments.client, name, importer)) ?? null
  return resolved
}

test('the single-copy list covers every runtime package the canvas kernel declares', async () => {
  const packages = await singleCopyPackages()
  // The kernel is synced from xingmang-canvas by tag; a new runtime dependency
  // there is a new package the root scan can reach through canvas-v2/index.html.
  const canvasRuntime = Object.keys(canvasPackageJson.dependencies ?? {})
  assert.ok(canvasRuntime.length > 0, 'canvas-v2/package.json must still declare its runtime dependencies')
  assert.deepEqual(canvasRuntime.filter((name) => !packages.includes(name)), [])
  for (const name of ['react', 'react-dom']) assert.ok(packages.includes(name), `${name} must resolve to one copy`)
  // dedupe resolves from the repository root, so the root has to own each copy.
  const rootDeclared = { ...packageJson.dependencies, ...packageJson.devDependencies }
  assert.deepEqual(packages.filter((name) => !rootDeclared[name]), [])
})

test('the root dev server resolves the shared packages from the root copy even beside a stale one', async (t) => {
  const packages = await singleCopyPackages()
  const { importer } = staleCopies(t, packages)
  const previousRenderer = process.env.XINGMANG_RENDERER
  delete process.env.XINGMANG_RENDERER
  t.after(() => { if (previousRenderer === undefined) delete process.env.XINGMANG_RENDERER; else process.env.XINGMANG_RENDERER = previousRenderer })
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-single-copy-vite-'))
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
  const { createServer } = await import('vite')
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    cacheDir,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  })
  t.after(() => server.close())

  const resolved = await resolveFromStaleImporter(server, packages, importer)
  for (const name of packages) assert.ok(underRootCopy(resolved[name], name), `${name} resolved to ${resolved[name]}`)
})

test('every browser fixture server resolves the shared packages from the root copy, with or without a config file', async (t) => {
  const packages = await singleCopyPackages()
  const { importer } = staleCopies(t, packages)
  const { createFixtureServer } = await import(pathToFileURL(path.join(root, 'e2e', 'harness.mjs')).href)
  // configFile:false is how most renderer-v2 fixtures start, so vite.config.ts
  // alone cannot cover them.
  for (const inlineConfig of [{ configFile: false }, { configFile: false, resolve: { dedupe: ['scheduler'] } }]) {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-single-copy-fixture-'))
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }))
    const { server } = await createFixtureServer({ ...inlineConfig, root, cacheDir, logLevel: 'silent', optimizeDeps: { noDiscovery: true } })
    try {
      const resolved = await resolveFromStaleImporter(server, packages, importer)
      for (const name of packages) assert.ok(underRootCopy(resolved[name], name), `${name} resolved to ${resolved[name]}`)
      // A suite's own dedupe entries are kept next to the shared ones.
      for (const name of inlineConfig.resolve?.dedupe ?? []) assert.ok(server.config.resolve.dedupe.includes(name))
    } finally {
      await server.close()
    }
  }
})

test('the vitest renderer-v2 and canvas projects use the root copy and the frozen legacy project keeps its own', async () => {
  const packages = await singleCopyPackages()
  const { loadConfigFromFile } = await import('vite')
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(root, 'vitest.config.ts'), root, 'silent')
  const projects = Object.fromEntries(loaded.config.test.projects.map((project) => [project.test.name, project]))
  for (const name of ['renderer-v2', 'canvas']) {
    assert.deepEqual(packages.filter((item) => !(projects[name].resolve?.dedupe ?? []).includes(item)), [], `${name} project`)
  }
  // legacy points React at tooling/legacy-renderer's 18 through aliases; the
  // root-copy rule must not reach it.
  assert.equal(projects.legacy.resolve?.dedupe, undefined)
})

test('the legacy dev build keeps resolving React through its own aliases only', async (t) => {
  const previousRenderer = process.env.XINGMANG_RENDERER
  process.env.XINGMANG_RENDERER = 'legacy'
  t.after(() => { if (previousRenderer === undefined) delete process.env.XINGMANG_RENDERER; else process.env.XINGMANG_RENDERER = previousRenderer })
  const { loadConfigFromFile } = await import('vite')
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.join(root, 'vite.config.ts'), root, 'silent')
  assert.deepEqual(loaded.config.resolve.dedupe ?? [], [])
  assert.ok(loaded.config.resolve.alias.some((entry) => String(entry.find) === '/^react$/'))
})
