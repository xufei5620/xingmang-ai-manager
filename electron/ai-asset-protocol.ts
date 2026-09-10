import type { ActiveIdentityReader } from './active-identity'
import { assetThumbnailVersion, parseAssetThumbnailPath } from './asset-thumbnail'
import { parseSingleByteRange } from './byte-range'

export type AiAssetProtocolMediaKind = 'image' | 'video' | 'audio'

// Structural, main-process-only dependencies keep this handler testable
// without importing Electron or constructing the filesystem-backed stores.
export interface AiAssetProtocolOptions {
  identities: Pick<ActiveIdentityReader, 'read' | 'assertCurrent'>
  assets: {
    readOwned(userId: number, assetId: string, kind: AiAssetProtocolMediaKind): Promise<{
      bytes: Buffer
      asset: { mimeType: string }
    }>
  }
  thumbnails: {
    resolve(userId: number, assetId: string, kind: 'image' | 'video'): Promise<{
      bytes: Buffer
      mimeType: string
    } | null>
  }
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...headers, 'Cache-Control': 'no-store' } })
}

/**
 * Register the returned function directly with protocol.handle. Ownership
 * must be rechecked after the last await, not just before an async disk read.
 * This is still the xm-only numeric store contract; it is not a multi-realm
 * storage migration or an authorization grant to untrusted renderer code.
 */
export function createAiAssetProtocolHandler(options: AiAssetProtocolOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'xingmang-asset:' || url.port || url.username || url.password || url.search || url.hash
        || !['image', 'video', 'audio', 'thumb'].includes(url.hostname)) return emptyResponse(404)
      if (request.method !== 'GET' && request.method !== 'HEAD') return emptyResponse(405, { Allow: 'GET, HEAD' })
      if (request.signal.aborted) return emptyResponse(404)
      const thumbnail = url.hostname === 'thumb' ? parseAssetThumbnailPath(url.pathname) : null
      const assetId = url.hostname === 'thumb' ? thumbnail?.assetId : decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!assetId || !/^[A-Za-z0-9_-]{43}$/.test(assetId)
        || (url.hostname === 'thumb' && thumbnail?.version !== assetThumbnailVersion)) return emptyResponse(404)

      const identity = options.identities.read()
      if (!identity) return emptyResponse(401)
      const userId = Number(identity.userId)
      if (!Number.isSafeInteger(userId) || userId <= 0 || String(userId) !== identity.userId) return emptyResponse(404)

      if (thumbnail) {
        const derived = await options.thumbnails.resolve(userId, assetId, thumbnail.mediaKind)
        options.identities.assertCurrent(identity)
        if (!derived || request.signal.aborted) return emptyResponse(404)
        return new Response(request.method === 'HEAD' ? null : derived.bytes, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            // Content addressing proves byte identity, not current access.
            'Cache-Control': 'no-store',
            'Content-Length': String(derived.bytes.byteLength),
            'Content-Type': derived.mimeType,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      const owned = await options.assets.readOwned(userId, assetId, url.hostname as AiAssetProtocolMediaKind)
      options.identities.assertCurrent(identity)
      if (request.signal.aborted) return emptyResponse(404)
      const range = request.method === 'HEAD' ? null : request.headers.get('range')
      let body = owned.bytes
      let status = 200
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': owned.asset.mimeType,
        'X-Content-Type-Options': 'nosniff',
      }
      if (range) {
        const parsedRange = parseSingleByteRange(range, body.byteLength)
        if (!parsedRange) return emptyResponse(416, { 'Content-Range': `bytes */${body.byteLength}` })
        const { start, end } = parsedRange
        status = 206
        body = body.subarray(start, end + 1)
        headers['Content-Range'] = `bytes ${start}-${end}/${owned.bytes.byteLength}`
      }
      headers['Content-Length'] = String(body.byteLength)
      return new Response(request.method === 'HEAD' ? null : body, { status, headers })
    } catch {
      // Never expose stale bytes, account details or filesystem exceptions.
      return emptyResponse(404)
    }
  }
}
