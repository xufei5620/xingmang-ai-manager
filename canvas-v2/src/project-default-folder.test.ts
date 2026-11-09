import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasStoredProjectSummary } from './host'
import { ProjectCenter } from './components/ProjectCenter'
import { canvasDefaultProjectFolderLabel, canvasProjectStorageCopy } from './project-pagination'
import { createBlankProjectForHost } from './persistence/host-project-create'

// 新建项目默认放进「文档 › 星芒画布」，不先弹选文件夹的框；「换个位置创建…」照旧选；文件夹不见了的项目可以重新选。

function project(id: string, overrides: Partial<CanvasStoredProjectSummary> = {}): CanvasStoredProjectSummary {
  return { id, name: id, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 0, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready', ...overrides }
}

function center(props: Partial<Parameters<typeof ProjectCenter>[0]> = {}) {
  return renderToStaticMarkup(createElement(ProjectCenter, {
    projects: [], loading: false, error: null, onCreate: async () => true, onOpen: () => undefined,
    onRename: async () => true, onDuplicate: async () => true, onSetArchived: async () => true, ...props,
  }))
}

const created = { project: project('new'), content: '{}' }

describe('creating canvas projects in the default folder', () => {
  it('names the folder the way each system shows it', () => {
    expect(canvasDefaultProjectFolderLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/45.0.0')).toBe('文稿 › 星芒画布')
    expect(canvasDefaultProjectFolderLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/45.0.0')).toBe('文档 › 星芒画布')
    expect(canvasDefaultProjectFolderLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Electron/45.0.0')).toBe('文档 › 星芒画布')
  })

  it('says where projects go and keeps asking for a folder when duplicating', () => {
    expect(canvasProjectStorageCopy('local', '文档 › 星芒画布')).toEqual({
      introduction: '项目自动保存在「文档 › 星芒画布」里，节点、布局和生成素材会自动保存',
      create: '创建',
      createElsewhere: '换个位置创建…',
      emptyHint: '点击右上角「新建项目」，输入名称就能创建。',
      duplicate: '选择文件夹并复制',
      duplicateHint: '下一步选择一个新的空工作文件夹，项目节点、布局和素材会一并复制。',
      archiveHint: '归档后保留工作流与本地素材，可随时恢复。',
    })
    expect(canvasProjectStorageCopy('local')).toMatchObject({ create: '选择文件夹并创建', createElsewhere: undefined, emptyHint: '点击右上角「新建项目」，输入名称后再选择工作文件夹。' })
    expect(canvasProjectStorageCopy('cloud', '文档 › 星芒画布')).toMatchObject({ create: '创建项目', createElsewhere: undefined })
  })

  it('shows the default folder only when the host can also create elsewhere', () => {
    const offered = center({ defaultFolder: '文稿 › 星芒画布', onCreateElsewhere: async () => true })
    expect(offered).toContain('项目自动保存在「文稿 › 星芒画布」里')
    expect(offered).toContain('输入名称就能创建')
    expect(center({ defaultFolder: '文稿 › 星芒画布' })).toContain('每个项目使用独立工作文件夹')
    expect(center({ onCreateElsewhere: async () => true })).toContain('每个项目使用独立工作文件夹')
    expect(center({ storageMode: 'cloud', defaultFolder: '文稿 › 星芒画布', onCreateElsewhere: async () => true })).toContain('项目节点与布局会自动云端保存')
  })

  it('creates in the default folder unless asked to choose, and falls back to choosing on hosts without one', async () => {
    const host = { createProject: vi.fn(async () => created), createProjectInDefaultFolder: vi.fn(async () => created) }
    await createBlankProjectForHost(host, '海报', 'default')
    expect(host.createProjectInDefaultFolder).toHaveBeenCalledWith('海报')
    expect(host.createProject).not.toHaveBeenCalled()
    await createBlankProjectForHost(host, '海报', 'elsewhere')
    expect(host.createProject).toHaveBeenCalledWith('海报')
    expect(host.createProjectInDefaultFolder).toHaveBeenCalledOnce()
    const older = { createProject: vi.fn(async () => created) }
    expect(await createBlankProjectForHost(older, '海报', 'default')).toBe(created)
    expect(older.createProject).toHaveBeenCalledWith('海报')
  })
})

describe('choosing a missing project folder again', () => {
  const missing = project('moved', { name: '搬走的项目', workspaceStatus: 'missing' })

  it('offers it on a missing project when the host can relink', () => {
    const html = center({ projects: [missing, project('fine')], onRelinkFolder: async () => true })
    expect(html).toContain('aria-label="重新选择文件夹：搬走的项目"')
    expect(html.match(/重新选择文件夹：/g)).toHaveLength(1)
    // The card still cannot be opened until the folder is back.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="打开项目：搬走的项目"/)
  })

  it('leaves it out without the host method, for archived projects and in the cloud', () => {
    expect(center({ projects: [missing] })).not.toContain('重新选择文件夹')
    expect(center({ projects: [{ ...missing, archivedAt: '2026-11-09T01:00:00.000Z' }], onRelinkFolder: async () => true })).not.toContain('重新选择文件夹')
    expect(center({ projects: [missing], storageMode: 'cloud', onRelinkFolder: async () => true })).not.toContain('重新选择文件夹')
  })
})
