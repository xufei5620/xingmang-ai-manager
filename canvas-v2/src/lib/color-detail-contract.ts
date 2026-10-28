import { graphHasColorGradeProperty } from './color-grade-contract'

/** Disabled, neutral, invalid and future detail settings remain editable data.
 * This guard prevents a stale client from dropping them, never grants ACLs. */
export function graphHasColorGradeDetail(value: unknown): boolean {
  return graphHasColorGradeProperty(value, 'detail')
}

export function projectHasColorGradeDetail(content: string): boolean {
  return graphHasColorGradeDetail(JSON.parse(content))
}

export function assertColorGradeDetailClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的细节增强与降噪设置，请刷新页面后重试；未提交生成或覆盖工程')
}
