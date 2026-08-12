import { describe, expect, it } from 'vitest'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { autoLayoutCanvasNodes } from './auto-layout'

function node(id: string, locked = false): EditorNodeRecord {
  return { id, type: 'prompt', definitionVersion: 1, position: { x: 9, y: 9 }, data: {}, width: 100, height: 60, ...(locked ? { locked } : {}) }
}

function edge(source: string, target: string): EditorEdgeRecord {
  return { id: `${source}-${target}`, source, sourceHandle: 'out:text', target, targetHandle: 'in:text' }
}

describe('canvas auto layout', () => {
  it('lays out a DAG left to right deterministically', () => {
    const nodes = [node('c'), node('a'), node('b')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    const first = autoLayoutCanvasNodes(nodes, edges)
    const second = autoLayoutCanvasNodes(nodes, edges)
    expect(second).toEqual(first)
    const positions = Object.fromEntries(first.map((entry) => [entry.id, entry.position.x]))
    expect(positions.a).toBeLessThan(positions.b)
    expect(positions.b).toBeLessThan(positions.c)
  })

  it('preserves locked nodes and other parent scopes', () => {
    const nodes = [node('locked', true), { ...node('child'), parentId: 'group' }, node('free')]
    const result = autoLayoutCanvasNodes(nodes, [])
    expect(result.find((entry) => entry.id === 'locked')?.position).toEqual({ x: 9, y: 9 })
    expect(result.find((entry) => entry.id === 'child')?.position).toEqual({ x: 9, y: 9 })
    expect(result.find((entry) => entry.id === 'free')?.position).toEqual({ x: 80, y: 80 })
  })

  it('places cyclic remnants in a stable final column', () => {
    const result = autoLayoutCanvasNodes([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')])
    expect(result.map((entry) => entry.position)).toEqual([{ x: 80, y: 80 }, { x: 80, y: 192 }])
  })
})
