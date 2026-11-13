const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')
const { touchesMacPackaging } = require('./ci-change-scope.cjs')
const layout = require('./macos-dmg-layout.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const buildDirectory = path.join(root, 'build')
const generatorPath = path.join(root, 'scripts', 'generate-dmg-background.mjs')
const hintPath = path.join(buildDirectory, 'dmg-background-hint.svg')
// 应用图标那块深蓝（scripts/generate-app-icons.mjs）。
const brandNavy = [0x0b, 0x1f, 0x3b]
const hintText = '把星芒拖到右边的「应用程序」文件夹，再从启动台打开'

// 同 windows-installer-sidebar.test.cjs：子进程读配置，构建模式变量由用例说了算。
function loadDmgConfig(extraEnvironment = {}) {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify(config.dmg))
  `], { cwd: root, encoding: 'utf8', env: { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...extraEnvironment } })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function readChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  const chunks = []
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const crc = bytes.readUInt32BE(offset + 8 + length)
    assert.equal(crc, zlib.crc32(bytes.subarray(offset + 4, offset + 8 + length)), `${type} CRC`)
    chunks.push({ type, data })
    offset += 12 + length
  }
  return chunks
}

// Just enough of a PNG decoder for 8-bit RGB / RGBA, non-interlaced: the
// output of the generator, which a test can then sample pixel by pixel.
function decodePng(file) {
  const chunks = readChunks(fs.readFileSync(file))
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  assert.equal(bitDepth, 8)
  assert.ok(colorType === 2 || colorType === 6, `unsupported colour type ${colorType}`)
  assert.equal(header[12], 0, 'not interlaced')
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
        predictor = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upLeft
      } else assert.equal(filter, 0, `unknown PNG filter ${filter}`)
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  const density = chunks.find((chunk) => chunk.type === 'pHYs')
  return {
    width,
    height,
    pixelsPerMetre: density ? [density.data.readUInt32BE(0), density.data.readUInt32BE(4), density.data[8]] : null,
    at(x, y) {
      const offset = y * stride + x * channels
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
    },
  }
}

function brightness([red, green, blue]) {
  return red + green + blue
}

test('every DMG build names the branded background and lays the window out from the shared layout', () => {
  const expectedContents = [
    { x: layout.application.x, y: layout.application.y, type: 'file' },
    { x: layout.applications.x, y: layout.applications.y, type: 'link', path: '/Applications', name: '应用程序' },
  ]
  const local = loadDmgConfig({ XINGMANG_LOCAL_BUILD: '1' })
  const free = loadDmgConfig({ XINGMANG_MAC_FREE_RELEASE: '1', CSC_NAME: 'XingMang Free Update Identity' })
  for (const dmg of [local, free]) {
    // 写明名字：文件不在时 electron-builder 当场报错，不会悄悄退回自带的灰底虚线箭头。
    assert.equal(dmg.background, 'dmg-background.png')
    assert.equal(dmg.backgroundColor, undefined, 'electron-builder refuses a background colour next to a picture')
    assert.equal(dmg.iconSize, layout.iconSize)
    assert.deepEqual(dmg.contents, expectedContents)
  }
  // 免费渠道只走 ZIP 更新，DMG 照旧不写更新信息；本地包不受这一条影响。
  assert.equal(free.writeUpdateInfo, false)
  assert.equal(local.writeUpdateInfo, undefined)
})

test('the icons sit on the light panel the background draws for them', () => {
  const { width, height, iconSize, panel } = layout
  for (const icon of [layout.application, layout.applications]) {
    // Finder 在图标下面写名字，大约 20px 高：图标和名字都要落在底板里，名字的黑字才看得清。
    assert.ok(icon.x - iconSize / 2 >= panel.x && icon.x + iconSize / 2 <= panel.x + panel.width, 'icon inside the panel horizontally')
    assert.ok(icon.y - iconSize / 2 >= panel.y && icon.y + iconSize / 2 + 28 <= panel.y + panel.height, 'icon and its label inside the panel vertically')
  }
  assert.ok(panel.x > 0 && panel.y > 0 && panel.x + panel.width < width && panel.y + panel.height < height)
  assert.ok(layout.applications.x - layout.application.x >= iconSize * 2, 'room for the arrow between the two icons')
})

test('the background ships as a matching 1x/2x pair that tiffutil can merge', () => {
  const standard = decodePng(path.join(buildDirectory, layout.backgroundName))
  const retina = decodePng(path.join(buildDirectory, layout.retinaBackgroundName))
  // 1 倍图的大小就是安装窗口的大小。
  assert.deepEqual([standard.width, standard.height], [layout.width, layout.height])
  assert.deepEqual([retina.width, retina.height], [layout.width * 2, layout.height * 2])
  // tiffutil -cathidpicheck wants both images to be the same size in points.
  assert.deepEqual(standard.pixelsPerMetre, [2835, 2835, 1], '72 dpi')
  assert.deepEqual(retina.pixelsPerMetre, [5669, 5669, 1], '144 dpi')
})

test('the background is brand navy with the hint on top and a light panel under the icons', () => {
  for (const [name, scale] of [[layout.backgroundName, 1], [layout.retinaBackgroundName, 2]]) {
    const image = decodePng(path.join(buildDirectory, name))
    const at = (x, y) => image.at(Math.round(x * scale), Math.round(y * scale))
    // 底下两个角在顶上那团亮光以外，是纯深蓝。
    assert.deepEqual(at(0, layout.height - 1), brandNavy, `${name} bottom-left`)
    assert.deepEqual(at(layout.width - 1, layout.height - 1), brandNavy, `${name} bottom-right`)
    // 图标名字所在的那一行要是浅色：Finder 用黑字写名字。
    for (const icon of [layout.application, layout.applications]) {
      for (const dx of [-40, 0, 40]) {
        const pixel = at(icon.x + dx, icon.y + layout.iconSize / 2 + 12)
        assert.ok(pixel.every((channel) => channel >= 225), `${name} label row under ${icon.x} is ${pixel}`)
      }
    }
    // 那行字画在顶上那一段：深蓝底上必须有成片的亮像素，否则就是一张没字的底图。
    let brightPixels = 0
    for (let y = Math.round(46 * scale); y < Math.round(74 * scale); y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (brightness(image.at(x, y)) > 600) brightPixels += 1
      }
    }
    assert.ok(brightPixels > 800 * scale * scale, `${name}: expected the hint line, found ${brightPixels} bright pixels`)
  }
})

test('the hint is the approved line, outlined so the build machine fonts cannot change it', () => {
  const hint = fs.readFileSync(hintPath, 'utf8')
  assert.ok(hint.includes(`文字：${hintText}`), 'the outline says which line it draws')
  assert.doesNotMatch(hint, /<text\b|font-family/, 'glyphs are paths, not live text')
  assert.match(hint, /viewBox="0 0 25000 1448"/, `${[...hintText].length} full-width glyphs at 1000 units`)
  assert.equal([...hintText].length, 25)
  // 「应用程序」四个字是金色的，其余是奶白。
  assert.deepEqual([...hint.matchAll(/<path fill="(#[0-9A-F]{6})"/g)].map((match) => match[1]), ['#FAF7EE', '#D4A355'])
})

test('the background is generated from the shared layout and the outlined hint', () => {
  const generator = fs.readFileSync(generatorPath, 'utf8')
  assert.match(generator, /import layout from '\.\/macos-dmg-layout\.cjs'/)
  assert.match(generator, /'dmg-background-hint\.svg'/)
  assert.match(generator, /'#0B1F3B'/)
  assert.match(generator, /layout\.backgroundName/)
  assert.match(generator, /layout\.retinaBackgroundName/)
})

test('changing the background or the layout runs the macOS packaging jobs', () => {
  for (const file of ['build/dmg-background.png', 'build/dmg-background@2x.png', 'build/dmg-background-hint.svg', 'scripts/macos-dmg-layout.cjs']) {
    assert.equal(touchesMacPackaging([file]), true, file)
  }
})
