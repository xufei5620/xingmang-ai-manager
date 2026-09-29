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
  assert.match(html, /关于本机/)
  assert.match(html, /“芯片”一行/)
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
