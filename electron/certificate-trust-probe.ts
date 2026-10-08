/**
 * 检查页「安全证书」一项：这台电脑有没有被换过网页证书，星芒替工具开的
 * 「也信任这台电脑的证书」那扇门开没开、没开是因为什么（system-certificate-trust.ts）。
 *
 * 「星芒 AI 网络」一项走 Chromium，本来就信这台电脑的证书库，公司证书下永远是绿的，
 * 看不出工具那一侧的情况。所以这里用电脑上跑工具的那个 Node.js 起两次 `node -e`，
 * 只做 TLS 握手连当前账号的状态地址：一次只用 Node 自带的根证书，一次带上
 * NODE_USE_SYSTEM_CA=1，两次结果一对就知道是哪种情况。
 */
import { nodeReadsSystemCertificates, systemCertificateTrustVariable } from './system-certificate-trust'

/** 一次握手的结果：连上了、证书不认、别的原因（连不上、超时、认不出输出）。 */
export type NodeTlsOutcome = 'ok' | 'cert' | 'other'

export interface NodeTlsProbeResult {
  outcome: NodeTlsOutcome
  /** 脚本自己报的 process.version；认不出输出时为 null。 */
  version: string | null
}

export type CertificateTrustVerdict =
  | 'direct'
  | 'systemTrusted'
  | 'outdatedNode'
  | 'untrusted'
  | 'elevated'
  | 'unknown'

/** 脚本里自己的握手时限；外层 runCommand 的时限要比它宽一点，好让脚本先报出 other。 */
export const nodeTlsProbeTimeoutMs = 5_000

/**
 * Chain-of-trust failures an intercepting root produces. Name mismatches and
 * expired certificates are deliberately absent: trusting the operating
 * system's store cannot fix either, so they must not be read as "a company
 * certificate the switch would cure".
 */
const certificateErrorCodes = [
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
]

/**
 * The script only ever prints one fixed marker plus process.version, never an
 * upstream error message or certificate field, so nothing from the network
 * reaches the report. Host and port arrive as argv, not interpolated into the
 * source. It only completes a handshake: no request line, no headers, no Key,
 * and a TLS socket cannot be redirected anywhere else. `require('tls')` without
 * the `node:` prefix and no optional catch binding keep it parseable by the
 * old Node versions this check exists to diagnose.
 */
export function buildNodeTlsProbeScript(): string {
  return [
    "var tls=require('tls'),net=require('net')",
    'var host=process.argv[1],port=Number(process.argv[2])',
    `var certCodes=${JSON.stringify(certificateErrorCodes)}`,
    'var done=false,socket=null',
    'function finish(marker){if(done)return;done=true;process.stdout.write(marker+" "+process.version+"\\n");try{if(socket)socket.destroy()}catch(e){}process.exit(0)}',
    'try{socket=tls.connect({host:host,port:port,servername:net.isIP(host)?undefined:host},function(){finish(socket.authorized?"ok":"cert")})}catch(e){finish("other")}',
    `if(socket){socket.setTimeout(${nodeTlsProbeTimeoutMs},function(){finish("other")});socket.on("error",function(e){finish(e&&certCodes.indexOf(e.code)>=0?"cert":"other")})}`,
  ].join(';')
}

/** 只认脚本自己那一行；其余任何输出（Node 的警告、被改过的 node）一律当 other。 */
export function parseNodeTlsProbeOutput(stdout: string): NodeTlsProbeResult {
  const match = stdout.trim().split(/\r?\n/)[0]?.match(/^(ok|cert|other) (v\d+\.\d+\.\d+)$/)
  if (!match) return { outcome: 'other', version: null }
  return { outcome: match[1] as NodeTlsOutcome, version: match[2] }
}

/**
 * 两次握手用的环境。只用自带根证书的那次要把这个开关（任何大小写）去掉；带开关的
 * 那次强制为 1——要问的是「开了它能不能连」，不是用户自己设了什么。
 */
export function nodeTlsProbeEnvironment(env: NodeJS.ProcessEnv, useSystemRoots: boolean): NodeJS.ProcessEnv {
  const key = systemCertificateTrustVariable.toLowerCase()
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() !== key) result[name] = value
  }
  if (useSystemRoots) result[systemCertificateTrustVariable] = '1'
  return result
}

export function certificateTrustVerdict(input: {
  defaultRoots: NodeTlsOutcome
  systemRoots: NodeTlsOutcome
  nodeVersion: string | null | undefined
}): Exclude<CertificateTrustVerdict, 'elevated'> {
  if (input.defaultRoots === 'ok') return 'direct'
  if (input.defaultRoots === 'cert' && input.systemRoots === 'ok') return 'systemTrusted'
  if (input.defaultRoots === 'cert' && input.systemRoots === 'cert') {
    return nodeReadsSystemCertificates(input.nodeVersion) === false ? 'outdatedNode' : 'untrusted'
  }
  // 连不上、超时这类跟证书无关的失败，这一项判断不了，交给「星芒 AI 网络」那一项去说。
  return 'unknown'
}

export const certificateTrustSummaries: Readonly<Record<CertificateTrustVerdict, string>> = {
  direct: '工具用自带的证书就能连上星芒服务，这台电脑没有换过网页证书。',
  systemTrusted: '这台电脑装了公司或安全软件的证书。星芒已经让装工具和从星芒打开的工具信任它，可以正常用。',
  outdatedNode: '这台电脑装了公司或安全软件的证书，电脑上的 Node.js 太旧，认不了它。点「去处理」换成新版。',
  untrusted: '这台电脑装了一张连电脑自己也不认的证书。公司电脑请找网络管理员；自己的电脑请关掉安全软件的网页扫描后再检查一次。',
  elevated: '星芒现在是以管理员身份打开的，这时不让工具信任电脑上另外装的证书。请关掉星芒，直接双击正常打开。',
  unknown: '这次没能直接连上星芒服务，证书的情况没判断出来。工具用着正常就不用管。',
}

/** 同一次检查里「星芒 AI 网络」也失败时，不重复怪罪证书，先让用户看网络那一项。 */
export const certificateTrustNetworkFailedSummary = '工具连星芒服务时证书对不上，先看上面「星芒 AI 网络」那一项。'
