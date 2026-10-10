/** Claim a displayed proposal synchronously, before React flushes state or IPC
 *  returns. A refreshed proposal is a new object and requires a fresh click.
 *  A failed or unknown submission never unlocks the same proposal implicitly. */
export function createRunProposalClaim(): (proposal: object) => boolean {
  const claimed = new WeakSet<object>()
  return (proposal) => {
    if (claimed.has(proposal)) return false
    claimed.add(proposal)
    return true
  }
}
