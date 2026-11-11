import type { AiRelayBillingObserver } from './ai-operation-progress'

// new-api stamps every answer with the id it files the request's usage record
// under (middleware/request-id.go sets common.RequestIdKey on the response, and
// model.Log keeps it in request_id, varchar(64)). The canvas run settles its
// 实扣 by looking that id up in the account's own usage records.
export const relayRequestIdHeader = 'x-oneapi-request-id'

const relayRequestIdPattern = /^[A-Za-z0-9._:-]{1,64}$/
// The run store refuses to write anything shaped like a key into a run record
// (canvas-run-store.ts, stateContainsSecretOrPath), and that write lands after
// the generation is paid for. An id that would trip it is not one new-api
// issues (timestamp + random letters), so it is treated as no id at all.
const keyShapedPattern = /\bsk-/i

/** The relay's request id from an answer's headers; null when absent or not shaped like one. */
export function readRelayRequestId(headers: Pick<Headers, 'get'>): string | null {
  const value = headers.get(relayRequestIdHeader)?.trim() ?? ''
  return relayRequestIdPattern.test(value) && !keyShapedPattern.test(value) ? value : null
}

/** Billing evidence is bookkeeping: an observer that throws must never sink paid work. */
export function reportRelayDispatch(observer: AiRelayBillingObserver | undefined, sent: boolean): void {
  try { observer?.onRelayDispatch?.(sent) } catch { /* bookkeeping only */ }
}

export function reportRelayAnswer(observer: AiRelayBillingObserver | undefined, headers: Pick<Headers, 'get'>): void {
  try { observer?.onRelayAnswer?.(readRelayRequestId(headers)) } catch { /* bookkeeping only */ }
}
