import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { isDarwinForeignWritablePath } from '../darwin-path-trust'
import { copyBoundedFileExclusive, readBoundedFile } from '../bounded-file'
import { ensureSafeDataDirectory } from '../safe-local-data'

export interface MacosProxyChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  unref(): void
}
export interface MacosSystemProxyOptions {
  journalPath: string
  helperPath?: string
  timeoutMs?: number
  spawnHelper?: (helperPath: string, args: string[]) => MacosProxyChild
  validateHelper?: (helperPath: string) => void
  prepareHelper?: (helperPath: string) => Promise<string>
}

/** authd must be able to inspect its client's executable. Desktop/Documents
 * privacy protection can deny that access before any authorization UI appears.
 * Keep immutable per-launch copies outside those protected folders; never
 * replace the executable of a helper that may still own proxy restoration. */
export async function prepareMacosProxyHelper(
  sourcePath: string,
  cacheDirectory = path.join(os.homedir(), 'Library', 'Application Support', 'XingMangProxy', 'helpers'),
): Promise<string> {
  const maximumBytes = 8 * 1024 * 1024
  const label = '系统代理组件'
  const source = await readBoundedFile(sourcePath, maximumBytes, label)
  if (!source.length) throw new Error('系统代理组件校验失败')
  const digest = createHash('sha256').update(source).digest('hex')
  ensureSafeDataDirectory(cacheDirectory, label)
  // A killed writer can leave an incomplete directory. Fresh private names
  // ensure a later start never selects those bytes or blocks on that old copy.
  const directory = await fs.promises.mkdtemp(path.join(cacheDirectory, `${digest}-`))
  const target = path.join(directory, 'macos-system-proxy')
  try {
    await fs.promises.chmod(directory, 0o700)
    await copyBoundedFileExclusive(sourcePath, target, maximumBytes, label)
    const copied = await readBoundedFile(target, maximumBytes, label)
    if (createHash('sha256').update(copied).digest('hex') !== digest) throw new Error('系统代理组件校验失败')
    await fs.promises.chmod(target, 0o500)
    return target
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function validateHelper(helperPath: string): void {
  const info = fs.lstatSync(helperPath)
  if (!path.isAbsolute(helperPath) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !(info.mode & 0o111) || isDarwinForeignWritablePath(helperPath)) {
    throw new Error('系统代理组件校验失败')
  }
}

function spawnHelper(helperPath: string, args: string[]): MacosProxyChild {
  // Never inherit DYLD_*, NODE_OPTIONS or shell startup variables into the helper.
  return spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8' }, shell: false })
}

function replyError(code: unknown): Error {
  if (code === 'authorization') return Object.assign(new Error('系统代理授权未完成，请授权后重试'), { code: 'MACOS_PROXY_AUTHORIZATION' })
  if (code === 'busy') return new Error('另一实例正在使用系统代理，请先停止该实例的加速。')
  return new Error('系统代理操作失败，恢复记录已保留，请重试恢复')
}

export function createMacosSystemProxy(options: MacosSystemProxyOptions) {
  const helperPath = options.helperPath ?? path.resolve(__dirname, '../../dist-native', `macos-system-proxy-${process.arch}`)
  if (!path.isAbsolute(options.journalPath) || options.journalPath.includes('\0')) throw new Error('系统代理恢复路径无效')
  let child: MacosProxyChild | undefined
  let retired: Promise<void> | undefined
  let sequence = 0
  let buffer = ''
  let tail: Promise<void> = Promise.resolve()
  let pending: { id: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  let disposed = false

  function disconnect(error: Error): void {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
    // EOF asks the native owner to restore with its retained authorization. Never
    // SIGKILL an owner: failed restoration must keep both journal and process alive.
    const retiring = child
    if (retiring) {
      retired = new Promise<void>(resolve => {
        let settled = false
        function ended(): void { if (!settled) { settled = true; resolve() } }
        retiring.once('exit', ended)
        retiring.once('close', ended)
      })
      child = undefined
      retiring.stdin.end()
      retiring.unref()
    }
    buffer = ''
  }

  async function ensureChild(): Promise<MacosProxyChild> {
    if (retired) { await retired; retired = undefined }
    if (child) return child
    try {
      const validate = options.validateHelper ?? validateHelper
      validate(helperPath)
      const preparedPath = await (options.prepareHelper ?? prepareMacosProxyHelper)(helperPath)
      validate(preparedPath)
      child = (options.spawnHelper ?? spawnHelper)(preparedPath, ['--journal', options.journalPath])
    } catch { throw new Error('系统代理组件不可用，请重新安装或联系支持') }
    const active = child
    active.stderr.resume()
    active.stdin.on('error', () => { if (child === active) disconnect(new Error('系统代理连接已中断，正在尝试恢复')) })
    active.on('error', () => { if (child === active) disconnect(new Error('系统代理组件启动失败')) })
    function ended(): void { if (child === active) { disconnect(new Error('系统代理组件已退出，请重试恢复')); retired = undefined } }
    active.on('exit', ended)
    active.on('close', ended)
    active.stdout.on('data', (data: Buffer) => {
      if (child !== active) return
      buffer += data.toString('utf8')
      if (Buffer.byteLength(buffer) > 8192) { disconnect(new Error('系统代理组件返回异常')); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || !('id' in value) || !('ok' in value) || typeof value.ok !== 'boolean' || !pending || value.id !== pending.id) throw new Error('invalid')
          const request = pending
          clearTimeout(request.timer)
          pending = undefined
          if (value.ok) request.resolve()
          else request.reject(replyError('error' in value ? value.error : undefined))
        } catch { disconnect(new Error('系统代理组件返回异常')); return }
      }
    })
    return active
  }

  function request(op: string, port?: number): Promise<void> {
    const task = tail.then(async () => {
      if (disposed) throw new Error('系统代理组件已关闭')
      const active = await ensureChild()
      const id = ++sequence
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => disconnect(new Error('系统代理操作超时，正在尝试恢复')), options.timeoutMs ?? 120_000)
        pending = { id, resolve, reject, timer }
        try { active.stdin.write(JSON.stringify({ id, op, ...(port === undefined ? {} : { port }) }) + '\n') }
        catch { disconnect(new Error('系统代理连接已中断，正在尝试恢复')) }
      })
    })
    tail = task.catch(() => {})
    return task
  }

  return {
    enable(port: number): Promise<void> {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('代理端口无效'))
      return request('enable', port)
    },
    restore(): Promise<void> { return request('restore') },
    recover(): Promise<void> { return request('recover') },
    async dispose(): Promise<void> {
      if (disposed) return
      await request('stop')
      disposed = true
      child?.stdin.end()
      child = undefined
    },
  }
}
