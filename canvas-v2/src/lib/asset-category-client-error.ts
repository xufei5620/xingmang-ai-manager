// 分类请求的错误类型和「服务端已明确拒绝」的判断，画布内核的恢复逻辑要用；发请求的部分留在 asset-category-client（#3）。
export class AssetCategoryClientError extends Error {
  constructor(message: string, public status: number | undefined = undefined, public responseConfirmed = false) { super(message) }
}

export function isAssetCategoryClientRejected(error: unknown): boolean {
  return error instanceof AssetCategoryClientError && error.responseConfirmed
}
