import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canvasHostKind, isCanvasHostKind, resolveCanvasHostKind } from './host-kind'

const sourceRoot = fileURLToPath(new URL('./', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'test-fixtures' ? [] : sourceFiles(candidate)
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name) ? [candidate] : []
  })
}

describe('canvas host kind switch', () => {
  it('accepts the three hosts and treats a missing switch as the desktop', () => {
    for (const kind of ['web', 'desktop', 'embed']) expect(resolveCanvasHostKind(kind)).toBe(kind)
    expect(resolveCanvasHostKind(undefined)).toBe('desktop')
  })
  it('rejects any other value instead of guessing a host', () => {
    for (const value of ['Web', '', 'sites', null, 1, {}]) {
      expect(isCanvasHostKind(value)).toBe(false)
      expect(() => resolveCanvasHostKind(value)).toThrow('画布宿主类型不正确')
    }
  })
  it('is the desktop when the build defines nothing', () => {
    expect(canvasHostKind).toBe('desktop')
  })
  it('is read only by host-kind.ts', () => {
    const readers = sourceFiles(sourceRoot).filter((file) => readFileSync(file, 'utf8').includes('__XINGMANG_CANVAS_HOST__')).map((file) => relative(sourceRoot, file))
    expect(readers).toEqual(['host-kind.ts'])
  })
})
