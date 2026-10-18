// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer may value-import this file (registered in
// scripts/verify-renderer-boundary.test.cjs), so it must stay free of Node APIs (I6).

// 「是不是对象」「是不是字符串数组」这类最基础的检查，以前在四十多个文件里各写一份，写法还不完全一样
// （#1071 第 3 条）。新代码从这里取；旧副本等所在文件拆分时（#1070）顺手换掉，不单独批量替换。
// 这里只判断、不出报错文案：要拒绝的调用点照旧抛自己的中文报错，上屏的话不因为换了检查而变。

/** 不是 null、不是数组的对象。Date、Map 这类也算，要排除它们的调用点自己再加一道。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface StringArrayLimits {
  maxItems?: number
  maxLength?: number
}

/**
 * 每一项都是字符串的数组。有一项不合格就整个不认，不悄悄丢掉那一项；IPC 入参这类敌意输入要给 maxItems（I5）。
 * 按下标逐项看而不用 every：every 跳过稀疏数组的空位，`new Array(3)` 会被当成三个字符串放过去。
 */
export function isStringArray(value: unknown, limits: StringArrayLimits = {}): value is string[] {
  if (!Array.isArray(value)) return false
  if (limits.maxItems !== undefined && value.length > limits.maxItems) return false
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index]
    if (typeof entry !== 'string') return false
    if (limits.maxLength !== undefined && entry.length > limits.maxLength) return false
  }
  return true
}

/**
 * 数组里的字符串项，别的项丢掉，不是数组就当空数组。只用在「读到什么算什么」的地方（比如别的程序写的配置文件）；
 * 要整个拒绝的输入用 isStringArray。maxItems 截的是过滤之后的前几项。
 */
export function filterStrings(value: unknown, maxItems?: number): string[] {
  if (!Array.isArray(value)) return []
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  return maxItems === undefined ? strings : strings.slice(0, maxItems)
}

/** await 会接着等的那种值：带 then 方法的对象或函数（Promises/A+ 的 thenable）。then 不是函数的不算。 */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return false
  return 'then' in value && typeof value.then === 'function'
}
