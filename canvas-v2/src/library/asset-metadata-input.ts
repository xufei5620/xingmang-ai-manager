export const maximumAssetTagCount = 20
export const maximumAssetTagLength = 40

export function parseAssetMetadataTagText(value: string): string[] {
  const tags = [...new Set(value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))]
  if (tags.length > maximumAssetTagCount || tags.some((tag) => tag.length > maximumAssetTagLength || /[\x00-\x1f\x7f]/.test(tag))) throw new Error('最多 20 个标签，每个最多 40 个字符，不能包含控制字符')
  return tags
}
