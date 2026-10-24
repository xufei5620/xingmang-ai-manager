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
  networkOf,
  parseDays,
  parseInstallerPath,
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
  assert.deepEqual(summary.outcomes.mac, { installed: 1, pending: 0, gone: 0 })
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
      download('XingMang-AI-Manager-0.2.18-Apple-Silicon-arm64.zip', 'ip-a', '10'),
      // An older version's installer is not the one being followed.
      download('XingMang-AI-Manager-0.2.15-Setup.exe', 'ip-z', '08'),
    ],
  }]
  const summary = summarizeInstallerDownloads(statusPieces, installerPieces)
  assert.deepEqual(summary, {
    version: '0.2.18',
    outcomes: { windows: { installed: 1, pending: 2, gone: 1 }, mac: { installed: 1, pending: 0, gone: 0 } },
    sampleInterval: 1,
  })
  assert.equal(JSON.stringify(summary).includes('ip-'), false)
  assert.deepEqual(summarizeInstallerDownloads(statusPieces, []), {
    version: null,
    outcomes: { windows: { installed: 0, pending: 0, gone: 0 }, mac: { installed: 0, pending: 0, gone: 0 } },
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
    outcomes: { windows: { installed: 0, pending: 0, gone: 0 }, mac: { installed: 1, pending: 1, gone: 0 } },
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
      download('latest-mac.yml', 'ip-b', '06'),
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
  assert.equal(stale.checkSampleInterval, 1)
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
  const cloudflare = createCloudflare({
    limits: hourlySettings,
    groups: (filter) => {
      if (filter.datetime_geq !== '2026-10-07T12:00:00Z') return []
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
  assert.match(report, /Mac 停在旧版本的电脑不到 20 台/)
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
  assert.equal(grouped.length, 3)
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
  assert.match(report, /Windows 下过的电脑不到 20 台，这一列只能粗看/)
  assert.match(report, /Mac 下过的电脑不到 20 台，这一列只能粗看/)
  assert.match(report, /\| 0\.2\.18 \| 0\.0% \| 33\.3% \| 0\.0% \| \*\*33\.3%\*\* \|/)
  assert.doesNotMatch(report, /203\.0\.113|198\.51\.100/)
  assert.doesNotMatch(report, /\| (?:1|2|3|4) \|/)
})

test('without hourly groups the installer section says it cannot be worked out and nothing extra is queried', async () => {
  const cloudflare = createCloudflare({ groups: () => [row(windows15, 'ip-a')] })
  const report = await collectUpdateFeedStats({ token: TOKEN, days: 1, now, fetchImpl: cloudflare.fetchImpl })
  const grouped = cloudflare.calls.slice(2).map((call) => JSON.parse(call.init.body))
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].variables.filter.clientRequestPath, '/xingmang-manager/service-status.json')
  assert.match(report, /### 下过新版安装包的电脑后来怎样/)
  assert.match(report, /查不到来源 IP、请求路径或小时，这一项没法算/)
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
