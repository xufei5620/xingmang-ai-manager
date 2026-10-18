import { describe, expect, it } from 'vitest'
import { loggedFailureNextStep, npmFailureSentence, npmSourceFailure, toolLaunchFailureMessage } from './failure-wording'

describe('toolLaunchFailureMessage', () => {
  it('keeps a reason that is already Chinese', () => {
    expect(toolLaunchFailureMessage('Claude Code', new Error('工作目录已失效或无法访问，请重新选择工作目录')))
      .toBe('未能打开 Claude Code：工作目录已失效或无法访问，请重新选择工作目录')
  })

  it('leaves an English reason to the log and says what to do next', () => {
    expect(toolLaunchFailureMessage('Claude Code', new Error('spawn EPERM')))
      .toBe('未能打开 Claude Code，原因已经记进运行日志。点「重试」；还不行到「反馈与客服」把报告发给客服。')
    // 中文用户名只在路径里，句子本身还是英文。
    expect(toolLaunchFailureMessage('Codex CLI', new Error("EACCES: permission denied, mkdtemp '/Users/张三/Library/Caches/x'")))
      .toBe(`未能打开 Codex CLI，${loggedFailureNextStep}`)
  })

  it('names the log when there is nothing to quote', () => {
    expect(toolLaunchFailureMessage('Grok CLI', new Error(''))).toBe(`未能打开 Grok CLI，${loggedFailureNextStep}`)
    expect(toolLaunchFailureMessage('Grok CLI', undefined)).toBe(`未能打开 Grok CLI，${loggedFailureNextStep}`)
  })
})

describe('npm failure sentences', () => {
  it('says each registry in Chinese with the codes at the end and the most actionable next step', () => {
    const official = npmSourceFailure('命令执行失败（退出码 1）：npm-cli.js（ETIMEDOUT；request to https://registry.npmjs.org/x failed）', { commandFailed: true })
    const mirror = npmSourceFailure('命令执行失败（退出码 1）：npm-cli.js（E404；404 Not Found - GET https://registry.npmmirror.com/x）', { commandFailed: true })
    expect(npmFailureSentence('Claude Code 安装失败：', [{ label: 'npm 官方源', reason: official }, { label: '国内 npm 镜像', reason: mirror }]))
      .toBe('Claude Code 安装失败：npm 官方源：下载太久没有完成，超时中止；国内 npm 镜像：找不到要装的版本（错误码 ETIMEDOUT、E404）。过一会儿再点「重试」；一直这样请找客服。')
  })

  it('keeps a reason that is already Chinese and does not take npm exit text for one', () => {
    const mismatch = npmSourceFailure('国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致。', { commandFailed: false })
    expect(npmFailureSentence('Codex CLI 安装失败：', [{ label: '国内 npm 镜像', reason: mismatch }]))
      .toBe('Codex CLI 安装失败：国内 npm 镜像：国内 npm 镜像的包名、版本或 SHA-512 完整性元数据与 npm 官方源不一致。')
    const exit = npmSourceFailure('命令执行失败（退出码 1）：npm-cli.js（ELIFECYCLE；command failed）', { commandFailed: true })
    expect(npmFailureSentence('Codex CLI 安装失败：', [{ label: 'npm 官方源', reason: exit }]))
      .toBe(`Codex CLI 安装失败：npm 官方源：npm 没有装成（错误码 ELIFECYCLE）。${loggedFailureNextStep}`)
    expect(npmSourceFailure('stopped', { commandFailed: false }).reason).toBe('npm 没有装成')
  })

  it('says an uninstall in its own words', () => {
    const denied = npmSourceFailure('命令执行失败（退出码 1）：npm（EPERM；Error: EPERM: operation not permitted）', { commandFailed: true, uninstall: true })
    expect(npmFailureSentence('Codex CLI 卸载失败：', [{ reason: denied }])).toBe('Codex CLI 卸载失败：工具的文件删不掉（拒绝访问）（错误码 EPERM）。')
    const unknown = npmSourceFailure('命令执行失败（退出码 1）：npm', { commandFailed: true, uninstall: true })
    expect(npmFailureSentence('Codex CLI 卸载失败：', [{ reason: unknown }])).toBe(`Codex CLI 卸载失败：卸载命令没有成功。${loggedFailureNextStep}`)
  })
})
