import { describe, expect, it } from 'vitest'
import {
  dnsCheckOutcome,
  dnsCheckSummaries,
  dnsLineLegitimateAddresses,
  dnsLineVerdict,
  dnsSettingsGuidance,
  publicDnsServers,
  type DnsLineVerdict,
} from './diagnostics-dns-check'
import type { RouteStatus } from './route-status-file'

// 全是文档段和 CF 公布的段：不写任何星芒线路的真实地址。
const cloudflare = '104.16.1.1'
const cloudflareV6 = '2606:4700::6810:101'
const legitDirect = '192.0.2.10'
const hijacked = '203.0.113.9'
const otherDirect = '198.51.100.7'

function statusWith(legitIps: string[], proxied = false): RouteStatus {
  return {
    updatedAt: null,
    incident: { line: null, state: 'none', since: null },
    lines: { direct: { target: 'lax', proxied, healthy: true, legitIps } },
    hkEnabled: false,
    hkRecommended: false,
  }
}

describe('dnsLineVerdict', () => {
  it('accepts the line 1 answer inside the Cloudflare ranges without asking the public DNS', () => {
    expect(dnsLineVerdict({ system: [cloudflare, cloudflareV6], public: null, legitimate: { cloudflare: true } })).toBe('ok')
  })

  it('calls a line 1 answer outside Cloudflare wrong when the public DNS answers Cloudflare', () => {
    expect(dnsLineVerdict({ system: [hijacked], public: [cloudflare], legitimate: { cloudflare: true } })).toBe('wrong')
  })

  it('accepts any answer the public DNS agrees with, including an IPv4-mapped spelling', () => {
    expect(dnsLineVerdict({ system: [`::ffff:${otherDirect}`], public: [otherDirect], legitimate: null })).toBe('ok')
  })

  it('leaves fake-ip and private answers to the proxy software', () => {
    expect(dnsLineVerdict({ system: ['198.18.0.12'], public: [cloudflare], legitimate: { cloudflare: true } })).toBe('proxy')
    expect(dnsLineVerdict({ system: ['10.0.0.8'], public: [otherDirect], legitimate: null })).toBe('proxy')
  })

  it('says missing only when the public DNS finds what the computer cannot', () => {
    expect(dnsLineVerdict({ system: null, public: [cloudflare], legitimate: { cloudflare: true } })).toBe('missing')
    expect(dnsLineVerdict({ system: [], public: [cloudflare], legitimate: { cloudflare: true } })).toBe('missing')
    expect(dnsLineVerdict({ system: null, public: null, legitimate: { cloudflare: true } })).toBe('unknown')
  })

  it('does not judge an unknown answer the public DNS cannot confirm', () => {
    expect(dnsLineVerdict({ system: [hijacked], public: null, legitimate: { cloudflare: true } })).toBe('unknown')
  })

  it('does not judge when the public DNS also disagrees with the known addresses', () => {
    // 手里的合法地址旧了：两边都不在里面，不下结论。
    expect(dnsLineVerdict({ system: [hijacked], public: [otherDirect], legitimate: { cloudflare: false, ips: [legitDirect] } })).toBe('unknown')
    expect(dnsLineVerdict({ system: [hijacked], public: [legitDirect], legitimate: { cloudflare: false, ips: [legitDirect] } })).toBe('wrong')
  })

  it('accepts a line 2 answer inside Cloudflare when there is no status file to compare with', () => {
    // 服务端出事时会把线路2 切到 CF，电脑缓存着新地址、公共 DNS 还给旧的也说得通。
    expect(dnsLineVerdict({ system: [cloudflare], public: [otherDirect], legitimate: null })).toBe('ok')
    expect(dnsLineVerdict({ system: [hijacked], public: [otherDirect], legitimate: null })).toBe('wrong')
  })
})

describe('dnsLineLegitimateAddresses', () => {
  it('reads line 1 as Cloudflare and line 2 from the status file for the xm account only', () => {
    expect(dnsLineLegitimateAddresses('solov', 'primary', null)).toEqual({ cloudflare: true })
    expect(dnsLineLegitimateAddresses('solov', 'direct', statusWith([legitDirect]))).toEqual({ cloudflare: false, ips: [legitDirect] })
    expect(dnsLineLegitimateAddresses('solov', 'direct', statusWith([], true))).toEqual({ cloudflare: true })
    expect(dnsLineLegitimateAddresses('solov', 'direct', null)).toBeNull()
    // 历史账号没有状态文件，线路2 只能和公共 DNS 对。
    expect(dnsLineLegitimateAddresses('solov-api', 'direct', statusWith([legitDirect]))).toBeNull()
    expect(dnsLineLegitimateAddresses('solov-api', 'primary', null)).toEqual({ cloudflare: true })
  })
})

describe('dnsCheckOutcome', () => {
  function outcome(line1: DnsLineVerdict, line2: DnsLineVerdict, route?: { automatic: boolean; line: 'primary' | 'direct' }, platform: NodeJS.Platform = 'win32') {
    return dnsCheckOutcome({ siteId: 'solov', verdicts: { primary: line1, direct: line2 }, route, platform })
  }

  it('passes when the computer DNS answers right', () => {
    expect(outcome('ok', 'ok')).toEqual({ state: 'pass', summary: dnsCheckSummaries.ok, details: { siteId: 'solov', line1: 'ok', line2: 'ok' } })
    expect(outcome('ok', 'unknown').summary).toBe(dnsCheckSummaries.ok)
  })

  it('passes and stays quiet when proxy software took over the lookups', () => {
    expect(outcome('proxy', 'proxy')).toMatchObject({ state: 'pass', summary: dnsCheckSummaries.proxy })
  })

  it('passes with a neutral line when nothing could be confirmed', () => {
    expect(outcome('unknown', 'unknown')).toMatchObject({ state: 'pass', summary: dnsCheckSummaries.unknown })
  })

  it('fails with the DNS servers to use and the steps when both lines are answered wrong', () => {
    const result = outcome('wrong', 'wrong')
    expect(result.state).toBe('fail')
    expect(result.summary).toBe(dnsCheckSummaries.wrong + dnsSettingsGuidance('win32'))
    expect(result.summary).toContain('223.5.5.5 和 119.29.29.29')
    expect(result.details).toMatchObject({ fix: 'open-dns-settings' })
  })

  it('says the DNS cannot find the address when both lines are missing', () => {
    expect(outcome('missing', 'missing').summary).toBe(dnsCheckSummaries.missing + dnsSettingsGuidance('win32'))
    // 一条查错、一条没查出来：照「查错了」说。
    expect(outcome('wrong', 'unknown')).toMatchObject({ state: 'fail', summary: dnsCheckSummaries.wrong + dnsSettingsGuidance('win32') })
  })

  it('offers no settings button where there is no settings page to open', () => {
    const result = outcome('wrong', 'wrong', undefined, 'linux')
    expect(result.summary).toContain(dnsSettingsGuidance('linux'))
    expect(result.details?.fix).toBeUndefined()
  })

  it('passes when only one line is wrong and automatic picks the other', () => {
    expect(outcome('wrong', 'ok', { automatic: true, line: 'primary' })).toEqual({
      state: 'pass',
      summary: '你这台电脑用的 DNS 把星芒线路1的地址查错了，线路2是对的，星芒会自动用线路2，不影响使用。想彻底解决，把电脑的 DNS 改成 223.5.5.5 和 119.29.29.29。',
      details: { siteId: 'solov', line1: 'wrong', line2: 'ok' },
    })
    expect(outcome('ok', 'missing').summary)
      .toBe('你这台电脑用的 DNS 查不到星芒线路2的地址，线路1是对的，星芒会自动用线路1，不影响使用。想彻底解决，把电脑的 DNS 改成 223.5.5.5 和 119.29.29.29。')
  })

  it('passes when the fixed line is the right one', () => {
    expect(outcome('wrong', 'ok', { automatic: false, line: 'direct' })).toMatchObject({
      state: 'pass',
      summary: '你这台电脑用的 DNS 把星芒线路1的地址查错了，线路2是对的。你选的是「只用线路2」，不影响使用。',
    })
  })

  it('warns and points at the line setting when the fixed line is the wrong one', () => {
    const result = outcome('ok', 'wrong', { automatic: false, line: 'direct' }, 'darwin')
    expect(result).toMatchObject({ state: 'warn', details: { line1: 'ok', line2: 'wrong', fix: 'open-dns-settings', reroute: 'auto' } })
    expect(result.summary).toBe('你这台电脑用的 DNS 把星芒线路2的地址查错了，线路1是对的。你选的是「只用线路2」，AI 工具会连不上：'
      + '点「去处理」改成「自动」，或者把电脑的 DNS 改成 223.5.5.5 和 119.29.29.29。' + dnsSettingsGuidance('darwin'))
  })
})

describe('dnsSettingsGuidance', () => {
  it('walks each system through its own settings page', () => {
    expect(dnsSettingsGuidance('win32')).toContain('DNS 服务器分配')
    expect(dnsSettingsGuidance('darwin')).toContain('详细信息')
    expect(dnsSettingsGuidance('linux')).toContain('系统设置里的「网络」')
  })
})

describe('publicDnsServers', () => {
  it('compares against the same two servers the home notice tells customers to use', () => {
    expect(publicDnsServers).toEqual(['223.5.5.5', '119.29.29.29'])
  })
})
