import { describe, expect, it } from 'vitest'
import {
  InstallCancellationRegistry,
  InstallCancelledError,
  isInstallCancelledError,
} from './install-cancellation'

describe('install cancellation registry', () => {
  it('reports that nothing is running when no install registered the key', () => {
    const registry = new InstallCancellationRegistry()
    const outcome = registry.cancel('cli:install:claude')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toContain('没有正在进行的安装')
  })

  it('aborts the signal handed to the running install', () => {
    const registry = new InstallCancellationRegistry()
    const handle = registry.begin('cli:install:claude')
    expect(handle.signal.aborted).toBe(false)
    expect(registry.cancel('cli:install:claude')).toEqual({ cancelled: true, reason: null })
    expect(handle.signal.aborted).toBe(true)
    expect(handle.cancelled).toBe(true)
    expect(isInstallCancelledError(handle.signal.reason)).toBe(true)
  })

  it('refuses to cancel while the install is sealed and explains why', () => {
    const registry = new InstallCancellationRegistry()
    const handle = registry.begin('cli:install:codex')
    handle.seal('正在把新版本写入工具目录')
    const outcome = registry.cancel('cli:install:codex')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toBe('正在把新版本写入工具目录')
    expect(handle.signal.aborted).toBe(false)
  })

  it('accepts cancellation again once the sealed stretch is over', () => {
    const registry = new InstallCancellationRegistry()
    const handle = registry.begin('cli:install:codex')
    handle.seal('正在把新版本写入工具目录')
    registry.cancel('cli:install:codex')
    handle.unseal()
    expect(registry.cancel('cli:install:codex').cancelled).toBe(true)
    expect(handle.signal.aborted).toBe(true)
  })

  it('treats a repeated cancel as the same cancellation rather than a failure', () => {
    const registry = new InstallCancellationRegistry()
    registry.begin('cli:install:gemini')
    expect(registry.cancel('cli:install:gemini').cancelled).toBe(true)
    expect(registry.cancel('cli:install:gemini')).toEqual({ cancelled: true, reason: null })
  })

  it('rejects a second install under the same key so the handle cannot be displaced', () => {
    const registry = new InstallCancellationRegistry()
    registry.begin('cli:install:grok')
    expect(() => registry.begin('cli:install:grok')).toThrow(/正在进行的安装/)
  })

  it('stops tracking a released key and leaves a released handle inert', () => {
    const registry = new InstallCancellationRegistry()
    const handle = registry.begin('cli:install:claude')
    handle.release()
    expect(registry.activeKeys()).toEqual([])
    handle.release()
    const replacement = registry.begin('cli:install:claude')
    expect(registry.activeKeys()).toEqual(['cli:install:claude'])
    // 旧句柄再 release 一次不能把新登记的那次安装从表里抹掉。
    handle.release()
    expect(registry.activeKeys()).toEqual(['cli:install:claude'])
    expect(registry.cancel('cli:install:claude').cancelled).toBe(true)
    expect(replacement.signal.aborted).toBe(true)
  })

  it('throws the shared cancellation error between phases', () => {
    const registry = new InstallCancellationRegistry()
    const handle = registry.begin('cli:install:claude')
    expect(() => handle.throwIfCancelled()).not.toThrow()
    registry.cancel('cli:install:claude')
    expect(() => handle.throwIfCancelled()).toThrow(InstallCancelledError)
  })

  it('refuses an empty key and an empty seal reason', () => {
    const registry = new InstallCancellationRegistry()
    expect(() => registry.begin('  ')).toThrow(TypeError)
    const handle = registry.begin('cli:install:claude')
    expect(() => handle.seal('  ')).toThrow(TypeError)
  })

  it('recognises a cancellation carried across a structured clone boundary', () => {
    expect(isInstallCancelledError(new InstallCancelledError())).toBe(true)
    expect(isInstallCancelledError({ installCancelled: true })).toBe(true)
    expect(isInstallCancelledError(new Error('npm 安装失败'))).toBe(false)
    expect(isInstallCancelledError(null)).toBe(false)
  })
})
