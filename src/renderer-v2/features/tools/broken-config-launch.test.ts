import { describe, expect, it } from 'vitest'
import { brokenConfigDetails, type BrokenConfig } from './model'
import { brokenConfigLaunchMessages, isBrokenConfigLaunchMessage } from './broken-config-launch'
import { presentOperationFailure } from '../../operation-error'

describe('broken config launch messages', () => {
  // 这几句是首页那行小字的前半句（yoyo 2026-10-06 定的原话），两边改字要一起改。
  it('reuses the first sentence of the home card line for every broken file', () => {
    for (const broken of Object.keys(brokenConfigDetails) as BrokenConfig[]) {
      expect(brokenConfigDetails[broken].startsWith(brokenConfigLaunchMessages[broken])).toBe(true)
    }
  })

  it('is recognised only word for word, so the error dialog offers 修好它 for exactly these', () => {
    for (const message of Object.values(brokenConfigLaunchMessages)) {
      expect(isBrokenConfigLaunchMessage(message)).toBe(true)
      expect(presentOperationFailure({ message })).toMatchObject({ key: 'configBroken', title: '配置文件坏了', actions: [{ id: 'repairConfig', label: '修好它' }, { id: 'support', label: '找客服' }] })
    }
    expect(isBrokenConfigLaunchMessage('请先确认账号连接，再打开工具。')).toBe(false)
    expect(isBrokenConfigLaunchMessage(`前面还有话。${brokenConfigLaunchMessages.codexConfig}`)).toBe(false)
    expect(presentOperationFailure({ message: '请先确认账号连接，再打开工具。' })?.key).not.toBe('configBroken')
  })
})
