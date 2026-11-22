import { describe, expect, it } from 'vitest'
import { missingAiAssetMessages, resolveMissingAiAssetMessage } from './ai-asset-missing'

describe('ai-asset-missing', () => {
  it('names each kind of work in plain words, without asking for a retry', () => {
    expect(missingAiAssetMessages).toEqual({
      image: '该图片已不在本机，可能已被移动或删除。',
      video: '该视频已不在本机，可能已被移动或删除。',
      audio: '该音频已不在本机，可能已被移动或删除。',
    })
    for (const sentence of Object.values(missingAiAssetMessages)) expect(sentence).not.toMatch(/重试|资产|无权访问/)
  })

  it('recognises the sentences through the IPC prefix and nothing else', () => {
    expect(resolveMissingAiAssetMessage(`Error invoking remote method 'chat:copy-asset': Error: ${missingAiAssetMessages.image}`)).toBe(missingAiAssetMessages.image)
    expect(resolveMissingAiAssetMessage(missingAiAssetMessages.audio)).toBe(missingAiAssetMessages.audio)
    expect(resolveMissingAiAssetMessage('AI 素材不存在或无权访问')).toBeNull()
    expect(resolveMissingAiAssetMessage('图片另存失败，请检查目标目录写入权限')).toBeNull()
    expect(resolveMissingAiAssetMessage('')).toBeNull()
  })
})
