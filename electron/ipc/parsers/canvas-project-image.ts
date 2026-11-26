// 主窗口「添加到画布」那一条通道的入参（I5）：只收图片编号，外加项目编号或新建项目用的名字，两样只能带一样；
// 别的字段一概不认。编号只看样子，是不是这个账号的图、这个账号的项目由主进程拿去自己的库和项目表里对
// （canvas-project-image-intake.ts）。没有任何一项是路径。
import { isRecord } from '../../input-guards'
import type { CanvasProjectImageInput } from '../../ipc-contract'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const projectIdPattern = /^[a-f0-9-]{36}$/
const fields = new Set(['assetId', 'projectId', 'newProjectName'])
/** 画布自己存项目名时的上限（canvas-project-store.ts 的 normalizedProjectName）。 */
export const maximumCanvasProjectImageNameLength = 128

const malformed = '添加到画布的请求格式错误'

export function parseCanvasProjectImageInput(value: unknown): CanvasProjectImageInput {
  if (!isRecord(value) || Object.keys(value).some((field) => !fields.has(field))) throw new Error(malformed)
  const { assetId, projectId, newProjectName } = value
  if (typeof assetId !== 'string' || !assetIdPattern.test(assetId)) throw new Error(malformed)
  if ((projectId === undefined) === (newProjectName === undefined)) throw new Error(malformed)
  if (projectId !== undefined) {
    if (typeof projectId !== 'string' || !projectIdPattern.test(projectId)) throw new Error(malformed)
    return { assetId, projectId }
  }
  if (typeof newProjectName !== 'string' || /[\x00-\x1f\x7f]/.test(newProjectName)) throw new Error(malformed)
  const name = newProjectName.trim()
  if (!name || name.length > maximumCanvasProjectImageNameLength) throw new Error(malformed)
  return { assetId, newProjectName: name }
}
