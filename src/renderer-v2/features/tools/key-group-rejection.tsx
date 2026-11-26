import { isKeyGroupRejectionMessage } from '../../../../electron/relay-quota-failure'
import { errorMessage, rawErrorMessage, supportDetailOf } from '../../business-common'
import { Button } from '../../ui'

/**
 * 检测模型时中转说这把密钥所在的分组账号已经用不了（服务端删了分组，密钥还留着）。以前把「服务返回 403：无权访问
 * Claude-ANTI 分组 (request id: …)」原样端给客户（2026-11-19 yoyo 在 0.2.24 看到），现在换成一句话加「更换可用密钥」，
 * 原话打过码收进「查看详情」给客服看（yoyo 同日回「改」）。detail 空着 = 没有原话可给。
 */
export interface KeyGroupRejection { groupRejected: true; detail: string }

/** 检测模型失败时上屏的东西：分组被拒的单独认出来，别的照旧是一句话。 */
export function modelCheckFailure(cause: unknown, fallback?: string): string | KeyGroupRejection {
  if (isKeyGroupRejectionMessage(rawErrorMessage(cause))) return { groupRejected: true, detail: supportDetailOf(cause) }
  return errorMessage(cause, fallback)
}

export function isKeyGroupRejection(value: unknown): value is KeyGroupRejection {
  return typeof value === 'object' && value !== null && (value as Partial<KeyGroupRejection>).groupRejected === true
}

export const keyGroupRejectedText = '该密钥所属的分组在当前账号下已不可用，请更换密钥。'

/** onSwitch 缺省 = 没有能替他换的那把：有 stuckText 就改说它（外部客户端弹窗叫他去「访问密钥」里换），没有照旧那一句。 */
export function KeyGroupRejectedNotice({ failure, onSwitch, stuckText, testId, switchTestId }: {
  failure: KeyGroupRejection
  onSwitch?(): void
  stuckText?: string
  testId: string
  switchTestId: string
}) {
  return <div className="v2-key-group-rejected" data-testid={testId}>
    <div className="v2-callout is-bad" role="alert"><span>{onSwitch || !stuckText ? keyGroupRejectedText : stuckText}</span>
      {onSwitch && <Button size="sm" onClick={onSwitch} testId={switchTestId}>更换可用密钥</Button>}</div>
    {failure.detail && <details className="v2-client-config-path"><summary>查看详情</summary><p>{failure.detail}</p></details>}
  </div>
}
