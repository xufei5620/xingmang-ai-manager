import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locateDirectUpdateFeed, resolveDirectUpdateFeed, type UpdateFeedRouteOptions } from './update-feed-route'

const primaryUrl = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
const directUrl = 'https://38.147.105.28:8443/xingmang-manager/'
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
