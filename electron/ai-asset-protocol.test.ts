import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createActiveIdentityReader } from './active-identity'
import { createAiAssetProtocolHandler, type AiAssetProtocolOptions } from './ai-asset-protocol'
import { assetThumbnailUrl, assetThumbnailVersion } from './asset-thumbnail'

const assetId = 'a'.repeat(43)
const mediaUrl = `xingmang-asset://image/${assetId}`
const thumbnailUrl = assetThumbnailUrl(assetId, 'image')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  let userId: number | null = 7
  let revision = 1
  const calls: { kind: string; userId: number; assetId: string }[] = []
  const identities = createActiveIdentityReader({
    siteId: 'solov', realmId: 'xm-account', accountOrigin: 'https://xm.solov.cc',
  }, {
    getSessionState: () => ({ authenticated: userId !== null, account: userId === null ? null : { userId } }),
    getSessionRevision: () => revision,
  })
  const media = { bytes: Buffer.from('0123456789'), asset: { mimeType: 'image/png' } }
  const thumbnail = { bytes: Buffer.from('thumbnail'), mimeType: 'image/png' }
  const options: AiAssetProtocolOptions = {
    identities,
    assets: { async readOwned(owner, id, kind) { calls.push({ kind, userId: owner, assetId: id }); return media } },
    thumbnails: { async resolve(owner, id, kind) { calls.push({ kind: `thumb:${kind}`, userId: owner, assetId: id }); return thumbnail } },
  }
  return {
    options, media, thumbnail, calls, handler: createAiAssetProtocolHandler(options),
    changeUser(id: number | null) { userId = id; revision += 1 },
    beginAttempt() { revision += 1 },
    refresh() { /* Token refresh preserves the source's ownership revision. */ },
  }
}

async function assertEmpty(response: Response, status: number): Promise<void> {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), '')
}

describe('account-owned asset protocol', () => {
  for (const kind of ['image', 'video', 'audio']) {
    it(`reads ${kind} only for the captured account`, async () => {
      const example = fixture()
      const response = await example.handler(new Request(`xingmang-asset://${kind}/${assetId}`))
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '0123456789')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('content-length'), '10')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(example.calls, [{ kind, userId: 7, assetId }])
    })
  }

  it('serves thumbnails without a shared long-lived HTTP cache', async () => {
    const example = fixture()
    const response = await example.handler(new Request(thumbnailUrl))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(await response.text(), 'thumbnail')
    assert.deepEqual(example.calls, [{ kind: 'thumb:image', userId: 7, assetId }])
  })

  it('versions URLs to avoid reusing previously cacheable v1 responses', async () => {
    const example = fixture()
    assert.equal(assetThumbnailVersion, 'v2')
    assert.ok(thumbnailUrl.includes('/v2/'))
    await assertEmpty(await example.handler(new Request(`xingmang-asset://thumb/v1/image/${assetId}`)), 404)
    assert.equal(example.calls.length, 0)
  })

  for (const url of [mediaUrl, thumbnailUrl]) {
    it(`checks ownership for HEAD without returning bytes: ${url}`, async () => {
      const example = fixture()
      const response = await example.handler(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=1-3' } }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('content-length'), url === mediaUrl ? '10' : '9')
      assert.equal(response.headers.get('content-range'), null)
      assert.equal(await response.text(), '')
      assert.equal(example.calls.length, 1)
    })

    it(`does not call a store while signed out: ${url}`, async () => {
      const example = fixture()
      example.changeUser(null)
      await assertEmpty(await example.handler(new Request(url)), 401)
      assert.equal(example.calls.length, 0)
    })

    it(`does not begin a read for an aborted request: ${url}`, async () => {
      const example = fixture()
      const controller = new AbortController()
      controller.abort()
      await assertEmpty(await example.handler(new Request(url, { signal: controller.signal })), 404)
      assert.equal(example.calls.length, 0)
    })
  }

  for (const [range, body, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-', '89', 'bytes 8-9/10'],
  ]) {
    it(`preserves single range responses: ${range}`, async () => {
      const response = await fixture().handler(new Request(mediaUrl, { headers: { Range: range } }))
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), contentRange)
      assert.equal(response.headers.get('content-length'), String(body.length))
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await response.text(), body)
    })
  }

  for (const range of ['bytes=100-', 'bytes=1-0', 'bytes=0-1,4-5']) {
    it(`rejects an invalid range without asset bytes: ${range}`, async () => {
      const response = await fixture().handler(new Request(mediaUrl, { headers: { Range: range } }))
      assert.equal(response.headers.get('content-range'), 'bytes */10')
      await assertEmpty(response, 416)
    })
  }

  for (const url of [
    `https://image/${assetId}`, `xingmang-asset://unknown/${assetId}`,
    `xingmang-asset://image:81/${assetId}`, `${mediaUrl}?x=1`, `${mediaUrl}#x`,
    'xingmang-asset://image/%ZZ', `xingmang-asset://image/${'a'.repeat(42)}`,
    `${mediaUrl}/extra`, `xingmang-asset://thumb/v2/audio/${assetId}`,
    `xingmang-asset://thumb/v2/image/${assetId}/extra`,
  ]) {
    it(`rejects unsupported URL shapes before reading storage: ${url}`, async () => {
      const example = fixture()
      await assertEmpty(await example.handler(new Request(url)), 404)
      assert.equal(example.calls.length, 0)
    })
  }

  it('rejects unsupported methods before reading storage', async () => {
    const example = fixture()
    const response = await example.handler(new Request(mediaUrl, { method: 'POST' }))
    await assertEmpty(response, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.equal(example.calls.length, 0)
  })

  for (const target of ['media', 'thumbnail'] as const) {
    for (const transition of ['different-user', 'logout', 'same-user-relogin', 'pending-attempt', 'abort'] as const) {
      it(`does not publish a stale ${target} after ${transition}`, async () => {
        const example = fixture()
        const gate = deferred<void>()
        example.options.assets.readOwned = async () => { await gate.promise; return example.media }
        example.options.thumbnails.resolve = async () => { await gate.promise; return example.thumbnail }
        const controller = new AbortController()
        const response = example.handler(new Request(target === 'media' ? mediaUrl : thumbnailUrl, { signal: controller.signal }))
        if (transition === 'different-user') example.changeUser(8)
        if (transition === 'logout') example.changeUser(null)
        if (transition === 'same-user-relogin') { example.changeUser(null); example.changeUser(7) }
        if (transition === 'pending-attempt') example.beginAttempt()
        if (transition === 'abort') controller.abort()
        gate.resolve()
        await assertEmpty(await response, 404)
      })
    }

    it(`allows a ${target} read through a stable ownership refresh`, async () => {
      const example = fixture()
      const gate = deferred<void>()
      example.options.assets.readOwned = async () => { await gate.promise; return example.media }
      example.options.thumbnails.resolve = async () => { await gate.promise; return example.thumbnail }
      const response = example.handler(new Request(target === 'media' ? mediaUrl : thumbnailUrl))
      example.refresh()
      gate.resolve()
      assert.equal((await response).status, 200)
    })

    it(`does not expose ${target} storage error text`, async () => {
      const example = fixture()
      const fail = async () => { throw new Error('private-path-and-account-detail') }
      example.options.assets.readOwned = fail
      example.options.thumbnails.resolve = fail
      await assertEmpty(await example.handler(new Request(target === 'media' ? mediaUrl : thumbnailUrl)), 404)
    })
  }

  it('returns an empty response when a thumbnail cannot be derived', async () => {
    const example = fixture()
    example.options.thumbnails.resolve = async () => null
    await assertEmpty(await example.handler(new Request(thumbnailUrl)), 404)
  })

  it('fails closed when identity metadata is invalid', async () => {
    const example = fixture()
    example.changeUser(Number.MAX_SAFE_INTEGER + 1)
    await assertEmpty(await example.handler(new Request(mediaUrl)), 404)
    assert.equal(example.calls.length, 0)
  })
})
