import { describe, expect, it } from 'vitest'
import { loggedFailureNextStep, toolLaunchFailureMessage } from './failure-wording'

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
