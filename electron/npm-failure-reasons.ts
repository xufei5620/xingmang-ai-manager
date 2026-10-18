// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports only network-failure, itself free of Node APIs: the renderer value-imports this
// file (registered in scripts/verify-renderer-boundary.test.cjs) to recognise the sentences
// below, so it must stay that way (I6).
import { classifyNetworkFailure, isTlsHandshakeFailure } from './network-failure'

/**
 * npm 没装成时，主进程那句只留中文原因和错误码，英文原话进运行日志（#1100 第1条）。
 * 下一步取最能动手的那一种：本机问题优先，其次证书，再次网络，最后其他。network 是这台电脑连不上
 * （超时、解析不出地址、连接被切断），source 是连上了、下载源那边自己出错（5xx）。
 */
export type NpmFailureKind = 'machine' | 'certificate' | 'network' | 'source' | 'other'

export interface NpmFailureReason {
  /** 接在「npm 官方源：」「国内 npm 镜像：」或「卸载失败：」后面的那段。 */
  reason: string
  /** 留在句尾「（错误码 X）」里的那个；界面的错误分类和证书提示还靠它认。没有就是 null。 */
  code: string | null
  kind: NpmFailureKind
  /** 句子里要自己写的下一步；null = 界面错误目录里有这一类，那边说。 */
  nextStep: string | null
}

/** 星芒自己判下载卡住、总时长到点时说的那句（渲染层按「超时」归成「下载超时」）。 */
export const npmDownloadTimedOutReason = '下载太久没有完成，超时中止'

interface NpmReasonRow {
  test: RegExp
  reason: string
  kind: NpmFailureKind
  nextStep: string | null
  /** 原话里只有散句、没有错误码时补上的那个（Node 自己就是这么对应的）。 */
  impliedCode?: string
}

const retryLaterThenSupport = '过一会儿再点「重试」；一直这样请找客服。'

// 顺序就是同一句原话里撞上几个码时取哪一个：本机、网络、其他，证书在下面单独认（排在网络前）。
const machineRows: readonly NpmReasonRow[] = [
  { test: /\bENOSPC\b/, reason: '磁盘空间不足', kind: 'machine', nextStep: null },
  { test: /\b(?:EBUSY|ETXTBSY)\b/, reason: '文件被占用', kind: 'machine', nextStep: null },
  { test: /\b(?:EPERM|EACCES)\b/, reason: '安装目录拒绝访问', kind: 'machine', nextStep: null },
]

const networkRows: readonly NpmReasonRow[] = [
  { test: /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b/, reason: npmDownloadTimedOutReason, kind: 'network', nextStep: null },
  { test: /\b(?:ENOTFOUND|EAI_AGAIN)\b/, reason: '解析不出下载源的地址', kind: 'network', nextStep: null },
  { test: /\b(?:ECONNREFUSED|ECONNRESET)\b|socket hang up/i, reason: '和下载源的连接被切断', kind: 'network', nextStep: null, impliedCode: 'ECONNRESET' },
  { test: /\bE50[0234]\b/, reason: '下载源那边出错', kind: 'source', nextStep: null },
]

const otherRows: readonly NpmReasonRow[] = [
  { test: /\b(?:E404|ETARGET)\b/, reason: '找不到要装的版本', kind: 'other', nextStep: retryLaterThenSupport },
  { test: /\b(?:E401|E403)\b/, reason: '下载源拒绝了这次下载', kind: 'other', nextStep: '换个网络后再点「重试」；一直这样请找客服。' },
  { test: /\bEINTEGRITY\b/, reason: '下载下来的文件没通过校验，已经丢掉', kind: 'other', nextStep: '再点「重试」；一直这样换个网络。' },
  { test: /\bERESOLVE\b/, reason: '要装的版本和它用到的组件对不上', kind: 'other', nextStep: retryLaterThenSupport },
]

// 证书那几种：先找错误码，只有散句的照 Node 的对应关系补一个（network-failure.ts 的 tls、certDate 两行认的就是这些）。
const certificateCode = /\b(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_UNTRUSTED|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH|ERR_CERT_[A-Z_]+|ERR_(?:SSL|TLS)[A-Z0-9_]*)\b/
const certificateSentences: ReadonlyArray<readonly [RegExp, string]> = [
  [/self[- ]signed certificate in certificate chain/i, 'SELF_SIGNED_CERT_IN_CHAIN'],
  [/self[- ]signed certificate/i, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
  [/unable to get local issuer certificate/i, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
  [/unable to verify the first certificate/i, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
  [/certificate has expired/i, 'CERT_HAS_EXPIRED'],
  [/certificate is not yet valid/i, 'CERT_NOT_YET_VALID'],
]
const handshakeCode = /\bERR_(?:SSL|TLS)[A-Z0-9_]*|\bERR_QUIC_HANDSHAKE_FAILED\b/

function matchedCode(row: NpmReasonRow, raw: string): string | null {
  const token = row.test.exec(raw)?.[0]
  return token && /^E[A-Z0-9_]+$/.test(token) ? token : row.impliedCode ?? null
}

function fromRow(row: NpmReasonRow, raw: string): NpmFailureReason {
  return { reason: row.reason, code: matchedCode(row, raw), kind: row.kind, nextStep: row.nextStep }
}

/**
 * 按 npm 报的码（或星芒自己写的超时那句）认出原因；认不出返回 null，交给调用方：原话本来是中文的照旧，
 * 其余说「npm 没有装成」。uninstall 时 EPERM、EACCES 说的是工具的文件删不掉，不是安装目录。
 */
export function npmFailureReasonFor(raw: string, options: { uninstall?: boolean } = {}): NpmFailureReason | null {
  for (const row of machineRows) {
    if (!row.test.test(raw)) continue
    const reason = fromRow(row, raw)
    return options.uninstall && /EPERM|EACCES/.test(reason.code ?? '') ? { ...reason, reason: '工具的文件删不掉（拒绝访问）' } : reason
  }
  const network = classifyNetworkFailure(raw)
  if (network === 'tls' || network === 'certDate') {
    const code = certificateCode.exec(raw)?.[0] ?? certificateSentences.find(([pattern]) => pattern.test(raw))?.[1] ?? null
    return { reason: '安全证书没通过校验', code, kind: 'certificate', nextStep: null }
  }
  // 握手被网络掐断（ERR_SSL_WRONG_VERSION_NUMBER 这类，#1060）和连接被重置是一回事。
  if (isTlsHandshakeFailure(raw)) return { reason: '和下载源的连接被切断', code: handshakeCode.exec(raw)?.[0] ?? null, kind: 'network', nextStep: null }
  if (raw.includes(npmDownloadTimedOutReason)) {
    return { reason: npmDownloadTimedOutReason, code: /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b/.exec(raw)?.[0] ?? null, kind: 'network', nextStep: null }
  }
  for (const row of [...networkRows, ...otherRows]) {
    if (row.test.test(raw)) return fromRow(row, raw)
  }
  return null
}

/** 认不出是哪一类时，原话里 npm 自己报的码（ELIFECYCLE 这类）照样留在句尾，给客服看。 */
export function npmErrorCodeIn(raw: string): string | null {
  return /\bE(?!RROR\b)[A-Z][A-Z0-9_]+\b|\bE\d{3}\b/.exec(raw)?.[0] ?? null
}

const kindRank: Record<NpmFailureKind, number> = { machine: 0, certificate: 1, network: 2, source: 2, other: 3 }

/**
 * 几个源各有一个原因时，句尾跟哪一句下一步：本机问题优先，其次证书，再次网络，最后其他；只在要自己写
 * 下一步的里面挑（界面目录管的那几类不在句子里重复）。都不用写就是 null。
 */
export function pickNpmNextStep(reasons: readonly NpmFailureReason[]): string | null {
  const candidates = reasons.filter((reason) => reason.nextStep).sort((left, right) => kindRank[left.kind] - kindRank[right.kind])
  return candidates[0]?.nextStep ?? null
}

/** 「（错误码 ETIMEDOUT、E404）」；一个码都没有就是空串。 */
export function npmErrorCodesClause(reasons: readonly NpmFailureReason[]): string {
  const codes = [...new Set(reasons.map((reason) => reason.code).filter((code): code is string => Boolean(code)))]
  return codes.length ? `（错误码 ${codes.join('、')}）` : ''
}

// 下面这几类整句自己说清了下一步，界面不另配标题（#1100 第1条的原因表）。
const selfExplainedCodes: ReadonlySet<string> = new Set(['E404', 'ETARGET', 'E401', 'E403', 'EINTEGRITY', 'ERESOLVE'])

/**
 * 渲染层用：句尾的码全是「整句自己说」那几类时为 true。下一步里的「换个网络」会被按网络失败认成
 * 「连不上下载源」，所以要在那几条规则前面先认出来。
 */
export function npmFailureExplainsItself(message: string): boolean {
  const clause = /（错误码 ([A-Z0-9_、]+)）/.exec(message)?.[1]
  if (!clause) return false
  return clause.split('、').every((code) => selfExplainedCodes.has(code))
}
