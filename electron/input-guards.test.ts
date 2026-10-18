import { describe, expect, it } from 'vitest'
import { filterStrings, isPromiseLike, isRecord, isStringArray } from './input-guards'

describe('isRecord', () => {
  it('accepts plain objects, including ones without a prototype', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ model: 'gpt-image-2' })).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
  })

  it('rejects null, arrays and primitives', () => {
    for (const value of [null, undefined, [], ['a'], 'text', 0, 1, true, false, Symbol('x'), 10n, () => undefined]) {
      expect(isRecord(value)).toBe(false)
    }
  })
})

describe('isStringArray', () => {
  it('accepts arrays whose every entry is a string', () => {
    expect(isStringArray([])).toBe(true)
    expect(isStringArray(['a', '', 'b'])).toBe(true)
  })

  it('rejects the whole array when a single entry is not a string', () => {
    expect(isStringArray(['a', 1])).toBe(false)
    expect(isStringArray(['a', null])).toBe(false)
    expect(isStringArray([['a']])).toBe(false)
    expect(isStringArray('a')).toBe(false)
    expect(isStringArray({ 0: 'a', length: 1 })).toBe(false)
  })

  it('does not let the holes of a sparse array pass as strings', () => {
    expect(isStringArray(new Array(3))).toBe(false)
    const holey: string[] = ['a']
    holey[2] = 'c'
    expect(isStringArray(holey)).toBe(false)
  })

  it('enforces the item and length limits when given', () => {
    expect(isStringArray(['a', 'b'], { maxItems: 2 })).toBe(true)
    expect(isStringArray(['a', 'b', 'c'], { maxItems: 2 })).toBe(false)
    expect(isStringArray(['abc'], { maxLength: 3 })).toBe(true)
    expect(isStringArray(['abc', 'abcd'], { maxLength: 3 })).toBe(false)
    expect(isStringArray([], { maxItems: 0 })).toBe(true)
  })
})

describe('filterStrings', () => {
  it('keeps the string entries and drops the rest', () => {
    expect(filterStrings(['a', 1, null, 'b', { c: 'c' }])).toEqual(['a', 'b'])
  })

  it('reads anything that is not an array as empty', () => {
    for (const value of [undefined, null, 'a', 1, { 0: 'a', length: 1 }]) {
      expect(filterStrings(value)).toEqual([])
    }
  })

  it('caps the result after filtering', () => {
    expect(filterStrings([1, 'a', 2, 'b', 'c'], 2)).toEqual(['a', 'b'])
    expect(filterStrings(['a', 'b'], 0)).toEqual([])
  })

  it('returns a new array rather than the caller input', () => {
    const input = ['a', 'b']
    const result = filterStrings(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })
})

describe('isPromiseLike', () => {
  it('accepts promises and thenable objects or functions', () => {
    const settled = Promise.resolve(1)
    expect(isPromiseLike(settled)).toBe(true)
    expect(isPromiseLike({ then: () => undefined })).toBe(true)
    expect(isPromiseLike(Object.assign(() => undefined, { then: () => undefined }))).toBe(true)
  })

  it('rejects values whose then is missing or not callable', () => {
    for (const value of [null, undefined, 1, 'then', {}, { then: 1 }, { then: 'function' }, () => undefined]) {
      expect(isPromiseLike(value)).toBe(false)
    }
  })
})
