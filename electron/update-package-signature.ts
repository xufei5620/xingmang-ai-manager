import { createPublicKey, verify, type KeyObject } from 'node:crypto'

// Why this exists: the Windows installer carries no Authenticode signature, and
// latest.yml sits in the same R2 bucket as the installer it describes. Anyone who
// obtains the bucket's upload credential can replace both and the SHA-512 check
// still passes. The publisher's Ed25519 key never touches the bucket: it lives only
// in the GitHub `release` environment and signs each manifest entry at publish
// time, so a forged installer cannot carry a signature these keys accept.
//
// Each entry is the base64 of an Ed25519 public key in SPKI DER form (60 chars).
// More than one key is allowed so a replacement key can ship one release before the
// old one is retired; removing a key strands every client that only trusts it.
// scripts/update-manifest-signature.cjs reads this list from the source text, so
// keep one quoted key per line between the two markers.
// update-signing-keys:begin
export const updateSigningPublicKeys: readonly string[] = [
]
// update-signing-keys:end

/** Field that publish-release adds to every `files[]` entry of latest.yml. */
export const UPDATE_SIGNATURE_FIELD = 'xingmangSignature'

// The signed text binds the version as well as the file: without it an old,
// genuinely signed installer could be re-announced under a higher version number.
// scripts/update-manifest-signature.cjs builds the same text; the two are pinned
// together by update-package-signature.test.ts.
const PAYLOAD_HEADER = 'xingmang-update-signature/v1'

export interface SignedUpdateEntry {
  url: string
  sha512: string
}

export type UpdateSignatureVerdict =
  | { ok: true }
  | { ok: false, code: 'UPDATE_SIGNATURE_MISSING' | 'UPDATE_SIGNATURE_INVALID' | 'UPDATE_SIGNATURE_UNCONFIGURED', message: string }

function hasLineBreak(value: string): boolean {
  return /[\r\n\0]/.test(value)
}

export function buildUpdateSignaturePayload(version: string, entry: SignedUpdateEntry): string | null {
  const fields = [version, entry.url, entry.sha512]
  if (fields.some((field) => typeof field !== 'string' || !field.trim() || hasLineBreak(field))) return null
  return `${PAYLOAD_HEADER}\nversion=${version.trim()}\nurl=${entry.url.trim()}\nsha512=${entry.sha512.trim()}\n`
}

function parsePublicKey(encoded: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}

function decodeSignature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.trim())) return null
  const bytes = Buffer.from(value.trim(), 'base64')
  return bytes.length === 64 ? bytes : null
}

/**
 * Checks the publisher signature on the manifest entry the downloaded package was
 * matched to. Never throws: every way the check can fail is a rejection, and a
 * build with no configured key rejects too rather than quietly skipping.
 */
export function verifyUpdateEntrySignature(
  version: string,
  entry: SignedUpdateEntry & Record<string, unknown>,
  publicKeys: readonly string[] = updateSigningPublicKeys,
): UpdateSignatureVerdict {
  const keys = publicKeys.map(parsePublicKey).filter((key): key is KeyObject => key !== null)
  if (keys.length === 0) {
    return { ok: false, code: 'UPDATE_SIGNATURE_UNCONFIGURED', message: '这个版本没有配置更新包签名公钥，已阻止安装，请到官网下载新版安装包' }
  }
  const signature = entry[UPDATE_SIGNATURE_FIELD]
  if (signature === undefined || signature === null || signature === '') {
    return { ok: false, code: 'UPDATE_SIGNATURE_MISSING', message: '更新清单里没有发布者签名，已阻止安装。请稍后再试，若一直这样请联系客服' }
  }
  const signatureBytes = decodeSignature(signature)
  const payload = buildUpdateSignaturePayload(version, entry)
  if (!signatureBytes || payload === null) {
    return { ok: false, code: 'UPDATE_SIGNATURE_INVALID', message: '更新包的发布者签名格式不对，已阻止安装。请联系客服' }
  }
  const data = Buffer.from(payload, 'utf8')
  const accepted = keys.some((key) => {
    try {
      return verify(null, data, key, signatureBytes)
    } catch {
      return false
    }
  })
  if (!accepted) {
    return { ok: false, code: 'UPDATE_SIGNATURE_INVALID', message: '更新包的发布者签名校验没通过，可能被人替换过，已阻止安装。请联系客服' }
  }
  return { ok: true }
}
