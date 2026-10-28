import { describe, expect, it } from 'vitest'
import { activeProviderIds } from './catalog'
import { externalToolIds } from './external-client-contract'
import {
  accelerationOffMessage,
  codexDesktopChineseOffMessage,
  codexRemoteOffMessage,
  isRemoteFeatureOffMessage,
  RemoteFeatureOffError,
  remoteFeatureIds,
  remoteFeatureOffErrorName,
  remoteFeatureTools,
  resolveRemoteFeatureId,
  toolInstallOffMessage,
  toolLaunchOffMessage,
  videoStudioOffMessage,
} from './remote-features'

describe('remote features', () => {
  it('can switch off the install and launch of every tool the app still manages and nothing it retired', () => {
    expect([...remoteFeatureTools].sort()).toEqual([...activeProviderIds, 'codexDesktop', ...externalToolIds].sort())
    expect(remoteFeatureIds).not.toContain('install:gemini')
    expect(new Set(remoteFeatureIds).size).toBe(remoteFeatureIds.length)
  })

  it('recognizes a listed name whatever its case and nothing else', () => {
    expect(resolveRemoteFeatureId(' Video-Studio ')).toBe('video-studio')
    expect(resolveRemoteFeatureId('install:codexdesktop')).toBe('install:codexDesktop')
    for (const value of ['teleport', 'install:gemini', 'install', 'install:', 'video studio', '', null, 7, { feature: 'video-studio' }]) {
      expect(resolveRemoteFeatureId(value)).toBeNull()
    }
  })

  it('says every switched-off sentence with the half the renderer recognizes it by', () => {
    const sentences = [
      videoStudioOffMessage, codexRemoteOffMessage, accelerationOffMessage, codexDesktopChineseOffMessage,
      toolInstallOffMessage('Codex CLI'), toolLaunchOffMessage('Codex CLI'),
    ]
    for (const sentence of sentences) expect(isRemoteFeatureOffMessage(sentence)).toBe(true)
    expect(isRemoteFeatureOffMessage('安装失败：npm ERR! code ECONNRESET')).toBe(false)
  })

  it('spaces the possessive only after a latin name', () => {
    expect(toolInstallOffMessage('Codex CLI')).toBe('Codex CLI 的安装和更新暂时停用了，修好以后会自动恢复。')
    expect(toolInstallOffMessage('Codex 桌面端')).toBe('Codex 桌面端的安装和更新暂时停用了，修好以后会自动恢复。')
    expect(toolLaunchOffMessage('WorkBuddy')).toBe('暂时不能从星芒打开 WorkBuddy，修好以后会自动恢复。')
  })

  it('names its error so the sentence crosses IPC intact', () => {
    const error = new RemoteFeatureOffError(videoStudioOffMessage)
    expect(error.name).toBe(remoteFeatureOffErrorName)
    expect(error.message).toBe(videoStudioOffMessage)
    expect(error).toBeInstanceOf(Error)
  })
})
