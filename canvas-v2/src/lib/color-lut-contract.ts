import { graphHasColorGradeProperty } from './color-grade-contract'

/** Inspect field presence, not truthiness or validity. An old client must not
 * overwrite a project after silently dropping a disabled, invalid or future
 * LUT setting. Shape validation is a separate recipe/resource responsibility. */
export function graphHasColorLut(value: unknown): boolean {
  return graphHasColorGradeProperty(value, 'lut')
}

export function projectHasColorLut(content: string): boolean {
  return graphHasColorLut(JSON.parse(content))
}

export function assertColorLutClientVersion(version: unknown, required: boolean): void {
  if (required && version !== 1) throw new Error('当前页面版本不支持此工程的 LUT 调色表，请刷新页面后重试；未提交生成或覆盖工程')
}
