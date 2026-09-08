import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('docs/renderer-v2-review')
await fs.mkdir(root, { recursive: true })
async function readGeneratedManifest(file, command) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`缺少本地截图清单 ${file}，请先运行：${command}`)
    }
    throw error
  }
}
const business = await readGeneratedManifest(
  'docs/v2-business-evidence/manifest.json',
  'node e2e/v2-business-screenshots.mjs',
)
const reference = await readGeneratedManifest(
  'docs/prototype-refs/current/manifest.json',
  'node e2e/prototype-reference-capture.cjs',
)
const rows = []
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
for (const filename of business.files) {
  const match = /^(.*)-(light|dark)-(win|mac)-(default|empty|failed)\.png$/.exec(filename)
  if (!match) throw new Error('Unrecognized screenshot: ' + filename)
  const [, page, theme, os, state] = match
  const refPage = page === 'account' ? 'account-overview' : page
  const refState = state === 'failed' ? 'error' : state
  const ref = reference.records.find((row) => row.page === refPage && row.theme === theme && row.os === os && row.state === refState)
  rows.push({ page, theme, os, state, actual: '../v2-business-evidence/' + filename, reference: ref?.status === 'captured' ? '../prototype-refs/current/' + ref.file : null, note: ref?.reason ?? '' })
}
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), prototypeSha256: reference.sourceSha256, evidence: 'Local mock UI; macOS appearance simulation, not a native Mac run; screenshots are review inputs, not approved goldens.', rows }, null, 2) + '\n', 'utf8')
const choices = [...new Set(rows.map((row) => row.page))].sort()
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>星芒 UI 本地对照</title><link rel="stylesheet" href="../../ui-spec/tokens.css"><style>
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font:14px/1.6 var(--font)}header{position:sticky;top:0;padding:12px;background:var(--panel-solid);border:1px solid var(--line);z-index:1}h1{margin:0;font-size:24px}select{font:inherit;margin:8px;padding:6px}article{margin:20px 0;padding:16px;border:1px solid var(--line);border-radius:8px}article[hidden]{display:none}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{max-width:100%;height:auto;border:1px solid var(--line)}figure{margin:0}a{color:var(--accent)}small{color:var(--text-3)}
</style><body data-theme="light"><header><h1>星芒 UI v3.1.1 · 本地对照</h1><p>原型与实现的样例数据不同。Win / Mac 是 Chromium 样式分支；Mac 未做真机验收。本页图片尚未作为验收通过的 golden。</p><label>页面<select id="page"><option value="">全部页面</option>${choices.map((page) => `<option>${escape(page)}</option>`).join('')}</select></label><label>主题<select id="theme"><option value="">全部</option><option>light</option><option>dark</option></select></label><label>平台<select id="os"><option value="">全部</option><option>win</option><option>mac</option></select></label><label>状态<select id="state"><option value="">全部</option><option>default</option><option>empty</option><option>failed</option></select></label></header>
${rows.map((row) => `<article data-page="${row.page}" data-theme="${row.theme}" data-os="${row.os}" data-state="${row.state}"><h2>${row.page} · ${row.theme} · ${row.os} · ${row.state}</h2><div class="pair"><figure><figcaption>原型</figcaption>${row.reference ? `<a href="${escape(row.reference)}"><img loading="lazy" src="${escape(row.reference)}" alt="原型 ${row.page}"></a>` : '<p>原型未定义此组合的独立截图。</p>'}</figure><figure><figcaption>实现</figcaption><a href="${escape(row.actual)}"><img loading="lazy" src="${escape(row.actual)}" alt="实现 ${row.page}"></a></figure></div><small>${escape(row.note)}</small></article>`).join('\n')}
<script>const filters=['page','theme','os','state'];function filter(){document.querySelectorAll('article').forEach(row=>{row.hidden=filters.some(key=>document.getElementById(key).value&&row.dataset[key]!==document.getElementById(key).value)})}filters.forEach(key=>document.getElementById(key).addEventListener('change',filter));</script></body></html>`
await fs.writeFile(path.join(root, 'index.html'), html, 'utf8')
console.log(JSON.stringify({ comparisons: rows.length, index: path.join(root, 'index.html') }))
