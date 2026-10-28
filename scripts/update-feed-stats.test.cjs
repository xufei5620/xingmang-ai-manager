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
  collectUsageSince,
  networkOf,
  parseDays,
  parseInstallerPath,
  parseUsagePath,
  planWindow,
  summarizeInstallerDownloads,
  summarizeStaleMachines,
} = require('./update-feed-stats.cjs')

const root = path.resolve(__dirname, '..')
const ZONE_ID = 'a'.repeat(32)
const TOKEN = 'T'.repeat(40)
const now = new Date('2026-10-08T12:00:30.000Z')

// Real Electron default user agents, as the client sends them on the status file request.
const windows15 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const windows14 = windows15.replace('/0.2.15 ', '/0.2.14 ')
const windows18 = windows15.replace('/0.2.15 ', '/0.2.18 ')
const mac15 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const mac18 = mac15.replace('/0.2.15 ', '/0.2.18 ')
const mac19 = mac15.replace('/0.2.15 ', '/0.2.19 ')
const mac20 = mac15.replace('/0.2.15 ', '/0.2.20 ')
const mac21 = mac15.replace('/0.2.15 ', '/0.2.21 ')
const windows19 = windows15.replace('/0.2.15 ', '/0.2.19 ')
const linux15 = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) 星芒AI管理工具/0.2.15 Chrome/150.0.7871.250 Electron/43.6.0 Safari/537.36'
const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function row(userAgent, clientIP, count = 4) {
  return { count, avg: { sampleInterval: 1 }, dimensions: { userAgent, clientIP } }
}

function hourRow(userAgent, clientIP, datetimeHour, count = 4) {
  return { count, avg: { sampleInterval: 1 }, dimensions: { userAgent, clientIP, datetimeHour } }
}

function downloadRow(file, clientIP, datetimeHour, count = 3) {
  return { count, avg: { sampleInterval: 1 }, dimensions: { clientRequestPath: `/xingmang-manager/${file}`, clientIP, datetimeHour } }
}

// What parseGroupRows hands on, for the pure aggregation tests.
function statusRead(userAgent, clientIP, hour) {
  return { count: 4, sampleInterval: 1, userAgent, clientIP, path: null, time: Date.parse(`2026-10-10T${hour}:00:00Z`) }
}

function download(file, clientIP, hour) {
  return { count: 3, sampleInterval: 1, userAgent: null, clientIP, path: `/xingmang-manager/${file}`, time: Date.parse(`2026-10-10T${hour}:00:00Z`) }
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
    // The shape a live zone reported on 2026-10-09.
    availableFields: ['avg_sampleInterval', 'count', 'dimensions_clientIP', 'dimensions_clientRequestPath', 'dimensions_userAgent', 'dimensions_userAgentBrowser'],
    ...overrides,
  }
}

const hourlySettings = settings({
  availableFields: ['avg_sampleInterval', 'count', 'dimensions_clientIP', 'dimensions_clientRequestPath', 'dimensions_datetimeHour', 'dimensions_userAgent'],
})

const statusCodeSettings = settings({
  availableFields: [...hourlySettings.availableFields, 'dimensions_edgeResponseStatus'],
})

function failedRow(file, edgeResponseStatus, count, sampleInterval = 1) {
  return { count, avg: { sampleInterval }, dimensions: { clientRequestPath: `/xingmang-manager/${file}`, edgeResponseStatus } }
}

const USAGE_FILTER = '/xingmang-manager/stats/v1/%'

// A stand-in for api.cloudflare.com: answers the zone lookup, the settings query and
// the grouped query, and records every call for the assertions. The daily check-in
// query has its own answer, empty unless a test gives one.
function createCloudflare({ limits = settings(), groups = () => [], usage = () => [], zoneStatus = 200 } = {}) {
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
    const answer = payload.variables.filter.clientRequestPath_like === USAGE_FILTER ? usage : groups
    return jsonResponse(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: answer(payload.variables.filter, payload.query) }] } } })
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

test('the report gives shares per version and platform, never an address or a count', async () => {
  const cloudflare = createCloudflare({
    groups: (filter) => (filter.datetime_geq === '2026-10-07T12:00:00Z'
      ? [row(windows15, '203.0.113.7'), row(mac15, '203.0.113.7'), row(windows14, '198.51.100.20', 40), row(browser, '192.0.2.1', 1)]
      : []),
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  assert.match(report, /统计时段：北京时间 2026-10-07 20:00 至 2026-10-08 20:00（1 天）/)
  assert.match(report, /\| 版本 \| Windows \| Mac \| Linux \| 合计 \|/)
  assert.match(report, /\| 0\.2\.15 \| 33\.3% \| 33\.3% \| 0\.0% \| \*\*66\.7%\*\* \|/)
  assert.match(report, /\| 0\.2\.14 \| 33\.3% \| 0\.0% \| 0\.0% \| \*\*33\.3%\*\* \|/)
  assert.match(report, /\| \*\*合计\*\* \| \*\*66\.7%\*\* \| \*\*33\.3%\*\* \| \*\*0\.0%\*\* \| \*\*100%\*\* \|/)
  assert.match(report, /\| 0\.2\.14 \| 83\.3% \|/)
  assert.match(report, /\| 0\.2\.15 \| 16\.7% \|/)
  assert.match(report, /另有 2\.0% 的请求看不出版本/)
  assert.match(report, /读到的电脑不到 20 台，比例只能粗看/)
  assert.match(report, /0\.2\.8、0\.2\.9 不读更新状态文件/)
  // The repository is public, and so is every run page: no address, no machine or request count.
  assert.doesNotMatch(report, /203\.0\.113|198\.51\.100|192\.0\.2/)
  assert.doesNotMatch(report, /\| (?:1|2|3|8|40|48|49) \|/)
  assert.doesNotMatch(report, /抽样/)
})

test('only the status file and the daily check-ins are queried, with the token sent to the Cloudflare API alone and no redirects', async () => {
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
  const status = grouped.filter((payload) => payload.variables.filter.clientRequestPath)
  const usage = grouped.filter((payload) => payload.variables.filter.clientRequestPath_like === USAGE_FILTER)
  assert.equal(grouped.length, 4)
  assert.equal(status.length, 2)
  for (const payload of status) {
    assert.equal(payload.variables.zoneTag, ZONE_ID)
    assert.equal(payload.variables.filter.clientRequestPath, '/xingmang-manager/service-status.json')
    assert.match(payload.query, /dimensions \{ userAgent clientIP \}/)
  }
  assert.deepEqual(status.map((payload) => payload.variables.filter.datetime_geq), ['2026-10-06T12:00:00Z', '2026-10-07T12:00:00Z'])
  // The check-ins carry everything in the path: no address, no hour, no status code.
  assert.equal(usage.length, 2)
  for (const payload of usage) {
    assert.equal(payload.variables.zoneTag, ZONE_ID)
    assert.match(payload.query, /dimensions \{ clientRequestPath \}/)
    assert.equal(Object.keys(payload.variables.filter).sort().join(','), 'clientRequestPath_like,datetime_geq,datetime_lt')
  }
  assert.deepEqual(usage.map((payload) => payload.variables.filter.datetime_geq), ['2026-10-06T12:00:00Z', '2026-10-07T12:00:00Z'])
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
  // 24h -> 12h -> 6h: four pieces of six hours, the later ones see ip-a on 0.2.15. The check-ins fit in one page.
  assert.equal(cloudflare.calls.length, 2 + 1 + 2 + 4 + 1)
  assert.match(report, /\| 0\.2\.15 \| 50\.0% \| 0\.0% \| 0\.0% \| \*\*50\.0%\*\* \|/)
  assert.match(report, /\| 0\.2\.14 \| 50\.0% \| 0\.0% \| 0\.0% \| \*\*50\.0%\*\* \|/)
})

test('without client addresses the report falls back to request counts', async () => {
  const cloudflare = createCloudflare({
    limits: settings({ availableFields: ['count', 'dimensions_userAgent', 'dimensions_userAgentOS'] }),
    groups: () => [{ count: 9, avg: { sampleInterval: 4 }, dimensions: { userAgent: windows15 } }],
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  assert.match(cloudflare.calls[2].init.body, /dimensions \{ userAgent \}/)
  assert.match(report, /查不到来源 IP/)
  assert.match(report, /\| 0\.2\.15 \| 100\.0% \|/)
  assert.match(report, /最多每 4 次记 1 次/)
})

test('a plan that cannot group by user agent stops with a plain explanation', async () => {
  const cloudflare = createCloudflare({ limits: settings({ availableFields: ['count', 'dimensions_clientIP', 'dimensions_userAgentBrowser'] }) })
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

test('a token that cannot list the zone says which permission is missing', async () => {
  async function fetchImpl() {
    return jsonResponse(200, { success: true, result: [] })
  }
  await assert.rejects(collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl }), /权限里要有 Zone \/ Zone \/ Read/)
})

test('a GraphQL error from Cloudflare is shown as it was given', async () => {
  async function fetchImpl(url) {
    if (url.includes('/zones')) return jsonResponse(200, { success: true, result: [{ id: ZONE_ID, name: 'shenfengwl.fun' }] })
    return jsonResponse(200, { data: null, errors: [{ message: 'cannot request data older than 691200s' }] })
  }
  await assert.rejects(collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl }), /统计接口拒绝了这次查询：cannot request data older than 691200s/)
})

test('with hours, a machine counts at the version of its latest hour, not of the last piece it showed up in', () => {
  const pieces = [{
    start: Date.parse('2026-10-10T00:00:00Z'),
    rows: [
      statusRead(windows15, 'ip-a', '09'),
      statusRead(windows18, 'ip-a', '10'),
      // Went back to 0.2.15 later the same day (a rollback, say): the later hour wins over the higher version.
      statusRead(windows15, 'ip-a', '11'),
      statusRead(mac15, 'ip-b', '10'),
      statusRead(mac18, 'ip-b', '10'),
    ],
  }]
  const stats = aggregateStats(pieces, true)
  assert.deepEqual(Object.fromEntries(stats.machines), {
    '0.2.15': { windows: 1, mac: 0, linux: 0, other: 0 },
    '0.2.18': { windows: 0, mac: 1, linux: 0, other: 0 },
  })
})

test('an IPv6 client counts by its /64 network, the way an IPv4 client counts by its public address', () => {
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7')
  assert.equal(networkOf('2001:db8:1234:5678:a:b:c:d'), '2001:db8:1234:5678::/64')
  assert.equal(networkOf('2001:0db8:0001::abcd'), '2001:db8:1:0::/64')
  assert.equal(networkOf('2001:db8::'), '2001:db8:0:0::/64')
  assert.equal(networkOf('::ffff:198.51.100.2'), '198.51.100.2')
  // Privacy extensions rotate the interface half: the same computer, still one machine, and the follow-up still joins.
  const pieces = [{
    rows: [
      statusRead(mac15, '2001:db8:1234:5678:1111:2222:3333:4444', '09'),
      statusRead(mac18, '2001:db8:1234:5678:5555:6666:7777:8888', '12'),
    ],
  }]
  assert.deepEqual(Object.fromEntries(aggregateStats(pieces, true).machines), { '0.2.18': { windows: 0, mac: 1, linux: 0, other: 0 } })
  const summary = summarizeInstallerDownloads(pieces, [{ rows: [download('XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.zip', '2001:db8:1234:5678:9999::1', '10')] }])
  assert.deepEqual(summary.outcomes.mac, { installed: 1, pending: 0, gone: 0, redownloaded: 0 })
})

test('only the installers the updater downloads are recognised, with their version and platform', () => {
  assert.deepEqual(parseInstallerPath('/xingmang-manager/XingMang-AI-Manager-0.2.18-Setup.exe'), { version: '0.2.18', platform: 'windows' })
  // The released Mac names carry the chip name; versions shipped before the rename kept electron-builder's.
  assert.deepEqual(parseInstallerPath('/xingmang-manager/XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.zip'), { version: '0.2.18', platform: 'mac' })
  assert.deepEqual(parseInstallerPath('/xingmang-manager/XingMang-AI-Manager-0.2.18-Intel-x64.zip'), { version: '0.2.18', platform: 'mac' })
  assert.deepEqual(parseInstallerPath('/xingmang-manager/XingMang-AI-Manager-0.2.14-arm64.zip'), { version: '0.2.14', platform: 'mac' })
  assert.deepEqual(parseInstallerPath('/xingmang-manager/XingMang-AI-Manager-0.2.14-x64.zip'), { version: '0.2.14', platform: 'mac' })
  // The differential download's block maps, hand-downloaded disk images and anything else are not an update download.
  for (const other of [
    '/xingmang-manager/XingMang-AI-Manager-0.2.18-Setup.exe.blockmap',
    '/xingmang-manager/XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.dmg',
    '/xingmang-manager/XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.zip.blockmap',
    '/xingmang-manager/latest.yml',
    '/xingmang-manager/service-status.json',
    '/other/XingMang-AI-Manager-0.2.18-Setup.exe',
    null,
  ]) assert.equal(parseInstallerPath(other), null, other)
})

test('each machine that downloaded the newest installer is followed from its first download hour on', () => {
  const statusPieces = [{
    rows: [
      // installed: read with the new version after downloading.
      statusRead(windows15, 'ip-a', '09'),
      statusRead(windows18, 'ip-a', '11'),
      // gone: its only old-version read is in the download hour, maybe before the download.
      statusRead(windows15, 'ip-b', '10'),
      // pending: still on the old version an hour after downloading.
      statusRead(windows15, 'ip-c', '12'),
      // pending: first download 09, old version read at 10.
      statusRead(windows15, 'ip-d', '10'),
      // pending and downloaded again three hours later: the first one did not finish or pass its checks.
      statusRead(windows15, 'ip-e', '12'),
      // A Mac behind ip-a is another machine; it installed within the download hour.
      statusRead(mac18, 'ip-a', '10'),
      // Never downloaded anything: not part of this section.
      statusRead(windows15, 'ip-z', '12'),
    ],
  }]
  const installerPieces = [{
    rows: [
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-a', '10'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe.blockmap', 'ip-a', '10'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-b', '10'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-c', '10'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-d', '10'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-d', '09'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-e', '08'),
      download('XingMang-AI-Manager-0.2.18-Setup.exe', 'ip-e', '11'),
      download('XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.zip', 'ip-a', '10'),
      // An older version's installer is not the one being followed.
      download('XingMang-AI-Manager-0.2.15-Setup.exe', 'ip-z', '08'),
    ],
  }]
  const summary = summarizeInstallerDownloads(statusPieces, installerPieces)
  assert.deepEqual(summary, {
    version: '0.2.18',
    // ip-d's two downloads are an hour apart, one download crossing the hour; only ip-e went back for it.
    outcomes: { windows: { installed: 1, pending: 3, gone: 1, redownloaded: 1 }, mac: { installed: 1, pending: 0, gone: 0, redownloaded: 0 } },
    sampleInterval: 1,
  })
  assert.equal(JSON.stringify(summary).includes('ip-'), false)
  assert.deepEqual(summarizeInstallerDownloads(statusPieces, []), {
    version: null,
    outcomes: { windows: { installed: 0, pending: 0, gone: 0, redownloaded: 0 }, mac: { installed: 0, pending: 0, gone: 0, redownloaded: 0 } },
    sampleInterval: 1,
  })
})

test('a version other than the newest can be followed, counting a later version as installed too', () => {
  const statusPieces = [{
    rows: [
      // Went from 0.2.19 straight past 0.2.20 to 0.2.21: installed as far as 0.2.20 is concerned.
      statusRead(mac19, 'ip-a', '09'),
      statusRead(mac21, 'ip-a', '12'),
      statusRead(mac19, 'ip-b', '12'),
    ],
  }]
  const installerPieces = [{
    rows: [
      download('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', 'ip-a', '10'),
      download('XingMang-AI-Manager-0.2.21-Apple-Silicon-arm64.zip', 'ip-a', '11'),
      download('XingMang-AI-Manager-0.2.20-Intel-x64.zip', 'ip-b', '10'),
    ],
  }]
  assert.deepEqual(summarizeInstallerDownloads(statusPieces, installerPieces, '0.2.20'), {
    version: '0.2.20',
    outcomes: { windows: { installed: 0, pending: 0, gone: 0, redownloaded: 0 }, mac: { installed: 1, pending: 1, gone: 0, redownloaded: 0 } },
    sampleInterval: 1,
  })
  // Without a version the newest one is followed, as before.
  assert.equal(summarizeInstallerDownloads(statusPieces, installerPieces).version, '0.2.21')
})

test('machines still below the newest version are split by whether they asked for a newer installer at all', () => {
  const statusPieces = [{
    rows: [
      // Downloaded 0.2.20 and is still on 0.2.19: downloaded but not installed.
      statusRead(mac19, 'ip-a', '12'),
      // Never asked for any installer.
      statusRead(mac19, 'ip-b', '12'),
      // Only fetched its own version again: that is not a newer one.
      statusRead(mac19, 'ip-c', '12'),
      // On 0.2.20, has fetched 0.2.21.
      statusRead(mac20, 'ip-d', '12'),
      // Moved from 0.2.19 to 0.2.20 within the window and stopped there: counts at 0.2.20.
      statusRead(mac19, 'ip-f', '09'),
      statusRead(mac20, 'ip-f', '11'),
      // Already on the newest version: not stale.
      statusRead(mac21, 'ip-e', '12'),
      // The Windows machine behind ip-a is another machine; the Mac's download is not its own.
      statusRead(windows19, 'ip-a', '12'),
      // Linux is not released; left out.
      statusRead(linux15, 'ip-g', '12'),
      // Last seen three hours after anything newer than 0.2.19 first went out: had no fair chance to download.
      statusRead(mac19, 'ip-h', '05'),
    ],
  }]
  const installerPieces = [{
    rows: [
      download('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', 'ip-a', '02'),
      download('XingMang-AI-Manager-0.2.19-Apple-Silicon-arm64.zip', 'ip-c', '02'),
      download('XingMang-AI-Manager-0.2.21-Intel-x64.zip', 'ip-d', '03'),
      download('XingMang-AI-Manager-0.2.21-Apple-Silicon-arm64.zip', 'ip-e', '03'),
    ],
  }]
  const manifestPieces = [{
    rows: [
      // ip-b read the Mac manifest after 0.2.20 went out: it saw the new version and did not fetch it.
      // Recorded one in five, so its three reads stand for fifteen.
      { ...download('latest-mac.yml', 'ip-b', '06'), sampleInterval: 5 },
      // ip-c only read it before anything newer than 0.2.19 was out.
      download('latest-mac.yml', 'ip-c', '01'),
      // The Windows manifest read from ip-a belongs to the Windows machine there, not to the Mac.
      download('latest.yml', 'ip-a', '06'),
      // Linux manifests and anything else under the pattern are not a Windows or Mac check.
      download('latest-linux.yml', 'ip-f', '12'),
    ],
  }]
  const stale = summarizeStaleMachines(statusPieces, installerPieces, manifestPieces)
  assert.equal(stale.target, '0.2.21')
  assert.equal(stale.sampleInterval, 1)
  assert.equal(stale.checkSampleInterval, 5)
  // Machines that fetched a newer installer stop checking once it is down, so ip-a and ip-d are left out of the cadence;
  // ip-h counts although it had no chance yet: how often a machine checks has nothing to do with a release.
  assert.deepEqual(stale.cadence, { windows: { statusReads: 4, manifestReads: 3 }, mac: { statusReads: 20, manifestReads: 18 } })
  assert.deepEqual([...stale.versions], [
    ['0.2.19', { windows: { downloaded: 0, missing: 1, checked: 1, estimated: 0 }, mac: { downloaded: 1, missing: 2, checked: 1, estimated: 1 } }],
    ['0.2.20', { windows: { downloaded: 0, missing: 0, checked: 0, estimated: 0 }, mac: { downloaded: 1, missing: 1, checked: 0, estimated: 1 } }],
  ])
  assert.deepEqual(stale.unexposed, { windows: 0, mac: 1 })
  assert.equal(JSON.stringify([...stale.versions]).includes('ip-'), false)
  const nothingDownloaded = summarizeStaleMachines(statusPieces, [])
  assert.equal(nothingDownloaded.target, null)
  assert.equal(nothingDownloaded.versions.size, 0)
})

test('under sampling each machine seen downloading stands for as many as its densest sampled hour implies', () => {
  const statusPieces = [{ rows: [statusRead(mac19, 'ip-a', '12'), statusRead(mac19, 'ip-b', '12'), statusRead(mac21, 'ip-c', '12')] }]
  const sampledDownload = (file, clientIP, hour, sampleInterval) => ({ ...download(file, clientIP, hour), sampleInterval })
  const installerPieces = [{
    rows: [
      // Seen twice, once in an hour recorded 1 in 10 and once 1 in 4: it stands for four.
      sampledDownload('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', 'ip-a', '01', 10),
      sampledDownload('XingMang-AI-Manager-0.2.21-Apple-Silicon-arm64.zip', 'ip-a', '02', 4),
      sampledDownload('XingMang-AI-Manager-0.2.21-Apple-Silicon-arm64.zip', 'ip-c', '02', 10),
    ],
  }]
  const stale = summarizeStaleMachines(statusPieces, installerPieces)
  assert.equal(stale.sampleInterval, 10)
  assert.deepEqual([...stale.versions], [
    ['0.2.19', { windows: { downloaded: 0, missing: 0, checked: 0, estimated: 0 }, mac: { downloaded: 1, missing: 1, checked: 0, estimated: 4 } }],
  ])
})

test('the report follows the two newest versions and shows whether machines left behind ever downloaded, without counts', async () => {
  const hour = (value) => `2026-10-07T${value}:00:00Z`
  const statusRows = [
    // Four Macs stopped on 0.2.19; one of them downloaded 0.2.20.
    hourRow(mac19, '203.0.113.1', hour('20')),
    hourRow(mac19, '203.0.113.2', hour('20')),
    hourRow(mac19, '203.0.113.3', hour('20')),
    hourRow(mac19, '203.0.113.4', hour('20')),
    // A Mac that took 0.2.20.
    hourRow(mac19, '203.0.113.5', hour('12')),
    hourRow(mac20, '203.0.113.5', hour('22')),
    // A Windows machine on 0.2.19 that downloaded 0.2.21.
    hourRow(windows19, '198.51.100.1', hour('22')),
    // A Windows machine last seen an hour after the first newer installer went out: no chance yet, left out of the shares.
    hourRow(windows15, '198.51.100.9', hour('13')),
    // Old versions beyond the rows shown are folded into one.
    ...['0.2.14', '0.2.15', '0.2.17', '0.2.18'].map((version, index) => hourRow(mac15.replace('/0.2.15 ', `/${version} `), `192.0.2.${index + 1}`, hour('20'))),
  ]
  const downloadRows = [
    downloadRow('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', '203.0.113.1', hour('12')),
    downloadRow('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', '203.0.113.5', hour('13')),
    downloadRow('XingMang-AI-Manager-0.2.21-Setup.exe', '198.51.100.1', hour('15')),
    // A third, older version downloaded in the window is not followed in a table of its own.
    downloadRow('XingMang-AI-Manager-0.2.19-Intel-x64.zip', '192.0.2.1', hour('12')),
  ]
  const manifestRows = [
    // One of the three Macs left on 0.2.19 without a download checked after 0.2.20 went out, one only before.
    downloadRow('latest-mac.yml', '203.0.113.2', hour('18')),
    downloadRow('latest-mac.yml', '203.0.113.3', hour('11')),
  ]
  const failedRows = [
    failedRow('latest-mac.yml', 403, 3, 2),
    failedRow('latest-mac.yml', 404, 2),
    failedRow('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', 416, 1),
    failedRow('service-status.json', 403, 2),
    // Other files under the folder are not update requests.
    failedRow('latest-linux.yml', 404, 5),
    failedRow('index.html', 404, 5),
  ]
  const cloudflare = createCloudflare({
    limits: statusCodeSettings,
    groups: (filter) => {
      if (filter.datetime_geq !== '2026-10-07T12:00:00Z') return []
      if (filter.edgeResponseStatus_geq === 400) return failedRows
      if (filter.clientRequestPath_like === '/xingmang-manager/latest%.yml') return manifestRows
      return filter.clientRequestPath_like ? downloadRows : statusRows
    },
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })

  assert.match(report, /### 下过 0\.2\.21 安装包的电脑后来怎样/)
  assert.match(report, /### 下过 0\.2\.20 安装包的电脑后来怎样/)
  assert.doesNotMatch(report, /### 下过 0\.2\.19 安装包/)
  assert.ok(report.indexOf('### 下过 0.2.21') < report.indexOf('### 下过 0.2.20'))
  // The shared reading notes come once, after the tables.
  assert.equal(report.split('「还没装上」里分不出装失败和下好了还没重启').length, 2)

  assert.match(report, /### 还停在旧版本的电脑下过新版没有/)
  assert.match(report, /只算这段时间里最后一次读状态文件时还低于 0\.2\.21、而且有机会下新版的电脑/)
  assert.match(report, /停着的电脑里另有一部分（Windows 50\.0%）最后一次出现时比它新的版本还没出来，或者出来不到 6 小时/)
  assert.match(report, /\| 停在哪个版本 \| Windows 下过新版 \| Windows 没下、查过更新 \| Mac 下过新版 \| Mac 没下、查过更新 \|/)
  assert.match(report, /\| 0\.2\.20 \| - \| - \| 0\.0% \| 0\.0% \|/)
  assert.match(report, /\| 0\.2\.19 \| 100\.0% \| 0\.0% \| 25\.0% \| 25\.0% \|/)
  assert.match(report, /\| 0\.2\.18 \| - \| - \| 0\.0% \| 0\.0% \|/)
  assert.match(report, /\| 0\.2\.17 \| - \| - \| 0\.0% \| 0\.0% \|/)
  // 0.2.14 fetched 0.2.19, which is newer than itself.
  assert.match(report, /\| 0\.2\.15 及更早 \| - \| - \| 50\.0% \| 0\.0% \|/)
  assert.match(report, /\| \*\*合计\*\* \| \*\*100\.0%\*\* \| \*\*0\.0%\*\* \| \*\*22\.2%\*\* \| \*\*11\.1%\*\* \|/)
  assert.match(report, /没下、查过更新：查到了新版却没去下/)
  assert.match(report, /Mac 的安装包、更新清单和状态文件在同一个地址，读得到状态文件就连得上/)
  assert.match(report, /想强制更新（抬最低版本）前先看这一节：强制更新只拦打开了窗口的人/)
  assert.doesNotMatch(report, /更新清单的请求这段时间也是抽样记的/)
  assert.match(report, /\*\*停着的电脑查更新勤不勤\*\*：没下过新版的停着的电脑，每读 100 次状态文件读了几次更新清单（Windows 0\.0 次、Mac 18\.8 次，/)
  // A window shorter than the time since the previous release hides machines that downloaded it earlier and stopped checking.
  assert.match(report, /大约是 8 次。统计开始以前就下好、在等装的电脑也算在这里面（那次下载这里看不到），它们不再查/)
  assert.match(report, /那样的时段里还远少于这个数、下面「更新相关的请求有没有被拒」里清单又没怎么被拒，才说明这些电脑开着却没按时查更新/)
  assert.match(report, /或者统计开始以前就下好了、在等装（那次下载这里看不到，下好以后也不再查）。只看 1 天这种比上一版发出来以后还短的时段，最后这种会占大头/)
  assert.match(report, /Mac 停在旧版本的电脑不到 20 台/)

  // Rejected requests per kind: sampled rows scaled up, the status file's rejections taken out of all its reads.
  assert.match(report, /### 更新相关的请求有没有被拒/)
  assert.match(report, /\| Mac 更新清单（latest-mac\.yml） \| 57\.1% \| 403（75\.0%）、404（25\.0%） \|/)
  assert.match(report, /\| Windows 更新清单（latest\.yml） \| - \| - \|/)
  assert.match(report, /\| Mac 安装包 \| 10\.0% \| 416（100\.0%） \|/)
  assert.match(report, /\| Windows 安装包 \| 0\.0% \| - \|/)
  assert.match(report, /\| 状态文件 \| 4\.2% \| 403（100\.0%） \|/)
  const failed = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body)).filter((payload) => payload.variables.filter.edgeResponseStatus_geq === 400)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].variables.filter.clientRequestPath_like, '/xingmang-manager/%')
  assert.match(failed[0].query, /dimensions \{ clientRequestPath edgeResponseStatus \}/)
  assert.doesNotMatch(failed[0].query, /clientIP/)
  assert.doesNotMatch(report, /203\.0\.113|198\.51\.100|192\.0\.2/)
})

test('a sampled window shows what was seen next to the estimate, capped at every machine, and says which is which', async () => {
  const hour = (value) => `2026-10-07T${value}:00:00Z`
  const sampledRow = (base, sampleInterval) => ({ ...base, avg: { sampleInterval } })
  const statusRows = ['1', '2', '3', '4'].map((last) => hourRow(mac19, `203.0.113.${last}`, hour('20')))
  const downloadRows = [
    sampledRow(downloadRow('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', '203.0.113.1', hour('12')), 10),
    downloadRow('XingMang-AI-Manager-0.2.20-Apple-Silicon-arm64.zip', '203.0.113.2', hour('13')),
  ]
  const manifestRows = [sampledRow(downloadRow('latest-mac.yml', '203.0.113.3', hour('16')), 5)]
  const cloudflare = createCloudflare({
    limits: hourlySettings,
    groups: (filter) => {
      if (filter.datetime_geq !== '2026-10-07T12:00:00Z') return []
      if (filter.clientRequestPath_like === '/xingmang-manager/latest%.yml') return manifestRows
      return filter.clientRequestPath_like ? downloadRows : statusRows
    },
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  // Two of four seen; ten plus one estimated, which cannot be more than the four machines there are.
  assert.match(report, /\| 0\.2\.19 \| - \| - \| 50\.0%（估 100\.0%） \| 25\.0% \|/)
  assert.match(report, /最多每 10 次记 1 次/)
  assert.match(report, /前面那个数是看到的，只能当下限/)
  assert.match(report, /更新清单的请求这段时间也是抽样记的（最多每 5 次记 1 次），「没下、查过更新」只能当下限/)
})

test('the report follows installer downloads by hour and states its scope, still without addresses or counts', async () => {
  const cloudflare = createCloudflare({
    limits: hourlySettings,
    groups: (filter) => {
      if (filter.datetime_geq !== '2026-10-07T12:00:00Z') return []
      if (filter.clientRequestPath_like) {
        return [
          downloadRow('XingMang-AI-Manager-0.2.18-Setup.exe', '203.0.113.7', '2026-10-07T13:00:00Z'),
          downloadRow('XingMang-AI-Manager-0.2.18-Setup.exe', '198.51.100.20', '2026-10-07T13:00:00Z'),
          downloadRow('XingMang-AI-Manager-0.2.18-Intel-x64.zip', '203.0.113.7', '2026-10-07T13:00:00Z'),
        ]
      }
      return [
        hourRow(windows15, '203.0.113.7', '2026-10-07T12:00:00Z'),
        hourRow(windows15, '198.51.100.20', '2026-10-07T15:00:00Z'),
        hourRow(mac15, '203.0.113.7', '2026-10-07T12:00:00Z'),
        hourRow(mac18, '203.0.113.7', '2026-10-07T14:00:00Z'),
      ]
    },
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  const grouped = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body))
  const status = grouped.filter((payload) => payload.variables.filter.clientRequestPath)
  const installers = grouped.filter((payload) => payload.variables.filter.clientRequestPath_like === '/xingmang-manager/XingMang-AI-Manager-%')
  const manifests = grouped.filter((payload) => payload.variables.filter.clientRequestPath_like === '/xingmang-manager/latest%.yml')
  assert.equal(grouped.length, 4)
  assert.equal(status.length, 1)
  assert.equal(installers.length, 1)
  assert.equal(manifests.length, 1)
  assert.equal(manifests[0].variables.filter.edgeResponseStatus_lt, 400)
  assert.equal(manifests[0].variables.filter.datetime_geq, '2026-10-07T12:00:00Z')
  assert.match(manifests[0].query, /dimensions \{ clientRequestPath clientIP datetimeHour \}/)
  assert.match(status[0].query, /dimensions \{ userAgent clientIP datetimeHour \}/)
  assert.equal(installers[0].variables.filter.clientRequestPath_like, '/xingmang-manager/XingMang-AI-Manager-%')
  assert.equal(installers[0].variables.filter.edgeResponseStatus_lt, 400)
  assert.equal(installers[0].variables.filter.datetime_geq, '2026-10-07T12:00:00Z')
  assert.match(installers[0].query, /dimensions \{ clientRequestPath clientIP datetimeHour \}/)

  assert.match(report, /### 口径/)
  assert.match(report, /Mac、Linux：各个版本都从这里读/)
  assert.match(report, /0\.2\.18 起走洛杉矶线路的，更新和状态文件都改从 xm-direct\.solov\.cc 读/)
  assert.match(report, /Windows 一栏里 0\.2\.18 及以后偏低、更早的版本偏高/)
  assert.match(report, /### 下过 0\.2\.18 安装包的电脑后来怎样/)
  assert.match(report, /\| 下完以后 \| Windows \| Mac \|/)
  assert.match(report, /\| 之后以 0\.2\.18 或更高版本读过状态文件（装上了） \| 0\.0% \| 100\.0% \|/)
  assert.match(report, /\| 之后还以旧版本读状态文件（还没装上） \| 50\.0% \| 0\.0% \|/)
  assert.match(report, /\| 之后在这里没再出现 \| 50\.0% \| 0\.0% \|/)
  // Only Windows has a machine still waiting, and it fetched the installer once.
  assert.match(report, /还没装上的里面，隔了两小时以上又下过 0\.2\.18 的（Windows 0\.0%）：/)
  assert.match(report, /Windows 下过的电脑不到 20 台，这一列只能粗看/)
  assert.match(report, /Mac 下过的电脑不到 20 台，这一列只能粗看/)
  assert.match(report, /\| 0\.2\.18 \| 0\.0% \| 33\.3% \| 0\.0% \| \*\*33\.3%\*\* \|/)
  // This zone lists no status code field, so rejected requests are not queried.
  assert.match(report, /这个套餐的 Cloudflare 统计不能按状态码分，这一项没法算/)
  assert.doesNotMatch(report, /203\.0\.113|198\.51\.100/)
  assert.doesNotMatch(report, /\| (?:1|2|3|4) \|/)
})

test('without hourly groups the installer section says it cannot be worked out and nothing extra is queried', async () => {
  const cloudflare = createCloudflare({ groups: () => [row(windows15, 'ip-a')] })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  const grouped = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body))
  // The status file, and the check-ins, which need the path alone.
  assert.equal(grouped.length, 2)
  assert.equal(grouped[0].variables.filter.clientRequestPath, '/xingmang-manager/service-status.json')
  assert.equal(grouped[1].variables.filter.clientRequestPath_like, USAGE_FILTER)
  assert.match(report, /### 下过新版安装包的电脑后来怎样/)
  assert.match(report, /查不到来源 IP、请求路径或小时，这一项没法算/)
})

// The same sample electron/usage-stats.test.ts builds with buildUsageStatsPath: if either side
// renames a code, one of the two tests goes red.
const usageSample = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'usage-stats-path.txt'), 'utf8').trim()

function usagePath({
  day = '20261007', app = '0.2.22', os = 'w11', arch = 'x64', account = 'xm', route = 'a2', auto = '1', update = 'ok',
  tools = 'cc~2.1.310_cx~0_gk~x_gm~0_cdx~0_cd~0_wb~0_oc~0', installs = '0', updates = '0', hangs = '0',
} = {}) {
  return `/xingmang-manager/stats/v1/d-${day}/a-${app}/o-${os}/c-${arch}/k-${account}/r-${route}/u-${auto}/s-${update}/t-${tools}/i-${installs}/f-${updates}/h-${hangs}`
}

function usageRow(clientRequestPath, count = 1, sampleInterval = 1) {
  return { count, avg: { sampleInterval }, dimensions: { clientRequestPath } }
}

test('a daily check-in path decodes field by field, matching the sample the client builds', () => {
  const absent = { seen: false, installed: false, version: null }
  const missing = { seen: true, installed: false, version: null }
  const present = { seen: true, installed: true, version: null }
  assert.deepEqual(parseUsagePath(usageSample), {
    day: '20261027',
    dayStart: Date.parse('2026-10-27T00:00:00Z'),
    app: '0.2.22',
    os: 'w11',
    platform: 'windows',
    arch: 'x64',
    account: 'xm',
    route: 'a2',
    autoUpdate: true,
    update: { state: 'dl', version: '0.2.23' },
    tools: {
      cc: { seen: true, installed: true, version: '2.1.310' },
      cx: missing,
      gk: absent,
      gm: present,
      cdx: missing,
      cd: present,
      wb: absent,
      oc: missing,
    },
    installs: [{ code: 'cc', category: 'net', count: 2 }, { code: 'nd', category: 'mac', count: 1 }],
    updates: [{ code: 'dl', category: 'net', count: 1 }],
    hangs: [{ code: 's', category: null, count: 3 }, { code: 'w', category: null, count: 1 }],
  })
  // Installed with a version the client could not read.
  assert.deepEqual(parseUsagePath(usageSample.replace('cc~2.1.310', 'cc~v')).tools.cc, present)
  // Nothing detected and nothing counted is still a day of use.
  assert.equal(parseUsagePath(usagePath({ app: 'x', os: 'x', arch: 'x', account: 'no', route: 'x', auto: '0', tools: 'cc~x_cx~x_gk~x_gm~x_cdx~x_cd~x_wb~x_oc~x' })).platform, 'other')
})

test('a check-in path with anything outside the vocabulary is not counted at all', () => {
  const variants = [
    usageSample.replace('/v1/', '/v2/'),
    usageSample.replace('d-20261027', 'd-20261332'),
    usageSample.replace('a-0.2.22', 'a-yoyo'),
    usageSample.replace('o-w11', 'o-w12'),
    usageSample.replace('c-x64', 'c-riscv'),
    usageSample.replace('k-xm', 'k-alice'),
    usageSample.replace('r-a2', 'r-a3'),
    usageSample.replace('u-1', 'u-2'),
    usageSample.replace('s-dl~0.2.23', 's-dl~latest'),
    usageSample.replace('cc~2.1.310', 'cc~sk-abc'),
    usageSample.replace('gm~1', 'gm~2'),
    usageSample.replace('_oc~0', ''),
    usageSample.replace('cc~2.1.310_cx~0', 'cx~0_cc~2.1.310'),
    usageSample.replace('i-cc~net~2', 'i-cc~net~100'),
    usageSample.replace('i-cc~net~2', 'i-cc~net~0'),
    usageSample.replace('i-cc~net~2', 'i-zz~net~2'),
    usageSample.replace('i-cc~net~2', 'i-cc~disk~2'),
    usageSample.replace('h-s~3', 'h-s~net~3'),
    usageSample.replace('/f-dl~net~1', ''),
    usageSample.replace('/k-xm/r-a2/', '/r-a2/k-xm/'),
    `${usageSample}/extra`,
    '/xingmang-manager/stats/v1/',
    '/xingmang-manager/service-status.json',
    null,
  ]
  for (const variant of variants) assert.equal(parseUsagePath(variant), null, String(variant))
})

test('the check-in section reads one whole day for shares and every day for rates, without counts', async () => {
  const cloudflare = createCloudflare({
    usage: (filter) => (filter.datetime_geq !== '2026-10-06T12:00:00Z' ? [] : [
      // Three Windows 11 machines seen once under one-in-three sampling.
      usageRow(usagePath(), 1, 3),
      usageRow(usagePath({
        os: 'm15', arch: 'arm64', account: 'api', route: 'a1', auto: '0', update: 'dl~0.2.23',
        tools: 'cc~v_cx~0.164.0_gk~1.0.70_gm~1_cdx~1_cd~0_wb~0_oc~0', installs: 'cx~net~2', hangs: 's~1',
      })),
      usageRow(usagePath({ os: 'w10', account: 'no', route: 'm1', update: 'ff~0.2.23', installs: 'cc~src~1_nd~mac~1', updates: 'ins~oth~1', hangs: 'w~1' })),
      // The day before is only half inside the window: counted in the rates, not in the day's shares.
      usageRow(usagePath({ day: '20261006', os: 'w10', installs: 'cc~net~3' })),
      usageRow('/xingmang-manager/stats/v1/d-20261007/a-hello'),
    ]),
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 2, now, fetchImpl: cloudflare.fetchImpl })
  const section = report.slice(report.indexOf('## 每天打卡（匿名使用统计）'))
  assert.ok(report.indexOf('## 每天打卡（匿名使用统计）') > 0)

  assert.match(section, /### 2026-10-07 这一天的电脑\n/)
  assert.match(section, /\| 0\.2\.22 \| 80\.0% \| 20\.0% \| 0\.0% \| \*\*100\.0%\*\* \|/)
  assert.match(section, /- \*\*系统\*\*：Windows 11 60\.0%、Windows 10 20\.0%、macOS 15 20\.0%\n/)
  assert.match(section, /- \*\*芯片\*\*：x64 80\.0%、arm64 20\.0%\n/)
  assert.match(section, /- \*\*账号\*\*：星芒账号 60\.0%、历史账号 20\.0%、没登录 20\.0%\n/)
  assert.match(section, /- \*\*线路\*\*：自动，正在走线路2 60\.0%、固定线路1 20\.0%、自动，正在走线路1 20\.0%\n/)
  assert.match(section, /- \*\*自动更新\*\*：开着 80\.0%、关了 20\.0%\n/)
  assert.match(section, /- \*\*新版装上没有\*\*：没有下好待装的新版 60\.0%、下好了还没装 0\.2\.23 20\.0%、试着装过、没装上 0\.2\.23 20\.0%（/)
  assert.match(section, /\| Claude Code \| 100\.0% \| 2\.1\.310 80\.0% \|/)
  assert.match(section, /\| Codex \| 20\.0% \| 0\.164\.0 100\.0% \|/)
  // Grok was only detected on the Mac.
  assert.match(section, /\| Grok \| 100\.0% \| 1\.0\.70 100\.0% \|/)
  assert.match(section, /\| Gemini CLI（已下线，老客户留着的） \| 20\.0% \| - \|/)
  assert.match(section, /这一天打卡的电脑不到 20 台/)

  assert.match(section, /\| 什么 \| 合计 \| Windows \| Mac \| 最多的原因 \|/)
  assert.match(section, /\| 装 Claude Code 失败 \| 66\.7 \| 80\.0 \| 0\.0 \| 网络 75\.0%、下载源那边出错 25\.0% \|/)
  assert.match(section, /\| 装 Codex 失败 \| 33\.3 \| 0\.0 \| 200\.0 \| 网络 100\.0% \|/)
  assert.match(section, /\| 装 Node\.js 失败 \| 16\.7 \| 20\.0 \| 0\.0 \| 电脑本身（磁盘、权限、文件被占用） 100\.0% \|/)
  assert.match(section, /\| 装 Python 失败 \| 0\.0 \| 0\.0 \| 0\.0 \| - \|/)
  assert.match(section, /\| 星芒更新：安装失败 \| 16\.7 \| 20\.0 \| 0\.0 \| 其他 100\.0% \|/)
  assert.match(section, /\| 窗口没响应 \| 16\.7 \| 20\.0 \| 0\.0 \| - \|/)
  assert.match(section, /\| 整个界面卡住 2 秒以上 \| 16\.7 \| 0\.0 \| 100\.0 \| - \|/)
  assert.match(section, /打卡加起来不到 20 台·天/)

  assert.match(section, /最多每 3 次记 1 次/)
  assert.match(section, /另有 14\.3% 的打卡地址认不出/)
  assert.match(section, /nginx 原样转发到这里的（服务端 10-17 核过），所以也记在这里/)
  // Public run pages: shares and rates only, never a count of machines or check-ins.
  assert.doesNotMatch(section, /\| (?:1|2|3|4|5|6|7) \|/)
})

test('G06: the newest versions each get their own crash, freeze and update-error rates', async () => {
  const cloudflare = createCloudflare({
    usage: (filter) => (filter.datetime_geq !== '2026-10-06T12:00:00Z' ? [] : [
      // 0.2.23: four machine-days. Each row stands for two identical check-ins, so its
      // counts land twice: two crashes and six freezes between them.
      usageRow(usagePath({ app: '0.2.23', hangs: 'e~1_s~2' }), 2),
      usageRow(usagePath({ app: '0.2.23', hangs: 'w~1' }), 2),
      // 0.2.22: two machine-days, each with one failed update on the way to 0.2.23.
      usageRow(usagePath({ app: '0.2.22', updates: 'dl~net~1' }), 2),
      // Older versions fall off the table once three newer ones are there.
      usageRow(usagePath({ app: '0.2.21' })),
      usageRow(usagePath({ app: '0.2.19', hangs: 'e~5' })),
      // A machine whose version could not be read is not a version of its own.
      usageRow(usagePath({ app: 'x' })),
    ]),
  })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 2, now, fetchImpl: cloudflare.fetchImpl })
  const section = report.slice(report.indexOf('### 每版健康数'))
  assert.ok(report.indexOf('### 每版健康数') > report.indexOf('### 出错和卡住'))
  assert.match(section, /\| 版本 \| 意外退出（闪退） \| 卡住（窗口没响应、界面卡 2 秒以上） \| 星芒更新出错（检查、下载、安装） \| 样本 \|/)
  assert.match(section, /\| 0\.2\.23 \| 50\.0 \| 150\.0 \| 0\.0 \| 不到 20 台·天 \|/)
  assert.match(section, /\| 0\.2\.22 \| 0\.0 \| 0\.0 \| 100\.0 \| 不到 20 台·天 \|/)
  assert.match(section, /\| 0\.2\.21 \| 0\.0 \| 0\.0 \| 0\.0 \| 不到 20 台·天 \|/)
  assert.doesNotMatch(section, /0\.2\.19|\| x \|/)
  assert.ok(section.indexOf('0.2.23') < section.indexOf('0.2.22'))
  assert.match(section, /旧版天然偏高/)
})

test('the check-in section says plainly when there is nothing to read or no way to read it', async () => {
  const empty = createCloudflare()
  assert.match(await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: empty.fetchImpl }), /这段时间没有认得出的打卡记录/)

  // Two half days in a one-day window: the busier one stands in, and says so.
  const halves = createCloudflare({ usage: () => [usageRow(usagePath(), 2), usageRow(usagePath({ day: '20261008' }))] })
  assert.match(await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: halves.fetchImpl }), /### 2026-10-07 这一天的电脑（这段时间没有一个整天，拿记录最多的那天）/)

  const pathless = createCloudflare({ limits: settings({ availableFields: ['count', 'dimensions_userAgent', 'dimensions_clientIP'] }) })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: pathless.fetchImpl })
  assert.match(report, /不能按请求路径分，打卡记录没法数/)
  const grouped = pathless.calls.slice(2).map((call) => JSON.parse(call.init.body))
  assert.equal(grouped.some((payload) => payload.variables.filter.clientRequestPath_like === USAGE_FILTER), false)
})

test('the rollout check reads the check-ins from the moment the new version went out', async () => {
  const cloudflare = createCloudflare({ usage: () => [usageRow(usagePath({ app: '0.2.23' }), 2)] })
  const from = Date.parse('2026-10-07T04:00:20.000Z')
  const { window, usage } = await collectUsageSince({ token: TOKEN, from, now, fetchImpl: cloudflare.fetchImpl })
  assert.equal(window.start, Date.parse('2026-10-07T04:00:00.000Z'))
  assert.equal(window.end, Date.parse('2026-10-08T12:00:00.000Z'))
  // 只查打卡，不查状态文件、安装包那几项。
  const filters = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body).variables.filter)
  assert.ok(filters.length > 0)
  assert.ok(filters.every((filter) => filter.clientRequestPath_like === USAGE_FILTER))
  assert.equal(filters[0].datetime_geq, '2026-10-07T04:00:00Z')
  // 一天多一点分成两段查，桩每段都回同一条。
  assert.equal(usage.records.length, filters.length)
  assert.ok(usage.records.every((record) => record.app === '0.2.23' && record.weight === 2))

  // 发出去比 Cloudflare 留的还早：只查它留着的那一段。
  const old = await collectUsageSince({ token: TOKEN, from: Date.parse('2026-09-01T00:00:00.000Z'), now, fetchImpl: createCloudflare().fetchImpl })
  assert.equal(old.window.clamped, true)
  const pathless = createCloudflare({ limits: settings({ availableFields: ['count', 'dimensions_userAgent', 'dimensions_clientIP'] }) })
  assert.equal((await collectUsageSince({ token: TOKEN, from, now, fetchImpl: pathless.fetchImpl })).usage, null)
})

test('the stats workflow only reads, on demand or once a day, with the read-only analytics token', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'update-feed-stats.yml'), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch'])
  // 北京时间早上 6:17，赶在 7 点的日汇总之前跑完。
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 22 * * *' }])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const [job] = Object.values(workflow.jobs)
  assert.equal(job.if, "${{ github.event_name != 'schedule' || github.repository == 'xufei5620/xingmang-ai-manager' }}")
  // 只读统计，不碰 release 环境：不用等人批准，也拿不到发布凭据。
  assert.equal(job.environment, undefined)
  assert.ok(job['timeout-minutes'] <= 15)
  const source = JSON.stringify(job)
  assert.doesNotMatch(source, /aws s3|R2_|XINGMANG_UPDATE_SIGNING_KEY/)
  const run = job.steps.find((step) => String(step.run || '').includes('scripts/update-feed-stats.cjs'))
  assert.equal(run.env.CLOUDFLARE_ANALYTICS_TOKEN, '${{ secrets.CLOUDFLARE_ANALYTICS_TOKEN }}')
  // 定时运行数 1 天（没有 inputs），手动跑照填的天数。
  assert.equal(run.env.DAYS, "${{ github.event_name == 'schedule' && '1' || inputs.days }}")
  assert.match(run.run, /--days "\$DAYS"/)
  assert.match(run.run, /GITHUB_STEP_SUMMARY/)
})
