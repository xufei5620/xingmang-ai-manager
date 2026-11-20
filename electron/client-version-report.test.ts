import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildClientVersionReport,
  clientVersionReportDay,
  clientVersionReportDigest,
  clientVersionReportMaxAttemptsPerDay,
  clientVersionReportUrl,
  emptyClientVersionReportState,
  parseClientVersionReportState,
  planClientVersionReport,
  serializeClientVersionReport,
  serializeClientVersionReportState,
  shouldSendClientVersionReport,
  type ClientVersionReportInput,
} from './client-version-report'

function input(overrides: Partial<ClientVersionReportInput> = {}): ClientVersionReportInput {
  return { siteId: 'solov', authenticated: true, userId: 1234, appVersion: '0.2.25', platform: 'win32', arch: 'x64', ...overrides }
}

describe('client version report', () => {
  it('sends to the fixed console address over https', () => {
    expect(clientVersionReportUrl).toBe('https://console.solov.cc/api/public/client-versions')
  })

  it('builds exactly the five agreed fields for a signed-in account', () => {
    expect(buildClientVersionReport(input())).toEqual({ site: 'xm', userId: 1234, version: '0.2.25', os: 'windows', arch: 'x64' })
    expect(buildClientVersionReport(input({ siteId: 'solov-api', platform: 'darwin', arch: 'arm64', userId: 7 })))
      .toEqual({ site: 'api', userId: 7, version: '0.2.25', os: 'macos', arch: 'arm64' })
    expect(buildClientVersionReport(input({ platform: 'linux' }))?.os).toBe('linux')
  })

  it('reports nothing when signed out or when any field falls outside its closed set', () => {
    expect(buildClientVersionReport(input({ authenticated: false }))).toBeNull()
    expect(buildClientVersionReport(input({ siteId: 'other' }))).toBeNull()
    expect(buildClientVersionReport(input({ siteId: 'toString' }))).toBeNull()
    expect(buildClientVersionReport(input({ platform: 'freebsd' }))).toBeNull()
    expect(buildClientVersionReport(input({ arch: 'ia32' }))).toBeNull()
    expect(buildClientVersionReport(input({ userId: 0 }))).toBeNull()
    expect(buildClientVersionReport(input({ userId: -3 }))).toBeNull()
    expect(buildClientVersionReport(input({ userId: 1.5 }))).toBeNull()
    expect(buildClientVersionReport(input({ userId: '1234' }))).toBeNull()
    expect(buildClientVersionReport(input({ userId: 2_147_483_648 }))).toBeNull()
    expect(buildClientVersionReport(input({ appVersion: '0.2.25 (dev)' }))).toBeNull()
    expect(buildClientVersionReport(input({ appVersion: '' }))).toBeNull()
  })

  it('serializes the body in the order the console expects', () => {
    const report = buildClientVersionReport(input())
    expect(report).not.toBeNull()
    if (!report) return
    expect(serializeClientVersionReport(report)).toBe('{"schema":1,"site":"xm","user_id":1234,"version":"0.2.25","os":"windows","arch":"x64"}')
  })

  it('keys the local record on everything that was sent, so a new account or version reports again', () => {
    const report = buildClientVersionReport(input())
    const otherUser = buildClientVersionReport(input({ userId: 1235 }))
    const newer = buildClientVersionReport(input({ appVersion: '0.2.26' }))
    if (!report || !otherUser || !newer) throw new Error('fixture should build')
    const digest = clientVersionReportDigest(report)
    expect(digest).toMatch(/^[0-9a-f]{32}$/)
    expect(clientVersionReportDigest(report)).toBe(digest)
    expect(clientVersionReportDigest(otherUser)).not.toBe(digest)
    expect(clientVersionReportDigest(newer)).not.toBe(digest)
  })

  it('stays quiet in development, local builds, CI and when switched off by the environment', () => {
    expect(shouldSendClientVersionReport({ packaged: true, localBuild: false, env: {} })).toBe(true)
    expect(shouldSendClientVersionReport({ packaged: false, localBuild: false, env: {} })).toBe(false)
    expect(shouldSendClientVersionReport({ packaged: true, localBuild: true, env: {} })).toBe(false)
    expect(shouldSendClientVersionReport({ packaged: true, localBuild: false, env: { CI: 'true' } })).toBe(false)
    expect(shouldSendClientVersionReport({ packaged: true, localBuild: false, env: { XINGMANG_DISABLE_CLIENT_VERSION_REPORT: '1' } })).toBe(false)
  })

  it('splits days in UTC', () => {
    expect(clientVersionReportDay(new Date('2026-11-20T23:59:59Z'))).toBe('20261120')
    expect(clientVersionReportDay(new Date('2026-11-21T00:00:00Z'))).toBe('20261121')
  })

  it('plans one send a day per report and caps attempts across the day', () => {
    const empty = emptyClientVersionReportState()
    const first = planClientVersionReport(empty, 'a'.repeat(32), '20261120')
    expect(first).toEqual({ sentDigest: null, sentDay: null, attemptDay: '20261120', attempts: 1 })

    const sent = { ...first!, sentDigest: 'a'.repeat(32), sentDay: '20261120' }
    expect(planClientVersionReport(sent, 'a'.repeat(32), '20261120')).toBeNull()
    // A different account or version the same day is a new report.
    expect(planClientVersionReport(sent, 'b'.repeat(32), '20261120')?.attempts).toBe(2)
    // The next day starts a fresh budget.
    expect(planClientVersionReport({ ...sent, attempts: clientVersionReportMaxAttemptsPerDay }, 'a'.repeat(32), '20261121')?.attempts).toBe(1)
    expect(planClientVersionReport({ ...empty, attemptDay: '20261120', attempts: clientVersionReportMaxAttemptsPerDay }, 'a'.repeat(32), '20261120')).toBeNull()
  })

  it('round-trips its local record and treats anything unrecognised as never sent', () => {
    const state = { sentDigest: 'c'.repeat(32), sentDay: '20261120', attemptDay: '20261120', attempts: 2 }
    expect(parseClientVersionReportState(serializeClientVersionReportState(state))).toEqual(state)
    expect(parseClientVersionReportState('not json')).toEqual(emptyClientVersionReportState())
    expect(parseClientVersionReportState('[]')).toEqual(emptyClientVersionReportState())
    expect(parseClientVersionReportState(JSON.stringify({ ...state, version: 2 }))).toEqual(emptyClientVersionReportState())
    expect(parseClientVersionReportState(JSON.stringify({ version: 1, ...state, sentDigest: '../../etc' })).sentDigest).toBeNull()
    expect(parseClientVersionReportState(JSON.stringify({ version: 1, ...state, attempts: 999 })).attempts).toBe(clientVersionReportMaxAttemptsPerDay)
    expect(parseClientVersionReportState(JSON.stringify({ version: 1, ...state, sentDay: 'today' }))).toMatchObject({ sentDigest: null, sentDay: null })
  })

  describe('with random inputs', () => {
    it('never puts anything but the five closed fields on the wire', () => {
      fc.assert(fc.property(
        fc.record({
          siteId: fc.oneof(fc.constantFrom('solov', 'solov-api'), fc.string()),
          authenticated: fc.boolean(),
          userId: fc.oneof(fc.integer(), fc.double(), fc.string(), fc.constant(null)),
          appVersion: fc.oneof(fc.constantFrom('0.2.25', '1.0.0-beta.1'), fc.string()),
          platform: fc.oneof(fc.constantFrom('win32', 'darwin', 'linux'), fc.string()),
          arch: fc.oneof(fc.constantFrom('x64', 'arm64'), fc.string()),
        }),
        (candidate) => {
          const report = buildClientVersionReport(candidate)
          if (!report) return
          const body = JSON.parse(serializeClientVersionReport(report)) as Record<string, unknown>
          expect(Object.keys(body)).toEqual(['schema', 'site', 'user_id', 'version', 'os', 'arch'])
          expect(['xm', 'api']).toContain(body.site)
          expect(['windows', 'macos', 'linux']).toContain(body.os)
          expect(['x64', 'arm64']).toContain(body.arch)
          expect(Number.isSafeInteger(body.user_id) && (body.user_id as number) > 0).toBe(true)
          expect(String(body.version)).toMatch(/^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,30})?$/)
          expect(candidate.authenticated).toBe(true)
        },
      ))
    })
  })
})
