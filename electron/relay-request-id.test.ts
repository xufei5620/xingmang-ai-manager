import { describe, expect, it } from 'vitest'
import { readRelayRequestId } from './relay-request-id'

describe('relay request id', () => {
  it('reads the id new-api puts on every answer', () => {
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': ' 2026111013000012345678abcdefgh ' }))).toBe('2026111013000012345678abcdefgh')
  })

  it('refuses a missing, oversized or odd-looking id rather than matching charges by it', () => {
    expect(readRelayRequestId(new Headers())).toBeNull()
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'a'.repeat(65) }))).toBeNull()
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'id with spaces' }))).toBeNull()
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'id%20x' }))).toBeNull()
  })

  it('refuses an id the run store would refuse to save as key-shaped', () => {
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'sk-12345678abcdefgh' }))).toBeNull()
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'req.sk-12345678abcdefgh' }))).toBeNull()
    expect(readRelayRequestId(new Headers({ 'X-Oneapi-Request-Id': 'desk-2026111013000012' }))).toBe('desk-2026111013000012')
  })
})
