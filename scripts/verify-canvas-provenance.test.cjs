const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validatePackageLockSources } = require('./audit-development-dependencies.cjs')
const { buildCanvasLockfile } = require('./trim-canvas-lockfile.cjs')

const projectRoot = path.resolve(__dirname, '..')

test('records every direct canvas runtime dependency in the provenance ledger', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'canvas-v2', 'package.json'), 'utf8'))
  const lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, 'canvas-v2', 'package-lock.json'), 'utf8'))
  const ledger = fs.readFileSync(path.join(projectRoot, 'docs', 'CANVAS-THIRD-PARTY.md'), 'utf8')
  const provenance = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docs', 'canvas-third-party.json'), 'utf8'))

  assert.equal(provenance.schemaVersion, 1)
  const records = new Map(provenance.runtimeDependencies.map((entry) => [entry.package, entry]))
  for (const [dependency, declaredRange] of Object.entries(manifest.dependencies ?? {})) {
    const record = records.get(dependency)
    assert.ok(record, `missing structured provenance for ${dependency}`)
    const lockEntry = lockfile.packages?.[`node_modules/${dependency}`]
    assert.ok(lockEntry?.version, `missing locked version for ${dependency}`)
    assert.equal(record.version, lockEntry.version, `${dependency} version must match package-lock.json`)
    assert.match(declaredRange, new RegExp(lockEntry.version.replaceAll('.', '\\.') + '$'))
    assert.match(record.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
    assert.match(record.license, /^[A-Za-z0-9-.+]+$/)
    assert.ok(record.usage.length > 0)
  }
  assert.deepEqual([...records.keys()].sort(), Object.keys(manifest.dependencies ?? {}).sort())
  assert.match(ledger, /Idea-only 研究来源/)
  assert.match(ledger, /无许可证/)
  assert.match(ledger, /GPL\/AGPL/)
  assert.ok(provenance.ideaOnly.some((entry) => entry.licenseClass === 'unlicensed'))
  assert.ok(provenance.ideaOnly.some((entry) => entry.licenseClass === 'copyleft'))
  assert.ok(provenance.ideaOnly.every((entry) => entry.forbidden.length > 0))
  assert.ok(provenance.templates.every((entry) => entry.provenance === 'xingmang-original'))
  assert.equal(new Set(provenance.templates.map((entry) => entry.id)).size, provenance.templates.length, 'template provenance ids must be unique')
  assert.equal(provenance.templates.length, 24)
})

// The canvas ships from the root dependencies (canvas:prepare), so its own lockfile only
// serves a standalone install. Holding it to the root lockfile keeps that install on the
// audited set from the official registry, and keeps the ledger above on what ships (D102).
test('trims the canvas lockfile from the audited root lockfile', () => {
  const rootLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'canvas-v2', 'package.json'), 'utf8'))
  const lockfile = JSON.parse(fs.readFileSync(path.join(projectRoot, 'canvas-v2', 'package-lock.json'), 'utf8'))
  const rootManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const regenerate = 'run node scripts/trim-canvas-lockfile.cjs, then the npm command it prints'

  const rootRanges = { ...rootManifest.dependencies, ...rootManifest.devDependencies }
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.equal(range, rootRanges[name], `canvas-v2/package.json must declare ${name} exactly as the root package.json does`)
  }
  assert.ok(validatePackageLockSources(lockfile) > 0)
  const expected = buildCanvasLockfile(rootLock, manifest)
  assert.deepEqual(lockfile.packages[''], expected.packages[''], `canvas-v2/package-lock.json is stale: ${regenerate}`)
  assert.deepEqual(
    Object.keys(lockfile.packages).sort(),
    Object.keys(expected.packages).sort(),
    `canvas-v2/package-lock.json must hold exactly the root lockfile entries the canvas manifest reaches: ${regenerate}`,
  )
  for (const location of Object.keys(expected.packages)) {
    if (!location) continue
    for (const field of ['version', 'resolved', 'integrity']) {
      assert.equal(lockfile.packages[location][field], rootLock.packages[location][field], `${location} ${field} must match the root lockfile: ${regenerate}`)
    }
  }
})

test('keeps executable canvas sources free of copied research-only project names', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docs', 'canvas-third-party.json'), 'utf8'))
  const forbidden = provenance.ideaOnly.flatMap((entry) => entry.projects)
  const scanRoots = [
    path.join(projectRoot, 'canvas-v2'),
    path.join(projectRoot, 'electron'),
    path.join(projectRoot, 'scripts'),
  ]
  const sourceFiles = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'coverage'].includes(entry.name)) visit(candidate)
      } else if (/\.(?:ts|tsx|css|html|json|cjs|mjs)$/.test(entry.name)) {
        sourceFiles.push(candidate)
      }
    }
  }
  for (const sourceRoot of scanRoots) visit(sourceRoot)
  const source = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const name of forbidden) assert.doesNotMatch(source, new RegExp(name, 'i'))
})

test('requires file-level attribution before adapted code or assets enter the canvas', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docs', 'canvas-third-party.json'), 'utf8'))
  for (const entry of provenance.adaptedFiles) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/)
    assert.ok(entry.sourcePath)
    assert.ok(entry.destinationPath)
    assert.ok(entry.copyright)
    assert.ok(entry.modifications)
  }
  for (const asset of provenance.assets) {
    assert.ok(asset.author)
    assert.match(asset.source, /^https:\/\//)
    assert.ok(asset.license)
    assert.ok(asset.destinationPath)
  }
})
