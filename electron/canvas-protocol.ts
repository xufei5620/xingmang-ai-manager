import {
  isAllowedAppNavigationUrl,
  isTrustedIpcSenderUrl,
  resolvePackagedApplicationFile,
  type ApplicationUrlPolicy,
} from './security'

// Mirrors xingmang://'s packaged-app protocol (main.ts) but points at the
// vendored infinite-canvas build instead of dist/. Kept as its own scheme
// (not a path under xingmang://) so the canvas window's protocol policy can
// be constructed independently of the main window's -- the two must never
// share a rendererRoot, or a traversal bug in one would expose the other.
export const canvasProtocolScheme = 'xingmang-canvas'
export const canvasPackagedBaseUrl = `${canvasProtocolScheme}://app/`

function isFileRequestPath(pathname: string): boolean {
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? ''
  const dotIndex = lastSegment.lastIndexOf('.')
  // A dot that is neither the first nor the last character of the segment
  // reads as a real extension (index.html, index-Bw0XXWX0.js). Dotfiles
  // (".env") and trailing dots don't occur in this build's asset names, so
  // treating them as "not a file" and falling through to the SPA index is
  // the safer default.
  return dotIndex > 0 && dotIndex < lastSegment.length - 1
}

/**
 * Resolves a xingmang-canvas:// request to an absolute file inside the
 * packaged canvas dist directory.
 *
 * All traversal/root-containment/scheme-confusion checks are delegated to
 * resolvePackagedApplicationFile (security.ts), which already backs the main
 * window's xingmang:// protocol -- this function adds exactly one thing on
 * top: infinite-canvas uses createBrowserRouter (real History API routes),
 * so a request for a path with no recognizable file extension is a
 * client-side route, not a missing asset, and must resolve to index.html
 * instead of failing the load. The fallback is produced by re-resolving the
 * literal string 'index.html' through the very same trusted function, never
 * by hand-assembling a path, so it carries identical guarantees.
 */
export function resolveCanvasProtocolFile(
  rawUrl: string,
  policy: ApplicationUrlPolicy,
): string | null {
  const directHit = resolvePackagedApplicationFile(rawUrl, policy)
  if (!directHit) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl).pathname)
  } catch {
    // resolvePackagedApplicationFile above already parsed rawUrl successfully
    // to produce directHit, so this branch is unreachable in practice; keep
    // the literal hit rather than fail a request we already validated.
    return directHit
  }
  if (isFileRequestPath(pathname)) return directHit
  if (!policy.packagedBaseUrl) return null
  return resolvePackagedApplicationFile(new URL('index.html', policy.packagedBaseUrl).href, policy)
}

export { isAllowedAppNavigationUrl, isTrustedIpcSenderUrl, type ApplicationUrlPolicy }
