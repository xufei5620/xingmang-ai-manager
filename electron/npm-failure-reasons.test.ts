import { describe, expect, it } from 'vitest'
import { npmErrorCodeIn, npmErrorCodesClause, npmFailureExplainsItself, npmFailureReasonFor, pickNpmNextStep, type NpmFailureReason } from './npm-failure-reasons'

// 命令运行器那句加 npm 要点，和 system-service.ts 的 describeNpmCommandFailure 拼出来的一样。
function npmDetail(highlights: string): string {
  return `命令执行失败（退出码 1）：npm-cli.js（${highlights}）`
}

describe('npm failure reasons', () => {
  it('names each npm code in Chinese and keeps the code for the dialog to read', () => {
    const cases: Array<[string, string, string | null]> = [
      [npmDetail('ENOSPC；nospc ENOSPC: no space left on device, write'), '磁盘空间不足', 'ENOSPC'],
      [npmDetail("EPERM；Error: EPERM: operation not permitted, rename 'C:\\x'"), '安装目录拒绝访问', 'EPERM'],
      [npmDetail('EACCES；permission denied'), '安装目录拒绝访问', 'EACCES'],
      [npmDetail('EBUSY；resource busy or locked'), '文件被占用', 'EBUSY'],
      [npmDetail('ETIMEDOUT；network request failed, reason: connect ETIMEDOUT'), '下载太久没有完成，超时中止', 'ETIMEDOUT'],
      ['下载太久没有完成，超时中止', '下载太久没有完成，超时中止', null],
      [npmDetail('ENOTFOUND；getaddrinfo ENOTFOUND registry.npmjs.org'), '解析不出下载源的地址', 'ENOTFOUND'],
      [npmDetail('EAI_AGAIN；getaddrinfo EAI_AGAIN'), '解析不出下载源的地址', 'EAI_AGAIN'],
      [npmDetail('ECONNRESET；network aborted'), '和下载源的连接被切断', 'ECONNRESET'],
      [npmDetail('request to https://registry.npmjs.org failed, reason: socket hang up'), '和下载源的连接被切断', 'ECONNRESET'],
      [npmDetail('ERR_SSL_WRONG_VERSION_NUMBER；40C7B5F8E5240000:error:0A00010B:SSL routines'), '和下载源的连接被切断', 'ERR_SSL_WRONG_VERSION_NUMBER'],
      [npmDetail('SELF_SIGNED_CERT_IN_CHAIN；request failed'), '安全证书没通过校验', 'SELF_SIGNED_CERT_IN_CHAIN'],
      [npmDetail('request to https://registry.npmjs.org failed, reason: unable to get local issuer certificate'), '安全证书没通过校验', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
      [npmDetail('CERT_HAS_EXPIRED；certificate has expired'), '安全证书没通过校验', 'CERT_HAS_EXPIRED'],
      [npmDetail('E503；503 Service Unavailable - GET https://registry.npmmirror.com/x'), '下载源那边出错', 'E503'],
      [npmDetail('E404；404 Not Found - GET https://registry.npmmirror.com/x'), '找不到要装的版本', 'E404'],
      [npmDetail('ETARGET；No matching version found'), '找不到要装的版本', 'ETARGET'],
      [npmDetail('E403；403 Forbidden'), '下载源拒绝了这次下载', 'E403'],
      [npmDetail('EINTEGRITY；sha512 integrity checksum failed'), '下载下来的文件没通过校验，已经丢掉', 'EINTEGRITY'],
      [npmDetail('ERESOLVE；unable to resolve dependency tree'), '要装的版本和它用到的组件对不上', 'ERESOLVE'],
    ]
    for (const [raw, reason, code] of cases) {
      expect([raw, npmFailureReasonFor(raw)?.reason, npmFailureReasonFor(raw)?.code]).toEqual([raw, reason, code])
    }
    expect(npmFailureReasonFor(npmDetail('ELIFECYCLE；command failed'))).toBeNull()
    expect(npmFailureReasonFor('国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致')).toBeNull()
  })

  it('says an uninstall that hit a locked or denied file could not delete the tool files', () => {
    expect(npmFailureReasonFor(npmDetail('EPERM；operation not permitted'), { uninstall: true })?.reason).toBe('工具的文件删不掉（拒绝访问）')
    expect(npmFailureReasonFor(npmDetail('ENOSPC；no space'), { uninstall: true })?.reason).toBe('磁盘空间不足')
  })

  it('keeps the code npm reported when the reason is not one it knows', () => {
    expect(npmErrorCodeIn(npmDetail('ELIFECYCLE；command failed'))).toBe('ELIFECYCLE')
    expect(npmErrorCodeIn('命令执行失败（退出码 1）：npm-cli.js（ERROR something）')).toBeNull()
    expect(npmErrorCodeIn('命令执行失败（退出码 1）：npm-cli.js')).toBeNull()
  })

  it('takes the next step from the most actionable reason that has one and lists every code once', () => {
    const timeout: NpmFailureReason = { reason: '下载太久没有完成，超时中止', code: 'ETIMEDOUT', kind: 'network', nextStep: null }
    const missing = npmFailureReasonFor(npmDetail('E404；Not Found')) as NpmFailureReason
    const integrity = npmFailureReasonFor(npmDetail('EINTEGRITY；checksum')) as NpmFailureReason
    expect(pickNpmNextStep([timeout, missing])).toBe('过一会儿再点「重试」；一直这样请找客服。')
    expect(pickNpmNextStep([timeout, timeout])).toBeNull()
    expect(pickNpmNextStep([missing, { ...integrity, kind: 'network' }])).toBe('再点「重试」；一直这样换个网络。')
    expect(npmErrorCodesClause([timeout, missing, timeout])).toBe('（错误码 ETIMEDOUT、E404）')
    expect(npmErrorCodesClause([{ ...timeout, code: null }])).toBe('')
  })

  it('tells the dialog when the sentence already says what to do', () => {
    expect(npmFailureExplainsItself('Codex CLI 安装失败：npm 官方源：下载源拒绝了这次下载（错误码 E403）。换个网络后再点「重试」；一直这样请找客服。')).toBe(true)
    expect(npmFailureExplainsItself('Codex CLI 安装失败：国内 npm 镜像：找不到要装的版本；npm 官方源：要装的版本和它用到的组件对不上（错误码 E404、ERESOLVE）。')).toBe(true)
    expect(npmFailureExplainsItself('Codex CLI 安装失败：npm 官方源：下载太久没有完成，超时中止；国内 npm 镜像：找不到要装的版本（错误码 ETIMEDOUT、E404）。')).toBe(false)
    expect(npmFailureExplainsItself('Codex CLI 安装失败：npm 官方源：npm 没有装成。')).toBe(false)
  })
})
