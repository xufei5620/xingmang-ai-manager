import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAccelerationElectronProfile, isolateAccelerationElectronProfile } from './acceleration-electron-profile'

describe('packaged acceleration Electron profile isolation', () => {
  it('gives concurrent workers separate profiles and removes only the exited worker state', () => {
    const first = createAccelerationElectronProfile()
    const second = createAccelerationElectronProfile()
    try {
      expect(first.directory).not.toBe(second.directory)
      expect(path.dirname(first.directory)).toBe(fs.realpathSync(os.tmpdir()))
      fs.writeFileSync(path.join(first.directory, 'Local State'), 'fixture-one')
      fs.writeFileSync(path.join(second.directory, 'Local State'), 'fixture-two')
      const app = { setPath: vi.fn() }
      isolateAccelerationElectronProfile(app, ['app', '--xingmang-acceleration-worker', second.argument])
      expect(app.setPath.mock.calls).toEqual([['userData', second.directory], ['sessionData', second.directory]])
      first.cleanup()
      first.cleanup()
      expect(fs.existsSync(first.directory)).toBe(false)
      expect(fs.readFileSync(path.join(second.directory, 'Local State'), 'utf8')).toBe('fixture-two')
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  it('rejects absent, duplicate and desktop data paths before changing Electron paths', () => {
    const profile = createAccelerationElectronProfile()
    const app = { setPath: vi.fn() }
    try {
      for (const argv of [[], [profile.argument, profile.argument], ['--user-data-dir=relative'],
        [`--user-data-dir=${path.join(os.homedir(), 'AppData', 'Roaming', 'xingmang-ai-manager')}`]]) {
        expect(() => isolateAccelerationElectronProfile(app, argv)).toThrow()
      }
      expect(app.setPath).not.toHaveBeenCalled()
    } finally { profile.cleanup() }
  })

  it('does not adopt or remove a replacement directory under a previously owned path', () => {
    const profile = createAccelerationElectronProfile()
    const original = `${profile.directory}-original`
    try {
      fs.renameSync(profile.directory, original)
      fs.mkdirSync(profile.directory)
      fs.writeFileSync(path.join(profile.directory, 'keep'), 'unrelated replacement')
      profile.cleanup()
      expect(fs.readFileSync(path.join(profile.directory, 'keep'), 'utf8')).toBe('unrelated replacement')
    } finally {
      expect(path.dirname(original)).toBe(fs.realpathSync(os.tmpdir()))
      fs.rmSync(profile.directory, { recursive: true, force: true })
      fs.renameSync(original, profile.directory)
      profile.cleanup()
    }
  })

  it('rejects a directory junction and leaves its destination untouched during cleanup', () => {
    const profile = createAccelerationElectronProfile()
    const destination = createAccelerationElectronProfile()
    try {
      fs.rmdirSync(profile.directory)
      fs.writeFileSync(path.join(destination.directory, 'keep'), 'fixture')
      fs.symlinkSync(destination.directory, profile.directory, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => isolateAccelerationElectronProfile({ setPath: vi.fn() }, [profile.argument])).toThrow()
      profile.cleanup()
      expect(fs.readFileSync(path.join(destination.directory, 'keep'), 'utf8')).toBe('fixture')
    } finally {
      fs.unlinkSync(profile.directory)
      destination.cleanup()
    }
  })
})
