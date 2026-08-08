/**
 * Provenance decisions for macOS executables and bundles.
 *
 * `codesign -dv` prints the signing identifier, the authority names and the team
 * identifier as prose, and every one of those strings is chosen by whoever signed
 * the code. The identifier may contain newline bytes, so a signature produced by
 * `codesign -s -` — which any unprivileged local process can produce, with no
 * certificate and no keychain — can emit output whose lines read exactly like a
 * genuine `TeamIdentifier=` and `Authority=Developer ID Application: ...` pair.
 * Matching that text therefore establishes nothing. `codesign --verify` alone is
 * equally useless here: it only asserts that a signature is self-consistent, which
 * an ad-hoc signature is.
 *
 * The certificate chain is the only thing that cannot be forged without Apple's
 * private keys, and only codesign can evaluate it. So the trust decision is handed
 * to a designated requirement and read from the process exit status, never from the
 * output. Requirements are passed as one argv element, so they never reach a shell.
 */

/** Apple's Developer ID Certification Authority marker OID. */
const developerIdAuthorityMarker = 'certificate 1[field.1.2.840.113635.100.6.2.6] exists'
/** Apple's Developer ID Application leaf marker OID. */
const developerIdApplicationMarker = 'certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

const teamIdentifierPattern = /^[A-Z0-9]{10}$/
const bundleIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/

export interface DarwinSignatureRequirementOptions {
  /** Pins the signing identifier, for bundles whose identity is part of the contract. */
  bundleIdentifier?: string
}

export interface DarwinSignatureVerificationOptions extends DarwinSignatureRequirementOptions {
  /** Walks nested code inside a bundle. Meaningless for a single Mach-O file. */
  deep?: boolean
}

/**
 * Builds the designated requirement for one Apple Developer ID team.
 *
 * `anchor apple generic` roots the chain in Apple's CA — plain `anchor apple` would
 * only accept Apple's own software and rejects every third-party Developer ID.
 * The two marker OIDs pin the chain to Developer ID specifically, so a certificate
 * issued for some other Apple program cannot satisfy it.
 */
export function darwinDeveloperIdRequirement(
  teamIdentifier: string,
  options: DarwinSignatureRequirementOptions = {},
): string {
  if (!teamIdentifierPattern.test(teamIdentifier)) {
    throw new TypeError('Apple Developer team identifier is invalid')
  }
  if (
    options.bundleIdentifier !== undefined
    && !bundleIdentifierPattern.test(options.bundleIdentifier)
  ) {
    throw new TypeError('macOS bundle identifier is invalid')
  }
  return [
    options.bundleIdentifier ? `identifier "${options.bundleIdentifier}"` : null,
    'anchor apple generic',
    developerIdAuthorityMarker,
    developerIdApplicationMarker,
    `certificate leaf[subject.OU] = "${teamIdentifier}"`,
  ]
    .filter((clause): clause is string => clause !== null)
    .join(' and ')
}

/**
 * Builds the codesign argv that decides trust by exit status.
 *
 * Callers must treat a non-zero exit as "unverified" and must not inspect stdout or
 * stderr to reach that conclusion.
 */
export function darwinDeveloperIdVerificationArgv(
  teamIdentifier: string,
  targetPath: string,
  options: DarwinSignatureVerificationOptions = {},
): string[] {
  if (!targetPath || targetPath.includes('\0')) {
    throw new TypeError('codesign target path is invalid')
  }
  return [
    '--verify',
    '--strict',
    ...(options.deep ? ['--deep'] : []),
    `-R=${darwinDeveloperIdRequirement(teamIdentifier, options)}`,
    targetPath,
  ]
}
