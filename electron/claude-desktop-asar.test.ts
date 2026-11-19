import { describe, expect, it } from 'vitest'
import { decodeSingleQuotedLiteral, listAsarBuildScripts, parseAsarHeaderJson, parseAsarSizePrefix } from './claude-desktop-asar'

describe('claude desktop asar reader', () => {
  it('decodes JavaScript single-quoted literals and refuses what it cannot read exactly', () => {
    const text = 'x(\'a\\\'b\\\\c\\x41\\u0042\\u{1F600}\\n\\\r\nd\')'
    expect(decodeSingleQuotedLiteral(text, 3)).toBe('a\'b\\cAB\u{1F600}\nd')
    expect(decodeSingleQuotedLiteral('\'abc', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'a\nb\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'\\012\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'\\xZ1\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'abcdef\'', 1, 3)).toBeNull()
  })

  it('bounds the asar header and the script table', () => {
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32LE(4, 0)
    prefix.writeUInt32LE(64 * 1024 * 1024, 4)
    expect(() => parseAsarSizePrefix(prefix, 1024 * 1024 * 1024)).toThrow()
    prefix.writeUInt32LE(100, 4)
    expect(() => parseAsarSizePrefix(prefix, 50)).toThrow()
    expect(parseAsarSizePrefix(prefix, 1000)).toBe(100)
    const header = Buffer.alloc(16)
    header.writeUInt32LE(100, 0)
    expect(() => parseAsarHeaderJson(header)).toThrow()
    const index = { files: { '.vite': { files: { build: { files: {
      'big.js': { size: 64 * 1024 * 1024, offset: '0' },
      'past-end.js': { size: 10, offset: '995' },
      'odd-offset.js': { size: 10, offset: '-1' },
      '../escape.js': { size: 10, offset: '0' },
      'ok.js': { size: 10, offset: '0' },
      'style.css': { size: 10, offset: '0' },
    } } } } } }
    expect(listAsarBuildScripts(index, 1000)).toEqual([{ name: 'ok.js', offset: 0, size: 10 }])
    expect(listAsarBuildScripts(null, 1000)).toEqual([])
  })

  it('reads the file table JSON out of a header pickle', () => {
    const json = Buffer.from('{"files":{}}')
    const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4)
    header.writeUInt32LE(header.length - 4, 0)
    header.writeUInt32LE(json.length, 4)
    json.copy(header, 8)
    expect(parseAsarHeaderJson(header)).toBe('{"files":{}}')
  })
})
