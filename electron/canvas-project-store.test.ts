import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasProjectStore } from './canvas-project-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workflow(name: string, nodeId = 'audio'): string {
  const assetId = 'A'.repeat(43)
  return JSON.stringify({
    schemaVersion: 2, name, viewport: { x: 12, y: 34, zoom: 0.9 }, mediaGroups: { image: '生图分组', video: 'grok' },
    nodes: [{ id: nodeId, kind: 'audio-input', definitionVersion: 1, position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true, data: { prompt: '', model: '', result: { kind: 'audio', assetId, localUrl: `xingmang-asset://audio/${assetId}`, mimeType: 'audio/wav' } } }],
    edges: [],
  }, null, 2)
}

describe('CanvasProjectStore', () => {
  it('creates, saves, lists and reopens a user-owned project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-'))
    roots.push(root)
    const store = new CanvasProjectStore(root)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-'))
    roots.push(workspace)
    const created = await store.create(36, '音视频创作', workspace)
    const saved = await store.save(36, created.project.id, workflow('音视频创作'))
    expect(saved.nodeCount).toBe(1)
    await expect(store.list(36)).resolves.toEqual([expect.objectContaining({ id: created.project.id, name: '音视频创作', nodeCount: 1, workspaceName: path.basename(workspace), workspaceConfigured: true })])
    await expect(store.getWorkspaceDirectory(36, created.project.id)).resolves.toBe(path.resolve(workspace))
    expect(fs.existsSync(path.join(workspace, 'assets'))).toBe(true)
    const reopened = await store.open(36, created.project.id)
    expect(reopened.project).toEqual(expect.objectContaining({ nodeCount: 1 }))
    expect(JSON.parse(reopened.content)).toMatchObject({
      viewport: { x: 12, y: 34, zoom: 0.9 },
      nodes: [{ position: { x: 742.5, y: -318.25 }, width: 280, height: 340, locked: true }],
    })
    await expect(store.open(37, created.project.id)).rejects.toThrow()
  })

  it('rejects invalid project identifiers and malformed workflow updates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-invalid-'))
    roots.push(root)
    const store = new CanvasProjectStore(root)
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-invalid-'))
    roots.push(workspace)
    const created = await store.create(36, '项目', workspace)
    await expect(store.open(36, '../escape')).rejects.toThrow('标识无效')
    await expect(store.save(36, created.project.id, '{bad json')).rejects.toThrow('不是有效 JSON')
  })

  it('rejects reusing one work folder for two projects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-duplicate-'))
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-workspace-duplicate-'))
    roots.push(root, workspace)
    const store = new CanvasProjectStore(root)
    await store.create(36, '项目一', workspace)
    await expect(store.create(36, '项目二', workspace)).rejects.toThrow('已绑定项目')
  })

  it('keeps legacy projects readable without inventing or exposing a work folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-canvas-projects-legacy-'))
    roots.push(root)
    const projectId = '11111111-1111-4111-8111-111111111111'
    const accountRoot = path.join(root, 'user-36')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.writeFileSync(path.join(accountRoot, `${projectId}.json`), JSON.stringify({
      version: 1,
      id: projectId,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      workflow: JSON.parse(workflow('旧项目')),
    }), 'utf8')
    const store = new CanvasProjectStore(root)

    await expect(store.list(36)).resolves.toEqual([
      expect.objectContaining({ id: projectId, workspaceConfigured: false }),
    ])
    await expect(store.getWorkspaceDirectory(36, projectId)).resolves.toBeNull()
    await expect(store.open(36, projectId)).resolves.toMatchObject({
      project: { id: projectId, workspaceConfigured: false },
    })
  })
})
