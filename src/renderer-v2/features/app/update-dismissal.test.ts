import { describe, expect, it } from 'vitest'
import { buildUpdateDismissal, parseUpdateDismissal, updateBubbleRepeatMs, updateDismissalRemainingMs } from './update-dismissal'

describe('update bubble dismissal', () => {
  const closedAt = Date.parse('2026-10-27T05:00:00Z')

  it('keeps a dismissed bubble away for a day and lets it back after that', () => {
    const dismissal = parseUpdateDismissal(buildUpdateDismissal('downloaded:0.2.23:', closedAt))
    expect(dismissal).toEqual({ key: 'downloaded:0.2.23:', at: closedAt })
    expect(updateDismissalRemainingMs(dismissal, 'downloaded:0.2.23:', closedAt)).toBe(updateBubbleRepeatMs)
    expect(updateDismissalRemainingMs(dismissal, 'downloaded:0.2.23:', closedAt + updateBubbleRepeatMs - 1000)).toBe(1000)
    expect(updateDismissalRemainingMs(dismissal, 'downloaded:0.2.23:', closedAt + updateBubbleRepeatMs)).toBe(0)
  })

  it('shows a different message at once, as before', () => {
    const dismissal = parseUpdateDismissal(buildUpdateDismissal('available:0.2.23:', closedAt))
    expect(updateDismissalRemainingMs(dismissal, 'downloaded:0.2.23:', closedAt + 1000)).toBe(0)
    expect(updateDismissalRemainingMs(dismissal, 'available:0.2.24:', closedAt + 1000)).toBe(0)
  })

  it('treats a clock set back before the dismissal as a day gone by', () => {
    const dismissal = parseUpdateDismissal(buildUpdateDismissal('downloaded:0.2.23:', closedAt))
    expect(updateDismissalRemainingMs(dismissal, 'downloaded:0.2.23:', closedAt - 60_000)).toBe(0)
  })

  it('reads anything it did not write as never dismissed', () => {
    for (const value of [null, '', 'downloaded:0.2.23:', '[]', 'null', '{"key":1,"at":2}', '{"key":"downloaded:0.2.23:"}', '{"key":"a","at":"soon"}']) {
      expect(parseUpdateDismissal(value)).toBeNull()
    }
    expect(updateDismissalRemainingMs(null, 'downloaded:0.2.23:', closedAt)).toBe(0)
  })
})
