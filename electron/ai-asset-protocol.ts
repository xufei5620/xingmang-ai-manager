import type { ActiveIdentityReader } from './active-identity'
import { assetThumbnailVersion, parseAssetThumbnailPath } from './asset-thumbnail'
import { parseSingleByteRange, type ByteRange } from './byte-range'

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
    /**
     * Video only. The same ownership, reparse, single-link and stability checks
     * as readOwned, but only the bytes `select` picks once the verified file
     * size is known are read; null reads none (HEAD, unsatisfiable range).
     */
    readOwnedVideoRange(userId: number, assetId: string, select: (totalBytes: number) => ByteRange | null): Promise<{
      bytes: Buffer
      totalBytes: number
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
      const head = request.method === 'HEAD'
      const rangeHeader = head ? null : request.headers.get('range')
      const picked: { range: ByteRange | null, unsatisfiable: boolean } = { range: null, unsatisfiable: false }
      // Decides what to serve once the size is known: nothing for HEAD, the
      // whole file without a Range header, else the single range asked for.
      // 开放式的「bytes=N-」要回到文件结尾，不能截短：0.2.24 每次最多回 8 MB，Electron 的播放器拿到这一截
      // 不会再要下一截，大于 8 MB 的视频播到一半就停（#1631 引入，Mac 验收 B1）。省内存靠的是只从 N 读起。
      const select = (totalBytes: number): ByteRange | null => {
        if (head) return null
        if (!rangeHeader) return { start: 0, end: totalBytes - 1 }
        const parsed = parseSingleByteRange(rangeHeader, totalBytes)
        if (!parsed) { picked.unsatisfiable = true; return null }
        picked.range = parsed
        return picked.range
      }
      let mimeType: string
      let totalBytes: number
      let body: Buffer
      if (url.hostname === 'video') {
        const owned = await options.assets.readOwnedVideoRange(userId, assetId, select)
        totalBytes = owned.totalBytes
        body = owned.bytes
        mimeType = owned.asset.mimeType
      } else {
        const owned = await options.assets.readOwned(userId, assetId, url.hostname as AiAssetProtocolMediaKind)
        totalBytes = owned.bytes.byteLength
        mimeType = owned.asset.mimeType
        const wanted = select(totalBytes)
        body = wanted ? owned.bytes.subarray(wanted.start, wanted.end + 1) : Buffer.alloc(0)
      }
      options.identities.assertCurrent(identity)
      if (request.signal.aborted) return emptyResponse(404)
      if (picked.unsatisfiable) return emptyResponse(416, { 'Content-Range': `bytes */${totalBytes}` })
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': mimeType,
        'X-Content-Type-Options': 'nosniff',
      }
      const served = picked.range
      if (served) headers['Content-Range'] = `bytes ${served.start}-${served.end}/${totalBytes}`
      headers['Content-Length'] = String(head ? totalBytes : body.byteLength)
      return new Response(head ? null : body, { status: served ? 206 : 200, headers })
    } catch {
      // Never expose stale bytes, account details or filesystem exceptions.
      return emptyResponse(404)
    }
  }
}
