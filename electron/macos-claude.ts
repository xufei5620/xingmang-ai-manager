import fs from 'node:fs'
import { darwinDeveloperIdVerificationArgv } from './macos-code-signing'

/**
 * Anthropic's Apple Developer ID team.
 *
 * Read out of the shipped artifact rather than copied from documentation: the macOS
 * `claude` binaries published as @anthropic-ai/claude-code-darwin-arm64 and
 * @anthropic-ai/claude-code-darwin-x64 (2.1.278) both carry the CodeDirectory
 * identifier `com.anthropic.claude-code` and team `Q6L2SF6YDW`, and their embedded
 * CMS leaf is `Developer ID Application: Anthropic PBC (Q6L2SF6YDW)`, issued by
 * Apple's Developer ID Certification Authority G2 under the Apple Root CA. The
 * Windows side pins the same vendor through the Authenticode subject
 * `O="Anthropic, PBC"` (trusted-native-cli.ts), so neither platform now launches a
 * natively installed `claude` that did not come from Anthropic.
 */
const anthropicTeamId = 'Q6L2SF6YDW'
const MAX_CACHED_VERIFICATIONS = 16

export interface DarwinClaudeCommandResult {
  stdout: string
  stderr: string
}

export interface VerifyDarwinClaudeNativeExecutableOptions {
  commandPath: string
  runCommand: (
    spec: { executable: string; argv: readonly string[] },
  ) => Promise<DarwinClaudeCommandResult>
}

interface DarwinClaudeFileIdentity {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

const verifiedExecutables = new Map<string, DarwinClaudeFileIdentity>()

/** Drops every cached verification. Only the tests need this. */
export function clearDarwinClaudeVerificationCache(): void {
  verifiedExecutables.clear()
}

function readExecutableIdentity(executablePath: string): DarwinClaudeFileIdentity {
  const stats = fs.lstatSync(executablePath, { bigint: true })
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111n) === 0n) {
    throw new Error('Claude Code 的原生程序不是可执行文件，请重新安装 Claude Code')
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  }
}

function sameIdentity(
  left: DarwinClaudeFileIdentity,
  right: DarwinClaudeFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
}

function rememberVerification(
  executablePath: string,
  identity: DarwinClaudeFileIdentity,
): void {
  if (verifiedExecutables.size >= MAX_CACHED_VERIFICATIONS) verifiedExecutables.clear()
  verifiedExecutables.set(executablePath, identity)
}

/**
 * Proves a natively installed macOS `claude` came from Anthropic, and answers with the
 * absolute path that was proven.
 *
 * Unlike the darwin Codex and Grok paths this does not copy the binary into a private
 * staging directory first. Those two resolve a *selection* out of a mutable, versioned
 * link tree, where the file that was verified and the file that would later be launched
 * can be two different files; a native `claude` resolves to one regular file, and the
 * realpath answered here is the exact path handed to spawn. What is left is a race a
 * process running as the current user could win, and macOS puts that principal outside
 * this program's threat model (AGENTS.md T5) — while the copy would cost a 200+ MB read
 * and fsync on a check whose purpose is supply-chain provenance, not privilege.
 *
 * Trust is decided by codesign's exit status against a designated requirement, never by
 * its output; see macos-code-signing.ts for why reading the output proves nothing.
 */
export async function verifyDarwinClaudeNativeExecutable(
  options: VerifyDarwinClaudeNativeExecutableOptions,
): Promise<string> {
  let executablePath: string
  try {
    executablePath = fs.realpathSync(options.commandPath)
  } catch (error) {
    throw new Error('无法定位 Claude Code 的原生程序，请重新安装 Claude Code', { cause: error })
  }
  const identity = readExecutableIdentity(executablePath)
  const cached = verifiedExecutables.get(executablePath)
  if (cached && sameIdentity(cached, identity)) return executablePath
  verifiedExecutables.delete(executablePath)
  try {
    await options.runCommand({
      executable: '/usr/bin/codesign',
      argv: darwinDeveloperIdVerificationArgv(anthropicTeamId, executablePath),
    })
  } catch (error) {
    throw new Error(
      'Claude Code 可执行文件未通过 Anthropic Developer ID 签名校验，请重新安装 Claude Code',
      { cause: error },
    )
  }
  if (!sameIdentity(identity, readExecutableIdentity(executablePath))) {
    throw new Error('Claude Code 的原生程序在校验期间被改动，请重新安装 Claude Code')
  }
  rememberVerification(executablePath, identity)
  return executablePath
}
