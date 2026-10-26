import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCanvasProjectWorkflow } from './canvas-project-package'
import { CanvasProjectStore } from './canvas-project-store'
import { parseCanvasPromptPresetInput, parseCanvasStartRunInput } from './canvas-request-parser'
import { canvasRunDesktopUnsupportedReason } from './canvas-run-engine'
import { isRecord } from './input-guards'

// These samples are shaped exactly like what the xingmang-canvas kernel
// writes and sends (#1392). The desktop parsers are the source of truth: the
// kernel's own CI reads the same files, so neither side can drift alone.
const fixtures = path.join(__dirname, 'fixtures', 'canvas-kernel-contract')

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))
}

interface RunGraphCase {
  name: string
  input: { graph: { nodes: Array<{ data: Record<string, unknown> }> } }
  expect: { refusal: string | null } | { parseError: string }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('canvas kernel contract fixtures', () => {
  it('saves and reopens the kernel workflow sample with every new field intact', async () => {
    const content = fs.readFileSync(path.join(fixtures, 'workflow-accepted.json'), 'utf8').trim()
    const { workflow } = parseCanvasProjectWorkflow(content)
    expect(workflow).toEqual(JSON.parse(content))

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-kernel-contract-'))
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-kernel-workspace-'))
    roots.push(root, workspace)
    const store = new CanvasProjectStore(root)
    const created = await store.create(7, '内核契约样例', workspace)
    await store.save(7, created.project.id, content)
    const reopened = await new CanvasProjectStore(root).open(7, created.project.id)
    expect(JSON.parse(reopened.content)).toEqual(JSON.parse(content))

    const keys = new Set((workflow.nodes as Array<{ data: Record<string, unknown> }>).flatMap((node) => Object.keys(node.data)))
    for (const key of ['dirty', 'imageCandidateCount', 'videoCandidateCount', 'outputText', 'promptReferences', 'textWebSearch']) {
      expect(keys, key).toContain(key)
    }
  })

  it('parses each kernel run graph after an IPC clone and refuses exactly the listed ones', () => {
    const fixture = readFixture('run-graphs.json')
    if (!isRecord(fixture) || !Array.isArray(fixture.kernelUndefinedKeys) || !Array.isArray(fixture.cases)) throw new Error('fixture shape')
    const undefinedKeys = fixture.kernelUndefinedKeys as string[]
    const cases = fixture.cases as RunGraphCase[]
    expect(cases.length).toBeGreaterThanOrEqual(10)
    for (const entry of cases) {
      // JSON cannot hold an undefined value; the kernel sends these keys that
      // way, and structured clone keeps them.
      for (const node of entry.input.graph.nodes) {
        for (const key of undefinedKeys) if (!(key in node.data)) node.data[key] = undefined
      }
      const input = structuredClone(entry.input)
      if ('parseError' in entry.expect) {
        expect(() => parseCanvasStartRunInput(input), entry.name).toThrow(entry.expect.parseError)
        continue
      }
      const parsed = parseCanvasStartRunInput(input)
      expect(canvasRunDesktopUnsupportedReason(parsed.graph, parsed.scope), entry.name).toBe(entry.expect.refusal ?? undefined)
    }
  })

  it('accepts and refuses the kernel prompt preset names', () => {
    const fixture = readFixture('prompt-presets.json')
    if (!isRecord(fixture) || !isRecord(fixture.accepted) || !isRecord(fixture.rejected)) throw new Error('fixture shape')
    const { accepted, rejected } = fixture
    expect(parseCanvasPromptPresetInput(accepted)).toEqual(accepted)
    expect(() => parseCanvasPromptPresetInput(rejected.input)).toThrow(String(rejected.error))
  })
})
