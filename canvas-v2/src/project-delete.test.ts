import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasProjectPage, CanvasStoredProjectSummary } from './host'
import { ProjectCenter } from './components/ProjectCenter'
import type { CanvasProjectListQuery } from './project-pagination'

// 已归档的项目可以删：确认框由宿主自己弹，内核只给项目标识。没归档的、云端的、宿主没有这个方法的一律不给删。

function project(id: string, overrides: Partial<CanvasStoredProjectSummary> = {}): CanvasStoredProjectSummary {
  return { id, name: id, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', lastOpenedAt: '2026-11-09T00:00:00.000Z', nodeCount: 0, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready', ...overrides }
}

const archived = project('old', { name: '去年的海报', archivedAt: '2026-11-09T01:00:00.000Z' })
const active = project('now', { name: '在做的海报' })

function center(props: Partial<Parameters<typeof ProjectCenter>[0]> = {}) {
  return renderToStaticMarkup(createElement(ProjectCenter, {
    projects: [], loading: false, error: null, onCreate: async () => true, onOpen: () => undefined,
    onRename: async () => true, onDuplicate: async () => true, onSetArchived: async () => true, ...props,
  }))
}

// The desktop lists everything at once and starts on recent projects, so the archived tab is reached through the paged view here.
function archivedTab(projects: CanvasStoredProjectSummary[], props: Partial<Parameters<typeof ProjectCenter>[0]> = {}) {
  const query: CanvasProjectListQuery = { view: 'archived', limit: 24, offset: 0, sort: 'updated-desc' }
  const page: CanvasProjectPage = { items: projects.map((item) => ({ ...item, version: 1 })), total: projects.length, limit: 24, offset: 0, counts: { all: projects.length, active: 0, archived: projects.length } }
  return center({ projects, page, query, onQueryChange: () => undefined, ...props })
}

describe('deleting archived canvas projects', () => {
  it('offers delete on archived projects when the host can delete them', () => {
    const html = archivedTab([archived], { onDeleteProject: async () => true })
    expect(html).toContain('aria-label="删除项目：去年的海报"')
    expect(html).toContain('title="删除项目"')
    expect(html).toContain('aria-label="恢复项目：去年的海报"')
  })

  it('never offers it on a project that is not archived', () => {
    const html = center({ projects: [active, archived], onDeleteProject: async () => true })
    expect(html).toContain('aria-label="归档项目：在做的海报"')
    expect(html).not.toContain('删除项目')
  })

  it('leaves it out without the host method and in the cloud', () => {
    expect(archivedTab([archived])).not.toContain('删除项目')
    expect(archivedTab([archived], { storageMode: 'cloud', onDeleteProject: async () => true })).not.toContain('删除项目')
  })

  it('says archived projects do not count and can be deleted only where the host can delete them', () => {
    const hint = '已归档的不占项目名额，不要了可以在「已归档」里删掉。'
    expect(archivedTab([], { onDeleteProject: async () => true })).toContain(`归档后保留工作流与本地素材，可随时恢复。${hint}`)
    expect(archivedTab([])).toContain('归档后保留工作流与本地素材，可随时恢复。')
    expect(archivedTab([])).not.toContain(hint)
    expect(archivedTab([], { storageMode: 'cloud', onDeleteProject: async () => true })).not.toContain(hint)
  })
})
