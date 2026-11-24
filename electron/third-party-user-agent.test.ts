import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { clientVersionReportUrl } from './client-version-report'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'
import { relaySiteEndpointChoices, relaySites } from './relay-sites'
import {
  createUserAgentPolicy,
  installThirdPartyUserAgentPolicy,
  isOwnServiceHost,
  ownServiceDomains,
  rewriteRequestUserAgent,
  withoutApplicationProduct,
  type UserAgentSession,
} from './third-party-user-agent'
import { usageStatsOrigins } from './usage-stats'

const productionHosts = createRequire(__filename)(path.join(__dirname, '..', 'scripts', 'ci-block-production-hosts.cjs')) as {
  collectProductionHosts: () => string[]
  productionDomains: readonly string[]
}

const applicationName = 'xingmang-ai-manager'
// 2026-11-24 在沙箱里用项目的 Electron 45.4.1 实际抓到的那一串（安全清单 安-1）。
const linuxUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.24 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36'
const windowsUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.24 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36'
const macUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) xingmang-ai-manager/0.2.24 Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36'
const genericLinuxUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36'

function policyFor(userAgent: string) {
  const policy = createUserAgentPolicy(userAgent, applicationName)
  if (!policy) throw new Error('expected a policy')
  return policy
}

type Listener = Parameters<UserAgentSession['webRequest']['onBeforeSendHeaders']>[1]

function fakeSession() {
  const registrations: { urls: string[], listener: Listener }[] = []
  const session: UserAgentSession = {
    webRequest: {
      onBeforeSendHeaders(filter, listener) {
        registrations.push({ urls: filter.urls, listener })
      },
    },
  }
  return { session, registrations }
}

function fakeApp(userAgentFallback: string) {
  const listeners: ((session: UserAgentSession) => void)[] = []
  const app = {
    userAgentFallback,
    getName: () => applicationName,
    on(event: 'session-created', listener: (session: UserAgentSession) => void) {
      expect(event).toBe('session-created')
      listeners.push(listener)
      return app
    },
  }
  return { app, listeners }
}

function send(listener: Listener, url: string, requestHeaders: Record<string, string>) {
  let response: { requestHeaders?: Record<string, string> } | undefined
  listener({ url, requestHeaders }, (value) => { response = value })
  if (!response) throw new Error('the listener must always answer, or the request hangs')
  return response
}

describe('third-party-user-agent', () => {
  describe('isOwnServiceHost', () => {
    it('accepts the account, line, invoice and update hosts and the download bucket', () => {
      for (const host of [
        'solov.cc', 'xm.solov.cc', 'xm-direct.solov.cc', 'api.solov.cc', 'api-direct.solov.cc', 'console.solov.cc',
        'invoice-xm.solov.cc', 'shenfengwl.fun', 'updatesnew.shenfengwl.fun', 'XM.SOLOV.CC', 'xm.solov.cc.',
        new URL(desktopPackageBucketOrigin).hostname,
      ]) {
        expect(isOwnServiceHost(host), host).toBe(true)
      }
    })

    it('treats look-alike and third-party hosts as outsiders', () => {
      for (const host of [
        '', 'evil-solov.cc', 'solov.cc.evil.example', 'xm.solov.cc.attacker.example', 'notshenfengwl.fun', 'solov.cc-evil.example',
        'codexapp.agentsmirror.com', 'codexapp-r2.agentsmirror.com', 'ipinfo.io', 'ipapi.co', 'myip.ipip.net', 'www.cloudflare.com',
        'registry.npmmirror.com', 'cdn.npmmirror.com', 'nodejs.org', 'www.python.org', 'storage.googleapis.com', 'github.com',
        'opencode.ai', 'www.workbuddy.ai', 'open.feishu.cn', 'ilinkai.weixin.qq.com', 'o4512110916009984.ingest.us.sentry.io',
        'other-bucket-1342302199.cos.ap-shanghai.myqcloud.com', 'cos.ap-shanghai.myqcloud.com', '127.0.0.1', 'localhost',
      ]) {
        expect(isOwnServiceHost(host), host).toBe(false)
      }
    })

    it('uses the same domains the CI host block treats as production', () => {
      expect([...ownServiceDomains].sort()).toEqual([...productionHosts.productionDomains].sort())
    })

    it('covers every own host the client source names, so a new one cannot quietly lose the version', () => {
      const hosts = productionHosts.collectProductionHosts()
      expect(hosts).toContain('xm.solov.cc')
      expect(hosts).toContain('updatesnew.shenfengwl.fun')
      for (const host of hosts) expect(isOwnServiceHost(host), host).toBe(true)
    })

    it('covers the site, line, report and stats addresses the server counts versions from', () => {
      const urls = [
        clientVersionReportUrl,
        ...usageStatsOrigins,
        ...relaySites.flatMap((site) => [site.websiteUrl, site.keysPageUrl, site.invoicePortalUrl, site.accountBaseUrl, ...Object.values(site.providerBaseUrls)]),
        ...relaySites.flatMap((site) => relaySiteEndpointChoices(site.id).map((endpoint) => endpoint.origin)),
      ].filter((url): url is string => typeof url === 'string')
      expect(urls.length).toBeGreaterThan(10)
      for (const url of urls) expect(isOwnServiceHost(new URL(url).hostname), url).toBe(true)
    })
  })

  describe('withoutApplicationProduct', () => {
    it('drops only the application segment and keeps everything else in order', () => {
      expect(withoutApplicationProduct(linuxUserAgent, applicationName)).toBe(genericLinuxUserAgent)
      expect(withoutApplicationProduct(windowsUserAgent, applicationName)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36')
      expect(withoutApplicationProduct(macUserAgent, applicationName)).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.100 Electron/45.4.1 Safari/537.36')
    })

    it('keeps the CI marker the server filters on', () => {
      expect(withoutApplicationProduct(`${linuxUserAgent} ci`, applicationName)).toBe(`${genericLinuxUserAgent} ci`)
    })

    it('drops the segment whatever version it carries, and names with spaces the way Electron compacts them', () => {
      expect(withoutApplicationProduct(linuxUserAgent.replace('0.2.24', '0.3.0-rc.1'), applicationName)).toBe(genericLinuxUserAgent)
      const spaced = linuxUserAgent.replace('xingmang-ai-manager', 'XingmangAIManager')
      expect(withoutApplicationProduct(spaced, 'Xingmang AI Manager')).toBe(genericLinuxUserAgent)
    })

    it('never strips the standard products when the application name collides with one', () => {
      for (const name of ['Electron', 'Chrome', 'Safari', 'Mozilla', 'AppleWebKit', '', ' ']) {
        expect(withoutApplicationProduct(genericLinuxUserAgent, name), name).toBe(genericLinuxUserAgent)
      }
    })
  })

  describe('createUserAgentPolicy', () => {
    it('keeps the Electron default for our own sites and strips the name for everyone else', () => {
      expect(createUserAgentPolicy(linuxUserAgent, applicationName)).toEqual({ branded: linuxUserAgent, generic: genericLinuxUserAgent })
    })

    it('has nothing to do when the default carries no application segment', () => {
      expect(createUserAgentPolicy(genericLinuxUserAgent, applicationName)).toBeNull()
      expect(createUserAgentPolicy('', applicationName)).toBeNull()
      expect(createUserAgentPolicy('xingmang-ai-manager/0.2.24', applicationName)).toBeNull()
    })
  })

  describe('rewriteRequestUserAgent', () => {
    const policy = policyFor(linuxUserAgent)

    it('puts the full user agent back for our own sites', () => {
      expect(rewriteRequestUserAgent('https://xm.solov.cc/api/status', { 'User-Agent': policy.generic, Accept: '*/*' }, policy))
        .toEqual({ 'User-Agent': linuxUserAgent, Accept: '*/*' })
      expect(rewriteRequestUserAgent('https://updatesnew.shenfengwl.fun/xingmang-manager/service-status.json', { 'User-Agent': policy.generic }, policy))
        .toEqual({ 'User-Agent': linuxUserAgent })
      expect(rewriteRequestUserAgent(`${desktopPackageBucketOrigin}/chatgpt/latest.json`, { 'User-Agent': policy.generic }, policy))
        .toEqual({ 'User-Agent': linuxUserAgent })
      expect(rewriteRequestUserAgent('wss://xm.solov.cc/socket', { 'User-Agent': policy.generic }, policy))
        .toEqual({ 'User-Agent': linuxUserAgent })
    })

    it('fills in the full user agent for our own sites when the request has none yet', () => {
      expect(rewriteRequestUserAgent('https://api.solov.cc/v1/models', { Accept: 'application/json' }, policy))
        .toEqual({ Accept: 'application/json', 'User-Agent': linuxUserAgent })
    })

    it('leaves third-party requests on the generic user agent', () => {
      expect(rewriteRequestUserAgent('https://codexapp.agentsmirror.com/latest.json', { 'User-Agent': policy.generic }, policy)).toBeNull()
      expect(rewriteRequestUserAgent('https://ipinfo.io/json', {}, policy)).toBeNull()
    })

    it('strips the name again when something set the full user agent on a third-party request', () => {
      expect(rewriteRequestUserAgent('https://ipapi.co/json/', { 'user-agent': linuxUserAgent, Accept: '*/*' }, policy))
        .toEqual({ 'User-Agent': policy.generic, Accept: '*/*' })
    })

    it('never touches a user agent the caller chose, on either side', () => {
      expect(rewriteRequestUserAgent('https://updatesnew.shenfengwl.fun/xingmang-manager/latest.yml', { 'User-Agent': 'electron-builder' }, policy)).toBeNull()
      expect(rewriteRequestUserAgent('https://registry.npmmirror.com/', { 'User-Agent': 'npm/10.9.0' }, policy)).toBeNull()
    })

    it('treats look-alike hosts as outsiders', () => {
      for (const url of ['https://xm.solov.cc.evil.example/', 'https://evil-solov.cc/', 'https://user@xm.solov.cc.evil.example/']) {
        expect(rewriteRequestUserAgent(url, { 'User-Agent': policy.generic }, policy), url).toBeNull()
        expect(rewriteRequestUserAgent(url, { 'User-Agent': linuxUserAgent }, policy), url).toEqual({ 'User-Agent': policy.generic })
      }
    })

    it('ignores local schemes and treats an unreadable address as a third party', () => {
      expect(rewriteRequestUserAgent('xingmang://app/index.html', { 'User-Agent': linuxUserAgent }, policy)).toBeNull()
      expect(rewriteRequestUserAgent('not a url', { 'User-Agent': policy.generic }, policy)).toBeNull()
      expect(rewriteRequestUserAgent('not a url', { 'User-Agent': linuxUserAgent }, policy)).toEqual({ 'User-Agent': policy.generic })
    })
  })

  describe('installThirdPartyUserAgentPolicy', () => {
    it('switches the default to the generic user agent and hooks every session created afterwards', () => {
      const { app, listeners } = fakeApp(`${linuxUserAgent} ci`)
      installThirdPartyUserAgentPolicy(app)
      expect(app.userAgentFallback).toBe(`${genericLinuxUserAgent} ci`)
      expect(listeners).toHaveLength(1)

      const { session, registrations } = fakeSession()
      listeners[0](session)
      expect(registrations).toHaveLength(1)
      expect(registrations[0].urls).toEqual(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'])
      const listener = registrations[0].listener
      expect(send(listener, 'https://xm.solov.cc/api/status', { 'User-Agent': `${genericLinuxUserAgent} ci` }))
        .toEqual({ requestHeaders: { 'User-Agent': `${linuxUserAgent} ci` } })
      expect(send(listener, 'https://codexapp.agentsmirror.com/latest.json', { 'User-Agent': `${genericLinuxUserAgent} ci` })).toEqual({})
    })

    it('hooks a session once however often it is handed over', () => {
      const { app, listeners } = fakeApp(linuxUserAgent)
      const apply = installThirdPartyUserAgentPolicy(app)
      const { session, registrations } = fakeSession()
      listeners[0](session)
      apply(session)
      apply(session)
      expect(registrations).toHaveLength(1)
      const other = fakeSession()
      apply(other.session)
      expect(other.registrations).toHaveLength(1)
    })

    it('still answers when working out the header fails, so no request hangs', () => {
      const { app, listeners } = fakeApp(linuxUserAgent)
      installThirdPartyUserAgentPolicy(app)
      const { session, registrations } = fakeSession()
      listeners[0](session)
      const hostile = Object.defineProperty({ requestHeaders: {} }, 'url', { get() { throw new Error('boom') } }) as { url: string, requestHeaders: Record<string, string> }
      let response: unknown
      registrations[0].listener(hostile, (value) => { response = value })
      expect(response).toEqual({})
    })

    it('does nothing when the default user agent carries no name or cannot be read', () => {
      const plain = fakeApp(genericLinuxUserAgent)
      const apply = installThirdPartyUserAgentPolicy(plain.app)
      expect(plain.app.userAgentFallback).toBe(genericLinuxUserAgent)
      expect(plain.listeners).toHaveLength(0)
      const { session, registrations } = fakeSession()
      apply(session)
      expect(registrations).toHaveLength(0)

      const unreadable = {
        get userAgentFallback(): string { throw new Error('not ready') },
        set userAgentFallback(_value: string) { throw new Error('not ready') },
        getName: () => applicationName,
        on: () => undefined,
      }
      expect(() => installThirdPartyUserAgentPolicy(unreadable)(session)).not.toThrow()
      expect(registrations).toHaveLength(0)
    })

    it('never lets a session that refuses the hook break startup', () => {
      const { app, listeners } = fakeApp(linuxUserAgent)
      installThirdPartyUserAgentPolicy(app)
      const refusing: UserAgentSession = { webRequest: { onBeforeSendHeaders() { throw new Error('destroyed') } } }
      expect(() => listeners[0](refusing)).not.toThrow()
    })
  })

  it('is the only place that hooks onBeforeSendHeaders, because Electron keeps just the last listener per session', () => {
    const electronRoot = __dirname
    const offenders: string[] = []
    function walk(directory: string): void {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(entryPath)
        } else if (/\.ts$/.test(entry.name) && !/\.test(?:-support)?\.ts$/.test(entry.name)) {
          if (fs.readFileSync(entryPath, 'utf8').includes('onBeforeSendHeaders(')) offenders.push(path.relative(electronRoot, entryPath))
        }
      }
    }
    walk(electronRoot)
    expect(offenders).toEqual(['third-party-user-agent.ts'])
  })

  // Random inputs (fast-check). The promise: whatever the address, a request that
  // goes out with the app's own default never carries the application name to a
  // host outside our domains, and our own hosts always get the full string back.
  describe('with random inputs', () => {
    const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])?$/)
    const outsiderHost = fc.array(label, { minLength: 1, maxLength: 4 })
      .chain((labels) => fc.constantFrom('com', 'cn', 'io', 'cc', 'fun', 'example').map((tld) => [...labels, tld].join('.')))
      .filter((host) => !isOwnServiceHost(host))
    const ownHost = fc.tuple(fc.array(label, { maxLength: 3 }), fc.constantFrom(...ownServiceDomains))
      .map(([labels, domain]) => [...labels, domain].join('.'))
    const scheme = fc.constantFrom('http', 'https', 'ws', 'wss')
    const pathPart = fc.stringMatching(/^[a-zA-Z0-9/._~-]{0,30}$/)
    const policy = policyFor(windowsUserAgent)
    const defaultHeader = fc.constantFrom<Record<string, string>>({}, { 'User-Agent': policy.generic }, { 'User-Agent': policy.branded }, { 'user-agent': policy.branded })

    it('never sends the application name to a third-party host', () => {
      fc.assert(fc.property(scheme, outsiderHost, pathPart, defaultHeader, (protocol, host, rest, headers) => {
        const url = `${protocol}://${host}/${rest}`
        const rewritten = rewriteRequestUserAgent(url, headers, policy) ?? headers
        const values = Object.entries(rewritten).filter(([name]) => name.toLowerCase() === 'user-agent').map(([, value]) => value)
        expect(values.length).toBeLessThanOrEqual(1)
        for (const value of values) expect(value).not.toContain(applicationName)
      }))
    })

    it('always sends the full user agent to our own hosts', () => {
      fc.assert(fc.property(scheme, ownHost, pathPart, defaultHeader, (protocol, host, rest, headers) => {
        const url = `${protocol}://${host.toUpperCase()}/${rest}`
        const rewritten = rewriteRequestUserAgent(url, headers, policy) ?? headers
        const values = Object.entries(rewritten).filter(([name]) => name.toLowerCase() === 'user-agent').map(([, value]) => value)
        expect(values).toEqual([windowsUserAgent])
      }))
    })
  })
})
