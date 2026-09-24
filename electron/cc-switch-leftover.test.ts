import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ccSwitchDataDirectoryName, ccSwitchProxyPlaceholder, inspectCcSwitchInstalled, resolveCcSwitchLeftover } from './cc-switch-leftover'

const homes: string[] = []

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cc-switch-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('cc-switch-leftover', () => {
  it('sees the CC Switch data directory only when it is a real directory', () => {
    const home = temporaryHome()
    expect(inspectCcSwitchInstalled(home)).toBe(false)
    fs.writeFileSync(path.join(home, ccSwitchDataDirectoryName), '')
    expect(inspectCcSwitchInstalled(home)).toBe(false)
    fs.rmSync(path.join(home, ccSwitchDataDirectoryName))
    fs.mkdirSync(path.join(home, ccSwitchDataDirectoryName))
    expect(inspectCcSwitchInstalled(home)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('does not follow a symlinked CC Switch data directory', () => {
    const home = temporaryHome()
    const target = temporaryHome()
    fs.symlinkSync(target, path.join(home, ccSwitchDataDirectoryName), 'dir')
    expect(inspectCcSwitchInstalled(home)).toBe(false)
  })

  it('recognises the proxy takeover placeholder even without the data directory', () => {
    expect(resolveCcSwitchLeftover({ apiKey: ccSwitchProxyPlaceholder, hasApiKey: true, actualBaseUrl: 'http://127.0.0.1:15721' }, false)).toBe('proxy')
  })

  it('attributes a foreign connection to CC Switch only when it is installed', () => {
    const foreign = { apiKey: 'sk-other', hasApiKey: true, actualBaseUrl: 'https://other.example' }
    expect(resolveCcSwitchLeftover(foreign, true)).toBe('provider')
    expect(resolveCcSwitchLeftover(foreign, false)).toBeNull()
    expect(resolveCcSwitchLeftover({ apiKey: '', hasApiKey: false, actualBaseUrl: 'http://127.0.0.1:15721/v1' }, true)).toBe('provider')
  })

  it('leaves an empty configuration alone', () => {
    expect(resolveCcSwitchLeftover({ apiKey: '', hasApiKey: false, actualBaseUrl: '' }, true)).toBeNull()
  })
})
