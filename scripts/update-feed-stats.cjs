#!/usr/bin/env node
// 统计各版本的星芒有多少台电脑在用（#28），只在 GitHub Actions 的 update-feed-stats
// 工作流里跑，步骤见 docs/SERVICE-STATUS.md「看各版本有多少人在用」。
//
// 数据从哪来：0.2.10 起客户端打开时和开着的每 15 分钟读一次更新目录上的
// service-status.json。这个请求走 electron-updater 的会话，User-Agent 是 Electron
// 默认那一串，里面带着「星芒AI管理工具/0.2.15 Chrome/… Electron/…」；latest.yml 的
// 请求 UA 是 electron-builder，不带版本，所以版本只能数状态文件，更新清单只拿来按来源 IP
// 看一台电脑新版出来以后查过更新没有。更新目录挂在 Cloudflare
// 上，这里拿只读的 Analytics 令牌查 GraphQL Analytics API，按 UA 和来源 IP 分组。
//
// 来源 IP 只在内存里拿来去重；仓库公开，任何输出（日志、Job Summary）里都只有按版本
// 和系统汇总后的占比，没有 IP，也没有台数。
//
// 下过新版安装包的电脑后来怎样：自动更新从同一个目录下安装包，按来源 IP 和系统把
// 「哪个小时下的」和「之后读状态文件时是哪个版本」对上，分成装上了、还在旧版、没再出现。
// 0.2.18 起 Windows 走洛杉矶线路时更新和状态文件都改读 xm-direct.solov.cc，Cloudflare
// 看不到，口径写在报告里。
//
// 每天打卡（匿名使用统计）：0.2.23 起开着这一项的客户端每天最多发成一条，内容整个写在更新目录 stats/
// 下面的地址里（electron/usage-stats.ts），一天一条就是一台电脑。这一项不查 IP，只按地址分；
// Windows 走洛杉矶线路的也先发到这里，补上面数不到的那一块。
const { compareReleaseVersions } = require('./update-release-utils.cjs')

const API_ORIGIN = 'https://api.cloudflare.com'
const ZONE_NAME = 'shenfengwl.fun'
const STATUS_PATH = '/xingmang-manager/service-status.json'
// 自动更新下的安装包：Windows 是 Setup.exe，Mac 是 zip（dmg 是手动下的）。Mac 发出去的名字带芯片名
// （scripts/macos-artifact-names.cjs），改名之前发的版本是 electron-builder 原名，两种都认。Linux 还没对外发。
const INSTALLER_PATH_PATTERN = '/xingmang-manager/XingMang-AI-Manager-%'
const INSTALLER_PATH = /^\/xingmang-manager\/XingMang-AI-Manager-(\d{1,6}\.\d{1,6}\.\d{1,6})-(Setup\.exe|(?:Apple-Silicon-arm64|Intel-x64|arm64|x64)\.zip)$/
// electron-updater 每次查更新都先读更新清单：Windows 是 latest.yml，Mac 是 latest-mac.yml。
const MANIFEST_PATH_PATTERN = '/xingmang-manager/latest%.yml'
const MANIFEST_PATH = /^\/xingmang-manager\/latest(-mac)?\.yml$/
// 每天打卡（匿名使用统计，electron/usage-stats.ts 的 buildUsageStatsPath）：0.2.23 起的星芒开着这项时
// 每天最多发成一条，内容整个写在地址里。下面几张缩写表和那边一一对应，改一边要改另一边；
// 两边的测试都读 scripts/fixtures/usage-stats-path.txt 这份样例，对不上当场就红。
const USAGE_PATH_PATTERN = '/xingmang-manager/stats/v1/%'
const USAGE_PATH_PREFIX = '/xingmang-manager/stats/v1/'
const USAGE_SEGMENT_LETTERS = ['d', 'a', 'o', 'c', 'k', 'r', 'u', 's', 't', 'i', 'f', 'h']
const USAGE_APP_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,30})?$/
const USAGE_TOOL_VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.]{1,30})?$/
const USAGE_INSTALL_TARGETS = [
  ['cc', 'Claude Code'], ['cx', 'Codex'], ['gk', 'Grok'], ['cdx', 'Codex 桌面端'], ['cd', 'Claude 桌面端'],
  ['wb', 'WorkBuddy'], ['oc', 'OpenCode'], ['nd', 'Node.js'], ['gt', 'Git'], ['py', 'Python'],
]
const USAGE_UPDATE_STEPS = [['chk', '星芒更新：检查失败'], ['dl', '星芒更新：下载失败'], ['ins', '星芒更新：安装失败']]
const USAGE_HANGS = [
  ['w', '窗口没响应'], ['s', '整个界面卡住 2 秒以上'], ['ps', '付款页 10 秒以上才打开'], ['pf', '付款页没打开'], ['e', '上次意外退出（闪退）'],
]
const USAGE_CATEGORIES = [['mac', '电脑本身（磁盘、权限、文件被占用）'], ['crt', '安全证书'], ['net', '网络'], ['src', '下载源那边出错'], ['oth', '其他']]
const USAGE_TOOLS = [
  ['cc', 'Claude Code', 'version'], ['cx', 'Codex', 'version'], ['gk', 'Grok', 'version'], ['gm', 'Gemini CLI（已下线，老客户留着的）', 'flag'],
  ['cdx', 'Codex 桌面端', 'flag'], ['cd', 'Claude 桌面端', 'flag'], ['wb', 'WorkBuddy', 'flag'], ['oc', 'OpenCode', 'flag'],
]
const USAGE_ACCOUNTS = [['xm', '星芒账号'], ['api', '历史账号'], ['no', '没登录']]
const USAGE_ROUTES = [['a2', '自动，正在走线路2'], ['a1', '自动，正在走线路1'], ['m2', '固定线路2'], ['m1', '固定线路1'], ['x', '看不出']]
const USAGE_ARCHES = [['x64', 'x64'], ['arm64', 'arm64'], ['ia32', '32 位'], ['x', '看不出']]
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
    withStatus: !fields || hasField(fields, 'edgeResponseStatus'),
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

// 状态码 Cloudflare 给的是数字，别的维度都是字符串。
function validDimension(name, value) {
  return name === 'edgeResponseStatus' ? Number.isSafeInteger(value) && value >= 100 && value <= 599 : typeof value === 'string'
}

function parseGroupRows(zone, dimensionNames) {
  const groups = zone.httpRequestsAdaptiveGroups
  if (!Array.isArray(groups)) throw new StatsError('Cloudflare 统计接口返回的分组格式不对')
  return groups.map((group) => {
    const dimensions = isRecord(group) && isRecord(group.dimensions) ? group.dimensions : null
    if (!dimensions || !Number.isSafeInteger(group.count) || group.count < 0 || dimensionNames.some((name) => !validDimension(name, dimensions[name]))) {
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
      status: dimensions.edgeResponseStatus ?? null,
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

// 和安装包一样要来源 IP、路径和小时才对得上电脑，只在查安装包的时候一起查。
function manifestQuery() {
  return {
    label: '更新清单',
    filter: { clientRequestPath_like: MANIFEST_PATH_PATTERN, edgeResponseStatus_lt: 400 },
    dimensions: ['clientRequestPath', 'clientIP', 'datetimeHour'],
  }
}

// 被拒的请求（状态码 400 以上）只按路径和状态码分：不用对上电脑，不带 IP。上面两项只数没被拒的，
// Mac 查更新时要是被这边拒了，在那里就成了「没见查过」，得在这里看。每天打卡的地址（stats/ 下面）
// 本来就是 404，也会落进这一项，按路径认不出是哪类更新请求，直接跳过。
function failedRequestQuery() {
  return {
    label: '被拒的请求',
    filter: { clientRequestPath_like: '/xingmang-manager/%', edgeResponseStatus_geq: 400 },
    dimensions: ['clientRequestPath', 'edgeResponseStatus'],
  }
}

// 每天打卡只按地址分：内容整个在地址里，一台电脑一天一条，不用 IP 也不用小时。
function usageQuery(limits) {
  if (!limits.withPath) return null
  return {
    label: '每天打卡',
    filter: { clientRequestPath_like: USAGE_PATH_PATTERN },
    dimensions: ['clientRequestPath'],
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
 * 键里有 IP，只在脚本里用，不往外交。
 */
function latestClientPerMachine(pieces) {
  const latest = new Map()
  pieces.forEach((piece, index) => {
    for (const row of piece.rows) {
      const client = classifyUserAgent(row.userAgent)
      if (!client) continue
      const key = machineKey(client.platform, row.clientIP)
      const time = readTime(row, piece, index)
      const previous = latest.get(key)
      if (!previous || time > previous.time || (time === previous.time && compareReleaseVersions(client.version, previous.version) > 0)) {
        latest.set(key, { ...client, time })
      }
    }
  })
  return latest
}

/** 按电脑的版本分布（规则见 latestClientPerMachine）和按请求的版本分布。返回值里没有 IP。 */
function aggregateStats(pieces, withIp) {
  const requests = new Map()
  let unrecognized = 0
  let sampleInterval = 1
  for (const piece of pieces) {
    for (const row of piece.rows) {
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      const client = classifyUserAgent(row.userAgent)
      if (!client) {
        unrecognized += row.count
        continue
      }
      requests.set(client.version, (requests.get(client.version) || 0) + row.count)
    }
  }
  const machines = new Map()
  if (withIp) {
    for (const client of latestClientPerMachine(pieces).values()) {
      const counts = machines.get(client.version) || { windows: 0, mac: 0, linux: 0, other: 0 }
      counts[client.platform] += 1
      machines.set(client.version, counts)
    }
  }
  return { withIp, machines, requests, unrecognized, sampleInterval }
}

function parseInstallerPath(path) {
  const match = typeof path === 'string' ? INSTALLER_PATH.exec(path) : null
  return match ? { version: match[1], platform: match[2] === 'Setup.exe' ? 'windows' : 'mac' } : null
}

function readInstallerDownloads(installerPieces) {
  let sampleInterval = 1
  const downloads = []
  for (const piece of installerPieces) {
    for (const row of piece.rows) {
      const installer = parseInstallerPath(row.path)
      if (!installer || !Number.isFinite(row.time)) continue
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      downloads.push({ ...installer, key: machineKey(installer.platform, row.clientIP), time: row.time, sampleInterval: row.sampleInterval })
    }
  }
  return { downloads, sampleInterval }
}

function parseManifestPath(path) {
  const match = typeof path === 'string' ? MANIFEST_PATH.exec(path) : null
  return match ? { platform: match[1] ? 'mac' : 'windows' } : null
}

/**
 * 每台电脑（来源 IP + 系统）最后一次读更新清单的那个小时，和按抽样倍数折算的读了几次（estimated）。
 * 键里有 IP，只在脚本里用。
 */
function readManifestChecks(manifestPieces) {
  let sampleInterval = 1
  const latest = new Map()
  const estimated = new Map()
  for (const piece of manifestPieces) {
    for (const row of piece.rows) {
      const manifest = parseManifestPath(row.path)
      if (!manifest || !Number.isFinite(row.time)) continue
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      const key = machineKey(manifest.platform, row.clientIP)
      const seen = latest.get(key)
      if (seen === undefined || row.time > seen) latest.set(key, row.time)
      estimated.set(key, (estimated.get(key) || 0) + row.count * row.sampleInterval)
    }
  }
  return { latest, estimated, sampleInterval }
}

/** 每台电脑这段时间读状态文件的次数，按抽样倍数折算。键里有 IP，只在脚本里用。 */
function estimateStatusReads(statusPieces) {
  const reads = new Map()
  for (const piece of statusPieces) {
    for (const row of piece.rows) {
      const client = classifyUserAgent(row.userAgent)
      if (!client) continue
      const key = machineKey(client.platform, row.clientIP)
      reads.set(key, (reads.get(key) || 0) + row.count * row.sampleInterval)
    }
  }
  return reads
}

/** 这段时间里被下过的版本，新的在前。 */
function downloadedVersions(installerPieces) {
  return sortVersionsDescending(new Set(readInstallerDownloads(installerPieces).downloads.map((download) => download.version)))
}

// 下好以后星芒不再定时查（electron/main.ts 里 downloaded 阶段跳过例行检查），重开时用缓存里那份、也不再下。
// 同一台隔了这么久又下同一版，多半是上一次没下完或没过校验，回头重下的（推测）。一次下载跨了整点不算。
const REDOWNLOAD_GAP_MS = 2 * 60 * 60 * 1000

/**
 * 看这段时间里被下过的某一版（缺省是最高的那版）。每台电脑（来源 IP + 系统）从它第一次下那个小时往后看：
 * 那之后以这个版本（或更高）读过状态文件算装上了；没有，但晚于那个小时还以旧版本读过，算还没装上；
 * 都没有就是没再出现。还没装上的里面，隔了两小时以上又下过这一版的另记 redownloaded。
 * 返回值里只有各系统的台数，没有 IP。
 */
function summarizeInstallerDownloads(statusPieces, installerPieces, followed = undefined) {
  const { downloads, sampleInterval } = readInstallerDownloads(installerPieces)
  const version = followed === undefined ? sortVersionsDescending(new Set(downloads.map((download) => download.version)))[0] ?? null : followed
  const downloadedAt = new Map()
  const lastDownloadedAt = new Map()
  for (const download of downloads) {
    if (download.version !== version) continue
    const previous = downloadedAt.get(download.key)
    if (previous === undefined || download.time < previous) downloadedAt.set(download.key, download.time)
    const last = lastDownloadedAt.get(download.key)
    if (last === undefined || download.time > last) lastDownloadedAt.set(download.key, download.time)
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
  const outcomes = {
    windows: { installed: 0, pending: 0, gone: 0, redownloaded: 0 },
    mac: { installed: 0, pending: 0, gone: 0, redownloaded: 0 },
  }
  for (const [key, first] of downloadedAt) {
    const outcome = installed.has(key) ? 'installed' : pending.has(key) ? 'pending' : 'gone'
    const platform = key.slice(0, key.indexOf('\n'))
    outcomes[platform][outcome] += 1
    if (outcome === 'pending' && lastDownloadedAt.get(key) - first >= REDOWNLOAD_GAP_MS) outcomes[platform].redownloaded += 1
  }
  return { version, outcomes, sampleInterval }
}

// 开着的星芒每 3 小时查一次更新（electron/main.ts 的 updateCheckIntervalMs）。比它新的版本第一次被人下到以后，
// 它又开了这么久（两轮检查，加上下载的时间）还没下，才算「有机会下却没下」。
const DOWNLOAD_CHANCE_MS = 6 * 60 * 60 * 1000

/**
 * 最后一次读状态文件时还低于这段时间里最新那版的电脑，这段时间里从这里请求过比它自己新的安装包没有。
 * 「下过还停着」是下了没装上（或没下完），「没下过」是根本没去下或下不到；两种的办法不一样，
 * 要不要强制更新先看这个。只按系统和它停在的版本汇总，返回值里没有 IP。
 *
 * 统计时段往往比新版本发出来的时间长：新版还没出（或刚出）时就最后一次出现的电脑没机会下，
 * 算进「没下过」会把下载不通说得比实际严重，单独记在 unexposed 里，不进比例。哪个版本什么时候
 * 「出来」的，按这段时间里第一次有人下到它的那个小时算。
 *
 * 没下过的再看新版出来以后读过更新清单没有（checked）：读过就是查到了新版却没去下（多半关了「自动更新」），
 * 没读过就是开着的时候还没轮到查（或者查的那次没被记下）。
 *
 * Cloudflare 忙的时候抽样记（一次请求只有 1/sampleInterval 的机会被记下），一台只请求一两次
 * 安装包的多半漏记，看到的「下过」只是下限。estimated 把看到的每台按它那几次里最密的抽样
 * 倍数算成几台（一台只请求一次时正好不偏；请求好几次时会估高），和看到的一起给个范围。
 */
function summarizeStaleMachines(statusPieces, installerPieces, manifestPieces = []) {
  const { downloads, sampleInterval } = readInstallerDownloads(installerPieces)
  const checks = readManifestChecks(manifestPieces)
  const byMachine = new Map()
  const firstDownloaded = new Map()
  let target = null
  for (const download of downloads) {
    const list = byMachine.get(download.key) || []
    list.push(download)
    byMachine.set(download.key, list)
    const first = firstDownloaded.get(download.version)
    if (first === undefined || download.time < first) firstDownloaded.set(download.version, download.time)
    if (!target || compareReleaseVersions(download.version, target) > 0) target = download.version
  }
  const versions = new Map()
  const unexposed = { windows: 0, mac: 0 }
  const checkSampleInterval = checks.sampleInterval
  const statusReads = estimateStatusReads(statusPieces)
  const cadence = { windows: { statusReads: 0, manifestReads: 0 }, mac: { statusReads: 0, manifestReads: 0 } }
  if (!target) return { target, versions, unexposed, cadence, sampleInterval, checkSampleInterval }
  for (const [key, client] of latestClientPerMachine(statusPieces)) {
    if (client.platform !== 'windows' && client.platform !== 'mac') continue
    if (compareReleaseVersions(client.version, target) >= 0) continue
    const newer = (byMachine.get(key) || []).filter((download) => compareReleaseVersions(download.version, client.version) > 0)
    // 只看没下过新版的：下好以后星芒就不再定时查，算进来会把数拉低。还没机会下的也算，查得勤不勤和有没有新版无关。
    if (!newer.length) {
      cadence[client.platform].statusReads += statusReads.get(key) || 0
      cadence[client.platform].manifestReads += checks.estimated.get(key) || 0
    }
    const newerOut = newer.length ? null : Math.min(...[...firstDownloaded]
      .filter(([version]) => compareReleaseVersions(version, client.version) > 0)
      .map(([, time]) => time))
    if (newerOut !== null && client.time < newerOut + DOWNLOAD_CHANCE_MS) {
      unexposed[client.platform] += 1
      continue
    }
    const counts = versions.get(client.version) || {
      windows: { downloaded: 0, missing: 0, checked: 0, estimated: 0 },
      mac: { downloaded: 0, missing: 0, checked: 0, estimated: 0 },
    }
    if (newer.length) {
      counts[client.platform].downloaded += 1
      counts[client.platform].estimated += Math.min(...newer.map((download) => download.sampleInterval))
    } else {
      counts[client.platform].missing += 1
      if (checks.latest.get(key) >= newerOut) counts[client.platform].checked += 1
    }
    versions.set(client.version, counts)
  }
  return { target, versions, unexposed, cadence, sampleInterval, checkSampleInterval }
}

// 最新那版刚发出去时大多还没轮到检查，只看它看不出装没装得上，所以连前一版一起看。
const FOLLOWED_VERSIONS = 2

const REQUEST_KINDS = [
  ['macManifest', 'Mac 更新清单（latest-mac.yml）'],
  ['windowsManifest', 'Windows 更新清单（latest.yml）'],
  ['macInstaller', 'Mac 安装包'],
  ['windowsInstaller', 'Windows 安装包'],
  ['status', '状态文件'],
]

function requestKind(path) {
  if (path === STATUS_PATH) return 'status'
  const manifest = parseManifestPath(path)
  if (manifest) return `${manifest.platform}Manifest`
  const installer = parseInstallerPath(path)
  return installer ? `${installer.platform}Installer` : null
}

/**
 * 更新相关的几类请求各被拒了多少（状态码 400 以上），按抽样倍数折算。没被拒的那部分来自前面几次查询：
 * 安装包和更新清单只查了没被拒的；状态文件不分状态码全查了，被拒的要从里面减掉。只有次数，没有 IP。
 */
function summarizeFailedRequests(statusPieces, installerPieces, manifestPieces, failedPieces) {
  const kinds = Object.fromEntries(REQUEST_KINDS.map(([id]) => [id, { ok: 0, failed: 0, codes: new Map() }]))
  for (const piece of failedPieces) {
    for (const row of piece.rows) {
      const kind = requestKind(row.path)
      if (!kind) continue
      const estimate = row.count * row.sampleInterval
      kinds[kind].failed += estimate
      kinds[kind].codes.set(row.status, (kinds[kind].codes.get(row.status) || 0) + estimate)
    }
  }
  for (const piece of [...installerPieces, ...manifestPieces]) {
    for (const row of piece.rows) {
      const kind = requestKind(row.path)
      if (kind) kinds[kind].ok += row.count * row.sampleInterval
    }
  }
  let statusReads = 0
  for (const piece of statusPieces) {
    for (const row of piece.rows) statusReads += row.count * row.sampleInterval
  }
  kinds.status.ok = Math.max(0, statusReads - kinds.status.failed)
  return kinds
}

function summarizeUpdateDownloads(statusPieces, installerPieces, manifestPieces = [], failedPieces = null) {
  return {
    followed: downloadedVersions(installerPieces)
      .slice(0, FOLLOWED_VERSIONS)
      .map((version) => summarizeInstallerDownloads(statusPieces, installerPieces, version)),
    stale: summarizeStaleMachines(statusPieces, installerPieces, manifestPieces),
    failures: failedPieces ? summarizeFailedRequests(statusPieces, installerPieces, manifestPieces, failedPieces) : null,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function codesOf(table) {
  return new Set(table.map(([code]) => code))
}

const USAGE_INSTALL_CODES = codesOf(USAGE_INSTALL_TARGETS)
const USAGE_STEP_CODES = codesOf(USAGE_UPDATE_STEPS)
const USAGE_HANG_CODES = codesOf(USAGE_HANGS)
const USAGE_CATEGORY_CODES = codesOf(USAGE_CATEGORIES)

// 日期按 UTC：客户端按 UTC 分天，Cloudflare 也是。
function parseUsageDay(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!match) return null
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return new Date(start).toISOString().slice(0, 10).replaceAll('-', '') === value ? start : null
}

// 「代号~原因~次数」或「代号~次数」用 _ 连起来，0 是一项都没有。次数是 1 到 99。
function parseUsageCounts(value, codes, withCategory) {
  if (value === '0') return []
  const items = []
  for (const item of value.split('_')) {
    const parts = item.split('~')
    if (parts.length !== (withCategory ? 3 : 2)) return null
    const category = withCategory ? parts[1] : null
    const count = parts[parts.length - 1]
    if (!codes.has(parts[0]) || (withCategory && !USAGE_CATEGORY_CODES.has(category)) || !/^[1-9]\d?$/.test(count)) return null
    items.push({ code: parts[0], category, count: Number(count) })
  }
  return items
}

// 版本号；0 = 没装；v = 装了但读不出版本；x = 这次没检测到。桌面端只有 1 / 0 / x。
function parseUsageTools(value) {
  const items = value.split('_')
  if (items.length !== USAGE_TOOLS.length) return null
  const tools = {}
  for (const [index, [code, , kind]] of USAGE_TOOLS.entries()) {
    const separator = items[index].indexOf('~')
    if (separator < 0 || items[index].slice(0, separator) !== code) return null
    const token = items[index].slice(separator + 1)
    if (token === 'x') tools[code] = { seen: false, installed: false, version: null }
    else if (token === '0') tools[code] = { seen: true, installed: false, version: null }
    else if (kind === 'flag' ? token === '1' : token === 'v') tools[code] = { seen: true, installed: true, version: null }
    else if (kind === 'version' && USAGE_TOOL_VERSION.test(token)) tools[code] = { seen: true, installed: true, version: token }
    else return null
  }
  return tools
}

// ok = 没有下好待装的新版；dl~版本 = 下好了还没装；ff~版本 = 试着装过、没装上。
function parseUsageUpdate(value) {
  if (value === 'ok') return { state: 'ok', version: null }
  const match = /^(dl|ff)~(.+)$/.exec(value)
  if (!match || (match[2] !== 'x' && !USAGE_APP_VERSION.test(match[2]))) return null
  return { state: match[1], version: match[2] === 'x' ? null : match[2] }
}

function usagePlatformOf(os) {
  if (/^w/.test(os)) return 'windows'
  if (/^m/.test(os)) return 'mac'
  return os === 'lx' ? 'linux' : 'other'
}

/**
 * 认一条打卡地址，认不出（段数、顺序、哪一个值不在缩写表里）就是 null。地址谁都能请求，
 * 所以每一段都按缩写表或版本号的样子严格认，认不出的整条不算，不会有别的字混进报告。
 */
function parseUsagePath(path) {
  if (typeof path !== 'string' || !path.startsWith(USAGE_PATH_PREFIX) || path.length > 1500) return null
  const segments = path.slice(USAGE_PATH_PREFIX.length).split('/')
  if (segments.length !== USAGE_SEGMENT_LETTERS.length) return null
  const values = {}
  for (const [index, letter] of USAGE_SEGMENT_LETTERS.entries()) {
    if (!segments[index].startsWith(`${letter}-`)) return null
    values[letter] = segments[index].slice(2)
  }
  const dayStart = parseUsageDay(values.d)
  const app = values.a === 'x' ? null : values.a
  const update = parseUsageUpdate(values.s)
  const tools = parseUsageTools(values.t)
  const installs = parseUsageCounts(values.i, USAGE_INSTALL_CODES, true)
  const updates = parseUsageCounts(values.f, USAGE_STEP_CODES, true)
  const hangs = parseUsageCounts(values.h, USAGE_HANG_CODES, false)
  if (
    dayStart === null
    || (app !== null && !USAGE_APP_VERSION.test(app))
    || !/^(?:w10|w11|wx|m\d{1,2}|mx|lx|x)$/.test(values.o)
    || !codesOf(USAGE_ARCHES).has(values.c)
    || !codesOf(USAGE_ACCOUNTS).has(values.k)
    || !codesOf(USAGE_ROUTES).has(values.r)
    || !/^[01]$/.test(values.u)
    || !update || !tools || !installs || !updates || !hangs
  ) return null
  return {
    day: values.d,
    dayStart,
    app,
    os: values.o,
    platform: usagePlatformOf(values.o),
    arch: values.c,
    account: values.k,
    route: values.r,
    autoUpdate: values.u === '1',
    update,
    tools,
    installs,
    updates,
    hangs,
  }
}

/**
 * 拿哪一天看「这一天的电脑」：统计时段里最后一个整天（UTC）；一个整天都没有（只统计 1 天、
 * 跨了两个半天）就拿记录最多的那天。
 */
function pickUsageDay(records, window) {
  const weights = new Map()
  for (const record of records) weights.set(record.day, (weights.get(record.day) || 0) + record.weight)
  const starts = new Map(records.map((record) => [record.day, record.dayStart]))
  const complete = [...weights.keys()]
    .filter((day) => starts.get(day) >= window.start && starts.get(day) + DAY_MS <= window.end)
    .sort()
  if (complete.length) return { day: complete[complete.length - 1], complete: true }
  const busiest = [...weights].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? 1 : -1))[0]
  return busiest ? { day: busiest[0], complete: false } : null
}

/** 每条打卡按抽样倍数折算成几台·天（weight）。返回值里只有认出来的打卡内容，没有 IP（本来也没查）。 */
function summarizeUsage(usagePieces, window) {
  const records = []
  let unrecognized = 0
  let sampleInterval = 1
  for (const piece of usagePieces) {
    for (const row of piece.rows) {
      const weight = row.count * row.sampleInterval
      sampleInterval = Math.max(sampleInterval, row.sampleInterval)
      const record = parseUsagePath(row.path)
      if (record) records.push({ ...record, weight })
      else unrecognized += weight
    }
  }
  return { records, unrecognized, sampleInterval, day: pickUsageDay(records, window) }
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

const DOWNLOAD_COLUMNS = [['windows', 'Windows'], ['mac', 'Mac']]

// 比例是占同一个系统里下过的电脑，不写台数。
function renderInstallerTable(summary) {
  const outcomes = [
    ['installed', `之后以 ${summary.version} 或更高版本读过状态文件（装上了）`],
    ['pending', '之后还以旧版本读状态文件（还没装上）'],
    ['gone', '之后在这里没再出现'],
  ]
  const totals = Object.fromEntries(DOWNLOAD_COLUMNS.map(([id]) => [id, outcomes.reduce((sum, [outcome]) => sum + summary.outcomes[id][outcome], 0)]))
  const lines = [
    '',
    `### 下过 ${summary.version} 安装包的电脑后来怎样`,
    '',
    `只算这段时间里从这里下过 ${summary.version} 安装包的电脑（Windows 的 Setup.exe、Mac 的 zip，自动更新下的就是这两个），`
      + '同一台下了几次算一次，从它第一次下的那个小时往后看。每格是占同一个系统里下过的电脑的比例。',
    '',
    `| 下完以后 | ${DOWNLOAD_COLUMNS.map(([, label]) => label).join(' | ')} |`,
    `|---|${DOWNLOAD_COLUMNS.map(() => '---:').join('|')}|`,
  ]
  for (const [outcome, label] of outcomes) {
    lines.push(`| ${label} | ${DOWNLOAD_COLUMNS.map(([id]) => formatShare(summary.outcomes[id][outcome], totals[id])).join(' | ')} |`)
  }
  const redownloaded = DOWNLOAD_COLUMNS
    .filter(([id]) => summary.outcomes[id].pending > 0)
    .map(([id, label]) => `${label} ${formatShare(summary.outcomes[id].redownloaded, summary.outcomes[id].pending)}`)
  if (redownloaded.length) {
    lines.push(
      '',
      `还没装上的里面，隔了两小时以上又下过 ${summary.version} 的（${redownloaded.join('、')}）：下好以后星芒不再定时查、重开也用下好的那份，`
        + '回头重下多半是上一次没下完或没过校验（推测）；其余的是下好了在等退出或重开。',
    )
  }
  const small = DOWNLOAD_COLUMNS.filter(([id]) => totals[id] > 0 && totals[id] < SMALL_SAMPLE)
  if (small.length) lines.push('', ...small.map(([, label]) => `- ${label} 下过的电脑不到 ${SMALL_SAMPLE} 台，这一列只能粗看。`))
  return lines
}

// 开着时状态文件 15 分钟读一次（electron/service-status.ts），更新 3 小时查一次（electron/main.ts），
// 每次查更新前还会补读一次状态文件：3 小时里大约 13 次状态文件对 1 次更新清单。
const EXPECTED_CHECKS_PER_100_STATUS_READS = 8

// 停过的版本多了表太长：最近的几个版本单列，更早的并成一行。
const STALE_VERSION_ROWS = 4

// 每格是这一行、这个系统里停着的电脑下过新版、或者没下但查过更新的比例，不写台数。
function renderStaleSection(stale) {
  const lines = ['', '### 还停在旧版本的电脑下过新版没有', '']
  const unexposedReason = '最后一次出现时比它新的版本还没出来，或者出来不到 6 小时（开着的星芒 3 小时查一次更新），没机会下'
  if (!stale.versions.size) {
    lines.push(`这段时间读过状态文件的电脑，最后一次读时都已经是 ${stale.target} 或更高，或者${unexposedReason}。`)
    return lines
  }
  const versions = sortVersionsDescending(stale.versions.keys())
  const rows = versions.slice(0, STALE_VERSION_ROWS).map((version) => [version, stale.versions.get(version)])
  function empty() {
    return { windows: { downloaded: 0, missing: 0, checked: 0, estimated: 0 }, mac: { downloaded: 0, missing: 0, checked: 0, estimated: 0 } }
  }
  function addInto(sum, counts) {
    for (const [id] of DOWNLOAD_COLUMNS) {
      for (const field of ['downloaded', 'missing', 'checked', 'estimated']) sum[id][field] += counts[id][field]
    }
    return sum
  }
  if (versions.length > STALE_VERSION_ROWS) {
    const older = versions.slice(STALE_VERSION_ROWS).reduce((sum, version) => addInto(sum, stale.versions.get(version)), empty())
    rows.push([`${versions[STALE_VERSION_ROWS]} 及更早`, older])
  }
  const total = [...stale.versions.values()].reduce(addInto, empty())
  const sampled = stale.sampleInterval > 1
  function cell(counts, id) {
    const machines = counts[id].downloaded + counts[id].missing
    const seen = formatShare(counts[id].downloaded, machines)
    return sampled && machines ? `${seen}（估 ${formatShare(Math.min(counts[id].estimated, machines), machines)}）` : seen
  }
  function cells(counts) {
    return DOWNLOAD_COLUMNS.flatMap(([id]) => [cell(counts, id), formatShare(counts[id].checked, counts[id].downloaded + counts[id].missing)])
  }
  lines.push(
    `只算这段时间里最后一次读状态文件时还低于 ${stale.target}、而且有机会下新版的电脑。「下过新版」是这段时间从这里请求过`
      + '比自己新的安装包（Windows 的 Setup.exe、Mac 的 zip，下没下完都算）；「没下、查过更新」是一次都没请求过安装包，'
      + '但新版出来以后读过更新清单（Windows 的 latest.yml、Mac 的 latest-mac.yml），也就是查到了新版却没去下。'
      + '每格是占这一行、这个系统里的电脑的比例，剩下的是新版出来以后既没下、也没见它查过更新。',
  )
  const unexposed = DOWNLOAD_COLUMNS
    .filter(([id]) => stale.unexposed[id] > 0)
    .map(([id, label]) => `${label} ${formatShare(stale.unexposed[id], stale.unexposed[id] + total[id].downloaded + total[id].missing)}`)
  if (unexposed.length) lines.push('', `停着的电脑里另有一部分（${unexposed.join('、')}）${unexposedReason}，没算进表里。`)
  if (sampled) {
    lines.push(
      '',
      `**这段时间 Cloudflare 是抽样记的（最多每 ${Math.round(stale.sampleInterval)} 次记 1 次）**：一台只请求一两次安装包的多半漏记，`
        + '所以前面那个数是看到的，只能当下限；括号里把看到的每台按那个小时的抽样倍数算成几台，是估出来的，一台请求了好几次时会估高。'
        + '实际在两个数之间。',
    )
  }
  if (stale.checkSampleInterval > 1) {
    lines.push(
      '',
      `更新清单的请求这段时间也是抽样记的（最多每 ${Math.round(stale.checkSampleInterval)} 次记 1 次），「没下、查过更新」只能当下限。`,
    )
  }
  const columns = DOWNLOAD_COLUMNS.flatMap(([, label]) => [`${label} 下过新版`, `${label} 没下、查过更新`])
  lines.push(
    '',
    `| 停在哪个版本 | ${columns.join(' | ')} |`,
    `|---|${columns.map(() => '---:').join('|')}|`,
  )
  for (const [label, counts] of rows) lines.push(`| ${label} | ${cells(counts).join(' | ')} |`)
  lines.push(`| **合计** | ${cells(total).map((value) => `**${value}**`).join(' | ')} |`)
  lines.push(
    '',
    '- 下过还停着：下了没装上，或者没下完，这里分不开。自动更新下好以后要等退出星芒、或者下次打开时才装，点关闭缩到托盘（Mac 是菜单栏）不算退出。',
    '- 没下、查过更新：查到了新版却没去下。多半是关了「自动更新」（关了只提示、不下），也可能是查完以后出了错（推测）。',
    '- 没下、也没见查过：新版出来以后还没轮到查，查的那次没被抽样记下，或者统计开始以前就下好了、在等装'
      + '（那次下载这里看不到，下好以后也不再查）。只看 1 天这种比上一版发出来以后还短的时段，最后这种会占大头，'
      + '看这一项要选从上一版发出来以前开始的时段（一般 7 天够）。下面「查更新勤不勤」那句能帮着分。'
      + '合盖睡着不耽误：Electron 主进程的定时按真实时间走，醒来时已经过了 3 小时的，十几分钟内就会补查（读代码推断）。',
    '- Mac 的安装包、更新清单和状态文件在同一个地址，读得到状态文件就连得上，Mac「没下过」不是一开始就连不上（下到一半断了的算「下过」）。'
      + 'Windows 走洛杉矶线路的从 xm-direct.solov.cc 查更新、下安装包，这里看不到，Windows 几列偏低。',
    '- 想强制更新（抬最低版本）前先看这一节：强制更新只拦打开了窗口的人，拦住时点「立即更新」会当场下载并装上；'
      + '窗口一直缩着、没去开的照旧停着。',
  )
  const cadence = DOWNLOAD_COLUMNS
    .filter(([id]) => stale.cadence[id].statusReads > 0)
    .map(([id, label]) => `${label} ${(stale.cadence[id].manifestReads * 100 / stale.cadence[id].statusReads).toFixed(1)} 次`)
  if (cadence.length) {
    lines.push(
      '',
      `**停着的电脑查更新勤不勤**：没下过新版的停着的电脑，每读 100 次状态文件读了几次更新清单（${cadence.join('、')}，`
        + `都按抽样倍数折算）。照代码，开着的星芒每 15 分钟读一次状态文件、每 3 小时查一次更新，大约是 ${EXPECTED_CHECKS_PER_100_STATUS_READS} 次。`
        + '统计开始以前就下好、在等装的电脑也算在这里面（那次下载这里看不到），它们不再查，'
        + '时段比上一版发出来以后还短时（比如只看 1 天）这个数会低很多，所以这一项也要看从上一版发出来以前开始的时段。'
        + '那样的时段里还远少于这个数、下面「更新相关的请求有没有被拒」里清单又没怎么被拒，才说明这些电脑开着却没按时查更新，'
        + '「没下、也没见查过」不是抽样漏记。',
    )
  }
  for (const [id, label] of DOWNLOAD_COLUMNS) {
    const machines = total[id].downloaded + total[id].missing
    if (machines > 0 && machines < SMALL_SAMPLE) lines.push(`- ${label} 停在旧版本的电脑不到 ${SMALL_SAMPLE} 台，这一列只能粗看。`)
  }
  return lines
}

// 只写占比：被拒的占这一类请求的几成，被拒的里面各个状态码又占几成。
function renderFailedRequests(failures) {
  const lines = ['', '### 更新相关的请求有没有被拒', '']
  if (!failures) {
    lines.push('这个套餐的 Cloudflare 统计不能按状态码分，这一项没法算。')
    return lines
  }
  lines.push(
    '这段时间各类请求里被这边拒掉（状态码 400 以上）的占几成，按请求次数算、不按电脑，都按抽样倍数折算。'
      + '前面两节只数没被拒的请求：Mac 的更新清单要是被拒得多，「没下、也没见查过」里就有一部分其实查过，只是被拒了。',
    '',
    '| 请求 | 被拒的占比 | 被拒的里面最多的状态码 |',
    '|---|---:|---|',
  )
  for (const [id, label] of REQUEST_KINDS) {
    const kind = failures[id]
    const codes = [...kind.codes]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 3)
      .map(([code, count]) => `${code}（${formatShare(count, kind.failed)}）`)
    lines.push(`| ${label} | ${formatShare(kind.failed, kind.ok + kind.failed)} | ${codes.join('、') || '-'} |`)
  }
  return lines
}

function renderDownloadSections(downloads) {
  if (!downloads) return ['', '### 下过新版安装包的电脑后来怎样', '', '这个套餐的 Cloudflare 统计查不到来源 IP、请求路径或小时，这一项没法算。']
  if (!downloads.followed.length) return ['', '### 下过新版安装包的电脑后来怎样', '', '这段时间没有电脑从这里下过安装包。']
  const lines = downloads.followed.flatMap((summary) => renderInstallerTable(summary))
  lines.push(
    '',
    '上面几张表都这样读：',
    '',
    '- 「还没装上」里分不出装失败和下好了还没重启。0.2.18 以前的版本要客户自己点「重启安装」才装。',
    '- Windows「没再出现」的，可能是装好后改走洛杉矶线路、从 xm-direct.solov.cc 读了（0.2.18 起），也可能只是关了星芒没再开，这里分不开。',
    '- Mac 的更新不走洛杉矶，「没再出现」就是之后没再开星芒。拿 Mac 这一格当「关了没再开」的大概比例，'
      + 'Windows 那一格多出来的，大致就是装好后改走洛杉矶的（推测）。',
  )
  if (downloads.followed.some((summary) => summary.sampleInterval > 1)) {
    lines.push('- Cloudflare 这段时间是抽样记录的，一台电脑只下一次的请求可能漏记，这几节的偏差比上面大。')
  }
  lines.push(...renderStaleSection(downloads.stale), ...renderFailedRequests(downloads.failures))
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

function sumWeights(records) {
  return records.reduce((sum, record) => sum + record.weight, 0)
}

function weightsBy(records, labelOf) {
  const weights = new Map()
  for (const record of records) {
    const label = labelOf(record)
    if (label !== null) weights.set(label, (weights.get(label) || 0) + record.weight)
  }
  return weights
}

// 「标签 占比」从高到低用顿号连起来；limit 只留前几个。
function shareList(weights, total, limit = Infinity) {
  const items = [...weights]
    .filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, limit)
    .map(([label, weight]) => `${label} ${formatShare(weight, total)}`)
  return items.join('、') || '-'
}

function labelFrom(table, code) {
  const entry = table.find(([id]) => id === code)
  return entry ? entry[1] : code
}

function usageOsLabel(os) {
  const names = { w10: 'Windows 10', w11: 'Windows 11', wx: 'Windows（认不出几）', mx: 'macOS（认不出版本）', lx: 'Linux' }
  if (names[os]) return names[os]
  const mac = /^m(\d{1,2})$/.exec(os)
  return mac ? `macOS ${mac[1]}` : '其他'
}

function usageUpdateLabel(update) {
  if (update.state === 'ok') return '没有下好待装的新版'
  return `${update.state === 'dl' ? '下好了还没装' : '试着装过、没装上'} ${update.version ?? '（认不出版本）'}`
}

function formatUsageDay(day) {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
}

// 只写每 100 台·天几次，不写次数和台·天数。
function formatRate(count, machineDays) {
  return machineDays > 0 ? (count * 100 / machineDays).toFixed(1) : '-'
}

// 一天一条就是一台电脑，所以这一节和上面按状态文件数的一样只写占比。
function renderUsageDay(usage) {
  const records = usage.records.filter((record) => record.day === usage.day.day)
  const total = sumWeights(records)
  const machines = new Map()
  for (const record of records) {
    if (record.app === null) continue
    const counts = machines.get(record.app) || { windows: 0, mac: 0, linux: 0, other: 0 }
    counts[record.platform] += record.weight
    machines.set(record.app, counts)
  }
  const lines = [
    '',
    `### ${formatUsageDay(usage.day.day)} 这一天的电脑${usage.day.complete ? '' : '（这段时间没有一个整天，拿记录最多的那天）'}`,
    '',
    '按 UTC 分天，也就是北京时间这天早上 8 点到第二天早上 8 点。下面每个数都是占这一天打卡电脑的比例。',
    '',
  ]
  if (machines.size) lines.push('各版本占比：', '', ...renderMachineTable(machines).lines, '')
  lines.push(
    `- **系统**：${shareList(weightsBy(records, (record) => usageOsLabel(record.os)), total)}`,
    `- **芯片**：${shareList(weightsBy(records, (record) => labelFrom(USAGE_ARCHES, record.arch)), total)}`,
    `- **账号**：${shareList(weightsBy(records, (record) => labelFrom(USAGE_ACCOUNTS, record.account)), total)}`,
    `- **线路**：${shareList(weightsBy(records, (record) => labelFrom(USAGE_ROUTES, record.route)), total)}`,
    `- **自动更新**：${shareList(weightsBy(records, (record) => (record.autoUpdate ? '开着' : '关了')), total)}`,
    `- **新版装上没有**：${shareList(weightsBy(records, (record) => usageUpdateLabel(record.update)), total)}`
      + '（「试着装过、没装上」是打开时、退出时或后台已经装过这一版，还停在旧版）',
    '',
    '| 工具 | 装了的电脑 | 装了的里面最多的版本 |',
    '|---|---:|---|',
  )
  for (const [code, label, kind] of USAGE_TOOLS) {
    const seen = records.filter((record) => record.tools[code].seen)
    const installed = seen.filter((record) => record.tools[code].installed)
    const versions = kind === 'version' ? shareList(weightsBy(installed, (record) => record.tools[code].version), sumWeights(installed), 3) : '-'
    lines.push(`| ${label} | ${formatShare(sumWeights(installed), sumWeights(seen))} | ${versions} |`)
  }
  lines.push('', '「装了的电脑」只算这次检测到了的（首页检测还没跑完的不算）；版本是占装了的电脑的比例。')
  if (total < SMALL_SAMPLE) lines.push('', `这一天打卡的电脑不到 ${SMALL_SAMPLE} 台，比例只能粗看。`)
  return lines
}

function renderUsageRates(usage) {
  const records = usage.records
  const columns = [['total', '合计'], ...PLATFORMS.filter(([id]) => records.some((record) => record.platform === id))]
  const machineDays = Object.fromEntries(columns.map(([id]) => [id, sumWeights(id === 'total' ? records : records.filter((record) => record.platform === id))]))
  const lines = [
    '',
    '### 出错和卡住（每 100 台·天几次）',
    '',
    '这段时间的打卡加在一起算：一台电脑开了一天算 1 台·天，每格是平均每 100 台·天出了几次。',
    '',
    `| 什么 | ${columns.map(([, label]) => label).join(' | ')} | 最多的原因 |`,
    `|---|${columns.map(() => '---:').join('|')}|---|`,
  ]
  function row(label, itemsOf, withReasons) {
    const counts = Object.fromEntries(columns.map(([id]) => [id, 0]))
    const reasons = new Map()
    for (const record of records) {
      for (const item of itemsOf(record)) {
        const weighted = item.count * record.weight
        counts.total += weighted
        counts[record.platform] += weighted
        if (withReasons) reasons.set(labelFrom(USAGE_CATEGORIES, item.category), (reasons.get(labelFrom(USAGE_CATEGORIES, item.category)) || 0) + weighted)
      }
    }
    lines.push(`| ${label} | ${columns.map(([id]) => formatRate(counts[id], machineDays[id])).join(' | ')} | ${withReasons ? shareList(reasons, counts.total, 2) : '-'} |`)
  }
  for (const [code, label] of USAGE_INSTALL_TARGETS) row(`装 ${label} 失败`, (record) => record.installs.filter((item) => item.code === code), true)
  for (const [code, label] of USAGE_UPDATE_STEPS) row(label, (record) => record.updates.filter((item) => item.code === code), true)
  for (const [code, label] of USAGE_HANGS) row(label, (record) => record.hangs.filter((item) => item.code === code), false)
  lines.push(
    '',
    '- 安装失败不算客户自己点了取消的。原因是星芒按报错归的类，报错原文不发。',
    '- 「星芒更新：检查失败」只算客户自己点的那次，开机和每 3 小时自动查的没查成不算；自动装没装上看上面「新版装上没有」。',
    '- 「整个界面卡住」只在星芒窗口在前台时量，2 到 30 秒算一次（再长多半是电脑睡着了）；「窗口没响应」是系统报的那种，同一次只算一回。',
    '- 付款两项只算点了充值或订阅以后打开付款页那一步。',
    '- 每种一天最多记 99 次。没发出去的攒着，最多留 7 天，算在发出去的那天。',
  )
  if (machineDays.total < SMALL_SAMPLE) lines.push(`- 这段时间的打卡加起来不到 ${SMALL_SAMPLE} 台·天，只能粗看。`)
  return lines
}

function renderUsageScope(usage) {
  const lines = [
    '',
    '### 打卡的口径',
    '',
    '- 只有 0.2.23 起、开着这一项、这天开过星芒的电脑。0.2.22 及更早的不发，亲手关掉的不发，所以和上面按状态文件数的不是同一批电脑，不能直接比。',
    '- 先发到 updatesnew.shenfengwl.fun，连不上才发洛杉矶那份（xm-direct.solov.cc）。那份的 /xingmang-manager/ 是 nginx 原样转发到这里的'
      + '（服务端 10-17 核过），所以也记在这里。一天最多试 3 次，一直连不上的电脑那天缺一条。',
    '- 只有打包好的正式版发，开发版、自己编的版本和 GitHub Actions 里真装真开的都不发。',
  ]
  if (usage.sampleInterval > 1) lines.push(`- 这段时间 Cloudflare 是抽样记的（最多每 ${Math.round(usage.sampleInterval)} 次记 1 次），每条按抽样倍数折算，比例有误差。`)
  if (usage.unrecognized) {
    lines.push(`- 另有 ${formatShare(usage.unrecognized, usage.unrecognized + sumWeights(usage.records))} 的打卡地址认不出（格式不对，多半不是星芒发的），没算进上面。`)
  }
  return lines
}

function renderUsageSection(usage) {
  const lines = ['', '## 每天打卡（匿名使用统计）', '']
  if (!usage) return [...lines, '这个套餐的 Cloudflare 统计不能按请求路径分，打卡记录没法数。']
  lines.push(
    '0.2.23 起的星芒开着「匿名使用统计」（设置 → 隐私数据，默认开）时，每天最多发成一条：版本、系统、装了哪些工具、'
      + '安装和更新出没出错、卡住几次，不带账号和电脑编号。一天只发成一条是客户端自己保证的，所以一天一条就是一台电脑。'
      + 'Windows 走线路2 的也先发到这里，和上面那几节不一样，数得到。',
  )
  if (usage.records.length) lines.push(...renderUsageDay(usage), ...renderUsageRates(usage))
  else lines.push('', '这段时间没有认得出的打卡记录：0.2.23 还没发出去，或者装了的都关了这一项。')
  lines.push(...renderUsageScope(usage))
  return lines
}

function renderReport(stats, window, limits, days, downloads = null, usage = undefined) {
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
  lines.push(...renderDownloadSections(downloads))
  if (stats.requests.size) {
    lines.push('', '### 按请求算', '', ...renderRequestTable(stats.requests), '')
    lines.push('开着的星芒每 15 分钟读一次，一直不关的电脑分量重，这张表只用来对照。')
  }
  const recognized = [...stats.requests.values()].reduce((sum, count) => sum + count, 0)
  if (stats.unrecognized) lines.push('', `另有 ${formatShare(stats.unrecognized, recognized + stats.unrecognized)} 的请求看不出版本（浏览器直接打开、爬虫等），没算进上面的表。`)
  // undefined 是没查（直接调用时），null 是这个套餐查不了。
  if (usage !== undefined) lines.push(...renderUsageSection(usage))
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
  const downloads = installers
    ? summarizeUpdateDownloads(
      pieces,
      await queryWindow(client, zoneTag, limits, window, installers),
      await queryWindow(client, zoneTag, limits, window, manifestQuery()),
      limits.withStatus ? await queryWindow(client, zoneTag, limits, window, failedRequestQuery()) : null,
    )
    : null
  const usageSpec = usageQuery(limits)
  const usage = usageSpec ? summarizeUsage(await queryWindow(client, zoneTag, limits, window, usageSpec), window) : null
  return renderReport(aggregateStats(pieces, limits.withIp), window, limits, days, downloads, usage)
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
  parseUsagePath,
  planWindow,
  renderReport,
  summarizeInstallerDownloads,
  summarizeStaleMachines,
  summarizeUpdateDownloads,
  summarizeUsage,
}
