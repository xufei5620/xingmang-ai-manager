#!/usr/bin/env node
// 统计各版本的星芒有多少台电脑在用（#28），只在 GitHub Actions 的 update-feed-stats
// 工作流里跑，步骤见 docs/SERVICE-STATUS.md「看各版本有多少人在用」。
//
// 数据从哪来：0.2.10 起客户端打开时和开着的每 15 分钟读一次更新目录上的
// service-status.json。这个请求走 electron-updater 的会话，User-Agent 是 Electron
// 默认那一串，里面带着「星芒AI管理工具/0.2.15 Chrome/… Electron/…」；latest.yml 的
// 请求 UA 是 electron-builder，不带版本，所以只能数状态文件。更新目录挂在 Cloudflare
// 上，这里拿只读的 Analytics 令牌查 GraphQL Analytics API，按 UA 和来源 IP 分组。
//
// 来源 IP 只在内存里拿来去重；仓库公开，任何输出（日志、Job Summary）里都只有按版本
// 和系统汇总后的占比，没有 IP，也没有台数。
//
// 下过新版安装包的电脑后来怎样：自动更新从同一个目录下安装包，按来源 IP 和系统把
// 「哪个小时下的」和「之后读状态文件时是哪个版本」对上，分成装上了、还在旧版、没再出现。
// 0.2.18 起 Windows 走洛杉矶线路时更新和状态文件都改读 xm-direct.solov.cc，Cloudflare
// 看不到，口径写在报告里。
const { compareReleaseVersions } = require('./update-release-utils.cjs')

const API_ORIGIN = 'https://api.cloudflare.com'
const ZONE_NAME = 'shenfengwl.fun'
const STATUS_PATH = '/xingmang-manager/service-status.json'
// 自动更新下的安装包：Windows 是 Setup.exe，Mac 是 zip（dmg 是手动下的）。Mac 发出去的名字带芯片名
// （scripts/macos-artifact-names.cjs），改名之前发的版本是 electron-builder 原名，两种都认。Linux 还没对外发。
const INSTALLER_PATH_PATTERN = '/xingmang-manager/XingMang-AI-Manager-%'
const INSTALLER_PATH = /^\/xingmang-manager\/XingMang-AI-Manager-(\d{1,6}\.\d{1,6}\.\d{1,6})-(Setup\.exe|(?:Apple-Silicon-arm64|Intel-x64|arm64|x64)\.zip)$/
const REQUEST_TIMEOUT_MS = 30 * 1000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_DAYS = 31
const DEFAULT_MAX_DURATION_SECONDS = 24 * 60 * 60
const DEFAULT_PAGE_SIZE = 10000
// 一段时间里的分组条数顶到上限就对半拆开重查；拆到这么短还顶满，说明不是星芒的流量。
const MIN_WINDOW_MS = 10 * 60 * 1000
// Cloudflare 按查询那一刻算「最早能查多久以前」，留几分钟余量免得卡在边上被拒。
const RETENTION_MARGIN_MS = 10 * 60 * 1000
// 电脑少于这么多台时提醒比例只能粗看；只说「不到」，不暴露具体台数。
const SMALL_SAMPLE = 20
const PLATFORMS = [['windows', 'Windows'], ['mac', 'Mac'], ['linux', 'Linux'], ['other', '其他']]

class StatsError extends Error {}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDays(value) {
  const text = String(value ?? '').trim()
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > MAX_DAYS) {
    throw new StatsError(`统计天数要填 1 到 ${MAX_DAYS} 之间的整数`)
  }
  return Number(text)
}

// 令牌只会出现在 Authorization 头里；先挡掉换行之类，免得拼出第二个请求头。
function validateToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new StatsError('仓库 Secrets 里没有 CLOUDFLARE_ANALYTICS_TOKEN，做法见 docs/SERVICE-STATUS.md「看各版本有多少人在用」')
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new StatsError('CLOUDFLARE_ANALYTICS_TOKEN 的格式不对，可能粘贴时多了空格或换行，重新粘一次')
  }
  return token
}

async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new StatsError('Cloudflare API 返回的内容太大')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new StatsError('Cloudflare API 返回的内容太大')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function describeApiErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return ''
  return errors
    .map((entry) => (isRecord(entry) && typeof entry.message === 'string' ? entry.message : ''))
    .filter(Boolean)
    .join('；')
    .slice(0, 500)
}

// 只连 api.cloudflare.com，不跟随重定向：带着令牌被跳去别的主机就等于把令牌交出去。
function createApiClient(token, fetchImpl) {
  async function request(pathname, init) {
    const url = new URL(pathname, API_ORIGIN)
    if (url.origin !== API_ORIGIN) throw new StatsError('只允许请求 Cloudflare API')
    let response
    try {
      response = await fetchImpl(url.href, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...init.headers, accept: 'application/json', authorization: `Bearer ${token}` },
      })
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? '超时' : '网络错误'
      throw new StatsError(`连不上 Cloudflare API（${reason}），过几分钟重跑`)
    }
    const text = await readBoundedText(response)
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new StatsError(`Cloudflare API 返回的不是 JSON（HTTP ${response.status}）`)
    }
    if (response.status === 401 || response.status === 403) {
      const detail = isRecord(body) ? describeApiErrors(body.errors) : ''
      throw new StatsError(`令牌被 Cloudflare 拒绝（HTTP ${response.status}${detail ? `：${detail}` : ''}）。看看令牌是不是过期或被删了，权限要有 Zone / Analytics / Read 和 Zone / Zone / Read`)
    }
    if (!response.ok || !isRecord(body)) {
      const detail = isRecord(body) ? describeApiErrors(body.errors) : ''
      throw new StatsError(`Cloudflare API 出错（HTTP ${response.status}${detail ? `：${detail}` : ''}）`)
    }
    return body
  }

  return {
    get(pathname) {
      return request(pathname, { method: 'GET', headers: {} })
    },
    post(pathname, payload) {
      return request(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    },
  }
}

async function resolveZoneId(client) {
  const body = await client.get(`/client/v4/zones?name=${encodeURIComponent(ZONE_NAME)}`)
  if (body.success === false) throw new StatsError(`Cloudflare 没列出域名：${describeApiErrors(body.errors) || '没给原因'}`)
  const zones = Array.isArray(body.result) ? body.result : []
  const zone = zones.find((entry) => isRecord(entry) && entry.name === ZONE_NAME)
  // 令牌缺 Zone / Zone / Read 时 Cloudflare 不报错，只回一个空列表。
  if (!zone) throw new StatsError(`令牌看不到 ${ZONE_NAME} 这个域名。去 Cloudflare 编辑这个令牌：权限里要有 Zone / Zone / Read（只有 Zone / Analytics / Read 不够），Zone Resources 要选 ${ZONE_NAME}`)
  if (typeof zone.id !== 'string' || !/^[0-9a-f]{32}$/.test(zone.id)) throw new StatsError('Cloudflare 返回的域名编号格式不对')
  return zone.id
}

async function queryGraphql(client, query, variables) {
  const body = await client.post('/client/v4/graphql', { query, variables })
  const detail = describeApiErrors(body.errors)
  if (detail) throw new StatsError(`Cloudflare 统计接口拒绝了这次查询：${detail}`)
  const zones = isRecord(body.data) && isRecord(body.data.viewer) ? body.data.viewer.zones : null
  if (!Array.isArray(zones) || !isRecord(zones[0])) throw new StatsError('Cloudflare 统计接口没返回这个域名的数据，令牌要有 Zone / Analytics / Read')
  return zones[0]
}

const SETTINGS_QUERY = `query ($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        httpRequestsAdaptiveGroups { enabled maxDuration notOlderThan maxPageSize availableFields }
      }
    }
  }
}`

// Cloudflare 把可用字段写成 dimensions_userAgent 这样，前缀是字段所在的分组。
function hasField(fields, name) {
  return fields.some((field) => typeof field === 'string' && (field === name || field.endsWith(`_${name}`) || field.endsWith(`.${name}`)))
}

// 套餐不同，能查多久以前、一次能查多长、能按哪些字段分组都不一样（免费版尤其短），
// 每次都先问 Cloudflare，而不是在这里写死。
async function readDatasetLimits(client, zoneTag) {
  const zone = await queryGraphql(client, SETTINGS_QUERY, { zoneTag })
  const settings = isRecord(zone.settings) ? zone.settings.httpRequestsAdaptiveGroups : null
  if (!isRecord(settings)) throw new StatsError('Cloudflare 没告诉这个域名的统计能查多久，没法往下查')
  if (settings.enabled === false) throw new StatsError('这个域名的套餐不提供按请求分组的统计，版本分布查不了')
  const fields = Array.isArray(settings.availableFields) ? settings.availableFields : null
  if (fields && !hasField(fields, 'userAgent')) {
    // 字段名是 Cloudflare 的统计口径，不含任何访问数据；列出来才知道这个套餐还能按什么分。
    throw new StatsError(`这个域名的套餐不能按 User-Agent 分组，版本分布查不了。这个套餐能用的字段：${fields.filter((field) => typeof field === 'string').join(', ').slice(0, 3000)}`)
  }
  if (!Number.isSafeInteger(settings.notOlderThan) || settings.notOlderThan <= 0) throw new StatsError('Cloudflare 没告诉这个域名的统计能查多久以前')
  const maxDuration = Number.isSafeInteger(settings.maxDuration) && settings.maxDuration > 0 ? settings.maxDuration : DEFAULT_MAX_DURATION_SECONDS
  const pageSize = Number.isSafeInteger(settings.maxPageSize) && settings.maxPageSize > 0 ? Math.min(settings.maxPageSize, DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  return {
    notOlderThanMs: settings.notOlderThan * 1000,
    maxDurationMs: maxDuration * 1000,
    pageSize,
    withIp: !fields || hasField(fields, 'clientIP'),
    withHour: !fields || hasField(fields, 'datetimeHour'),
    withPath: !fields || hasField(fields, 'clientRequestPath'),
  }
}

// 统计结束在这一分钟的开头，往前推 days 天；比 Cloudflare 留的更早的部分截掉。
function planWindow(now, days, limits) {
  const end = Math.floor(now.getTime() / 60000) * 60000
  const earliest = now.getTime() - limits.notOlderThanMs + RETENTION_MARGIN_MS
  const requested = end - days * 24 * 60 * 60 * 1000
  const start = Math.max(requested, Math.ceil(earliest / 60000) * 60000)
  if (start >= end) throw new StatsError('Cloudflare 留的统计太短，查不出任何一段')
  const pieces = []
  for (let from = start; from < end; from += limits.maxDurationMs) pieces.push({ start: from, end: Math.min(from + limits.maxDurationMs, end) })
  return { start, end, clamped: start > requested, pieces }
}

function formatApiTime(milliseconds) {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function buildGroupsQuery(pageSize, dimensions) {
  return `query ($zoneTag: string, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(limit: ${pageSize}, filter: $filter) {
        count
        avg { sampleInterval }
        dimensions { ${dimensions.join(' ')} }
      }
    }
  }
}`
}

function parseGroupRows(zone, dimensionNames) {
  const groups = zone.httpRequestsAdaptiveGroups
  if (!Array.isArray(groups)) throw new StatsError('Cloudflare 统计接口返回的分组格式不对')
  return groups.map((group) => {
    const dimensions = isRecord(group) && isRecord(group.dimensions) ? group.dimensions : null
    if (!dimensions || !Number.isSafeInteger(group.count) || group.count < 0 || dimensionNames.some((name) => typeof dimensions[name] !== 'string')) {
      throw new StatsError('Cloudflare 统计接口返回的分组格式不对')
    }
    const time = dimensionNames.includes('datetimeHour') ? Date.parse(dimensions.datetimeHour) : null
    if (Number.isNaN(time)) throw new StatsError('Cloudflare 统计接口返回的分组格式不对')
    const sampleInterval = isRecord(group.avg) && typeof group.avg.sampleInterval === 'number' && group.avg.sampleInterval >= 1 ? group.avg.sampleInterval : 1
    return {
      count: group.count,
      sampleInterval,
      userAgent: dimensions.userAgent ?? null,
      clientIP: dimensions.clientIP ?? null,
      path: dimensions.clientRequestPath ?? null,
      time,
    }
  })
}

function statusQuery(limits) {
  return {
    label: '状态文件',
    filter: { clientRequestPath: STATUS_PATH },
    dimensions: ['userAgent', ...(limits.withIp ? ['clientIP'] : []), ...(limits.withIp && limits.withHour ? ['datetimeHour'] : [])],
  }
}

// 要对上「哪台电脑下过」，非得有来源 IP、请求路径和小时；套餐给不全就不查这一项。
function installerQuery(limits) {
  if (!limits.withIp || !limits.withHour || !limits.withPath) return null
  return {
    label: '安装包',
    filter: { clientRequestPath_like: INSTALLER_PATH_PATTERN, edgeResponseStatus_lt: 400 },
    dimensions: ['clientRequestPath', 'clientIP', 'datetimeHour'],
  }
}

async function queryPiece(client, zoneTag, limits, piece, spec) {
  const filter = { datetime_geq: formatApiTime(piece.start), datetime_lt: formatApiTime(piece.end), ...spec.filter }
  const zone = await queryGraphql(client, buildGroupsQuery(limits.pageSize, spec.dimensions), { zoneTag, filter })
  const rows = parseGroupRows(zone, spec.dimensions)
  if (rows.length < limits.pageSize) return [{ ...piece, rows }]
  // 分组顶到上限说明这一段没取全，对半拆开分别查，保持时间先后。
  const span = piece.end - piece.start
  if (span <= MIN_WINDOW_MS) throw new StatsError(`${formatApiTime(piece.start)} 起十分钟里${spec.label}的请求就超过 ${limits.pageSize} 组，不像是星芒客户端，先去 Cloudflare 后台看看`)
  const middle = piece.start + Math.floor(span / 2 / 60000) * 60000
  return [
    ...await queryPiece(client, zoneTag, limits, { start: piece.start, end: middle }, spec),
    ...await queryPiece(client, zoneTag, limits, { start: middle, end: piece.end }, spec),
  ]
}

function platformOf(userAgent) {
  if (/Windows NT/.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'mac'
  if (/Linux/.test(userAgent)) return 'linux'
  return 'other'
}

// 匹配 Electron 默认 UA 里「产品名/版本 Chrome/… Electron/…」那一段。产品名是中文，
// 经过 Cloudflare 记录后编码不一定原样，所以只认它后面的版本号和 Chrome、Electron。
function classifyUserAgent(userAgent) {
  const match = /\/(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?) Chrome\/[\d.]+ Electron\/[\d.]+/.exec(userAgent)
  return match ? { version: match[1], platform: platformOf(userAgent) } : null
}

// 一台电脑的 IPv6 临时地址隔一阵就换（系统的隐私扩展），同一台前后两次请求的地址常常不同；
// 网段前 64 位在同一个网络里不变。所以 IPv6 按 /64 网段算一个出口，和 IPv4 一个公网地址算一个出口
// 是同样的口径：同一个出口后面的几台电脑算一台。
function networkOf(address) {
  if (typeof address !== 'string' || !address.includes(':')) return address
  const mappedIpv4 = /^(?:0{0,4}:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address.replace(/^::/, '0:'))
  if (mappedIpv4) return mappedIpv4[1]
  const [head, tail = null] = address.toLowerCase().split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const groups = tail === null ? headGroups : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

function machineKey(platform, address) {
  return `${platform}\n${networkOf(address)}`
}

// 有小时就按小时排先后；没有就按所在那一段排（pieces 本来就按时间先后）。
function readTime(row, piece, index) {
  if (Number.isFinite(row.time)) return row.time
  return Number.isFinite(piece.start) ? piece.start : index
}

/**
 * pieces 必须按时间先后排好。每台电脑（来源 IP + 系统）只算它最后出现的那个小时（查不到
 * 小时就是那一段）里的版本；同一时间里出现两个版本取高的那个（多半是这时候升了级）。
 * 返回值里没有 IP。
 */
function aggregateStats(pieces, withIp) {
  const latest = new Map()
  const requests = new Map()
  let unrecognized = 0
  let sampleInterval = 1
  pieces.forEach((piece, index) => {
    for (const row of piece.rows) {
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      const client = classifyUserAgent(row.userAgent)
      if (!client) {
        unrecognized += row.count
        continue
      }
      requests.set(client.version, (requests.get(client.version) || 0) + row.count)
      if (!withIp) continue
      const key = machineKey(client.platform, row.clientIP)
      const time = readTime(row, piece, index)
      const previous = latest.get(key)
      if (!previous || time > previous.time || (time === previous.time && compareReleaseVersions(client.version, previous.version) > 0)) {
        latest.set(key, { ...client, time })
      }
    }
  })
  const machines = new Map()
  for (const client of latest.values()) {
    const counts = machines.get(client.version) || { windows: 0, mac: 0, linux: 0, other: 0 }
    counts[client.platform] += 1
    machines.set(client.version, counts)
  }
  return { withIp, machines, requests, unrecognized, sampleInterval }
}

function parseInstallerPath(path) {
  const match = typeof path === 'string' ? INSTALLER_PATH.exec(path) : null
  return match ? { version: match[1], platform: match[2] === 'Setup.exe' ? 'windows' : 'mac' } : null
}

/**
 * 只看这段时间里被下过的最高版本。每台电脑（来源 IP + 系统）从它第一次下那个小时往后看：
 * 那之后以这个版本（或更高）读过状态文件算装上了；没有，但晚于那个小时还以旧版本读过，算还没装上；
 * 都没有就是没再出现。返回值里只有各系统的台数，没有 IP。
 */
function summarizeInstallerDownloads(statusPieces, installerPieces) {
  let version = null
  let sampleInterval = 1
  const downloads = []
  for (const piece of installerPieces) {
    for (const row of piece.rows) {
      const installer = parseInstallerPath(row.path)
      if (!installer || !Number.isFinite(row.time)) continue
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      downloads.push({ ...installer, key: machineKey(installer.platform, row.clientIP), time: row.time })
      if (!version || compareReleaseVersions(installer.version, version) > 0) version = installer.version
    }
  }
  const downloadedAt = new Map()
  for (const download of downloads) {
    if (download.version !== version) continue
    const previous = downloadedAt.get(download.key)
    if (previous === undefined || download.time < previous) downloadedAt.set(download.key, download.time)
  }
  const installed = new Set()
  const pending = new Set()
  for (const piece of statusPieces) {
    for (const row of piece.rows) {
      const client = classifyUserAgent(row.userAgent)
      if (!client || !Number.isFinite(row.time)) continue
      const key = machineKey(client.platform, row.clientIP)
      const downloaded = downloadedAt.get(key)
      if (downloaded === undefined) continue
      if (compareReleaseVersions(client.version, version) >= 0) {
        if (row.time >= downloaded) installed.add(key)
      } else if (row.time > downloaded) {
        // 和下载同一个小时里的旧版本请求可能发生在下载之前，不算。
        pending.add(key)
      }
    }
  }
  const outcomes = { windows: { installed: 0, pending: 0, gone: 0 }, mac: { installed: 0, pending: 0, gone: 0 } }
  for (const key of downloadedAt.keys()) {
    const outcome = installed.has(key) ? 'installed' : pending.has(key) ? 'pending' : 'gone'
    outcomes[key.slice(0, key.indexOf('\n'))][outcome] += 1
  }
  return { version, outcomes, sampleInterval }
}

function formatBeijingTime(milliseconds) {
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function formatShare(part, total) {
  return total ? `${(part * 100 / total).toFixed(1)}%` : '-'
}

function sortVersionsDescending(versions) {
  return [...versions].sort((left, right) => compareReleaseVersions(right, left))
}

// 仓库是公开的，运行页和摘要页谁都能看，所以只写占比，不写台数和请求次数：
// 台数等于告诉别人星芒有多少客户。
function renderMachineTable(machines) {
  const columns = PLATFORMS.filter(([id]) => id !== 'other' || [...machines.values()].some((counts) => counts.other > 0))
  const totals = { windows: 0, mac: 0, linux: 0, other: 0 }
  let total = 0
  for (const counts of machines.values()) {
    for (const [id] of PLATFORMS) totals[id] += counts[id]
    total += counts.windows + counts.mac + counts.linux + counts.other
  }
  const lines = [
    `| 版本 | ${columns.map(([, label]) => label).join(' | ')} | 合计 |`,
    `|---|${columns.map(() => '---:').join('|')}|---:|`,
  ]
  for (const version of sortVersionsDescending(machines.keys())) {
    const counts = machines.get(version)
    const sum = counts.windows + counts.mac + counts.linux + counts.other
    lines.push(`| ${version} | ${columns.map(([id]) => formatShare(counts[id], total)).join(' | ')} | **${formatShare(sum, total)}** |`)
  }
  lines.push(`| **合计** | ${columns.map(([id]) => `**${formatShare(totals[id], total)}**`).join(' | ')} | **100%** |`)
  return { lines, total }
}

function renderRequestTable(requests) {
  const total = [...requests.values()].reduce((sum, count) => sum + count, 0)
  const lines = ['| 版本 | 占比 |', '|---|---:|']
  for (const version of sortVersionsDescending(requests.keys())) {
    lines.push(`| ${version} | ${formatShare(requests.get(version), total)} |`)
  }
  return lines
}

// 比例是占同一个系统里下过的电脑，不写台数。
function renderInstallerSection(downloads) {
  const lines = ['', `### 下过${downloads?.version ? ` ${downloads.version} ` : '新版'}安装包的电脑后来怎样`, '']
  if (!downloads) {
    lines.push('这个套餐的 Cloudflare 统计查不到来源 IP、请求路径或小时，这一项没法算。')
    return lines
  }
  if (!downloads.version) {
    lines.push('这段时间没有电脑从这里下过安装包。')
    return lines
  }
  const columns = [['windows', 'Windows'], ['mac', 'Mac']]
  const outcomes = [
    ['installed', `之后以 ${downloads.version} 读过状态文件（装上了）`],
    ['pending', '之后还以旧版本读状态文件（还没装上）'],
    ['gone', '之后在这里没再出现'],
  ]
  const totals = Object.fromEntries(columns.map(([id]) => [id, outcomes.reduce((sum, [outcome]) => sum + downloads.outcomes[id][outcome], 0)]))
  lines.push(
    `只算这段时间里从这里下过 ${downloads.version} 安装包的电脑（Windows 的 Setup.exe、Mac 的 zip，自动更新下的就是这两个），`
      + '同一台下了几次算一次，从它第一次下的那个小时往后看。每格是占同一个系统里下过的电脑的比例。',
    '',
    `| 下完以后 | ${columns.map(([, label]) => label).join(' | ')} |`,
    `|---|${columns.map(() => '---:').join('|')}|`,
  )
  for (const [outcome, label] of outcomes) {
    lines.push(`| ${label} | ${columns.map(([id]) => formatShare(downloads.outcomes[id][outcome], totals[id])).join(' | ')} |`)
  }
  lines.push(
    '',
    '- 「还没装上」里分不出装失败和下好了还没重启。0.2.18 以前的版本要客户自己点「重启安装」才装。',
    '- Windows「没再出现」的，可能是装好后改走洛杉矶线路、从 xm-direct.solov.cc 读了（0.2.18 起），也可能只是关了星芒没再开，这里分不开。',
    '- Mac 的更新不走洛杉矶，「没再出现」就是之后没再开星芒。拿 Mac 这一格当「关了没再开」的大概比例，'
      + 'Windows 那一格多出来的，大致就是装好后改走洛杉矶的（推测）。',
  )
  for (const [id, label] of columns) {
    if (totals[id] > 0 && totals[id] < SMALL_SAMPLE) lines.push(`- ${label} 下过的电脑不到 ${SMALL_SAMPLE} 台，这一列只能粗看。`)
  }
  if (downloads.sampleInterval > 1) lines.push('- Cloudflare 这段时间是抽样记录的，一台电脑只下一次的请求可能漏记，这一节的偏差比上面大。')
  return lines
}

// 0.2.18 起 Windows 走洛杉矶线路时，更新和状态文件都改读 xm-direct.solov.cc（electron/update-feed-route.ts，
// 只限 win32），Cloudflare 这边看不到它们。结论要带着这个口径读，所以每次都写在报告里。
function renderScope(stats) {
  const lines = ['', '### 口径', '']
  lines.push('- 数的是 updatesnew.shenfengwl.fun 上 service-status.json 的请求：星芒一打开读一次，开着时每 15 分钟读一次，请求里带着自己的版本号。这段时间一次都没开过星芒的电脑不在里面。')
  lines.push('- Mac、Linux：各个版本都从这里读（直连那份更新目录只给 Windows），数字可信。')
  lines.push('- Windows：0.2.18 以前的正式版都从这里读。0.2.18 起走洛杉矶线路的，更新和状态文件都改从 xm-direct.solov.cc 读，只在服务端日志里；走 CF 线路的照常数得到。'
    + '所以 Windows 一栏 0.2.18 及以后偏低；它们升级前读的那一次还算在旧版本上，旧版本偏高。偏多少这里算不出来，要服务端按同样的办法数 xm-direct 的日志。')
  lines.push('- 0.2.8、0.2.9 不读更新状态文件。')
  if (stats.sampleInterval > 1) lines.push(`- Cloudflare 这段时间的统计是抽样的（最多每 ${Math.round(stats.sampleInterval)} 次记 1 次），比例有误差。`)
  return lines
}

function renderReport(stats, window, limits, days, downloads = null) {
  const lines = ['## 星芒各版本的占比', '']
  const covered = (window.end - window.start) / (24 * 60 * 60 * 1000)
  lines.push(`统计时段：北京时间 ${formatBeijingTime(window.start)} 至 ${formatBeijingTime(window.end)}（${Number.isInteger(covered) ? covered : covered.toFixed(1)} 天）`)
  if (window.clamped) lines.push('', `Cloudflare 只留了最近 ${(limits.notOlderThanMs / (24 * 60 * 60 * 1000)).toFixed(1)} 天的统计，要的 ${days} 天查不全，只统计了上面这一段。`)
  lines.push('')
  if (!stats.requests.size) {
    lines.push('这段时间没有星芒客户端读过更新状态文件。')
  } else if (stats.withIp) {
    const table = renderMachineTable(stats.machines)
    lines.push('按电脑算（每格是占全部电脑的比例）：', '', ...table.lines, '')
    lines.push('电脑按「来源 IP + 系统」去重（IPv6 按 /64 网段），每台只算它这段时间里最后一次读更新状态文件时的版本。同一个网络出口下的几台电脑只算一台，换过网络的电脑会算成几台，比例会有些偏差。')
    lines.push('', 'Windows 一栏里 0.2.18 及以后偏低、更早的版本偏高，原因见下面「口径」。')
    if (table.total < SMALL_SAMPLE) lines.push('', `这段时间读到的电脑不到 ${SMALL_SAMPLE} 台，比例只能粗看。`)
  } else {
    lines.push('这个套餐的 Cloudflare 统计查不到来源 IP，没法按电脑去重，只有下面按请求算的占比。')
  }
  lines.push(...renderScope(stats))
  lines.push(...renderInstallerSection(downloads))
  if (stats.requests.size) {
    lines.push('', '### 按请求算', '', ...renderRequestTable(stats.requests), '')
    lines.push('开着的星芒每 15 分钟读一次，一直不关的电脑分量重，这张表只用来对照。')
  }
  const recognized = [...stats.requests.values()].reduce((sum, count) => sum + count, 0)
  if (stats.unrecognized) lines.push('', `另有 ${formatShare(stats.unrecognized, recognized + stats.unrecognized)} 的请求看不出版本（浏览器直接打开、爬虫等），没算进上面的表。`)
  return `${lines.join('\n')}\n`
}

async function queryWindow(client, zoneTag, limits, window, spec) {
  const pieces = []
  for (const piece of window.pieces) pieces.push(...await queryPiece(client, zoneTag, limits, piece, spec))
  return pieces
}

async function collectUpdateFeedStats({ token, days, now = new Date(), fetchImpl = fetch }) {
  const client = createApiClient(validateToken(token), fetchImpl)
  const zoneTag = await resolveZoneId(client)
  const limits = await readDatasetLimits(client, zoneTag)
  const window = planWindow(now, days, limits)
  const pieces = await queryWindow(client, zoneTag, limits, window, statusQuery(limits))
  const installers = installerQuery(limits)
  const downloads = installers ? summarizeInstallerDownloads(pieces, await queryWindow(client, zoneTag, limits, window, installers)) : null
  return renderReport(aggregateStats(pieces, limits.withIp), window, limits, days, downloads)
}

function parseArguments(argv) {
  if (argv.length === 0) return {}
  if (argv.length === 2 && argv[0] === '--days') return { days: argv[1] }
  throw new StatsError('用法：update-feed-stats.cjs [--days 1~31]（令牌从环境变量 CLOUDFLARE_ANALYTICS_TOKEN 读）')
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const options = parseArguments(process.argv.slice(2))
      return collectUpdateFeedStats({ token: process.env.CLOUDFLARE_ANALYTICS_TOKEN, days: parseDays(options.days ?? '7') })
    })
    .then((report) => process.stdout.write(report))
    .catch((error) => {
      console.error(`::error::${error instanceof StatsError ? error.message : '统计失败（脚本自身出错），看上面的日志'}`)
      if (!(error instanceof StatsError)) console.error(error)
      process.exit(1)
    })
}

module.exports = {
  StatsError,
  aggregateStats,
  classifyUserAgent,
  collectUpdateFeedStats,
  parseDays,
  networkOf,
  parseInstallerPath,
  planWindow,
  renderReport,
  summarizeInstallerDownloads,
}
