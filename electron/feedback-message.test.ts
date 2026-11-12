import { describe, expect, it } from 'vitest'
import { buildFeedbackMessage, feedbackMessageTypes, isFeedbackMessageType } from './feedback-message'

describe('buildFeedbackMessage', () => {
  it('puts the type, what the customer wrote and who they are in one block, then the report', () => {
    expect(buildFeedbackMessage({
      type: 'bug',
      description: '  点「打开」后终端闪一下就关了 \n',
      contact: ' wx-yoyo ',
      identity: '账号 yoyo（ID 7） · 星芒AI管理工具 0.2.19 · Windows',
      lastFailure: '最近一次出错：14:37 打开 Codex：没有写入权限',
      report: '[report]',
    })).toBe([
      '留言反馈 · 遇到问题',
      '点「打开」后终端闪一下就关了',
      '联系方式：wx-yoyo',
      '账号 yoyo（ID 7） · 星芒AI管理工具 0.2.19 · Windows',
      '最近一次出错：14:37 打开 Codex：没有写入权限',
      '',
      '[report]',
    ].join('\n'))
  })

  it('leaves out an empty contact and the report when it is not attached', () => {
    expect(buildFeedbackMessage({ type: 'idea', description: '想要深色图标', contact: '  ' })).toBe('留言反馈 · 功能建议\n想要深色图标')
    expect(buildFeedbackMessage({ type: 'other', description: '想要深色图标' })).toBe('留言反馈 · 其他\n想要深色图标')
  })

  it('says at the end that the report could not be made, so support does not take it for an unticked box', () => {
    expect(buildFeedbackMessage({ type: 'bug', description: '打不开', contact: '', reportMissing: true })).toBe('留言反馈 · 遇到问题\n打不开\n反馈报告：这次没生成出来')
  })

  it('masks a key the customer pasted into the description', () => {
    const text = buildFeedbackMessage({ type: 'other', description: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789', contact: '' })
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
  })
})

describe('feedbackMessageTypes', () => {
  it('offers the three types in the order the form shows them', () => {
    expect(feedbackMessageTypes).toEqual([
      { value: 'bug', label: '遇到问题' },
      { value: 'idea', label: '功能建议' },
      { value: 'other', label: '其他' },
    ])
  })

  it('accepts only those three values, not a label or an inherited key', () => {
    expect(feedbackMessageTypes.every((entry) => isFeedbackMessageType(entry.value))).toBe(true)
    for (const value of ['遇到问题', 'Bug', 'constructor', 'toString', '', undefined, null, 1]) {
      expect(isFeedbackMessageType(value)).toBe(false)
    }
  })
})
