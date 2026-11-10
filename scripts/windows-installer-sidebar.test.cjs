const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const sidebarName = 'installerSidebar.bmp'
const sidebarPath = path.join(root, 'build', sidebarName)
const generatorPath = path.join(root, 'scripts', 'generate-installer-sidebar.mjs')
// 应用图标那块深蓝（scripts/generate-app-icons.mjs），向导左图的底色跟它一致。
const brandNavy = [0x0b, 0x1f, 0x3b]

// 同 windows-installer-shortcuts.test.cjs：子进程读配置，构建模式变量由用例说了算。
function loadNsisConfig() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify(config.nsis))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function readBitmap() {
  const bytes = fs.readFileSync(sidebarPath)
  return {
    bytes,
    signature: bytes.toString('ascii', 0, 2),
    fileSize: bytes.readUInt32LE(2),
    pixelOffset: bytes.readUInt32LE(10),
    headerSize: bytes.readUInt32LE(14),
    width: bytes.readInt32LE(18),
    height: bytes.readInt32LE(22),
    planes: bytes.readUInt16LE(26),
    bitsPerPixel: bytes.readUInt16LE(28),
    compression: bytes.readUInt32LE(30),
  }
}

// Rows are stored bottom-up and every row is padded to 4 bytes; y counts from
// the top of the picture the way the wizard shows it.
function pixelAt(bitmap, x, y) {
  const rowSize = Math.ceil(bitmap.width * 3 / 4) * 4
  const offset = bitmap.pixelOffset + (bitmap.height - 1 - y) * rowSize + x * 3
  return [bitmap.bytes[offset + 2], bitmap.bytes[offset + 1], bitmap.bytes[offset]]
}

test('the installer names the branded sidebar explicitly so a missing file fails the build', () => {
  const nsis = loadNsisConfig()
  // 不写这一项时 electron-builder 找不到 build/installerSidebar.bmp 就悄悄退回 NSIS
  // 自带的 nsis3-metro.bmp，打包日志全绿，客户看到的又是那张通用图。
  assert.equal(nsis.installerSidebar, sidebarName)
  // 卸载向导不单独配：electron-builder 会让它跟着用安装向导这一张。
  assert.equal(nsis.uninstallerSidebar, undefined)
  assert.equal(nsis.oneClick, false, 'the sidebar only shows in the assisted (non one-click) wizard')
  assert.ok(fs.existsSync(sidebarPath), `missing build/${sidebarName}`)
})

test('the sidebar is a plain 164x314 24-bit bitmap the NSIS wizard can load', () => {
  const bitmap = readBitmap()
  assert.equal(bitmap.signature, 'BM')
  assert.equal(bitmap.fileSize, bitmap.bytes.length)
  assert.equal(bitmap.headerSize, 40, 'expected a BITMAPINFOHEADER')
  // MUI2 欢迎页、完成页左图的固定尺寸；高度为正 = 自下而上存，LoadImage 最稳的写法。
  assert.equal(bitmap.width, 164)
  assert.equal(bitmap.height, 314)
  assert.equal(bitmap.planes, 1)
  assert.equal(bitmap.bitsPerPixel, 24, 'no alpha channel: the wizard draws the bitmap as-is')
  assert.equal(bitmap.compression, 0, 'BI_RGB, uncompressed')
  assert.equal(bitmap.pixelOffset, 54)
  assert.equal(bitmap.bytes.length, 54 + Math.ceil(164 * 3 / 4) * 4 * 314)
})

test('the sidebar sits on the app icon navy with the brand mark drawn in the middle', () => {
  const bitmap = readBitmap()
  for (const [x, y] of [[0, 0], [163, 0], [0, 313], [163, 313], [82, 10], [82, 300]]) {
    assert.deepEqual(pixelAt(bitmap, x, y), brandNavy, `corner or margin pixel ${x},${y}`)
  }
  // 图形和字标画在中间那一段：那里必须有明显比底色亮的像素，否则就是一张空底图。
  let brightPixels = 0
  for (let y = 60; y < 210; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const [red, green, blue] = pixelAt(bitmap, x, y)
      if (red + green + blue > 400) brightPixels += 1
    }
  }
  assert.ok(brightPixels > 500, `expected the brand mark in the middle band, found ${brightPixels} bright pixels`)
})

test('the sidebar is rendered from the approved dark brand masters, not drawn by hand', () => {
  const generator = fs.readFileSync(generatorPath, 'utf8')
  assert.match(generator, /'symbol-dark\.svg'/)
  assert.match(generator, /'wordmark-dark\.svg'/)
  assert.match(generator, /'#0B1F3B'/)
  assert.match(generator, /path\.join\(root, 'build', 'installerSidebar\.bmp'\)/)
  for (const master of ['symbol-dark.svg', 'wordmark-dark.svg']) {
    assert.ok(fs.existsSync(path.join(root, 'assets', 'brand', 'v3', master)), `missing brand master ${master}`)
  }
})
