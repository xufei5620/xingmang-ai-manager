import { describe, expect, it } from 'vitest'
import {
  buildClaudeDesktopInstallFailureMessage, claudeDesktopInstallFailureReasons, classifyClaudeDesktopInstallFailure,
  isClaudeDesktopInstallFailureMessage, isPlainClaudeDesktopInstallMessage, type ClaudeDesktopInstallFailureReason,
} from './claude-desktop-install-failure'
import { buildCodexDesktopInstallFailureMessage } from './codex-desktop-install-failure'

describe('Claude Desktop install failure wording', () => {
  it('names both routes only when the system installer was actually tried', () => {
    expect(buildClaudeDesktopInstallFailureMessage('unreachable', { wingetTried: true }))
      .toBe('Claude Desktop 没装上：系统自带的安装组件和 Claude 官网的离线安装包这次都没装上，Claude 官网这会儿连不上。')
    expect(buildClaudeDesktopInstallFailureMessage('unreachable', { wingetTried: false }))
      .toBe('Claude Desktop 没装上：Claude 官网这会儿连不上。')
  })

  it('keeps every sentence free of words customers cannot act on', () => {
    for (const reason of Object.keys(claudeDesktopInstallFailureReasons) as ClaudeDesktopInstallFailureReason[]) {
      for (const wingetTried of [false, true]) {
        const message = buildClaudeDesktopInstallFailureMessage(reason, { wingetTried })
        expect(message).not.toMatch(/MSIX|winget|SHA|HTTP|Content-Type|Appx|0x[0-9a-f]{4,}/i)
        expect(isClaudeDesktopInstallFailureMessage(message)).toBe(true)
      }
    }
  })

  it.each([
    ['Add-AppxPackage 安装失败：部署失败，HRESULT: 0x80073CFD，Windows cannot install package Claude because this package requires OS version 10.0.19041.0 or higher', 'unsupported'],
    ['Add-AppxPackage 安装失败：部署失败，HRESULT: 0x80073CF3，包无法通过更新、依赖项或冲突验证', 'blocked'],
    ['Claude Desktop 管理员安装失败（退出码 1），请检查 Windows 应用部署事件日志后重试。', 'blocked'],
    ['授权使用了不同的 Windows 账号，已停止安装以免注册到其他用户。请由当前 Windows 账号的管理员会话完成安装。', 'blocked'],
    ['授权期间 Claude 安装包发生变化，已停止安装，请重新下载。', 'damaged'],
    ['Claude 官网的安装包缺少有效的 Anthropic 签名', 'damaged'],
    ['Claude 官网的安装包发布者不是 Anthropic', 'damaged'],
    ['Claude 官网的安装包下载不完整：应为 300 字节，实际 200 字节', 'damaged'],
    ['Claude 官网返回的不是 MSIX 文件（Content-Type: text/html）', 'damaged'],
    ['Claude 官网返回的数据超过声明的安装包大小', 'damaged'],
    ['Claude 官网返回 HTTP 503', 'unreachable'],
    ['Claude 官网连接或下载超时', 'unreachable'],
    ['Claude 官网下载重定向到了没核实过的地址', 'unreachable'],
    ['fetch failed', 'unreachable'],
    ['net::ERR_CONNECTION_RESET', 'unreachable'],
    ['核对 Claude 官网安装包没有完成：命令执行时间过长，已中止：powershell.exe', 'unknown'],
    ['核对 Claude 官网安装包的结果读不出来', 'unknown'],
  ] as const)('classifies %s as %s', (detail, reason) => {
    expect(classifyClaudeDesktopInstallFailure(detail)).toBe(reason)
  })

  it('lets sentences that already carry their own next step through', () => {
    for (const message of [
      '已取消管理员授权，Claude Desktop 安装未开始。重新点击安装即可再次授权。',
      '未获得管理员权限，Claude Desktop 安装已停止。请在弹出的授权窗口点击「是」。',
      'Claude Desktop 安装失败：安装目录所在磁盘空间不足，只剩 1.0 GB，至少需要 2.0 GB，请先清理磁盘再试',
      '安装已取消。',
    ]) expect(isPlainClaudeDesktopInstallMessage(message)).toBe(true)
    expect(isPlainClaudeDesktopInstallMessage('Claude 官网返回 HTTP 503')).toBe(false)
  })

  it('is not mistaken for the Codex Desktop failure sentence', () => {
    expect(isClaudeDesktopInstallFailureMessage(buildCodexDesktopInstallFailureMessage('unreachable', { storeTried: true, updating: false }))).toBe(false)
    expect(isClaudeDesktopInstallFailureMessage('Claude Desktop 安装完成')).toBe(false)
  })
})
