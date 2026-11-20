const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const root = path.resolve(__dirname, '..')
const load = () => import('./build-plugin-icons.mjs')

// 「插件」页 GPT 官方那一组的图标由这个脚本在出版本前生成、随包带走；客户电脑上不读插件目录里第三方写的图标。
// 这里钉住它对第三方输入的几道收口，以及随包那份清单和文件对得上。
test('sniffs image types from their bytes, not their names', async () => {
  const { sniffImageType } = await load()
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png')
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg')
  assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(sniffImageType(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>')), 'svg')
  assert.equal(sniffImageType(Buffer.from('\ufeff  <svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg')
  assert.equal(sniffImageType(Buffer.from('<html><svg></svg></html>')), null)
  assert.equal(sniffImageType(Buffer.from('GIF89a')), null)
})

test('rejects SVGs that carry scripts, foreign content, entities, handlers or outside references', async () => {
  const { svgProblem } = await load()
  const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  assert.equal(svgProblem(svg('<path d="M0 0h1v1z" fill="url(#g)"/><use href="#a"/>')), null)
  assert.equal(svgProblem(svg('<script>alert(1)</script>')), '带脚本')
  assert.equal(svgProblem(svg('<SCRIPT/>')), '带脚本')
  assert.equal(svgProblem(svg('<foreignObject><div/></foreignObject>')), '带 foreignObject')
  assert.equal(svgProblem('<!DOCTYPE svg [<!ENTITY x "y">]>' + svg('')), '带实体声明')
  assert.equal(svgProblem(svg('<rect onload="x()"/>')), '带事件属性')
  assert.equal(svgProblem(svg('<image href="https://example.test/a.png"/>')), '带外部链接')
  assert.equal(svgProblem(svg('<image xlink:href="data:image/png;base64,AAAA"/>')), '带外部链接')
  assert.equal(svgProblem(svg('<rect style="fill:url(https://example.test/x)"/>')), '带外部链接')
  assert.equal(svgProblem(svg('<style>@import "x.css";</style>')), '带外部链接')
})

test('keeps icon paths inside the plugin folder and names to a safe file name', async () => {
  const { resolveLogoPath, safeIconName, pluginDirectoryFor } = await load()
  const base = path.resolve('/tmp/catalog/plugins/sentry')
  assert.equal(resolveLogoPath(base, './assets/logo.png'), path.join(base, 'assets', 'logo.png'))
  assert.equal(resolveLogoPath(base, ''), null)
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'C:/x.png', 'assets\\logo.png', 'file:///x', 'a\0b'])
    assert.throws(() => resolveLogoPath(base, bad), /图标路径不在插件目录里/, bad)
  assert.equal(safeIconName('twilio-developer-kit'), true)
  for (const bad of ['../x', 'Sentry', 'a/b', '', '-x', 'x'.repeat(65)]) assert.equal(safeIconName(bad), false, bad)
  const catalog = path.resolve('/tmp/catalog')
  assert.equal(pluginDirectoryFor({ name: 'sentry', source: { source: 'local', path: './plugins/sentry' } }, catalog, new Map()), path.join(catalog, 'plugins', 'sentry'))
  assert.equal(pluginDirectoryFor({ name: 'qodo', source: { source: 'url', url: 'https://example.test/qodo.git' } }, catalog, new Map()), null)
  assert.throws(() => pluginDirectoryFor({ name: 'x', source: { source: 'local', path: '../outside' } }, catalog, new Map()))
})

test('accepts only the documented arguments', async () => {
  const { parseArguments } = await load()
  const parsed = parseArguments(['--catalog', '/tmp/c', '--repo', 'qodo=/tmp/q'])
  assert.equal(parsed.catalog, '/tmp/c')
  assert.equal(parsed.repos.get('qodo'), '/tmp/q')
  assert.throws(() => parseArguments([]), /--catalog/)
  assert.throws(() => parseArguments(['--catalog', '/tmp/c', '--repo', '../x=/tmp/q']), /写法不对/)
  assert.throws(() => parseArguments(['--catalog', '/tmp/c', '--shell', 'x']), /不认识的参数/)
})

test('the bundled icons are the PNG files the index lists, at the size it says', async () => {
  const { iconSize } = await load()
  const directory = path.join(root, 'bundled-catalog', 'plugin-icons')
  const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
  assert.equal(index.size, iconSize)
  const listed = new Set()
  for (const [name, entry] of Object.entries(index.icons)) {
    for (const variant of [entry.light, entry.dark].filter(Boolean)) {
      assert.match(variant.file, new RegExp(`^codex/${name}(-dark)?\\.png$`))
      const bytes = fs.readFileSync(path.join(directory, variant.file))
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), variant.sha256, variant.file)
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', variant.file)
      // IHDR 里的宽高。
      assert.equal(bytes.readUInt32BE(16), iconSize, variant.file)
      assert.equal(bytes.readUInt32BE(20), iconSize, variant.file)
      listed.add(variant.file)
    }
  }
  const files = fs.readdirSync(path.join(directory, 'codex')).map((file) => `codex/${file}`)
  assert.deepEqual(files.sort(), [...listed].sort(), 'every PNG on disk is in the index and nothing else is bundled')
})
