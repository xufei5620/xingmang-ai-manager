import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

let server, browser, page
const externalRequests = []
before(async () => {
  server = await createServer({
    root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  page = await browser.newPage()
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(`${origin}/`)) return route.continue()
    externalRequests.push(url)
    return route.abort()
  })
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?noticeEmpty=1`)
  await page.evaluate(async () => {
    window.parseNewApiNoticeFixture = (await import('/src/renderer-v2/features/shell/newapi-announcements.ts'))
      .parseNewApiAnnouncementCollection
  })
})
after(async () => { await browser?.close(); await server?.close() })

const nativeBody = (label, extra = '') => `<div class="xm-newapi-fixture" lang="zh-CN" data-newapi-notice="v1"><style data-newapi-base="">.xm-newapi-fixture .notice-title{color:#203047}</style><article class="announcement"><h1 class="notice-title">${label}</h1><p>公告正文</p>${extra}</article></div>`
const entry = (title, body = nativeBody(title), id = title) => `<details class="collection-entry" id="${id}" open data-collection-latest><summary class="collection-summary"><span class="collection-meta"><span class="collection-badge">最新</span><time datetime="2026-09-09">2026-09-09</time></span><span class="collection-entry-title">${title}</span></summary><div class="collection-body">${body}</div></details>`
const collection = (entries, id = 'fixture-collection') => `<div class="xm-newapi-collection-fixture" id="${id}" lang="zh-CN" data-newapi-collection="v1"><style data-newapi-collection-style>.xm-newapi-collection-fixture{color:#203047}</style><header class="collection-header"><h1>星芒 AI 公告合集</h1><p>点击标题展开或收起。</p></header>${entries.join('')}</div>`
const parse = (text) => page.evaluate((source) => window.parseNewApiNoticeFixture(source), text)
async function expectReadableError(source) {
  const result = await page.evaluate(async (text) => {
    try { await window.parseNewApiNoticeFixture(text); return null }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }, source)
  assert.equal(typeof result, 'string', 'Invalid collections must fail rather than silently hide entries')
  assert.match(result, /公告/, 'The parser must return a user-readable announcement error')
}

test('NewAPI collections extract one title per entry and keep each complete native notice body', async () => {
  const first = nativeBody('gpt-image-2.5 已上线')
  const second = nativeBody('开票中心上线')
  const parsed = await parse(collection([entry('gpt-image-2.5 已上线', first), entry('开票中心上线', second)]))
  assert.deepEqual(parsed.map(({ title }) => title), ['gpt-image-2.5 已上线', '开票中心上线'])
  assert.deepEqual(parsed.map(({ text }) => text), [first, second])
  for (const notice of parsed) {
    assert.match(notice.id, /^newapi-[a-f0-9]{64}$/)
    assert.match(notice.text, /data-newapi-notice="v1"/)
    assert.match(notice.text, /<style data-newapi-base="">/)
    assert.doesNotMatch(notice.title, /最新|2026-09-09|公告合集/)
    assert.doesNotMatch(notice.text, /collection-summary|collection-header/)
  }
})

test('NewAPI entry identity survives collection replacement and reordering while one edit changes only its ID', async () => {
  const first = entry('模型更新')
  const second = entry('开票中心')
  const original = await parse(collection([first, second], 'collection-old'))
  const reordered = await parse(collection([second, first], 'collection-new'))
  assert.deepEqual(reordered.map(({ id }) => id), [original[1].id, original[0].id])
  const updated = await parse(collection([entry('模型更新', nativeBody('模型更新', '<p>新增配置说明</p>')), second]))
  assert.notEqual(updated[0].id, original[0].id)
  assert.equal(updated[1].id, original[1].id)
  const renamed = await parse(collection([entry('模型更新说明', nativeBody('模型更新')), second]))
  assert.notEqual(renamed[0].id, original[0].id)
})

test('NewAPI repeated content is deduplicated independently of wrapper IDs and metadata', async () => {
  const first = entry('模型更新', nativeBody('模型更新'), 'entry-a')
  const duplicate = entry('模型更新', nativeBody('模型更新'), 'entry-b').replace('2026-09-09', '2026-09-10')
  const parsed = await parse(collection([first, duplicate, entry('开票中心')]))
  assert.deepEqual(parsed.map(({ title }) => title), ['模型更新', '开票中心'])
  assert.equal(parsed[0].id, (await parse(collection([first])))[0].id)
})

test('NewAPI parsing stays inert and does not turn nested content into additional announcements', async () => {
  const nested = '<details><summary>正文折叠说明</summary><p>补充说明</p></details>'
  const active = '<script>window.newApiNoticeExecuted=true</script><img id="notice-parser-probe" src="https://notice-fixture.invalid/image.png" onerror="window.newApiNoticeExecuted=true"><iframe src="https://notice-fixture.invalid/frame"></iframe>'
  const parsed = await parse(collection([entry('安全内容', nativeBody('安全内容', nested + active))]))
  assert.equal(parsed.length, 1)
  assert.match(parsed[0].text, /正文折叠说明/)
  const state = await page.evaluate(() => ({
    executed: window.newApiNoticeExecuted,
    inserted: document.querySelectorAll('#notice-parser-probe').length,
  }))
  assert.deepEqual(state, { executed: undefined, inserted: 0 })
  assert.deepEqual(externalRequests, [])
})

test('plain Markdown and standalone notices keep the legacy path without a collection marker', async () => {
  for (const source of [
    '# 重要公告\n\n普通 Markdown 正文。',
    '<article><h1>单篇公告</h1><p>正文</p></article>',
    nativeBody('原生单篇公告'),
    '<details class="collection-entry"><summary>普通折叠</summary>正文</details>',
  ]) assert.equal(await parse(source), null)
})

test('NewAPI malformed collections fail visibly instead of dropping or merging announcements', async () => {
  const sources = [
    collection([entry('未知版本')]).replace('data-newapi-collection="v1"', 'data-newapi-collection="v2"'),
    collection([]),
    collection(['<details class="collection-entry"><div class="collection-body">缺少标题</div></details>']),
    collection(['<details class="collection-entry"><summary class="collection-summary"><span class="collection-entry-title">缺少正文</span></summary></details>']),
    collection([entry('   ')]),
    collection([entry('空正文', '')]),
  ]
  for (const source of sources) await expectReadableError(source)
})

test('NewAPI collections reject oversized content, too many entries, and excessive DOM nodes', async () => {
  await expectReadableError(collection(Array.from({ length: 101 }, (_, index) => entry(`公告 ${index}`))))
  await expectReadableError(collection([entry('过大的公告', 'x'.repeat(4 * 1024 * 1024 + 1))]))
  await expectReadableError(collection([entry('过多节点', '<span></span>'.repeat(20_001))]))
})

test('NewAPI local read state isolates platforms and accounts and persists one entry at a time', async () => {
  const entries = await parse(collection([entry('模型更新'), entry('开票中心')]))
  const state = await page.evaluate(async ([first, second]) => {
    const { markLocalAnnouncementRead, readLocalAnnouncementIds } = await import('/src/renderer-v2/features/shell/newapi-announcements.ts')
    const accepted = markLocalAnnouncementRead('xm-account:42', first.id)
    const duplicate = markLocalAnnouncementRead('xm-account:42', first.id)
    const invalid = markLocalAnnouncementRead('xm-account:42', 'not-a-content-hash')
    return {
      accepted, duplicate, invalid,
      sameAccount: readLocalAnnouncementIds('xm-account:42'),
      otherAccount: readLocalAnnouncementIds('xm-account:43'),
      otherPlatform: readLocalAnnouncementIds('api-account:42'),
      unopenedRead: readLocalAnnouncementIds('xm-account:42').includes(second.id),
    }
  }, entries)
  assert.deepEqual(state, {
    accepted: true, duplicate: true, invalid: false, sameAccount: [entries[0].id],
    otherAccount: [], otherPlatform: [], unopenedRead: false,
  })
})

test('NewAPI local read state rejects corrupted values and bounds retained history', async () => {
  const result = await page.evaluate(async () => {
    const { markLocalAnnouncementRead, readLocalAnnouncementIds } = await import('/src/renderer-v2/features/shell/newapi-announcements.ts')
    const scope = 'xm-account:bounded-fixture'
    const key = `xingmang-v2-notice-entries:${scope}`
    const corrupted = []
    for (const value of ['broken JSON', '{}', JSON.stringify([null, 4, '__proto__', 'newapi-invalid']), 'x'.repeat(20_001)]) {
      localStorage.setItem(key, value)
      corrupted.push(readLocalAnnouncementIds(scope))
    }
    localStorage.removeItem(key)
    const ids = Array.from({ length: 205 }, (_, index) => `newapi-${index.toString(16).padStart(64, '0')}`)
    for (const id of ids) markLocalAnnouncementRead(scope, id)
    return { corrupted, retained: readLocalAnnouncementIds(scope), expected: ids.slice(-200) }
  })
  assert.deepEqual(result.corrupted, [[], [], [], []])
  assert.deepEqual(result.retained, result.expected)
})

test('NewAPI failed local persistence reports failure without losing an existing read record', async () => {
  const entries = await parse(collection([entry('保存成功的公告'), entry('等待保存的公告')]))
  const result = await page.evaluate(async ([first, second]) => {
    const { markLocalAnnouncementRead, readLocalAnnouncementIds } = await import('/src/renderer-v2/features/shell/newapi-announcements.ts')
    const scope = 'xm-account:storage-failure-fixture'
    markLocalAnnouncementRead(scope, first.id)
    const original = Storage.prototype.setItem
    try {
      Storage.prototype.setItem = () => { throw new DOMException('Storage disabled', 'QuotaExceededError') }
      return { accepted: markLocalAnnouncementRead(scope, second.id), retained: readLocalAnnouncementIds(scope) }
    } finally { Storage.prototype.setItem = original }
  }, entries)
  assert.deepEqual(result, { accepted: false, retained: [entries[0].id] })
})
