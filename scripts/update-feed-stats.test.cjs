const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')
const {
  StatsError,
  aggregateStats,
  classifyUserAgent,
  collectUpdateFeedStats,
  parseDays,
  planWindow,
} = require('./update-feed-stats.cjs')

const root = path.resolve(__dirname, '..')
const ZONE_ID = 'a'.repeat(32)
const TOKEN = 'T'.repeat(40)
const now = new Date('2026-10-08T12:00:30.000Z')

// Real Electron default user agents, as the client sends them on the status file request.
const windows15 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const windows14 = windows15.replace('/0.2.15 ', '/0.2.14 ')
const mac15 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const linux15 = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function row(userAgent, clientIP, count = 4) {
  return { count, avg: { sampleInterval: 1 }, dimensions: { userAgent, clientIP } }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function settings(overrides = {}) {
  return {
    enabled: true,
    maxDuration: 86400,
    notOlderThan: 8 * 86400,
    maxPageSize: 10000,
    availableFields: ['count', 'avg.sampleInterval', 'dimensions.userAgent', 'dimensions.clientIP', 'dimensions.clientRequestPath'],
    ...overrides,
  }
}

// A stand-in for api.cloudflare.com: answers the zone lookup, the settings query and
// the grouped query, and records every call for the assertions.
function createCloudflare({ limits = settings(), groups = () => [], zoneStatus = 200 } = {}) {
  const calls = []
  async function fetchImpl(url, init) {
    calls.push({ url, init })
    const parsed = new URL(url)
    if (parsed.pathname === '/client/v4/zones') {
      if (zoneStatus !== 200) return jsonResponse(zoneStatus, { success: false, errors: [{ message: 'Authentication error' }] })
      return jsonResponse(200, { success: true, result: [{ id: ZONE_ID, name: 'shenfengwl.fun' }] })
    }
    const payload = JSON.parse(init.body)
    if (payload.query.includes('settings')) {
      return jsonResponse(200, { data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: limits } }] } } })
    }
    return jsonResponse(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups(payload.variables.filter, payload.query) }] } } })
  }
  return { calls, fetchImpl }
}

test('the client version and platform come out of the Electron default user agent', () => {
  assert.deepEqual(classifyUserAgent(windows15), { version: '0.2.15', platform: 'windows' })
  assert.deepEqual(classifyUserAgent(mac15), { version: '0.2.15', platform: 'mac' })
  assert.deepEqual(classifyUserAgent(linux15), { version: '0.2.15', platform: 'linux' })
  // Cloudflare may not keep the Chinese product name byte for byte.
  assert.deepEqual(classifyUserAgent(windows15.replace('星芒AI管理工具', 'æ˜ŸèŠ’AIç®¡ç†å·¥å…·')), { version: '0.2.15', platform: 'windows' })
  assert.deepEqual(classifyUserAgent(windows15.replace('/0.2.15 ', '/0.2.17-test.3 ')), { version: '0.2.17-test.3', platform: 'windows' })
  // A browser opening the file and the updater's manifest request carry no client version.
  assert.equal(classifyUserAgent(browser), null)
  assert.equal(classifyUserAgent('electron-builder'), null)
})

test('each machine counts once, at the version it last read the status file with', () => {
  const pieces = [
    { rows: [{ count: 90, sampleInterval: 1, userAgent: windows14, clientIP: 'ip-a' }, { count: 10, sampleInterval: 1, userAgent: windows14, clientIP: 'ip-b' }] },
    {
      rows: [
        // ip-a upgraded within this piece: both versions show up, the higher one wins.
        { count: 3, sampleInterval: 1, userAgent: windows14, clientIP: 'ip-a' },
        { count: 5, sampleInterval: 1, userAgent: windows15, clientIP: 'ip-a' },
        // A Mac behind the same address is another machine.
        { count: 7, sampleInterval: 1, userAgent: mac15, clientIP: 'ip-a' },
        { count: 2, sampleInterval: 1, userAgent: browser, clientIP: 'ip-c' },
      ],
    },
  ]
  const stats = aggregateStats(pieces, true)
  assert.deepEqual(Object.fromEntries(stats.machines), {
    '0.2.15': { windows: 1, mac: 1, linux: 0, other: 0 },
    '0.2.14': { windows: 1, mac: 0, linux: 0, other: 0 },
  })
  assert.deepEqual(Object.fromEntries(stats.requests), { '0.2.14': 103, '0.2.15': 12 })
  assert.equal(stats.unrecognized, 2)
  assert.equal(JSON.stringify([...stats.machines, ...stats.requests]).includes('ip-'), false)
})

test('the window ends on the current minute, is cut into pieces Cloudflare accepts and never reaches past retention', () => {
  const day = 24 * 60 * 60 * 1000
  const limits = { notOlderThanMs: 8 * day, maxDurationMs: day, pageSize: 10000, withIp: true }
  const week = planWindow(now, 7, limits)
  assert.equal(new Date(week.end).toISOString(), '2026-10-08T12:00:00.000Z')
  assert.equal(new Date(week.start).toISOString(), '2026-10-01T12:00:00.000Z')
  assert.equal(week.clamped, false)
  assert.equal(week.pieces.length, 7)
  assert.ok(week.pieces.every((piece) => piece.end - piece.start <= day))
  assert.equal(week.pieces[0].start, week.start)
  assert.equal(week.pieces.at(-1).end, week.end)

  const clamped = planWindow(now, 31, { ...limits, notOlderThanMs: 3 * day })
  assert.equal(clamped.clamped, true)
  assert.ok(clamped.start > now.getTime() - 3 * day)
  assert.ok(clamped.end - clamped.start < 3 * day)
})

test('the day count must be a whole number of days Cloudflare could hold', () => {
  assert.equal(parseDays('7'), 7)
  assert.equal(parseDays(' 1 '), 1)
  for (const bad of ['0', '32', '1.5', '-1', 'abc', '']) assert.throws(() => parseDays(bad), StatsError, bad)
})

test('the report lists machines per version and platform without any address in it', async () => {
  const cloudflare = createCloudflare({
    groups: (filter) => (filter.datetime_geq === '2026-10-07T12:00:00Z'
      ? [row(windows15, '203.0.113.7'), row(mac15, '203.0.113.7'), row(windows14, '198.51.100.20', 40), row(browser, '192.0.2.1', 1)]
      : []),
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  assert.match(report, /统计时段：北京时间 2026-10-07 20:00 至 2026-10-08 20:00（1 天）/)
  assert.match(report, /\| 版本 \| Windows \| Mac \| Linux \| 合计 \| 占比 \|/)
  assert.match(report, /\| 0\.2\.15 \| 1 \| 1 \| 0 \| 2 \| 66\.7% \|/)
  assert.match(report, /\| 0\.2\.14 \| 1 \| 0 \| 0 \| 1 \| 33\.3% \|/)
  assert.match(report, /\| \*\*合计\*\* \| \*\*2\*\* \| \*\*1\*\* \| \*\*0\*\* \| \*\*3\*\* \| \|/)
  assert.match(report, /\| 0\.2\.14 \| 40 \| 83\.3% \|/)
  assert.match(report, /另有 1 次请求看不出版本/)
  assert.match(report, /0\.2\.8、0\.2\.9 不读更新状态文件/)
  assert.doesNotMatch(report, /203\.0\.113|198\.51\.100|192\.0\.2/)
  assert.doesNotMatch(report, /抽样/)
})

test('only the status file is queried, with the token sent to the Cloudflare API alone and no redirects', async () => {
  const cloudflare = createCloudflare()
  await collectUpdateFeedStats({ token: TOKEN, days: 2, now, fetchImpl: cloudflare.fetchImpl })
  assert.equal(cloudflare.calls[0].url, 'https://api.cloudflare.com/client/v4/zones?name=shenfengwl.fun')
  for (const call of cloudflare.calls) {
    assert.equal(new URL(call.url).origin, 'https://api.cloudflare.com')
    assert.equal(call.init.redirect, 'error')
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`)
    assert.ok(call.init.signal instanceof AbortSignal)
  }
  const grouped = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body))
  assert.equal(grouped.length, 2)
  for (const payload of grouped) {
    assert.equal(payload.variables.zoneTag, ZONE_ID)
    assert.equal(payload.variables.filter.clientRequestPath, '/xingmang-manager/service-status.json')
    assert.match(payload.query, /dimensions \{ userAgent clientIP \}/)
  }
  assert.deepEqual(grouped.map((payload) => payload.variables.filter.datetime_geq), ['2026-10-06T12:00:00Z', '2026-10-07T12:00:00Z'])
})

test('a piece that fills a whole page is split in half until every group fits', async () => {
  const cloudflare = createCloudflare({
    limits: settings({ maxPageSize: 2 }),
    groups: (filter) => {
      const hours = (Date.parse(filter.datetime_lt) - Date.parse(filter.datetime_geq)) / 3600000
      if (hours > 6) return [row(windows14, 'ip-a'), row(windows14, 'ip-b')]
      return Date.parse(filter.datetime_geq) >= Date.parse('2026-10-08T06:00:00Z') ? [row(windows15, 'ip-a')] : [row(windows14, 'ip-b')]
    },
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  // 24h -> 12h -> 6h: four pieces of six hours, the later ones see ip-a on 0.2.15.
  assert.equal(cloudflare.calls.length, 2 + 1 + 2 + 4)
  assert.match(report, /\| 0\.2\.15 \| 1 \| 0 \| 0 \| 1 \| 50\.0% \|/)
  assert.match(report, /\| 0\.2\.14 \| 1 \| 0 \| 0 \| 1 \| 50\.0% \|/)
})

test('without client addresses the report falls back to request counts', async () => {
  const cloudflare = createCloudflare({
    limits: settings({ availableFields: ['count', 'dimensions.userAgent'] }),
    groups: () => [{ count: 9, avg: { sampleInterval: 4 }, dimensions: { userAgent: windows15 } }],
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  assert.match(cloudflare.calls[2].init.body, /dimensions \{ userAgent \}/)
  assert.match(report, /查不到来源 IP/)
  assert.match(report, /\| 0\.2\.15 \| 9 \| 100\.0% \|/)
  assert.match(report, /最多每 4 次记 1 次/)
})

test('a plan that cannot group by user agent stops with a plain explanation', async () => {
  const cloudflare = createCloudflare({ limits: settings({ availableFields: ['count', 'dimensions.clientIP'] }) })
  await assert.rejects(collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl }), /不能按 User-Agent 分组/)
  assert.equal(cloudflare.calls.length, 2)
})

test('a rejected or malformed token stops before anything is queried and is never echoed', async () => {
  const rejected = createCloudflare({ zoneStatus: 403 })
  await assert.rejects(collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: rejected.fetchImpl }), (error) => {
    assert.ok(error instanceof StatsError)
    assert.match(error.message, /令牌被 Cloudflare 拒绝（HTTP 403：Authentication error）/)
    assert.equal(error.message.includes(TOKEN), false)
    return true
  })
  const unused = createCloudflare()
  await assert.rejects(collectUpdateFeedStats({ token: undefined, days: 1, now, fetchImpl: unused.fetchImpl }), /CLOUDFLARE_ANALYTICS_TOKEN/)
  await assert.rejects(collectUpdateFeedStats({ token: `${TOKEN}\nx-evil: 1`, days: 1, now, fetchImpl: unused.fetchImpl }), /格式不对/)
  assert.equal(unused.calls.length, 0)
})

test('a GraphQL error from Cloudflare is shown as it was given', async () => {
  async function fetchImpl(url) {
    if (url.includes('/zones')) return jsonResponse(200, { success: true, result: [{ id: ZONE_ID, name: 'shenfengwl.fun' }] })
    return jsonResponse(200, { data: null, errors: [{ message: 'cannot request data older than 691200s' }] })
  }
  await assert.rejects(collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl }), /统计接口拒绝了这次查询：cannot request data older than 691200s/)
})

test('the stats workflow only reads, on demand, with the read-only analytics token', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'update-feed-stats.yml'), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const [job] = Object.values(workflow.jobs)
  // 只读统计，不碰 release 环境：不用等人批准，也拿不到发布凭据。
  assert.equal(job.environment, undefined)
  assert.ok(job['timeout-minutes'] <= 15)
  const source = JSON.stringify(job)
  assert.doesNotMatch(source, /aws s3|R2_|XINGMANG_UPDATE_SIGNING_KEY/)
  const run = job.steps.find((step) => String(step.run || '').includes('scripts/update-feed-stats.cjs'))
  assert.equal(run.env.CLOUDFLARE_ANALYTICS_TOKEN, '${{ secrets.CLOUDFLARE_ANALYTICS_TOKEN }}')
  assert.equal(run.env.DAYS, '${{ inputs.days }}')
  assert.match(run.run, /--days "\$DAYS"/)
  assert.match(run.run, /GITHUB_STEP_SUMMARY/)
})
