const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const assetsRoot = path.join(root, 'assets')
const brandRoot = path.join(assetsRoot, 'brand', 'v3')
const configPath = path.join(root, 'electron-builder.config.cjs')

// Same reason as macos-build-config.test.cjs: the child must see only the build
// mode a case asks for, not whatever the shell running npm test carries.
function cleanBuildEnvironment() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  return { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
}

function loadPackagingConfig() {
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({
      files: config.files,
      icons: [config.win.icon, config.mac.icon, config.linux.icon],
    }))
  `], { cwd: root, encoding: 'utf8', env: cleanBuildEnvironment() })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// Every main-process file that builds a path into assets/brand/v3, plus the
// helper that picks the window icon's name for main.ts.
function iconNamesTheMainProcessLoads() {
  const electronRoot = path.join(root, 'electron')
  const sources = fs.readdirSync(electronRoot)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(electronRoot, name))
    .filter((file) => {
      const source = fs.readFileSync(file, 'utf8')
      return source.includes("'assets', 'brand', 'v3'") || file.endsWith('window-presentation.ts')
    })
  const names = new Set()
  for (const file of sources) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/'([A-Za-z0-9_-]+\.(?:png|ico|icns))'/g)) names.add(match[1])
  }
  return [...names].sort()
}

test('packaging still takes the whole assets directory', () => {
  // The next case only means something while this glob decides what reaches the
  // installer: a loose file at the root of assets/ ships to every customer.
  assert.ok(loadPackagingConfig().files.includes('assets/**/*'))
})

test('the root of assets holds no loose files', () => {
  // The old purple icons sat here for months after assets/brand/v3 replaced them,
  // and every Windows and Mac installer carried about 3 MB of them for nothing.
  // Icons the app reads live under assets/brand/v3; images the renderer imports
  // are bundled into dist by Vite and never read from here.
  const loose = fs.readdirSync(assetsRoot, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
  assert.deepEqual(loose, [])
})

test('every icon the main process loads is in assets/brand/v3', () => {
  const names = iconNamesTheMainProcessLoads()
  // Guards the scan itself: if the path style changes and nothing matches, the
  // existence check below would pass on an empty list.
  for (const expected of ['app-icon.png', 'favicon.ico', 'tray-16.png', 'tray.ico', 'trayTemplate-16.png']) {
    assert.ok(names.includes(expected), `scan no longer finds ${expected}`)
  }
  const missing = names.filter((name) => !fs.existsSync(path.join(brandRoot, name)))
  assert.deepEqual(missing, [])
})

test('every installer icon electron-builder is told to use exists', () => {
  const missing = loadPackagingConfig().icons.filter((icon) => !fs.existsSync(path.join(root, icon)))
  assert.deepEqual(missing, [])
})
