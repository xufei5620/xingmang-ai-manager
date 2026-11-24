import { describe, expect, it, vi } from 'vitest'
import {
  buildWindowsUpdateRefusedStartQuery,
  countWindowsUpdateRefusedStarts,
  decodeWindowsEventQueryOutput,
  inspectWindowsUpdateServiceBlocked,
  inspectWindowsUpdateServiceState,
  isWindowsUpdateServiceBlocked,
  parseWindowsServiceStartType,
} from './windows-update-service-state'

const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\wuauserv'
const WUAUSERV = '770075006100750073006500720076000000'
const BITS = '42004900540053000000'

function startOutput(value: string) {
  return `\r\n${KEY}\r\n    Start    REG_DWORD    ${value}\r\n\r\n`
}

// Shaped like `wevtutil qe System /f:xml` output: one <Event> after another, no root element.
function scmEvent(options: { id?: number; provider?: string; param1?: string; param2?: string; binary?: string } = {}) {
  const provider = options.provider ?? 'Service Control Manager'
  return `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}' Guid='{555908d1-a6d7-4695-8e1e-26931d2012f4}' EventSourceName='${provider}'/>`
    + `<EventID Qualifiers='49152'>${options.id ?? 7023}</EventID><Version>0</Version><Level>2</Level><TimeCreated SystemTime='2026-11-23T16:23:13.4589121Z'/>`
    + `<Channel>System</Channel><Computer>LAPTOP-VQK0SPRN</Computer><Security/></System><EventData>`
    + `<Data Name='param1'>${options.param1 ?? 'Windows Update'}</Data><Data Name='param2'>${options.param2 ?? '%%2147942405'}</Data>`
    + `<Binary>${options.binary ?? WUAUSERV}</Binary></EventData></Event>`
}

describe('windows update service state', () => {
  it('reads the service start type from reg.exe output', () => {
    expect(parseWindowsServiceStartType(startOutput('0x3'))).toBe(3)
    expect(parseWindowsServiceStartType(startOutput('0x4'))).toBe(4)
    expect(parseWindowsServiceStartType('')).toBeNull()
    expect(parseWindowsServiceStartType(`${KEY}\r\n    Type    REG_DWORD    0x20\r\n`)).toBeNull()
  })

  it('counts the times Windows Update quit with access denied, as on the 21H2 machine', () => {
    // That machine logged one every two minutes: "Windows Update 服务因下列错误而停止: 一般性拒绝访问错误".
    expect(countWindowsUpdateRefusedStarts(scmEvent() + '\r\n' + scmEvent())).toBe(2)
    // The display name is localised on some systems; the service name in the binary data is not.
    expect(countWindowsUpdateRefusedStarts(scmEvent({ param1: 'Windows 更新' }))).toBe(1)
    // Win32 ERROR_ACCESS_DENIED instead of the HRESULT form.
    expect(countWindowsUpdateRefusedStarts(scmEvent({ param2: '%%5' }))).toBe(1)
    expect(countWindowsUpdateRefusedStarts(scmEvent({ binary: WUAUSERV.toUpperCase() }))).toBe(1)
  })

  it('ignores other services, other errors and other events', () => {
    expect(countWindowsUpdateRefusedStarts(scmEvent({ binary: BITS, param1: 'Background Intelligent Transfer Service' }))).toBe(0)
    // "wuauservx" shares the prefix but not the terminator.
    expect(countWindowsUpdateRefusedStarts(scmEvent({ binary: '7700750061007500730065007200760078000000' }))).toBe(0)
    // ERROR_PROCESS_ABORTED and friends: the service started and failed for another reason.
    expect(countWindowsUpdateRefusedStarts(scmEvent({ param2: '%%1067' }))).toBe(0)
    expect(countWindowsUpdateRefusedStarts(scmEvent({ id: 7036 }))).toBe(0)
    expect(countWindowsUpdateRefusedStarts(scmEvent({ provider: 'Microsoft-Windows-WindowsUpdateClient' }))).toBe(0)
    expect(countWindowsUpdateRefusedStarts('')).toBe(0)
    expect(countWindowsUpdateRefusedStarts('没有匹配的事件')).toBe(0)
  })

  it('calls the service blocked when it is disabled or keeps being refused, and not after one stray failure', () => {
    expect(isWindowsUpdateServiceBlocked({ startType: 4, refusedStarts: 0 })).toBe(true)
    expect(isWindowsUpdateServiceBlocked({ startType: 3, refusedStarts: 2 })).toBe(true)
    expect(isWindowsUpdateServiceBlocked({ startType: null, refusedStarts: 30 })).toBe(true)
    expect(isWindowsUpdateServiceBlocked({ startType: 3, refusedStarts: 1 })).toBe(false)
    expect(isWindowsUpdateServiceBlocked({ startType: 2, refusedStarts: 0 })).toBe(false)
    expect(isWindowsUpdateServiceBlocked({ startType: null, refusedStarts: 0 })).toBe(false)
  })

  it('reads wevtutil output in the console code page or in UTF-16', () => {
    const text = scmEvent()
    expect(decodeWindowsEventQueryOutput(Buffer.from(text, 'latin1'))).toBe(text)
    expect(countWindowsUpdateRefusedStarts(decodeWindowsEventQueryOutput(Buffer.from(text, 'utf16le')))).toBe(1)
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    expect(decodeWindowsEventQueryOutput(withBom)).toBe(text)
    expect(decodeWindowsEventQueryOutput(Buffer.alloc(0))).toBe('')
  })

  it('looks back one hour at the Service Control Manager 7023 events only', () => {
    expect(buildWindowsUpdateRefusedStartQuery()).toBe(
      "*[System[Provider[@Name='Service Control Manager'] and (EventID=7023) and TimeCreated[timediff(@SystemTime) <= 3600000]]]",
    )
  })

  it('asks reg.exe and wevtutil.exe in System32 by absolute path, with argument arrays and a minimal environment', async () => {
    const queryRegistry = vi.fn(async () => startOutput('0x3'))
    const queryEvents = vi.fn(async () => Buffer.from(scmEvent() + scmEvent() + scmEvent(), 'latin1'))
    await expect(inspectWindowsUpdateServiceState({
      platform: 'win32', resolveSystem32: () => 'C:\\Windows\\System32', queryRegistry, queryEvents,
    })).resolves.toEqual({ startType: 3, refusedStarts: 3 })
    const env = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }
    expect(queryRegistry).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['query', KEY, '/v', 'Start'], env)
    expect(queryEvents).toHaveBeenCalledWith('C:\\Windows\\System32\\wevtutil.exe', [
      'qe', 'System', `/q:${buildWindowsUpdateRefusedStartQuery()}`, '/c:20', '/rd:true', '/f:xml',
    ], env)
  })

  it('answers not blocked instead of throwing when nothing can be read', async () => {
    const fail = async () => { throw new Error('exit 1') }
    await expect(inspectWindowsUpdateServiceState({
      platform: 'win32', resolveSystem32: () => 'C:\\Windows\\System32', queryRegistry: fail, queryEvents: fail,
    })).resolves.toEqual({ startType: null, refusedStarts: 0 })
    await expect(inspectWindowsUpdateServiceBlocked({
      platform: 'win32', resolveSystem32: () => 'C:\\Windows\\System32', queryRegistry: fail, queryEvents: fail,
    })).resolves.toBe(false)
    const untouched = vi.fn(async () => startOutput('0x4'))
    await expect(inspectWindowsUpdateServiceBlocked({
      platform: 'win32', resolveSystem32: () => { throw new Error('no system root') }, queryRegistry: untouched,
    })).resolves.toBe(false)
    await expect(inspectWindowsUpdateServiceBlocked({ platform: 'darwin', queryRegistry: untouched })).resolves.toBe(false)
    expect(untouched).not.toHaveBeenCalled()
  })

  it('reports blocked from either half alone', async () => {
    const system32 = () => 'C:\\Windows\\System32'
    await expect(inspectWindowsUpdateServiceBlocked({
      platform: 'win32', resolveSystem32: system32,
      queryRegistry: async () => startOutput('0x4'), queryEvents: async () => { throw new Error('access denied') },
    })).resolves.toBe(true)
    await expect(inspectWindowsUpdateServiceBlocked({
      platform: 'win32', resolveSystem32: system32,
      queryRegistry: async () => { throw new Error('exit 1') }, queryEvents: async () => Buffer.from(scmEvent() + scmEvent(), 'latin1'),
    })).resolves.toBe(true)
  })
})
