import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWindowsSystemRoot, SYSTEM_ROOT_DEVICE_PATH } from './windows-system-root'

const corePair = ['D:\\Windows\\SYSTEM32\\ntdll.dll', 'D:\\Windows\\System32\\KERNEL32.DLL']

function objectManager(answer: string) {
  const asked: string[] = []
  return {
    asked,
    realpathSystemRoot(devicePath: string) {
      asked.push(devicePath)
      return answer
    },
  }
}

describe('Windows SystemRoot', () => {
  it('stays a leaf the release gate can load from source', () => {
    const source = fs.readFileSync(path.join(__dirname, 'windows-system-root.ts'), 'utf8')
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'|\brequire\(\s*'([^']+)'\s*\)|\bimport\(\s*'([^']+)'\s*\)/g)]
      .map((match) => match[1] ?? match[2] ?? match[3])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => !specifier.startsWith('node:'))).toEqual([])
  })

  it('takes the root the core modules name without asking the object manager', () => {
    const lookup = objectManager('E:\\Windows')
    expect(resolveWindowsSystemRoot({ platform: 'win32', sharedObjects: corePair, realpathSystemRoot: lookup.realpathSystemRoot })).toBe('D:\\Windows')
    expect(lookup.asked).toEqual([])
  })

  it('asks the object manager only when the core modules name nothing', () => {
    const lookup = objectManager('E:\\Windows\\')
    expect(resolveWindowsSystemRoot({ platform: 'win32', sharedObjects: [], realpathSystemRoot: lookup.realpathSystemRoot })).toBe('E:\\Windows')
    expect(lookup.asked).toEqual([SYSTEM_ROOT_DEVICE_PATH])
  })

  it('refuses a root the core modules name but the check rejects, without a second opinion', () => {
    const lookup = objectManager('E:\\Windows')
    expect(() => resolveWindowsSystemRoot({
      platform: 'win32',
      sharedObjects: ['C:\\Win\0dows\\System32\\ntdll.dll', 'C:\\Win\0dows\\System32\\kernel32.dll'],
      realpathSystemRoot: lookup.realpathSystemRoot,
    })).toThrow('无法解析可信的 Windows SystemRoot 目录')
    expect(lookup.asked).toEqual([])
  })

  it('refuses off Windows without asking the object manager', () => {
    const lookup = objectManager('E:\\Windows')
    expect(() => resolveWindowsSystemRoot({ platform: 'darwin', sharedObjects: corePair, realpathSystemRoot: lookup.realpathSystemRoot }))
      .toThrow('仅支持 Windows')
    expect(lookup.asked).toEqual([])
  })
})
