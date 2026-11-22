// 星芒自己的更新在 Windows 上怎么交给安装程序（审查总表 S01）。不再经 electron-updater 的 quitAndInstall，
// 由提权后的脚本（build/update-handoff/verified-install.ps1）自己复制、自己核对、自己执行，
// 主程序只负责发起和看结果。
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { isRecord } from './input-guards'
import { ensureSafeDataDirectory, readSafeUtf8File, readSafeUtf8FileSync, writeAtomicSafeUtf8File } from './safe-local-data'

/** 安装目录 resources 下那份提权脚本的位置（electron-builder.config.cjs 的 win.extraResources）。 */
export const windowsUpdateHandoffScriptRelativePath = path.win32.join('update-handoff', 'verified-install.ps1')

/**
 * 脚本核对完以后等星芒退出的上限，跟脚本里的 $parentWaitMs 是同一个数。过了它还没退，脚本放弃这次安装。
 * 主程序这边「已准备好却没退出」的那句提示要在它之后才说，那时脚本已经不会再装了。
 */
export const windowsUpdateHandoffParentWaitMs = 90_000

const maximumPackageBytes = 2 * 1024 * 1024 * 1024
const statusFileLabel = '更新安装状态'
const recordLabel = '更新安装记录'
const maximumStatusBytes = 4096

export type WindowsUpdateHandoffState = 'started' | 'verified' | 'mismatch' | 'aborted' | 'installed' | 'install-failed' | 'failed'

const handoffStates: readonly WindowsUpdateHandoffState[] = ['started', 'verified', 'mismatch', 'aborted', 'installed', 'install-failed', 'failed']

export interface WindowsUpdateHandoffStatus {
  state: WindowsUpdateHandoffState
  exitCode: number
}

/** 下载完成时核对过的那一份：sha512 取自签过名的清单项，size 是清单写的大小（没写为 null）。 */
export interface WindowsUpdateHandoffPackage {
  path: string
  sha512: string
  size: number | null
  version: string
}

export type WindowsUpdateHandoffOutcome =
  | { kind: 'verified' }
  | { kind: 'mismatch' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string }

export interface WindowsUpdateHandoffCommandInput {
  elevate: string
  powershell: string
  script: string
  packagePath: string
  sha512: string
  size: number | null
  parentPid: number
  nonce: string
}

export interface WindowsUpdateHandoffCommand {
  file: string
  args: string[]
}

function assertWindowsAbsolutePath(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.win32.isAbsolute(value)) {
    throw new Error(`${label}不是绝对路径`)
  }
  // Device and verbatim namespaces skip the normalisation every other check here
  // relies on; nothing the handoff starts or reads ever lives there.
  if (/^[\\/]{2}[.?][\\/]/.test(value)) throw new Error(`${label}不能是设备路径`)
  // A drive-relative path such as C:setup.exe is "absolute" to path.win32 only in
  // the sense that it names a drive; the script would resolve it elsewhere.
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value)) throw new Error(`${label}不是绝对路径`)
}

/** latest.yml 写 base64，electron-updater 也认 128 位十六进制：两种都收，规则跟 update-package-digest.ts 一致。 */
export function isUpdatePackageDigest(value: string): boolean {
  if (typeof value !== 'string') return false
  if (/^[0-9a-f]{128}$/i.test(value)) return true
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return false
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 64 && bytes.toString('base64') === value
}

/**
 * 提权那一步的命令：elevate.exe 以管理员身份启动系统 PowerShell 跑安装目录里的脚本。每个值都是
 * 单独一个参数（I1），引号由 Node 按 Windows 的规则加，路径里有空格、中文都照原样到脚本手里。
 */
export function buildWindowsUpdateHandoffCommand(input: WindowsUpdateHandoffCommandInput): WindowsUpdateHandoffCommand {
  assertWindowsAbsolutePath(input.elevate, '提权程序')
  if (path.win32.basename(input.elevate).toLowerCase() !== 'elevate.exe') throw new Error('提权程序不是 elevate.exe')
  assertWindowsAbsolutePath(input.powershell, 'PowerShell')
  if (path.win32.basename(input.powershell).toLowerCase() !== 'powershell.exe') throw new Error('PowerShell 路径无效')
  assertWindowsAbsolutePath(input.script, '安装脚本')
  if (path.win32.extname(input.script).toLowerCase() !== '.ps1') throw new Error('安装脚本路径无效')
  assertWindowsAbsolutePath(input.packagePath, '安装包')
  if (path.win32.extname(input.packagePath).toLowerCase() !== '.exe') throw new Error('安装包路径无效')
  const sha512 = typeof input.sha512 === 'string' ? input.sha512.trim() : ''
  if (!isUpdatePackageDigest(sha512)) throw new Error('安装包校验值无效')
  const size = input.size ?? 0
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumPackageBytes) throw new Error('安装包大小无效')
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0) throw new Error('进程号无效')
  if (!/^[0-9a-f]{32}$/.test(input.nonce)) throw new Error('交接编号无效')
  return {
    file: input.elevate,
    args: [
      input.powershell,
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', input.script,
      '-Package', input.packagePath,
      '-Sha512', sha512,
      '-Size', String(size),
      '-ParentPid', String(input.parentPid),
      '-Nonce', input.nonce,
    ],
  }
}

/** 脚本把状态写在 %SystemRoot%\Temp 下以交接编号命名的文件里；那里普通用户改不动它写好的文件。 */
export function resolveWindowsUpdateHandoffStatusPath(windowsDirectory: string, nonce: string): string {
  assertWindowsAbsolutePath(windowsDirectory, 'Windows 目录')
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('交接编号无效')
  return path.win32.join(windowsDirectory, 'Temp', `xingmang-update-status-${nonce}.json`)
}

/**
 * 只认这一次交接编号写的、格式完整的状态；别的一律当没读到（null）。状态只是提示：被伪造了顶多不装或
 * 提前退出，装进去的仍只能是脚本自己核对过的那一份。
 */
export function parseWindowsUpdateHandoffStatus(content: string | null, nonce: string): WindowsUpdateHandoffStatus | null {
  if (typeof content !== 'string' || !content.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value) || value.nonce !== nonce) return null
  const state = handoffStates.find((candidate) => candidate === value.state)
  if (!state) return null
  const exitCode = value.exitCode === undefined ? 0 : value.exitCode
  if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode)) return null
  return { state, exitCode }
}

/** elevate.exe 自己的退出码：0 是提权进程起来了，1223 是授权窗口里点了「否」。 */
export function classifyWindowsElevateExit(code: number | null): 'launched' | 'cancelled' | 'failed' {
  if (code === 0) return 'launched'
  if (code === 1223) return 'cancelled'
  return 'failed'
}

export interface WindowsUpdateHandoffPaths {
  elevate: string
  powershell: string
  script: string
  windowsDirectory: string
}

export interface WindowsUpdateHandoffAttempt {
  nonce: string
  version: string
}

export interface WindowsUpdateHandoffDependencies {
  resolvePaths(): WindowsUpdateHandoffPaths
  parentPid: number
  /** 起 elevate.exe（不随本进程退出），返回它的退出码；起不来时 reject。 */
  launch(file: string, args: readonly string[]): Promise<number | null>
  /** 读状态文件；还没有或读不了时为 null。 */
  readStatus(filePath: string): Promise<string | null>
  /** 记下这次交接，下次打开时认得出「上次没装完」。写不进去不影响这次安装。 */
  rememberAttempt?(attempt: WindowsUpdateHandoffAttempt): Promise<void>
  createNonce?(): string
  sleep?(ms: number): Promise<void>
  now?(): number
  /** elevate.exe 返回以后多久内要看到 started。 */
  startedTimeoutMs?: number
  /** elevate.exe 返回以后多久内要看到 verified 或 mismatch。 */
  verifiedTimeoutMs?: number
  pollIntervalMs?: number
}

export interface WindowsUpdateHandoff {
  start(updatePackage: WindowsUpdateHandoffPackage): Promise<WindowsUpdateHandoffOutcome>
}

function createNonce(): string {
  return randomBytes(16).toString('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWindowsUpdateHandoff(dependencies: WindowsUpdateHandoffDependencies): WindowsUpdateHandoff {
  const startedTimeoutMs = dependencies.startedTimeoutMs ?? 60_000
  const verifiedTimeoutMs = dependencies.verifiedTimeoutMs ?? 180_000
  const pollIntervalMs = dependencies.pollIntervalMs ?? 250
  const now = dependencies.now ?? Date.now
  const wait = dependencies.sleep ?? sleep
  return {
    async start(updatePackage) {
      const nonce = (dependencies.createNonce ?? createNonce)()
      let command: WindowsUpdateHandoffCommand
      let statusPath: string
      try {
        const paths = dependencies.resolvePaths()
        command = buildWindowsUpdateHandoffCommand({
          ...paths,
          packagePath: updatePackage.path,
          sha512: updatePackage.sha512,
          size: updatePackage.size,
          parentPid: dependencies.parentPid,
          nonce,
        })
        statusPath = resolveWindowsUpdateHandoffStatusPath(paths.windowsDirectory, nonce)
      } catch (error) {
        return { kind: 'failed', reason: failureReason(error) }
      }
      try {
        await dependencies.rememberAttempt?.({ nonce, version: updatePackage.version })
      } catch {
        // 只影响下次打开时那句「上次未能安装完成」，这次照装。
      }
      let exitCode: number | null
      try {
        exitCode = await dependencies.launch(command.file, command.args)
      } catch (error) {
        return { kind: 'failed', reason: `提权程序未能启动：${failureReason(error)}` }
      }
      const exit = classifyWindowsElevateExit(exitCode)
      if (exit === 'cancelled') return { kind: 'cancelled' }
      if (exit === 'failed') return { kind: 'failed', reason: `提权程序退出码 ${exitCode ?? '未知'}` }
      const startedAt = now()
      let started = false
      for (;;) {
        let content: string | null = null
        try {
          content = await dependencies.readStatus(statusPath)
        } catch {
          content = null
        }
        // 脚本正在改写时读到的半截内容当没读到，下一轮再读。
        const status = parseWindowsUpdateHandoffStatus(content, nonce)
        if (status) {
          started = true
          if (status.state === 'verified' || status.state === 'installed') return { kind: 'verified' }
          if (status.state === 'mismatch') return { kind: 'mismatch' }
          if (status.state !== 'started') return { kind: 'failed', reason: `安装脚本停在 ${status.state}` }
        }
        const elapsed = now() - startedAt
        if (!started && elapsed >= startedTimeoutMs) return { kind: 'failed', reason: '安装脚本没有启动' }
        if (elapsed >= verifiedTimeoutMs) return { kind: 'failed', reason: '安装脚本没有核对完' }
        await wait(pollIntervalMs)
      }
    },
  }
}

/**
 * 起 elevate.exe。detached：安装要在星芒退出之后接着进行，不能跟着本进程的作业对象一起被结束。
 * 环境由调用方给（trustedCommandEnvironment，I2），不经 shell（I1）。
 */
export function launchDetachedWindowsProcess(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = nodeSpawn,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
        env,
        cwd: path.win32.dirname(file),
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      resolve(code)
    })
  })
}

export async function readWindowsUpdateHandoffStatusFile(filePath: string): Promise<string | null> {
  try {
    return await readSafeUtf8File(filePath, statusFileLabel, maximumStatusBytes)
  } catch {
    return null
  }
}

export interface WindowsUpdateHandoffRecordStore {
  read(): WindowsUpdateHandoffAttempt | null
  write(attempt: WindowsUpdateHandoffAttempt): Promise<void>
}

export function parseWindowsUpdateHandoffRecord(content: string | null): WindowsUpdateHandoffAttempt | null {
  if (typeof content !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { nonce, targetVersion: version } = value
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return null
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return null
  return { nonce, version }
}

export function createWindowsUpdateHandoffRecordStore(options: { filePath: string }): WindowsUpdateHandoffRecordStore {
  if (!path.isAbsolute(options.filePath)) throw new Error('更新安装记录必须使用绝对路径。')
  return {
    read() {
      try {
        return parseWindowsUpdateHandoffRecord(readSafeUtf8FileSync(options.filePath, recordLabel, maximumStatusBytes))
      } catch {
        return null
      }
    },
    async write(attempt) {
      ensureSafeDataDirectory(path.dirname(options.filePath), recordLabel)
      await writeAtomicSafeUtf8File(options.filePath, `${JSON.stringify({ version: 1, nonce: attempt.nonce, targetVersion: attempt.version })}\n`, recordLabel)
    },
  }
}

/**
 * 下次打开时问一句：上次交给安装程序的是不是这一版、安装程序有没有报失败。只认脚本写下的
 * install-failed：授权窗口被关、没核对过、星芒没退出这几种上次那一刻已经说过了，不再重复。
 */
export function resolvePreviousWindowsHandoffFailure(
  record: WindowsUpdateHandoffAttempt | null,
  version: string,
  currentVersion: string,
  readStatus: (nonce: string) => string | null,
): boolean {
  if (!record || record.version !== version || version === currentVersion) return false
  let content: string | null = null
  try {
    content = readStatus(record.nonce)
  } catch {
    return false
  }
  return parseWindowsUpdateHandoffStatus(content, record.nonce)?.state === 'install-failed'
}

export function readWindowsUpdateHandoffStatusFileSync(filePath: string): string | null {
  try {
    return readSafeUtf8FileSync(filePath, statusFileLabel, maximumStatusBytes)
  } catch {
    return null
  }
}
