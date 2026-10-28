// 导入工程时素材回执的形状，画布内核算建工程摘要要用；核对和保存素材的服务端代码留在 project-asset-import、project-import-receipts（#3）。
export type ProjectAssetImportMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'audio/mpeg' | 'audio/wav'
export interface ProjectAssetImportIdentity { operationId: string; sourceAssetId: string; sha256: string; mimeType: ProjectAssetImportMimeType; mediaType?: 'video' | 'audio' }

export interface ProjectImportAssetReceipt extends Omit<ProjectAssetImportIdentity, 'operationId'> {
  assetId: string
  byteSize: number
}
