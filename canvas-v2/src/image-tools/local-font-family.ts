/** A selected family is a name, never a CSS declaration or a font URL. */
export function isSafeLocalTextFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100
    && value === value.trim() && /^[\p{L}\p{N}\p{M} ._+\-]+$/u.test(value)
}

export function quoteLocalTextFontFamily(family: string): string {
  if (!isSafeLocalTextFontFamily(family)) throw new Error('本机字体名称无效，请重新选择字体')
  return `"${family}"`
}
