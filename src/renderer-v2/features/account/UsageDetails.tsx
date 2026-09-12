import { useRef, type ReactNode } from 'react'
import type { AccountBalance, AccountUsageRecord } from '../../../../electron/ipc-contract'
import { Button, Dialog, Pill } from '../../ui'
import { displayDate } from '../../business-common'
import { normalizedUsageTier, usageBillingMode, usageMoney, usageNumber, usagePriceFields, usageTierCondition, usageUnitPrice } from './usage-detail-view'

function DetailRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="v2-usage-detail-kv">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

export function UsageDetails({ record, balance, onClose }: { record: AccountUsageRecord; balance: AccountBalance; onClose(): void }) {
  const initialFocus = useRef<HTMLDivElement>(null)
  const details = record.details
  const prices = details.unitPrices
  const tiers = details.pricingTiers ?? []
  const costs = details.costs
  const typeLabel = ({ 1: '充值', 2: '消费', 3: '管理', 4: '系统', 5: '错误', 6: '退款', 7: '登录' } as Record<number, string>)[record.type] ?? '未知'
  const info: Array<[string, ReactNode]> = [
    ['模型', record.modelName || '未提供'], ['记录时间', displayDate(record.createdAt)],
    ['请求编号', record.requestId || '未提供'], ['令牌', record.tokenName || '未提供'], ['分组', record.group || '未提供'],
    ['响应时间', `${usageNumber(record.useTimeSeconds)} 秒`],
    ['首字响应', details.firstResponseTimeMs === null ? '未提供' : `${usageNumber(details.firstResponseTimeMs)} ms`],
    ['请求方式', record.isStream ? '流式' : '非流式'],
  ]
  if (details.reasoningEffort) info.push(['推理强度', details.reasoningEffort])
  if (record.upstreamRequestId) info.push(['上游请求', record.upstreamRequestId])
  if (details.upstreamModelName) info.push(['上游模型', details.upstreamModelName])
  if (details.serviceTier) info.push(['服务等级', details.serviceTier])
  const tokens: Array<[string, ReactNode]> = [
    ['输入 Token', usageNumber(record.promptTokens)], ['输出 Token', usageNumber(record.completionTokens)],
    ['缓存读取', usageNumber(details.cacheTokens)], ['缓存写入', usageNumber(details.cacheCreationTokens)],
  ]
  if (details.cacheCreationTokens5m > 0) tokens.push(['缓存写入（5 分钟）', usageNumber(details.cacheCreationTokens5m)])
  if (details.cacheCreationTokens1h > 0) tokens.push(['缓存写入（1 小时）', usageNumber(details.cacheCreationTokens1h)])
  if ((details.imageInputTokens ?? 0) > 0) tokens.push(['其中图片输入 Token', usageNumber(details.imageInputTokens)])
  if ((details.imageOutputTokens ?? 0) > 0) tokens.push(['其中图片输出 Token', usageNumber(details.imageOutputTokens)])
  if ((details.imageCount ?? 0) > 0) tokens.push(['图片数量', usageNumber(details.imageCount)])
  if (details.imageSize) tokens.push(['图片计费尺寸', details.imageSize])
  const billing: Array<[string, ReactNode]> = [['计费模式', usageBillingMode(record)]]
  if (details.billingType) billing.push(['扣费来源', details.billingType === 'subscription' ? '订阅额度' : '账户余额'])
  if (details.matchedTier) billing.push(['命中阶梯', details.matchedTier])
  if (prices) for (const [field, label] of usagePriceFields) {
    if (prices[field] !== null && prices[field] !== undefined) billing.push([label, usageUnitPrice(prices[field])])
  }
  if (details.billingMode !== 'tiered_expr' && details.modelPrice !== null && details.modelPrice > 0) billing.push(['单次价格', `${usageMoney(details.modelPrice)}/次`])
  const exclusiveRatio = details.userGroupRatio !== null && details.userGroupRatio >= 0 ? details.userGroupRatio : null
  const groupRatio = exclusiveRatio ?? details.groupRatio
  if (groupRatio !== null) billing.push([costs ? '计费倍率' : exclusiveRatio !== null ? '用户专属倍率' : '分组倍率', `${groupRatio.toFixed(4)}x`])
  if (details.longContextBillingApplied !== null && details.longContextBillingApplied !== undefined) billing.push(['长上下文计费', details.longContextBillingApplied ? '已触发' : '未触发'])
  if (costs) {
    const hasImageCosts = (costs.imageInput ?? 0) > 0 || (costs.imageOutput ?? 0) > 0 || (details.imageInputTokens ?? 0) > 0 || (details.imageOutputTokens ?? 0) > 0
    for (const [field, label] of [['input', '输入费用'], ['output', '输出费用'], ['cacheRead', '缓存读取费用'], ['cacheCreation', '缓存写入费用'], ['imageInput', '图片输入费用'], ['imageOutput', '图片输出费用']] as const) {
      if (costs[field] !== null && costs[field] !== undefined) billing.push([hasImageCosts && (field === 'input' || field === 'output') ? `文本${label}` : label, usageMoney(costs[field])])
    }
    if (costs.total !== null) billing.push(['倍率前费用', usageMoney(costs.total)])
  }
  const actualCost = costs ? costs.actual : balance.quotaPerUnit > 0 ? record.quota / balance.quotaPerUnit : null
  billing.push(['总费用', <strong>{usageMoney(actualCost)}</strong>])
  const priceColumns = usagePriceFields.filter(([field]) => tiers.some((tier) => tier.prices[field] !== null && tier.prices[field] !== undefined))
  const matches = tiers.filter((tier) => normalizedUsageTier(tier.label) && normalizedUsageTier(tier.label) === normalizedUsageTier(details.matchedTier))
  return <Dialog open title="调用详情" width={640} onClose={onClose} initialFocus={initialFocus} testId="usage-detail-dialog" footer={<Button onClick={onClose}>关闭</Button>}>
    <div className="v2-usage-detail-summary" ref={initialFocus} tabIndex={-1}><Pill tone={record.type === 5 ? 'bad' : record.type === 2 ? 'ok' : 'neutral'}>{typeLabel}</Pill><strong>{record.modelName || '未知模型'}</strong></div>
    <section className="v2-usage-detail-section" aria-label="调用信息"><h3>调用信息</h3><DetailRows rows={info} /></section>
    <section className="v2-usage-detail-section" aria-label="Token 明细"><h3>Token 明细</h3><DetailRows rows={tokens} /></section>
    <section className="v2-usage-detail-section" aria-label="计费详情"><h3>计费详情</h3><DetailRows rows={billing} /></section>
    {details.billingMode === 'tiered_expr' && <section className="v2-usage-detail-section" aria-label="动态计费"><h3>动态计费</h3>{tiers.length ? <>
      <div className="v2-usage-price-table" tabIndex={0} role="region" aria-label="分档价格表，可横向滚动">
        <table><caption>分档价格表 · USD / 每百万 Token</caption><thead><tr><th scope="col">档位</th>{priceColumns.map(([field, label]) => <th scope="col" key={field}>{label}</th>)}</tr></thead>
          <tbody>{tiers.map((tier, index) => {
            const matched = matches.length === 1 && matches[0] === tier
            return <tr key={`${index}:${tier.label}`} className={matched ? 'is-matched' : undefined}>
              <th scope="row"><span>{tier.label || '未命名档位'}</span>{matched && <Pill tone="ok">已命中</Pill>}{tier.conditions.length > 0 && <small>{tier.conditions.map(usageTierCondition).join(' 且 ')}</small>}</th>
              {priceColumns.map(([field]) => <td key={field}>{tier.prices[field] === null || tier.prices[field] === undefined ? '—' : usageMoney(tier.prices[field], true)}</td>)}
            </tr>
          })}</tbody></table>
      </div>
      {!prices && <p className="v2-usage-detail-note">该记录未提供可确认的命中价格，请以服务端记录的总费用为准。</p>}
    </> : <p className="v2-usage-detail-note">该记录未提供可识别的分档价格，请以服务端记录的总费用为准。</p>}</section>}
    {details.streamStatus && <section className="v2-usage-detail-section" aria-label="流式响应详情"><h3>流式响应详情</h3><DetailRows rows={[
      ['状态', details.streamStatus.status || '未提供'], ['结束原因', details.streamStatus.endReason || '未提供'], ['错误次数', usageNumber(details.streamStatus.errorCount)],
      ...(details.streamStatus.endError ? [['结束错误', details.streamStatus.endError] as [string, ReactNode]] : []),
    ]} />{details.streamStatus.errors.length > 0 && <ul>{details.streamStatus.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}</section>}
    {record.content && <section className="v2-usage-detail-section" aria-label="说明"><h3>说明</h3><p className="v2-usage-detail-note">{record.content}</p></section>}
  </Dialog>
}
