const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')
const { createSettledPackage } = require('./asar-fixture.test-support.cjs')
const {
  ACCEPTED_LICENSES,
  EXPECTED_PACKAGES,
  NOTICES_FILE_NAME,
  NOTICES_HEADING,
  OUTPUT_DIRECTORY_NAME,
  assertPackagedThirdPartyNotices,
  buildBundleManifest,
  buildBundledExtras,
  buildThirdPartyNotices,
  collectProductionPackageDirectories,
  collectThirdPartyEntries,
  copyMacElectronLicenses,
  extractLobeIconsLicense,
  isAcceptedLicense,
  normalizeLicenseField,
  normalizeRepositoryUrl,
  resolvePackageDirectoryFromModuleId,
  resolveToolchainPackageFromModuleId,
  writeBundleManifest,
} = require('./third-party-notices.cjs')

const projectRoot = path.resolve(__dirname, '..')

function temporaryDirectory(t, prefix = 'xingmang-third-party-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function installPackage(root, relativeDirectory, packageJson, licenseText = `Copyright (c) ${packageJson.name} authors\n`) {
  const directory = path.join(root, relativeDirectory)
  writeFile(path.join(directory, 'package.json'), JSON.stringify(packageJson))
  if (licenseText !== null) writeFile(path.join(directory, 'LICENSE'), licenseText)
  writeFile(path.join(directory, 'index.js'), 'module.exports = 1\n')
  return directory
}

// A project with one interface chunk, one canvas chunk and a two-level
// production dependency tree, laid out the way compile leaves the real one.
function createFixtureProject(t, { rendererPackages = ['react', 'mediabunny'], canvasPackages = ['@xyflow/react'], renderer = 'v2', extraPackages = {} } = {}) {
  const root = temporaryDirectory(t)
  writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'main-dep': '^1.0.0' } }))
  installPackage(root, 'node_modules/main-dep', {
    name: 'main-dep', version: '1.0.0', license: 'ISC', dependencies: { 'nested-dep': '^2.0.0' }, optionalDependencies: { 'not-installed': '^1.0.0' },
  })
  installPackage(root, 'node_modules/main-dep/node_modules/nested-dep', { name: 'nested-dep', version: '2.0.0', license: 'MIT' })
  const known = {
    react: { name: 'react', version: '19.2.8', license: 'MIT', repository: { type: 'git', url: 'https://github.com/facebook/react.git', directory: 'packages/react' } },
    mediabunny: { name: 'mediabunny', version: '1.61.4', license: 'MPL-2.0', repository: 'git+https://github.com/Vanilagy/mediabunny.git' },
    '@xyflow/react': { name: '@xyflow/react', version: '12.11.3', license: 'MIT' },
    ...extraPackages,
  }
  for (const [name, packageJson] of Object.entries(known)) installPackage(root, `node_modules/${name}`, packageJson)
  writeFile(path.join(root, 'dist', 'assets', 'index-renderer.js'), '')
  writeFile(path.join(root, 'dist-canvas', 'assets', 'index-canvas.js'), '')
  writeBundleManifest(root, buildBundleManifest({
    bundle: 'renderer',
    renderer,
    chunks: ['assets/index-renderer.js'],
    workerBuilds: 1,
    packageDirectories: rendererPackages.map((name) => path.join(root, 'node_modules', name)),
    toolchainPackages: [],
  }))
  writeBundleManifest(root, buildBundleManifest({
    bundle: 'canvas',
    chunks: ['assets/index-canvas.js'],
    workerBuilds: 1,
    packageDirectories: canvasPackages.map((name) => path.join(root, 'node_modules', name)),
    toolchainPackages: [],
  }))
  return root
}

test('maps a bundled module to the package directory right after its last node_modules', () => {
  assert.equal(resolvePackageDirectoryFromModuleId('/repo/node_modules/react/cjs/react.production.js'), '/repo/node_modules/react')
  assert.equal(resolvePackageDirectoryFromModuleId('/repo/node_modules/@xyflow/react/dist/esm/index.js'), '/repo/node_modules/@xyflow/react')
  assert.equal(
    resolvePackageDirectoryFromModuleId('/repo/node_modules/a/node_modules/b/lib/x.js'),
    '/repo/node_modules/a/node_modules/b',
  )
  assert.equal(resolvePackageDirectoryFromModuleId('C:\\repo\\node_modules\\katex\\dist\\katex.mjs?commonjs-es-import'), 'C:/repo/node_modules/katex')
  // Our own sources, virtual modules and a bare node_modules entry are not packages.
  assert.equal(resolvePackageDirectoryFromModuleId('/repo/src/renderer-v2/main.tsx'), null)
  assert.equal(resolvePackageDirectoryFromModuleId('\0vite/preload-helper.js'), null)
  assert.equal(resolvePackageDirectoryFromModuleId('/repo/node_modules/react'), null)
  assert.equal(resolvePackageDirectoryFromModuleId('/repo/node_modules/.vite/deps/x.js'), null)
})

test('credits the helper code Vite and Rolldown inject as virtual modules to those packages', () => {
  assert.equal(resolveToolchainPackageFromModuleId('\0vite/preload-helper.js'), 'vite')
  assert.equal(resolveToolchainPackageFromModuleId('\0rolldown/runtime.js'), 'rolldown')
  assert.equal(resolveToolchainPackageFromModuleId('\0commonjsHelpers.js'), null)
  assert.equal(resolveToolchainPackageFromModuleId('/repo/node_modules/vite/x.js'), null)
})

test('accepts only licenses whose terms were reviewed, OR needing one and AND needing all', () => {
  for (const license of ACCEPTED_LICENSES) assert.equal(isAcceptedLicense(license), true, license)
  assert.equal(isAcceptedLicense('(MIT OR CC0-1.0)'), true)
  assert.equal(isAcceptedLicense('MIT OR GPL-3.0'), true)
  assert.equal(isAcceptedLicense('MIT AND GPL-3.0'), false)
  for (const license of ['GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'SSPL-1.0', 'UNLICENSED', 'SEE LICENSE IN LICENSE', '', null, '((MIT))']) {
    assert.equal(isAcceptedLicense(license), false, String(license))
  }
})

test('reads the license and repository fields in every shape npm packages use', () => {
  assert.equal(normalizeLicenseField({ license: ' MIT ' }), 'MIT')
  assert.equal(normalizeLicenseField({ license: { type: 'ISC' } }), 'ISC')
  assert.equal(normalizeLicenseField({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)')
  assert.equal(normalizeLicenseField({}), null)
  assert.equal(normalizeRepositoryUrl('git+https://github.com/Vanilagy/mediabunny.git'), 'https://github.com/Vanilagy/mediabunny')
  assert.equal(normalizeRepositoryUrl('github:d3/d3-ease'), 'https://github.com/d3/d3-ease')
  assert.equal(normalizeRepositoryUrl('d3/d3-ease'), 'https://github.com/d3/d3-ease')
  assert.equal(normalizeRepositoryUrl('git@github.com:remarkjs/remark-gfm.git'), 'https://github.com/remarkjs/remark-gfm')
  assert.equal(normalizeRepositoryUrl({ url: 'https://github.com/facebook/react.git', directory: 'packages/react' }), 'https://github.com/facebook/react/tree/HEAD/packages/react')
  assert.equal(normalizeRepositoryUrl('file:../local'), null)
  assert.equal(normalizeRepositoryUrl(undefined), null)
})

test('takes the lobe-icons MIT text from the header of the file it was copied into', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'renderer-v2', 'ui', 'vendor-icons.tsx'), 'utf8')
  const text = extractLobeIconsLicense(source)
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2023 LobeHub\n/)
  assert.match(text, /SOFTWARE\.$/)
  assert.doesNotMatch(text, /^\/\//m)
  assert.equal(extractLobeIconsLicense(source.replace('Copyright (c) 2023 LobeHub', 'Copyright')), null)
  assert.equal(extractLobeIconsLicense('// nothing here\n'), null)
})

test('merges the interface, canvas and main process packages into one sorted list', (t) => {
  const root = createFixtureProject(t, { canvasPackages: ['@xyflow/react', 'react'] })
  const entries = collectThirdPartyEntries(root)
  assert.deepEqual(entries.map((entry) => `${entry.name}@${entry.version}`), [
    '@xyflow/react@12.11.3', 'main-dep@1.0.0', 'mediabunny@1.61.4', 'nested-dep@2.0.0', 'react@19.2.8',
  ])
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
  assert.deepEqual([...byName.react.usedIn].sort(), ['canvas', 'interface'])
  assert.deepEqual([...byName['nested-dep'].usedIn], ['main process'])
  assert.equal(byName.react.source, 'https://github.com/facebook/react/tree/HEAD/packages/react')
  assert.match(byName.react.texts[0].text, /react authors/)
})

test('walks the production dependency tree the way it is installed and skips optional packages that are absent', (t) => {
  const root = createFixtureProject(t)
  const directories = collectProductionPackageDirectories(root).map((directory) => path.relative(fs.realpathSync(root), directory).replaceAll('\\', '/'))
  assert.deepEqual(directories, ['node_modules/main-dep', 'node_modules/main-dep/node_modules/nested-dep'])
  fs.rmSync(path.join(root, 'node_modules', 'main-dep', 'node_modules', 'nested-dep'), { recursive: true })
  assert.throws(() => collectProductionPackageDirectories(root), /nested-dep 没装好/)
})

test('refuses to ship a bundled package whose license was never reviewed', (t) => {
  const root = createFixtureProject(t, {
    rendererPackages: ['react', 'mediabunny', 'copyleft'],
    extraPackages: { copyleft: { name: 'copyleft', version: '3.0.0', license: 'GPL-3.0' } },
  })
  assert.throws(() => collectThirdPartyEntries(root), /copyleft@3\.0\.0（GPL-3\.0）/)
})

test('refuses a package that names no license at all', (t) => {
  const root = createFixtureProject(t, {
    rendererPackages: ['react', 'mediabunny', 'unnamed'],
    extraPackages: { unnamed: { name: 'unnamed', version: '1.0.0' } },
  })
  assert.throws(() => collectThirdPartyEntries(root), /unnamed@1\.0\.0（没写许可）/)
})

test('refuses a package list that does not match the build that will be packaged', (t) => {
  const root = createFixtureProject(t)
  fs.rmSync(path.join(root, 'dist-canvas', 'assets', 'index-canvas.js'))
  assert.throws(() => collectThirdPartyEntries(root), /画布的第三方包名单跟 dist-canvas\/ 里的产物对不上/)
  const missing = createFixtureProject(t)
  fs.rmSync(path.join(missing, OUTPUT_DIRECTORY_NAME, 'renderer.json'))
  assert.throws(() => collectThirdPartyEntries(missing), /读不到界面的第三方包名单/)
})

test('fails when the worker or canvas half of the list was not collected', (t) => {
  // mediabunny only lives in the video compose worker, the part Vite's own
  // build.license does not see.
  const withoutWorker = createFixtureProject(t, { rendererPackages: ['react'] })
  assert.throws(() => collectThirdPartyEntries(withoutWorker), /视频拼片后台线程的 mediabunny 不在第三方包名单里/)
  const withoutCanvas = createFixtureProject(t, { canvasPackages: [] })
  assert.throws(() => collectThirdPartyEntries(withoutCanvas), /画布的 @xyflow\/react 不在第三方包名单里/)
  // The frozen rollback interface has no video studio, so its build is not held to the v2 list.
  const legacy = createFixtureProject(t, { rendererPackages: ['react'], renderer: 'legacy' })
  assert.doesNotThrow(() => collectThirdPartyEntries(legacy))
  assert.deepEqual(EXPECTED_PACKAGES.renderer.map((entry) => entry.name), ['react', 'mediabunny'])
})

test('writes every entry with its version, license, source and full license text, and tells MPL recipients where the exact source is', (t) => {
  const root = createFixtureProject(t)
  const text = buildThirdPartyNotices({
    packages: collectThirdPartyEntries(root),
    extras: [{ name: 'Electron', version: '45.1.0', license: 'MIT', source: 'https://github.com/electron/electron', usedIn: ['application runtime'], texts: [{ name: 'LICENSE', text: 'Copyright (c) Electron contributors\r\n' }], notes: [] }],
  })
  assert.ok(text.startsWith(`${NOTICES_HEADING}\n`))
  assert.match(text, /Components: 6\n/)
  assert.match(text, /\n={80}\nElectron 45\.1\.0\nLicense: MIT\nSource: https:\/\/github\.com\/electron\/electron\nUsed in: application runtime\n-{80}\nLICENSE:\n\nCopyright \(c\) Electron contributors\n/)
  assert.match(text, /\nmediabunny 1\.61\.4\nLicense: MPL-2\.0\nSource: https:\/\/github\.com\/Vanilagy\/mediabunny\nUsed in: interface\nDistributed unmodified\. Source of this exact version: https:\/\/www\.npmjs\.com\/package\/mediabunny\/v\/1\.61\.4\n/)
  assert.doesNotMatch(text, /\r/)
  assert.ok(text.endsWith(`${'='.repeat(80)}\n`))
})

test('registers by hand what no build step can see, each with text read from the repository', () => {
  const extras = buildBundledExtras(projectRoot)
  const byName = Object.fromEntries(extras.map((extra) => [extra.name.split(' ')[0], extra]))
  assert.deepEqual(Object.keys(byName).sort(), ['@lobehub/icons', 'Chromium', 'Electron', 'Mihomo', 'Nsis7z', 'OpenAI', 'OpenCV'])
  assert.equal(byName.Electron.version, require('../node_modules/electron/package.json').version)
  assert.match(byName.Electron.texts[0].text, /Electron contributors/)
  assert.match(byName['@lobehub/icons'].texts[0].text, /LobeHub/)
  assert.match(byName.OpenCV.texts[0].text, /Apache License/)
  assert.deepEqual(byName.OpenAI.texts.map((entry) => entry.name), ['NOTICE', 'LICENSE'])
  assert.equal(byName.Nsis7z.license, 'LGPL-2.1')
  assert.equal(byName.Mihomo.license, 'GPL-3.0')
  assert.ok(byName.Chromium.notes.some((note) => note.includes('LICENSES.chromium.html')))
})

async function createPackagedFixture(t, { listed = ['dep 1.0.0', 'nested 2.0.0'], chromium = 'GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1, February 1999\n', omit = [] } = {}) {
  const root = temporaryDirectory(t, 'xingmang-packaged-notices-')
  const unpacked = path.join(root, 'unpacked')
  const resources = path.join(unpacked, 'resources')
  const source = path.join(root, 'app')
  writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  writeFile(path.join(source, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
  writeFile(path.join(source, 'node_modules', 'dep', 'lib', 'package.json'), JSON.stringify({ type: 'module' }))
  writeFile(path.join(source, 'node_modules', 'dep', 'node_modules', 'nested', 'package.json'), JSON.stringify({ name: 'nested', version: '2.0.0' }))
  fs.mkdirSync(resources, { recursive: true })
  await createSettledPackage(source, path.join(resources, 'app.asar'))
  const files = {
    [path.join(resources, NOTICES_FILE_NAME)]: `${NOTICES_HEADING}\n\n${listed.map((entry) => `${'='.repeat(80)}\n${entry}\nLicense: MIT`).join('\n\n')}\n\n${'='.repeat(80)}\n`,
    [path.join(unpacked, 'LICENSE.electron.txt')]: 'Copyright (c) Electron contributors\n',
    [path.join(unpacked, 'LICENSES.chromium.html')]: chromium,
  }
  for (const [filePath, contents] of Object.entries(files)) {
    if (!omit.includes(path.basename(filePath))) writeFile(filePath, contents)
  }
  return { unpacked, resources, asarPath: path.join(resources, 'app.asar') }
}

function checkPackaged(fixture) {
  return assertPackagedThirdPartyNotices({
    resourcesDirectory: fixture.resources,
    electronLicenseDirectory: fixture.unpacked,
    asarPath: fixture.asarPath,
    asarModule: asar,
  })
}

test('accepts a package whose notices list every package inside app.asar', async (t) => {
  const result = checkPackaged(await createPackagedFixture(t))
  assert.equal(result.listedCount, 2)
})

test('rejects a package with a dependency in app.asar that the notices leave out', async (t) => {
  const fixture = await createPackagedFixture(t, { listed: ['dep 1.0.0'] })
  assert.throws(() => checkPackaged(fixture), /app\.asar 里这些包不在第三方许可清单上：nested 2\.0\.0/)
})

for (const name of [NOTICES_FILE_NAME, 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  test(`rejects a package without ${name}`, async (t) => {
    const fixture = await createPackagedFixture(t, { omit: [name] })
    assert.throws(() => checkPackaged(fixture), new RegExp(`安装包里缺.*${name.replaceAll('.', '\\.')}`))
  })
}

test('rejects a Chromium license file that no longer carries the LGPL-2.1 text the Nsis7z entry points to', async (t) => {
  const fixture = await createPackagedFixture(t, { chromium: '<html>credits</html>\n' })
  assert.throws(() => checkPackaged(fixture), /不再附 LGPL-2\.1 全文/)
})

test('copies the Electron and Chromium licenses into the macOS bundle before electron-builder deletes them', (t) => {
  const appOutDir = temporaryDirectory(t, 'xingmang-mac-extract-')
  const resources = path.join(appOutDir, 'Electron.app', 'Contents', 'Resources')
  fs.mkdirSync(resources, { recursive: true })
  writeFile(path.join(appOutDir, 'LICENSE'), 'Copyright (c) Electron contributors\n')
  writeFile(path.join(appOutDir, 'LICENSES.chromium.html'), '<html>credits</html>\n')
  copyMacElectronLicenses(appOutDir, 'Electron.app')
  assert.equal(fs.readFileSync(path.join(resources, 'LICENSE.electron.txt'), 'utf8'), 'Copyright (c) Electron contributors\n')
  assert.equal(fs.readFileSync(path.join(resources, 'LICENSES.chromium.html'), 'utf8'), '<html>credits</html>\n')
  fs.rmSync(path.join(appOutDir, 'LICENSES.chromium.html'))
  assert.throws(() => copyMacElectronLicenses(appOutDir, 'Electron.app'), /没有 LICENSES\.chromium\.html/)
  assert.throws(() => copyMacElectronLicenses(appOutDir, 'Missing.app'), /找不到 Electron 应用的资源目录/)
})

test('the packaging config ships the notices beside app.asar and restores the macOS licenses at afterExtract', async (t) => {
  const config = require('../electron-builder.config.cjs')
  assert.ok(config.extraResources.some((entry) => entry.from === `${OUTPUT_DIRECTORY_NAME}/${NOTICES_FILE_NAME}` && entry.to === NOTICES_FILE_NAME))
  assert.doesNotMatch(JSON.stringify(config.files), new RegExp(OUTPUT_DIRECTORY_NAME))
  const appOutDir = temporaryDirectory(t, 'xingmang-after-extract-')
  fs.mkdirSync(path.join(appOutDir, 'Electron.app', 'Contents', 'Resources'), { recursive: true })
  writeFile(path.join(appOutDir, 'LICENSE'), 'electron\n')
  writeFile(path.join(appOutDir, 'LICENSES.chromium.html'), 'chromium\n')
  const context = (electronPlatformName) => ({ electronPlatformName, appOutDir, packager: { info: { framework: { distMacOsAppName: 'Electron.app' } } } })
  await config.afterExtract(context('win32'))
  assert.equal(fs.existsSync(path.join(appOutDir, 'Electron.app', 'Contents', 'Resources', 'LICENSE.electron.txt')), false)
  await config.afterExtract(context('darwin'))
  assert.equal(fs.readFileSync(path.join(appOutDir, 'Electron.app', 'Contents', 'Resources', 'LICENSE.electron.txt'), 'utf8'), 'electron\n')
})

test('compile writes the notices last, and the canvas is built through the collector without touching canvas-v2', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const steps = packageJson.scripts['compile:runtime'].split('&&').map((step) => step.trim())
  assert.equal(steps.at(-1), 'node scripts/third-party-notices.cjs')
  assert.ok(steps.indexOf('vite build') < steps.length - 1)
  const canvasSteps = packageJson.scripts['canvas:prepare'].split('&&').map((step) => step.trim())
  assert.deepEqual(canvasSteps, [
    'tsc -p canvas-v2/tsconfig.json --noEmit',
    'node scripts/build-canvas.mjs',
    'node scripts/copy-canvas-assets.mjs',
  ])
  assert.ok(packageJson.scripts['test:scripts'].includes('scripts/third-party-notices.test.cjs'))
  const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/)
  assert.ok(gitignore.includes(`${OUTPUT_DIRECTORY_NAME}/`))
})

test('the collector records interface and worker packages and writes the list only for the packaged output directory', async (t) => {
  const { createThirdPartyCollector } = await import('./third-party-collector.mjs')
  const root = temporaryDirectory(t)
  const run = (outDir) => {
    const collector = createThirdPartyCollector({ bundle: 'renderer', projectRoot: root, expectedOutDir: 'dist', renderer: 'v2' })
    collector.plugin.configResolved({ root, build: { outDir } })
    collector.plugin.buildStart()
    collector.workerPlugin().generateBundle({}, {
      'assets/compose-worker.js': { type: 'chunk', fileName: 'assets/compose-worker.js', moduleIds: [path.join(root, 'node_modules', 'mediabunny', 'dist', 'index.js')] },
    })
    collector.plugin.generateBundle({}, {
      'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', moduleIds: [path.join(root, 'node_modules', 'react', 'index.js'), path.join(root, 'src', 'main.tsx'), '\0vite/preload-helper.js'] },
      'assets/index.css': { type: 'asset', fileName: 'assets/index.css' },
    })
    collector.plugin.writeBundle()
  }
  const manifest = path.join(root, OUTPUT_DIRECTORY_NAME, 'renderer.json')
  run('dist-legacy')
  assert.equal(fs.existsSync(manifest), false)
  run('dist')
  const written = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  assert.deepEqual(written.chunks, ['assets/index.js'])
  assert.equal(written.workerBuilds, 1)
  assert.equal(written.renderer, 'v2')
  assert.deepEqual(written.packageDirectories, ['node_modules/mediabunny', 'node_modules/react'])
  assert.deepEqual(written.toolchainPackages, ['vite'])
})

test('LICENSE says installers are used under the user agreement accepted at registration (D97)', () => {
  const license = fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8')
  assert.match(license.replace(/\n/g, ''), /版权人向付费客户提供的安装包，按注册时同意的用户协议使用。/)
  assert.match(license.replace(/\s+/g, ' '), /Installers the copyright holder provides to paying customers are used under the user agreement accepted at registration\./)
  assert.doesNotMatch(license, /随附的使用条款|terms that accompany them/)
})
