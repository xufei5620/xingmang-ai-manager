import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanCommandOutput, CommandRunnerError, runCommand, trustedCommandEnvironment } from './command-runner'
import type { ExternalClientInstallProgress } from './external-client-contract'
import { isRegisteredTrustedManagedWindowsPath } from './managed-path-trust'
import { parseAuthenticodeSignature } from './node-runtime'
import { sameLocalPathIdentity } from './path-identity'
import { assertNoReparseComponents } from './safe-local-data'
import { createTrustedTemporaryDirectory } from './trusted-temp'
import { encodeWindowsPowerShellCommand, resolveWindowsPowerShellExecutable, type WindowsCliExecutionMode } from './windows-elevation'
import { resolveWindowsMachinePaths, type WindowsMachinePaths } from './windows-machine-paths'

export const WORKBUDDY_OFFICIAL_INSTALLER = Object.freeze({
  version: '5.5.6',
  url: 'https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.5.6.38337834-5f969292.exe',
  // The same official URL serves two 5.5.6 packages. Both were downloaded in
  // full and verified by Windows as Tencent-signed WorkBuddy on 2026-09-18.
  // The first is also pinned by Microsoft's winget manifest. Do not accept an
  // unknown hash merely because this CDN serves a changed file in the future.
  sha256: Object.freeze([
    'b1c61b8a0550012c3e9e2cce4b2d566fb5bdb3283e97146b8808c3dcb1a571f4',
    '0be18472b3c1d4cdbbe977784c09736bd96e641e30901ac22ccd4a8ee8f54303',
  ]),
  fileName: 'WorkBuddy-5.5.6-x64.exe',
})
const maximumInstallerBytes = 1024 * 1024 * 1024
const downloadTimeoutMs = 15 * 60_000
class WorkBuddyInstallerError extends Error {
  cleanupError?: unknown
  constructor(message: string, readonly originalError?: unknown) {
    super(message)
    this.name = 'WorkBuddyInstallerError'
  }
}
const publisherPattern = /(?:^|,\s*)(?:CN|O)="?Tencent Technology \(Shenzhen\) Company Limited"?(?:,|$)/i
const signatureScript = [
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force -ErrorAction Stop",
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:XINGMANG_WORKBUDDY_INSTALLER -ErrorAction Stop',
  '[pscustomobject]@{ status = [string]$signature.Status; subject = [string]$signature.SignerCertificate.Subject } | ConvertTo-Json -Compress',
].join('; ')

export interface WorkBuddyOfficialInstallOptions {
  architecture?: NodeJS.Architecture
  windowsExecutionMode?: WindowsCliExecutionMode
  onProgress?: (event: ExternalClientInstallProgress) => void
  signal?: AbortSignal
  runCommand?: typeof runCommand
  fetch?: typeof globalThis.fetch
  env?: NodeJS.ProcessEnv
  /** Injected only by host-independent installer tests. */
  platform?: NodeJS.Platform
  resolveMachinePaths?: () => WindowsMachinePaths
  resolvePowerShellExecutable?: () => string
  createTemporaryDirectory?: (mode: WindowsCliExecutionMode) => Promise<string>
  removeTemporaryDirectory?: (directory: string) => Promise<void>
  isTrustedTemporaryPath?: (candidate: string) => boolean
  onCleanupError?: (error: unknown) => void
}

function report(options: WorkBuddyOfficialInstallOptions, phase: ExternalClientInstallProgress['phase'], message: string, percent: number | null = null): void {
  try { options.onProgress?.({ tool: 'workbuddy', phase, message, percent }) } catch { /* A disconnected observer cannot alter the installation. */ }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof WorkBuddyInstallerError
    ? signal.reason : new WorkBuddyInstallerError('WorkBuddy 安装已取消')
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function downloadInstaller(filePath: string, options: WorkBuddyOfficialInstallOptions, onCreated: (identity: fs.Stats) => void): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new WorkBuddyInstallerError('WorkBuddy 官方安装包下载超时')), downloadTimeoutMs)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  let file: fs.promises.FileHandle | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let response: Response | null = null
  try {
    checkAborted(options.signal)
    report(options, 'downloading', `正在下载 WorkBuddy ${WORKBUDDY_OFFICIAL_INSTALLER.version} 官方安装包`, 0)
    response = await cancellable((options.fetch ?? globalThis.fetch)(WORKBUDDY_OFFICIAL_INSTALLER.url, {
      redirect: 'error', signal: controller.signal, credentials: 'omit',
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    }), controller.signal)
    if (response.redirected || (response.url && response.url !== WORKBUDDY_OFFICIAL_INSTALLER.url)) throw new WorkBuddyInstallerError('WorkBuddy 安装包下载地址发生了未经批准的跳转')
    if (response.status !== 200) throw new WorkBuddyInstallerError(`WorkBuddy 安装包下载失败：HTTP ${response.status}`)
    const lengthHeader = response.headers.get('content-length')
    const declared = lengthHeader === null ? null : Number(lengthHeader)
    if (declared !== null && (!/^\d+$/.test(lengthHeader!) || !Number.isSafeInteger(declared) || declared <= 0 || declared > maximumInstallerBytes)) throw new WorkBuddyInstallerError('WorkBuddy 安装包大小无效或超过 1 GB 上限')
    if (!response.body) throw new WorkBuddyInstallerError('WorkBuddy 安装包响应没有可读取内容')
    file = await fs.promises.open(filePath, 'wx', 0o600)
    onCreated(await file.stat())
    reader = response.body.getReader()
    const hash = createHash('sha256')
    let total = 0
    let lastProgressAt = Date.now()
    for (;;) {
      const { value, done } = await cancellable(reader.read(), controller.signal)
      if (done) break
      checkAborted(controller.signal)
      total += value.byteLength
      if (total > maximumInstallerBytes || (declared !== null && total > declared)) throw new WorkBuddyInstallerError('WorkBuddy 安装包超过声明大小或 1 GB 上限')
      hash.update(value)
      // FileHandle.write may write fewer bytes than requested. Keep the stream
      // hash and the bytes persisted to disk in agreement even on short writes.
      for (let offset = 0; offset < value.byteLength;) {
        checkAborted(controller.signal)
        const written = await file.write(value, offset, value.byteLength - offset)
        if (written.bytesWritten <= 0) throw new WorkBuddyInstallerError('WorkBuddy 安装包写入失败')
        offset += written.bytesWritten
      }
      if (Date.now() - lastProgressAt >= 250) {
        report(options, 'downloading', `正在下载 WorkBuddy 官方安装包（${Math.floor(total / 1024 / 1024)} MB）`, declared === null ? null : Math.min(99, Math.floor(total / declared * 100)))
        lastProgressAt = Date.now()
      }
    }
    checkAborted(controller.signal)
    if (!total || (declared !== null && total !== declared)) throw new WorkBuddyInstallerError('WorkBuddy 安装包下载不完整')
    const downloadedHash = hash.digest('hex')
    if (!WORKBUDDY_OFFICIAL_INSTALLER.sha256.includes(downloadedHash)) throw new WorkBuddyInstallerError('WorkBuddy 安装包 SHA-256 校验失败', { actualSha256: downloadedHash, size: total })
    await file.sync()
    checkAborted(controller.signal)
    return total
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    // Abort the HTTP request before waiting for cleanup, including early errors
    // before a reader exists (bad status, redirect, oversized Content-Length).
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
    else if (response?.body) void response.body.cancel().catch(() => undefined)
    await file?.close()
  }
}

function verifyDirectory(directory: string, mode: WindowsCliExecutionMode, options: WorkBuddyOfficialInstallOptions): void {
  if (!path.isAbsolute(directory) || directory.includes('\0') || path.parse(directory).root === directory) throw new WorkBuddyInstallerError('WorkBuddy 安装暂存目录无效')
  assertNoReparseComponents(directory, 'WorkBuddy 安装暂存目录')
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new WorkBuddyInstallerError('WorkBuddy 安装暂存目录不是普通目录')
  if (mode === 'trusted-only' && !(options.isTrustedTemporaryPath ?? isRegisteredTrustedManagedWindowsPath)(directory)) throw new WorkBuddyInstallerError('WorkBuddy 安装暂存目录未通过受保护路径验证')
}

async function verifyInstaller(filePath: string, directory: string, size: number, mode: WindowsCliExecutionMode, options: WorkBuddyOfficialInstallOptions): Promise<void> {
  verifyDirectory(directory, mode, options)
  assertNoReparseComponents(filePath, 'WorkBuddy 安装包')
  const before = await fs.promises.lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== size) throw new WorkBuddyInstallerError('WorkBuddy 安装包在校验后发生变化')
  const canonical = await fs.promises.realpath(filePath)
  if (!sameLocalPathIdentity(filePath, canonical) || path.dirname(canonical).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new WorkBuddyInstallerError('WorkBuddy 安装包路径在校验后发生变化')
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) { checkAborted(options.signal); hash.update(chunk) }
  const after = await fs.promises.lstat(filePath)
  if (!WORKBUDDY_OFFICIAL_INSTALLER.sha256.includes(hash.digest('hex'))
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || after.isSymbolicLink() || after.nlink !== 1 || !sameLocalPathIdentity(filePath, canonical)) throw new WorkBuddyInstallerError('WorkBuddy 安装包在执行前完整性校验失败')
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
}

/** The caller owns the install queue and must probe the installed application
 * after this returns. An installer exit is deliberately not a completed event. */
export async function installWorkBuddyFromOfficial(options: WorkBuddyOfficialInstallOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') throw new WorkBuddyInstallerError('WorkBuddy 官方备用安装仅支持 Windows')
  if ((options.architecture ?? process.arch) !== 'x64') throw new WorkBuddyInstallerError('WorkBuddy 官方备用安装仅支持 Windows x64')
  const mode = options.windowsExecutionMode ?? 'trusted-only'
  if (mode !== 'same-user' && mode !== 'trusted-only') throw new WorkBuddyInstallerError('WorkBuddy 安装权限模式无效')
  checkAborted(options.signal)
  const machinePaths = (options.resolveMachinePaths ?? resolveWindowsMachinePaths)()
  const baseEnvironment = Object.fromEntries(Object.entries(trustedCommandEnvironment(options.env, machinePaths, 'win32'))
    .filter(([key]) => !/^(?:temp|tmp|tmpdir)$/i.test(key)))
  const execute = options.runCommand ?? runCommand
  let directory: string | null = null
  let directoryIdentity: fs.Stats | null = null
  let installerIdentity: fs.Stats | null = null
  let failure: WorkBuddyInstallerError | null = null
  let commandStage = '签名检查'
  try {
    directory = await (options.createTemporaryDirectory
      ? options.createTemporaryDirectory(mode)
      : mode === 'same-user'
        ? fs.promises.mkdtemp(path.join(os.tmpdir(), 'xingmang-workbuddy-'))
        : createTrustedTemporaryDirectory('workbuddy', { env: baseEnvironment, machinePaths }))
    verifyDirectory(directory, mode, options)
    directoryIdentity = fs.lstatSync(directory)
    const filePath = path.join(directory, WORKBUDDY_OFFICIAL_INSTALLER.fileName)
    const size = await downloadInstaller(filePath, options, (identity) => { installerIdentity = identity })
    report(options, 'checking', '正在验证 WorkBuddy 官方安装包及腾讯数字签名')
    await verifyInstaller(filePath, directory, size, mode, options)
    // NSIS extracts helper executables through TEMP. An elevated installation
    // must inherit the protected staging directory for both extraction and cwd.
    const env = { ...baseEnvironment, TEMP: directory, TMP: directory, TMPDIR: directory, XINGMANG_WORKBUDDY_INSTALLER: filePath }
    const shared = { env, cwd: directory, trustedOnly: mode === 'trusted-only', trustedPaths: [filePath], machinePaths, signal: options.signal, windowsHide: true, acceptedExitCodes: [0] }
    const result = await execute({
      executable: options.resolvePowerShellExecutable?.() ?? resolveWindowsPowerShellExecutable({ machinePaths }),
      argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsPowerShellCommand(signatureScript)],
    }, { ...shared, timeoutMs: 60_000, maxOutputBytes: 64 * 1024 })
    const signature = parseAuthenticodeSignature(cleanCommandOutput(result.stdout))
    if (!signature || signature.status.toLowerCase() !== 'valid' || !publisherPattern.test(signature.subject)) throw new WorkBuddyInstallerError('WorkBuddy 安装包数字签名无效或发布者不是腾讯官方')
    report(options, 'installing', '正在以当前用户安装 WorkBuddy')
    await verifyInstaller(filePath, directory, size, mode, options)
    checkAborted(options.signal)
    const installationTemporaryDirectory = mode === 'same-user' ? os.tmpdir() : directory
    verifyDirectory(installationTemporaryDirectory, mode, options)
    // The installer starts WorkBuddy itself. Same-user children must inherit
    // durable TEMP/cwd locations instead of the soon-to-be-removed download dir.
    const installerOptions = mode === 'same-user' ? {
      ...shared, cwd: machinePaths.system32,
      env: { ...baseEnvironment, TEMP: installationTemporaryDirectory, TMP: installationTemporaryDirectory, TMPDIR: installationTemporaryDirectory },
    } : shared
    commandStage = '安装'
    await execute({ executable: filePath, argv: ['/S', '/currentuser'] }, { ...installerOptions, timeoutMs: 15 * 60_000, maxOutputBytes: 1024 * 1024 })
  } catch (error) {
    const message = options.signal?.aborted || error instanceof CommandRunnerError && (error.code === 'ABORTED' || commandStage === '安装' && error.exitCode === 1) ? 'WorkBuddy 安装已取消'
      : error instanceof CommandRunnerError && error.code === 'TIMED_OUT' ? `WorkBuddy ${commandStage}超时，请重新检测客户端状态后重试`
      : error instanceof WorkBuddyInstallerError ? error.message
        : 'WorkBuddy 官方备用安装失败，请检查网络连接、磁盘空间和 Windows 安装权限后重试'
    report(options, 'error', message)
    failure = new WorkBuddyInstallerError(message, error)
    throw failure
  } finally {
    if (directory && directoryIdentity) {
      let installerRemoved = installerIdentity === null
      try {
        verifyDirectory(directory, mode, options)
        const current = fs.lstatSync(directory)
        if (!sameFileIdentity(current, directoryIdentity)) throw new WorkBuddyInstallerError('WorkBuddy 安装暂存目录身份发生变化')
        if (installerIdentity) {
          const filePath = path.join(directory, WORKBUDDY_OFFICIAL_INSTALLER.fileName)
          const currentFile = await fs.promises.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
          if (currentFile) {
            assertNoReparseComponents(filePath, 'WorkBuddy 安装包清理路径')
            if (!currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.nlink !== 1 || !sameFileIdentity(currentFile, installerIdentity)) throw new WorkBuddyInstallerError('WorkBuddy 安装包清理路径身份发生变化')
            await fs.promises.unlink(filePath)
          }
          installerRemoved = true
        }
        // Only remove our download and an empty staging directory. NSIS can
        // launch the application before exiting, leaving live runtime data here.
        await (options.removeTemporaryDirectory ?? ((target: string) => fs.promises.rmdir(target)))(directory)
      } catch (error) {
        try { options.onCleanupError?.(error) } catch { /* Diagnostics cannot alter installation results. */ }
        if (failure) failure.cleanupError = error
        const code = (error as NodeJS.ErrnoException).code
        const message = installerRemoved && (code === 'ENOTEMPTY' || code === 'EEXIST')
          ? 'WorkBuddy 安装包已清理，暂存目录中的客户端运行文件已保留'
          : installerRemoved ? 'WorkBuddy 安装包已清理，暂存目录暂时无法移除'
            : 'WorkBuddy 安装包暂未清理，已保留以避免删除正在使用或身份已变化的文件'
        report(options, 'checking', message)
      }
    }
  }
}
