// Zero Node dependency, same as catalog.ts and relay-sites.ts -- the advice
// this module builds is carried into the renderer through ipc-contract.ts's
// type re-exports (I6). Pulling in any node:* module here would make Vite try
// to bundle it for the browser.
//
// 为什么存在这份名单(N1):本产品把四个 CLI 的 base URL 全部指向自家中转,
// 而这些 CLI 每周发版,针对第三方 base URL 的回归是反复出现的——Claude Code
// 官方 changelog 里就有两次「指向网关时每个请求都 400」。用户一更新就整条
// 链路不可用,他的感受是「星芒坏了」,客服也看不出他装的是哪个版本。
// 所以安装与更新默认装这里的推荐版本,而不是永远装 latest。
import type { ProviderId } from './catalog'
import { isNewerVersion } from './versions'

export interface VerifiedCliRelease {
  /** 精确版本号,必须是 npm 上真实存在的版本。 */
  version: string
  /** 验证日期 YYYY-MM-DD,写进文档与 PR,方便判断名单有多旧。 */
  verifiedAt: string
  /**
   * 验证过的中转站点 id(relay-sites.ts 的 RelaySite.id)。双站点是有意做成
   * 用户无感的,所以这个维度只存在于数据与文档里,永远不出现在界面文案上。
   * 空数组 = 尚未在任何站点实测,只是按上游 changelog 推断。
   */
  verifiedSites: readonly string[]
  /** 中文备注,说明为什么选它。 */
  note: string
}

export interface BlockedCliVersionRange {
  /** 首个受影响版本(含)。 */
  introduced: string
  /** 首个修复版本(不含);null = 上游尚未修复。 */
  fixed: string | null
  /** 中文原因,直接展示给用户。 */
  reason: string
  /**
   * 只影响这些站点时列出站点 id;缺省 = 所有站点。绝大多数上游回归打的是
   * 「第三方 base URL」这一整类,与站点无关,所以缺省才是常态。
   */
  sites?: readonly string[]
}

export interface CliVersionCompatibility {
  /** 推荐安装的版本;null = 该工具还没有名单,安装继续走 latest(旧行为)。 */
  recommended: VerifiedCliRelease | null
  blocked: readonly BlockedCliVersionRange[]
}

/**
 * 维护说明见 docs/CLI-VERIFIED-VERSIONS.md。首版只维护 Claude Code,
 * 2026-09-21 扩到 Codex 与 Gemini —— 扩它们的直接原因是 Codex 0.155.0
 * 那次回归:那两天点过「更新」的客户装到的就是它,而名单管不到 Codex。
 * Grok 仍然留空,行为与今天完全一致(装 latest)。
 */
export const cliVerifiedVersions: Record<ProviderId, CliVersionCompatibility> = {
  claude: {
    recommended: {
      version: '2.1.277',
      verifiedAt: '2026-09-18',
      verifiedSites: [],
      note: '当前 npm latest,且修复了 2.1.275 引入的「指向网关时每个请求 400」回归',
    },
    blocked: [
      {
        introduced: '2.1.265',
        fixed: '2.1.268',
        reason: '这些版本在第三方中转上每次请求都返回 400（上游已在 2.1.268 修复）',
      },
      {
        introduced: '2.1.275',
        fixed: '2.1.277',
        reason: '这些版本指向中转时每次请求都返回 400（上游已在 2.1.277 修复）',
      },
    ],
  },
  codex: {
    recommended: {
      version: '0.155.1',
      verifiedAt: '2026-09-21',
      verifiedSites: [],
      note: '当前 npm latest,且把 0.155.0 那次「默认索要推理摘要」改了回去',
    },
    blocked: [
      {
        introduced: '0.155.0',
        fixed: '0.155.1',
        reason: '这个版本每次都向中转索要推理摘要，不支持的中转会直接拒绝请求（上游已在 0.155.1 修复）',
      },
    ],
  },
  grok: { recommended: null, blocked: [] },
  gemini: {
    recommended: {
      version: '0.60.0',
      verifiedAt: '2026-09-21',
      verifiedSites: [],
      note: '当前 npm latest;0.57~0.60 四个正式版全是安全加固,未发现与第三方 base URL 相关的回归',
    },
    blocked: [],
  },
}

// 已装版本可能是 "2.1.277 (Claude Code)" 这样的整行输出,也可能是一句
// 无法解析的错误文案。isNewerVersion 对解析不出来的输入两个方向都返回
// false,所以「同版本」必须先确认它真的含版本号,否则一行乱码会被判成
// 「正在用推荐版本」。
function containsComparableVersion(value: string | null): value is string {
  return typeof value === 'string' && /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.test(value)
}

function appliesToSite(range: BlockedCliVersionRange, siteId: string | null | undefined): boolean {
  if (!range.sites) return true
  return typeof siteId === 'string' && range.sites.includes(siteId)
}

/** 判断 version 是否落在 [introduced, fixed) 区间内。 */
export function versionInBlockedRange(version: string, range: BlockedCliVersionRange): boolean {
  if (isNewerVersion(version, range.introduced)) return false
  if (!range.fixed) return true
  return isNewerVersion(version, range.fixed)
}

/** 已装版本命中的第一个不兼容区间;没有命中返回 null。不抛错。 */
export function findBlockedCliVersion(
  provider: ProviderId,
  version: string | null,
  siteId?: string | null,
  list: Record<ProviderId, CliVersionCompatibility> = cliVerifiedVersions,
): BlockedCliVersionRange | null {
  if (!containsComparableVersion(version)) return null
  for (const range of list[provider].blocked) {
    if (!appliesToSite(range, siteId)) continue
    if (versionInBlockedRange(version, range)) return range
  }
  return null
}

export interface CliInstallVersionOptions {
  /** 调用方点名的版本(回滚按钮),优先级最高。 */
  requested?: string | null
  /** 用户在设置里打开了「总是安装最新版」。 */
  alwaysLatest?: boolean
  list?: Record<ProviderId, CliVersionCompatibility>
}

export interface CliInstallVersionChoice {
  /** 传给 npm 的版本,'latest' 表示不钉版本。 */
  version: string
  /** requested = 用户点名;recommended = 名单;latest = 没有名单或用户选择跟随最新。 */
  source: 'requested' | 'recommended' | 'latest'
}

/**
 * 决定这次安装装哪个版本。缺省(用户没点名、没开「总是最新」)走名单里的推荐
 * 版本——这是 N1 有意做的默认行为变更;名单为空的工具行为与从前一致。
 */
export function resolveCliInstallVersion(
  provider: ProviderId,
  options: CliInstallVersionOptions = {},
): CliInstallVersionChoice {
  const list = options.list ?? cliVerifiedVersions
  const requested = typeof options.requested === 'string' ? options.requested.trim() : ''
  if (requested) return { version: requested, source: 'requested' }
  if (options.alwaysLatest) return { version: 'latest', source: 'latest' }
  const recommended = list[provider].recommended
  return recommended
    ? { version: recommended.version, source: 'recommended' }
    : { version: 'latest', source: 'latest' }
}

/** 渲染层展示用的版本建议。全部字段都可直接上屏,不含站点信息。 */
export interface CliVersionAdvice {
  recommendedVersion: string | null
  /** 已装版本落在不兼容区间时的中文说明;null = 没有已知问题。 */
  blockedReason: string | null
  /** 已装版本就是推荐版本。未安装或没有名单时为 false。 */
  onRecommended: boolean
  /**
   * 下一次安装/更新会被名单钉在 recommendedVersion 上(有名单且用户没开
   * 「总是安装最新版」)。开了开关的用户仍然要看到不兼容提示,但不该被
   * 一行「推荐 x.y.z」反复劝说,所以展示与「有没有更新」都看这个字段。
   */
  pinned: boolean
  /** 可以一键切到推荐版本。 */
  rollbackAvailable: boolean
  /**
   * 推荐版本比已装版本新——界面据此说「更新到」还是「回到」。两种情形都
   * 真实存在:撞上 blocked 区间的用户要往前走到修复版(Codex 0.155.0 →
   * 0.155.1),而跟着 npm latest 跑到推荐版本前面的用户才是真的退回来。
   * 界面原先一律写「回到」,前一种情形就把用户指反了方向。缺省(未安装、
   * 没名单、版本号读不出来)保持旧文案。
   */
  recommendedIsNewer?: boolean
}

export function buildCliVersionAdvice(
  provider: ProviderId,
  installedVersion: string | null,
  options: {
    siteId?: string | null
    alwaysLatest?: boolean
    list?: Record<ProviderId, CliVersionCompatibility>
  } = {},
): CliVersionAdvice {
  const list = options.list ?? cliVerifiedVersions
  const recommended = list[provider].recommended?.version ?? null
  const blocked = findBlockedCliVersion(provider, installedVersion, options.siteId, list)
  const comparable = containsComparableVersion(installedVersion)
  const onRecommended = Boolean(
    recommended
    && comparable
    && !isNewerVersion(installedVersion, recommended)
    && !isNewerVersion(recommended, installedVersion),
  )
  const pinned = Boolean(recommended) && options.alwaysLatest !== true
  return {
    recommendedVersion: recommended,
    blockedReason: blocked ? blocked.reason : null,
    onRecommended,
    pinned,
    // 跟随最新版的用户只在真的撞上不兼容版本时才被拉回推荐版本;否则这是
    // 他自己选的策略,不该在每一行挂一个回滚按钮。
    rollbackAvailable: Boolean(recommended && comparable && !onRecommended && (pinned || blocked)),
    ...(recommended && comparable && isNewerVersion(installedVersion, recommended)
      ? { recommendedIsNewer: true }
      : {}),
  }
}
