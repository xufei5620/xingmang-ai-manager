interface PanoramaSnapshotCanvas { width: number; height: number; toBlob(callback: BlobCallback, type: string): void }

export function capturePanoramaPng(canvas: PanoramaSnapshotCanvas): Promise<Blob> {
  if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 1 || canvas.height < 1 || canvas.width > 2048 || canvas.height > 1024) return Promise.reject(new Error('全景取景尺寸超出导出范围'))
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => { settled = true; reject(new Error('全景取景编码超时，请重试')) }, 10000)
    try {
      canvas.toBlob((blob) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (!blob || blob.type !== 'image/png' || blob.size < 1 || blob.size > 20 * 1024 * 1024) reject(new Error('浏览器未能生成有效的全景 PNG，请重试'))
        else resolve(blob)
      }, 'image/png')
    } catch {
      settled = true
      clearTimeout(timeout)
      reject(new Error('当前图片不允许导出取景，请检查素材读取权限；全景预览仍可继续使用'))
    }
  })
}

export function downloadPanoramaPng(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = '星芒-全景视角.png'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    // Let the browser claim the download before releasing its object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
