import { Infinity as InfinityIcon, Plus } from 'lucide-react'
import { resolveMissingAiAssetMessage } from '../../../../electron/ai-asset-missing'
import type { CanvasProjectImageInput, CanvasProjectImageResult, CanvasProjectListEntry } from '../../../../electron/ipc-contract'
import { redactSecretPatterns } from '../../../../electron/redaction-patterns'
import { speaksChinese, userFacingErrorMessage } from '../../business-common'
import { Button, Menu } from '../../ui'
import { createTimeText } from './list'

// 「添加到画布」（融合第 5 步的「放进画布」，yoyo 2026-11-22 亲手打字同意）：对话里生成的图和作品库里的图下面的那个
// 按钮、点开以后选项目的小菜单，和添加完说的那两句。字照方案第 2.5 节，按 2026-11-21 定的正式口吻重写，跟
// 「添加到视频」是一个说法。抄图在主进程（canvas-project-image-intake.ts），这里只交图片编号和选的项目。

/** 菜单里的一个画布项目。 */
export interface CanvasIntakeProject { id: string; title: string; detail: string }

export const unnamedCanvasProjectName = '未命名项目'
const newProjectNameLength = 20

/**
 * 新建的画布项目叫什么：这张图那句描述开头的 20 个字（新视频也是拿描述当名字），没有描述就叫「未命名项目」。
 * 正好切在标点上时把末尾的标点去掉，名字不以逗号收尾。
 */
export function canvasIntakeProjectName(description: string): string {
  const text = description.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, newProjectNameLength).join('').replace(/[\s，。、；：,.;:！!？?]+$/, '') || unnamedCanvasProjectName
}

/** 交给主进程的那一份：projectId 是 null 就新建一个项目。 */
export function canvasIntakeRequest(projectId: string | null, assetId: string, description: string): CanvasProjectImageInput {
  return projectId === null ? { assetId, newProjectName: canvasIntakeProjectName(description) } : { assetId, projectId }
}

/** 菜单里列的项目：没归档的那些，最近改过的在前（「创作」左边那一列的那一份），右边小字是什么时候改的。 */
export function canvasIntakeProjects(projects: readonly CanvasProjectListEntry[], now?: number): CanvasIntakeProject[] {
  return projects.map((project) => ({ id: project.id, title: project.name, detail: project.updatedAt > 0 ? `${createTimeText(project.updatedAt, now)} 修改` : '' }))
}

export function sameCanvasIntakeProjects(left: readonly CanvasIntakeProject[], right: readonly CanvasIntakeProject[]): boolean {
  return left.length === right.length && left.every((project, index) => project.id === right[index].id && project.title === right[index].title && project.detail === right[index].detail)
}

export function canvasIntakeDoneMessage(result: Pick<CanvasProjectImageResult, 'projectName' | 'created'>): string {
  return result.created
    ? `已新建画布项目「${result.projectName}」，并将此图添加到其素材库`
    : `已添加到画布项目「${result.projectName}」的素材库`
}

export const canvasIntakeFailureMessage = '添加失败，请稍后重试。'

/** 没添加成：主进程说的中文原话上屏（文件没了、项目不在了、文件夹够不着、项目满了），别的换成兜底句。 */
export function canvasIntakeErrorMessage(error: unknown): string {
  const message = userFacingErrorMessage(error)
  return resolveMissingAiAssetMessage(message) ?? (message && speaksChinese(message) ? redactSecretPatterns(message) : canvasIntakeFailureMessage)
}

interface AddToCanvasMenuProps {
  projects: readonly CanvasIntakeProject[]
  /** null：新建一个项目。 */
  onPick: (projectId: string | null) => void
  /** 对话里图下面那一排是小号、不带底色的。 */
  compact?: boolean
  testId: string
}

export function AddToCanvasMenu({ projects, onPick, compact = false, testId }: AddToCanvasMenuProps) {
  return <Menu label="选择要添加到的画布项目" heading="选择要添加到的画布项目" align="start"
    anchor={<Button icon={InfinityIcon} {...(compact ? { size: 'xs' as const, variant: 'ghost' as const } : {})} title="将此图添加到画布项目的素材库" testId={testId}>添加到画布</Button>}
    items={[
      { label: '新建画布项目', icon: Plus, testId: `${testId}-new`, onSelect: () => onPick(null) },
      ...(projects.length ? ['divider' as const] : []),
      ...projects.map((project) => ({ label: project.title, hint: project.detail || undefined, icon: InfinityIcon, testId: `${testId}-${project.id}`, onSelect: () => onPick(project.id) })),
    ]} />
}
