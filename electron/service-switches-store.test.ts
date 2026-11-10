import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseServiceStatusDocument, pickServiceSwitches, resolveFeaturesOffFor, resolveHiddenPaymentMethodsFor, resolveKnownIssuesFor, type ServiceSwitches } from './service-status'
import { createServiceSwitchesStore, parseStoredServiceSwitches } from './service-switches-store'

const directories: string[] = []

function temporaryFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-service-switches-'))
  directories.push(directory)
  return path.join(directory, 'service-switches.json')
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

// 键和字段的先后照状态文件解析出来的那样（service-status.ts 的 readKnownIssues 这几个）。
const switches: ServiceSwitches = {
  knownIssues: [{ page: 'recharge', message: '支付宝暂时打不开，请先用微信付款。', action: 'support', versions: ['0.2.23'], platforms: ['windows'] }],
  paymentMethodsOff: [{ method: 'alipay' }],
  featuresOff: [{ feature: 'video-studio' }, { feature: 'install:codex', platforms: ['mac'] }],
}

describe('service switches store', () => {
  it('reads nothing on a machine that never remembered a status file', () => {
    expect(createServiceSwitchesStore({ filePath: temporaryFile() }).read()).toBeNull()
  })

  it('reads the remembered switches back from a fresh store, scopes and all', async () => {
    const filePath = temporaryFile()
    await createServiceSwitchesStore({ filePath }).write(switches)
    expect(createServiceSwitchesStore({ filePath }).read()).toEqual(switches)
  })

  it('remembers that the status file stopped switching anything off', async () => {
    const filePath = temporaryFile()
    const store = createServiceSwitchesStore({ filePath })
    await store.write(switches)
    await store.write({})
    expect(createServiceSwitchesStore({ filePath }).read()).toEqual({})
  })

  it('keeps exactly the three switches out of a status file that was read', async () => {
    const status = parseServiceStatusDocument(JSON.stringify({
      maintenance: { message: '升级中' },
      badVersions: ['0.2.21'],
      minimumVersion: '0.2.22',
      updatedAt: '2026-11-09T00:00:00Z',
      ...switches,
    }), new Date('2026-11-10T00:00:00Z'))
    if (!status) throw new Error('status file did not parse')
    expect(pickServiceSwitches(status)).toEqual(switches)
    expect(pickServiceSwitches({ maintenance: null })).toEqual({})
    const filePath = temporaryFile()
    await createServiceSwitchesStore({ filePath }).write(pickServiceSwitches(status))
    expect(Object.keys(JSON.parse(fs.readFileSync(filePath, 'utf8')))).toEqual(['version', 'knownIssues', 'paymentMethodsOff', 'featuresOff'])
  })

  it('keeps the later of two writes issued back to back', async () => {
    const filePath = temporaryFile()
    const store = createServiceSwitchesStore({ filePath })
    await Promise.all([
      store.write(switches),
      store.write({ featuresOff: [{ feature: 'codex-remote' }] }),
    ])
    expect(createServiceSwitchesStore({ filePath }).read()).toEqual({ featuresOff: [{ feature: 'codex-remote' }] })
  })

  it('leaves the disk alone when the switches have not changed since they were read or written', async () => {
    const filePath = temporaryFile()
    await createServiceSwitchesStore({ filePath }).write(switches)
    const store = createServiceSwitchesStore({ filePath })
    expect(store.read()).toEqual(switches)
    fs.rmSync(filePath)
    await store.write(structuredClone(switches))
    expect(fs.existsSync(filePath)).toBe(false)
    await store.write({ paymentMethodsOff: [{ method: 'wxpay' }] })
    await store.write({ paymentMethodsOff: [{ method: 'wxpay' }] })
    expect(createServiceSwitchesStore({ filePath }).read()).toEqual({ paymentMethodsOff: [{ method: 'wxpay' }] })
  })

  it('writes the same switches again after a write that did not land', async () => {
    const parent = path.dirname(temporaryFile())
    const filePath = path.join(parent, 'blocked', 'service-switches.json')
    fs.writeFileSync(path.dirname(filePath), 'not a directory')
    const store = createServiceSwitchesStore({ filePath })
    await expect(store.write(switches)).rejects.toThrow()
    fs.rmSync(path.dirname(filePath))
    await store.write(switches)
    expect(createServiceSwitchesStore({ filePath }).read()).toEqual(switches)
  })

  it('rewrites a damaged record on the next successful read', async () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, 'not json')
    const store = createServiceSwitchesStore({ filePath })
    expect(store.read()).toBeNull()
    await store.write({})
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1}\n')
  })

  it('treats a damaged or foreign record as never remembered', () => {
    expect(parseStoredServiceSwitches('not json')).toBeNull()
    expect(parseStoredServiceSwitches('[]')).toBeNull()
    expect(parseStoredServiceSwitches(JSON.stringify(switches))).toBeNull()
    expect(parseStoredServiceSwitches(JSON.stringify({ version: 2, ...switches }))).toBeNull()
  })

  it('revalidates every entry the way the status file is read', () => {
    // 带网址的提示、认不出的功能、不合格的付款方式名、读不懂的范围都整条丢掉，写对的照用。
    expect(parseStoredServiceSwitches(JSON.stringify({
      version: 1,
      knownIssues: [
        { page: 'home', message: '请到 https://example.com 充值' },
        { page: 'nowhere', message: '以后的版本才有这一页' },
        { page: 'chat', message: '聊天先换个型号用。', action: 'open-anything' },
      ],
      paymentMethodsOff: [{ method: 'ali pay' }, { method: 'WXPAY' }],
      featuresOff: [{ feature: 'everything' }, { feature: 'launch:grok', versions: 'all' }, { feature: 'acceleration' }],
    }))).toEqual({
      knownIssues: [{ page: 'chat', message: '聊天先换个型号用。' }],
      paymentMethodsOff: [{ method: 'wxpay' }],
      featuresOff: [{ feature: 'acceleration' }],
    })
  })

  it('narrows the remembered switches to the running version and package only when they are used', async () => {
    // 记的是没筛过的原样：升到 0.2.24 的电脑不再认只给 0.2.23 的那条，没写版本的照样认。
    const filePath = temporaryFile()
    await createServiceSwitchesStore({ filePath }).write(switches)
    const remembered = createServiceSwitchesStore({ filePath }).read()
    expect(resolveKnownIssuesFor(remembered, '0.2.23', ['windows', 'windows-x64'])).toEqual([
      { page: 'recharge', message: '支付宝暂时打不开，请先用微信付款。', action: 'support' },
    ])
    expect(resolveKnownIssuesFor(remembered, '0.2.24', ['windows', 'windows-x64'])).toEqual([])
    expect(resolveFeaturesOffFor(remembered, '0.2.24', ['windows', 'windows-x64'])).toEqual(['video-studio'])
    expect(resolveFeaturesOffFor(remembered, '0.2.24', ['mac', 'mac-arm64'])).toEqual(['video-studio', 'install:codex'])
    expect(resolveHiddenPaymentMethodsFor(remembered, '0.2.24', ['mac', 'mac-arm64'])).toEqual(['alipay'])
  })

  it('reads an oversized record as never remembered', () => {
    const filePath = temporaryFile()
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, ...switches, padding: 'x'.repeat(64 * 1024) }))
    expect(createServiceSwitchesStore({ filePath }).read()).toBeNull()
  })

  it('refuses a relative path', () => {
    expect(() => createServiceSwitchesStore({ filePath: 'service-switches.json' })).toThrow('绝对路径')
  })
})
