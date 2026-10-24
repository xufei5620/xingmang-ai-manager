import type fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectAppxVolumeLink, type AppxVolumeLinkFileSystem } from './appx-volume-link'

const location = 'C:\\Program Files\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc'

function machine(target: string, link = true): AppxVolumeLinkFileSystem {
  return {
    lstat: (value) => {
      if (value !== location) throw new Error(`ENOENT ${value}`)
      return { isSymbolicLink: () => link } as fs.Stats
    },
    readlink: () => target,
  }
}

describe('inspectAppxVolumeLink', () => {
  it('recognizes the system link to the same package on another drive', () => {
    expect(inspectAppxVolumeLink(location, 'C', machine('D:\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc'))).toEqual({ drive: 'D' })
    expect(inspectAppxVolumeLink(location, 'c', machine('\\\\?\\e:\\windowsapps\\claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\'))).toEqual({ drive: 'E' })
  })

  it.each([
    ['a plain package directory', machine('D:\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc', false)],
    ['another package', machine('D:\\WindowsApps\\Claude_9.9.9.9_x64__pzs8sxrjxfjjc')],
    ['a folder that is not a drive-level WindowsApps', machine('D:\\Users\\Tester\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc')],
    ['a folder inside the package', machine('D:\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc\\app')],
    ['a network share', machine('\\\\server\\share\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc')],
    ['the system drive itself', machine('C:\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc')],
  ])('does not claim %s', (_label, fileSystem) => {
    expect(inspectAppxVolumeLink(location, 'C', fileSystem)).toBeNull()
  })

  it('answers null rather than throwing when the link cannot be read', () => {
    expect(inspectAppxVolumeLink(location, 'C', { lstat: () => { throw new Error('EACCES') } })).toBeNull()
    expect(inspectAppxVolumeLink(location, 'C', { ...machine(''), readlink: () => { throw new Error('EPERM') } })).toBeNull()
    expect(inspectAppxVolumeLink('Claude_3.6556.2.0_x64__pzs8sxrjxfjjc', 'C', machine('D:\\WindowsApps\\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc'))).toBeNull()
  })
})
