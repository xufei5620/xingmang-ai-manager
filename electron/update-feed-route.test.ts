import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyDirectFeedFailure,
  locateDirectUpdateFeed,
  packagedUpdateFeed,
  resolveDirectUpdateFeed,
  type UpdateFeedRouteOptions,
} from './update-feed-route'

const primaryUrl = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
const directUrl = 'https://xm-direct.solov.cc/xingmang-manager/'
const productionConfig = `provider: generic\nurl: ${primaryUrl}\nupdaterCacheDirName: xingmang-ai-manager-updater\n`
const directWindows: UpdateFeedRouteOptions = {
  activeSolovEndpointId: 'direct',
  platform: 'win32',
  isPackaged: true,
}

describe('resolveDirectUpdateFeed', () => {
  it('selects only the fixed HTTPS mirror and carries no credentials or signature options', () => {
    const config = `${productionConfig}publisherName:\n  - XingMang\n`
    expect(resolveDirectUpdateFeed(config, directWindows)).toEqual({
      feed: { provider: 'generic', url: directUrl },
      serviceStatusUrl: `${directUrl}service-status.json`,
    })
  })

  it('leaves the default route, development builds and other platforms on their packaged feed', () => {
    for (const options of [
      { ...directWindows, activeSolovEndpointId: 'primary' as const },
      { ...directWindows, isPackaged: false },
      { ...directWindows, localBuild: true },
      { ...directWindows, platform: 'darwin' },
      { ...directWindows, platform: 'linux' },
    ]) {
      expect(resolveDirectUpdateFeed(productionConfig, options)).toBeNull()
    }
  })

  it('preserves explicit build-time update URLs and every non-default channel configuration', () => {
    for (const url of [
      'https://updatesnew.shenfengwl.fun/xingmang-manager/beta/',
      'https://updates.shenfengwl.fun/xingmang-manager/',
      'https://updates.example.test/xingmang-manager/',
      'http://127.0.0.1:8123/',
      directUrl,
    ]) {
      expect(resolveDirectUpdateFeed(`provider: generic\nurl: ${url}\n`, directWindows)).toBeNull()
    }
    for (const extra of ['channel: beta', 'requestHeaders:\n  Authorization: Bearer test', 'useMultipleRangeRequest: false']) {
      expect(resolveDirectUpdateFeed(`${productionConfig}${extra}\n`, directWindows)).toBeNull()
    }
  })

  it('requires an exact production URL instead of accepting related hosts, paths or credentials', () => {
    for (const url of [
      `${primaryUrl}?token=test`,
      `${primaryUrl}#fragment`,
      'https://user:pass@updatesnew.shenfengwl.fun/xingmang-manager/',
      'https://updatesnew.shenfengwl.fun.evil.test/xingmang-manager/',
      'https://updatesnew.shenfengwl.fun/xingmang-manager/../other/',
      'http://updatesnew.shenfengwl.fun/xingmang-manager/',
    ]) {
      expect(resolveDirectUpdateFeed(`provider: generic\nurl: ${url}\n`, directWindows)).toBeNull()
    }
  })

  it('accepts quoted YAML but refuses malformed, ambiguous, aliased and oversized configurations', () => {
    expect(resolveDirectUpdateFeed(`provider: generic\nurl: '${primaryUrl}'\n`, directWindows)?.feed.url).toBe(directUrl)
    for (const config of [
      '', '[]', 'null', 'provider: [',
      `provider: github\nurl: ${primaryUrl}\n`,
      `${productionConfig}url: https://other.example.test/\n`,
      `${productionConfig}provider: generic\n`,
      `provider: &kind generic\nurl: ${primaryUrl}\npublisherName: *kind\n`,
      `provider: generic\nurl: !custom ${primaryUrl}\n`,
      `${productionConfig}${'#'.repeat(16 * 1024)}`,
    ]) {
      expect(resolveDirectUpdateFeed(config, directWindows)).toBeNull()
    }
  })
})

describe('locateDirectUpdateFeed', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  it('reads without changing publisher verification or cache configuration on disk', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-update-feed-'))
    directories.push(directory)
    const filePath = path.join(directory, 'app-update.yml')
    const config = `${productionConfig}publisherName:\n  - XingMang\n`
    fs.writeFileSync(filePath, config)
    expect(locateDirectUpdateFeed(filePath, directWindows)?.feed.url).toBe(directUrl)
    expect(fs.readFileSync(filePath, 'utf8')).toBe(config)
    expect(locateDirectUpdateFeed(path.join(directory, 'missing.yml'), directWindows)).toBeNull()
  })

  it('refuses linked or oversized update configuration files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-update-feed-'))
    directories.push(directory)
    const filePath = path.join(directory, 'app-update.yml')
    fs.writeFileSync(filePath, productionConfig)
    const linkedPath = path.join(directory, 'linked.yml')
    fs.linkSync(filePath, linkedPath)
    expect(locateDirectUpdateFeed(linkedPath, directWindows)).toBeNull()
    const oversized = path.join(directory, 'oversized.yml')
    fs.writeFileSync(oversized, `${productionConfig}${'#'.repeat(16 * 1024)}`)
    expect(locateDirectUpdateFeed(oversized, directWindows)).toBeNull()
  })
})

describe('packagedUpdateFeed', () => {
  it('points back at the packaged production feed and its status file', () => {
    expect(packagedUpdateFeed()).toEqual({
      feed: { provider: 'generic', url: primaryUrl },
      serviceStatusUrl: `${primaryUrl}service-status.json`,
    })
  })
})

// 直连那份更新地址没查通时，哪些失败值得换回包里那份再查一次、哪些要报给线路那边。
describe('classifyDirectFeedFailure', () => {
  function httpError(statusCode: number): Error {
    return Object.assign(new Error(`HttpError: ${statusCode}`), { statusCode })
  }

  it('retries a gateway error and an allowlist 404 on the packaged feed, but only reports the gateway errors', () => {
    expect(classifyDirectFeedFailure(httpError(502))).toEqual({ reason: 'http-502', lineFailure: true })
    expect(classifyDirectFeedFailure(httpError(503))).toEqual({ reason: 'http-503', lineFailure: true })
    expect(classifyDirectFeedFailure(new Error('download failed', { cause: httpError(504) }))).toEqual({ reason: 'http-504', lineFailure: true })
    expect(classifyDirectFeedFailure(httpError(404))).toEqual({ reason: 'http-404', lineFailure: false })
  })

  it('leaves other HTTP answers to the normal update error handling', () => {
    for (const status of [401, 403, 429, 500]) expect(classifyDirectFeedFailure(httpError(status))).toBeNull()
  })

  it('reports a connection failure by its code, and retries a slow check without blaming the line', () => {
    expect(classifyDirectFeedFailure(new Error('net::ERR_CONNECTION_REFUSED'))).toEqual({ reason: 'ERR_CONNECTION_REFUSED', lineFailure: true })
    expect(classifyDirectFeedFailure(new Error('net::ERR_NAME_NOT_RESOLVED'))).toEqual({ reason: 'ERR_NAME_NOT_RESOLVED', lineFailure: true })
    expect(classifyDirectFeedFailure(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toEqual({ reason: 'ERR_CONNECTION_TIMED_OUT', lineFailure: true })
    expect(classifyDirectFeedFailure(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toEqual({ reason: 'timeout', lineFailure: false })
    // 只放行老地址的公司网关回绝了直连这个地址：包里那份有可能放行。
    expect(classifyDirectFeedFailure(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'))).toEqual({ reason: 'ERR_TUNNEL_CONNECTION_FAILED', lineFailure: true })
  })

  it('does not blame the line for a failure that switching lines cannot fix', () => {
    expect(classifyDirectFeedFailure(new Error('sha512 checksum mismatch'))).toBeNull()
    expect(classifyDirectFeedFailure(new Error('net::ERR_ABORTED'))).toBeNull()
    expect(classifyDirectFeedFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBeNull()
    expect(classifyDirectFeedFailure(null)).toBeNull()
  })
})
