const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'dl-landing', 'index.html'), 'utf8')
const app = fs.readFileSync(path.join(root, 'dl-landing', 'app.js'), 'utf8')

test('the download page walks Windows users past the unsigned-installer warning', () => {
  // Windows 安装包没有签名（docs/RELEASING.md），蓝色拦截窗一定会出现；不教就有人当成病毒走掉。
  assert.match(html, /Windows 第一次安装/)
  assert.match(html, /Windows 已保护你的电脑/)
  assert.match(html, /不是病毒/)
  assert.match(html, /更多信息/)
  assert.match(html, /仍要运行/)
})

test('the Mac download entries state the same minimum macOS the installer enforces', () => {
  // 读源码而不是 require：加载构建配置要带签名相关的环境变量，这里只关心这一个字面量。
  const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.config.cjs'), 'utf8')
  const minimum = builderConfig.match(/minimumSystemVersion: '(\d+)\.\d+'/)
  assert.ok(minimum, 'electron-builder.config.cjs no longer declares minimumSystemVersion')
  const major = minimum[1]
  const macEntries = app.match(/title: 'macOS [^']+', detail: '[^']+'/g)
  assert.equal(macEntries.length, 2)
  for (const entry of macEntries) {
    assert.ok(entry.includes(`需要 macOS ${major} 或更新`), entry)
  }
  assert.ok(html.includes(`需要 macOS ${major} 或更新`))
})

test('the Mac guide tells users how to find their chip type', () => {
  // Intel Mac 的「关于本机」没有「芯片」那一行，写的是「处理器」；只教找「芯片」，Intel 用户会以为自己是 M 芯片（#1155）。
  assert.match(html, /关于本机/)
  assert.match(html, /“芯片 Apple M…”一行就选 M 系列芯片版/)
  assert.match(html, /“处理器 …Intel…”一行就选 Intel 版/)
  assert.match(app, /detail: 'Intel 处理器 · /)
})

test('the install guides avoid jargon customers do not know', () => {
  const guides = html.slice(html.indexOf('win-guide-title'), html.indexOf('<form id="register-view"'))
  for (const word of ['Gatekeeper', '公证', 'DMG', 'SmartScreen', 'Finder']) {
    assert.ok(!guides.includes(word), `download guide still mentions ${word}`)
  }
})

test('the Mac guide leads with the System Settings route that still works on macOS 15 and later', () => {
  // macOS 15 起「右键 → 打开」不再放行，只剩「隐私与安全性 → 仍要打开」。
  // 放行主路必须在步骤列表里，右键打开只能作为旧系统的补充留在折叠段。
  const guide = html.slice(html.indexOf('mac-guide-title'), html.indexOf('<form id="register-view"'))
  const steps = guide.slice(guide.indexOf('<ol class="mac-guide-steps">'), guide.indexOf('</ol>'))
  assert.match(steps, /隐私与安全性/)
  assert.match(steps, /仍要打开/)
  assert.match(steps, /移到废纸篓/)
  assert.doesNotMatch(steps, /右键|按住 Control/)
  const fallback = guide.slice(guide.indexOf('<details'), guide.indexOf('</details>'))
  assert.match(fallback, /macOS 14 或更早/)
  assert.match(fallback, /右键/)
})

test('the download buttons open the same tutorial download page as the app', () => {
  // 飞书安装教程已经不用了，落地页和应用里「打开下载页」要去同一个教程站下载区，那边按芯片分开给包（#1155）。
  const clientSource = fs.readFileSync(path.join(root, 'electron', 'app-download-page.ts'), 'utf8')
  const clientUrl = clientSource.match(/appReleaseDownloadUrl = '([^']+)'/)
  assert.ok(clientUrl, 'electron/app-download-page.ts no longer declares appReleaseDownloadUrl')
  const landingUrl = app.match(/const DOWNLOAD_GUIDE_URL = '([^']+)'/)
  assert.ok(landingUrl, 'dl-landing/app.js no longer declares DOWNLOAD_GUIDE_URL')
  assert.equal(landingUrl[1], clientUrl[1])
  assert.doesNotMatch(app, /feishu|larksuite/i)
  assert.doesNotMatch(html, /feishu|larksuite/i)
})

function readIcoEntry(ico, size) {
  // ICONDIR (6 bytes) then one 16-byte ICONDIRENTRY per image; a width byte of 0 means 256.
  const count = ico.readUInt16LE(4)
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16
    if ((ico[entry] || 256) !== size) continue
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    return ico.subarray(offset, offset + length)
  }
  return null
}

test('the download page shows the same mark customers see once the app is installed', () => {
  // IC-11：下载页原来是老版发紫光的四角星，装好打开却是 v3 深蓝金色星芒，第一次来的客户会怀疑是不是同一家。
  // 页面上的标和标签页图标都从 Windows 安装包用的那份 favicon.ico 原样取，品牌素材换了这里会红。
  const appIcon = fs.readFileSync(path.join(root, 'assets', 'brand', 'v3', 'favicon.ico'))
  const tile = readIcoEntry(appIcon, 256)
  assert.ok(tile, 'assets/brand/v3/favicon.ico no longer carries a 256px image')
  assert.ok(fs.readFileSync(path.join(root, 'dl-landing', 'favicon.ico')).equals(appIcon), 'dl-landing/favicon.ico drifted from the app icon')
  assert.ok(fs.readFileSync(path.join(root, 'dl-landing', 'logo.png')).equals(tile), 'dl-landing/logo.png drifted from the app icon')
})

test('the download page asks for the new mark rather than a cached old one', () => {
  // 新标沿用了 /logo.png 这个文件名，不带版本参数的话，CDN 和浏览器会接着给老客户看缓存里的紫光标。
  const logos = [...html.matchAll(/<img class="[^"]*\b(?:brand|card)-logo\b[^"]*" src="([^"]+)"/g)].map((match) => match[1])
  assert.equal(logos.length, 4)
  for (const source of logos) assert.match(source, /^\/logo\.png\?v=[\w.-]+$/)
  assert.match(html, /<link rel="icon" href="\/favicon\.ico\?v=[\w.-]+"/)
  assert.doesNotMatch(html, /src="\/logo\.png"|href="\/logo\.png"/)
})
