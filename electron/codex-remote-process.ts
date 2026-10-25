import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { windowsSystemExecutable } from './command-runner'
import type { AppServerProcess, AppServerReadable, AppServerWritable } from './codex-remote-app-server'
import type { ResolvedCliCommand } from './tool-installation'

// 起手机遥控用的 `codex app-server`：可执行文件由 resolveCodexCommand 认过（只认受信任的 npm 安装），
// argv 数组、不经 shell（I1），环境由调用方给（同用户运行时的 commandEnvironment）。
//
// Windows: child.kill() only reaches the direct child, while the commands Codex
// runs are grandchildren holding inherited pipes; stopping remote control must
// take the whole tree down, so the kill goes through taskkill /T resolved from
// System32 (I14), never PATH.

export type SpawnAppServerProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface CodexAppServerSpawnOptions {
  env: NodeJS.ProcessEnv
  resolveCommand(): Promise<ResolvedCliCommand>
  platform?: NodeJS.Platform
  spawnProcess?: SpawnAppServerProcess
  resolveWindowsSystemExecutable?(fileName: string): string
}

export function buildCodexAppServerArgv(base: Pick<ResolvedCliCommand, 'argv'>): string[] {
  return [...base.argv, 'app-server', '--listen', 'stdio://']
}

class SpawnedAppServer implements AppServerProcess {
  readonly stdin: AppServerWritable
  readonly stdout: AppServerReadable
  readonly stderr: AppServerReadable
  private exited = false

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: CodexAppServerSpawnOptions,
    private readonly spawnProcess: SpawnAppServerProcess,
  ) {
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    child.once('exit', () => { this.exited = true })
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): unknown {
    if (event === 'exit') return this.child.on('exit', listener as (code: number | null, signal: NodeJS.Signals | null) => void)
    return this.child.on('error', listener as (error: Error) => void)
  }

  kill(signal?: NodeJS.Signals): boolean {
    const platform = this.options.platform ?? process.platform
    const pid = this.child.pid
    if (platform !== 'win32' || !pid || this.exited) return this.child.kill(signal)
    const fallback = () => { this.child.kill(signal) }
    try {
      const resolve = this.options.resolveWindowsSystemExecutable ?? ((fileName: string) => windowsSystemExecutable(fileName))
      const killer = this.spawnProcess(resolve('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        env: this.options.env,
      })
      killer.once('error', fallback)
      killer.once('exit', (code) => {
        if (code !== 0) fallback()
      })
      killer.unref()
    } catch {
      fallback()
    }
    return true
  }
}

export async function spawnCodexAppServer(options: CodexAppServerSpawnOptions): Promise<AppServerProcess> {
  const command = await options.resolveCommand()
  const spawnProcess: SpawnAppServerProcess = options.spawnProcess ?? spawn
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess(command.executable, buildCodexAppServerArgv(command), {
      env: options.env,
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    await command.release?.()
    throw error
  }
  child.once('exit', () => { void command.release?.() })
  // 可执行文件起不来时 Node 只发 error、不发 exit：先等它真起来，免得握手干等到超时。
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      child.off('spawn', onSpawn)
      void command.release?.()
      // 原话带着可执行文件的完整路径，不往外带。
      reject(new Error('电脑上的 Codex 没能启动'))
    }
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
  return new SpawnedAppServer(child, options, spawnProcess)
}
