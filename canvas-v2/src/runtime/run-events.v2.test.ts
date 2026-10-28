import { describe, expect, it } from 'vitest'
import {
  canvasRunTimelineLimit,
  type CanvasRunEvent,
  type CanvasRunRecord,
} from '../host'
import { mergeCanvasRunEvent } from './run-events'

function record(): CanvasRunRecord {
  return {
    version: 1,
    userId: 7,
    ownerId: 9,
    runId: 'run-1',
    graphRevision: 'revision-1',
    scope: { kind: 'all' },
    status: 'running',
    createdAt: '2026-08-17T01:00:00.000Z',
    startedAt: '2026-08-17T01:00:00.000Z',
    nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'queued', attempts: [] }],
    events: [],
  }
}

function stageEvent(
  sequence: number,
  stage: 'processing' | 'saving' = 'processing',
): Extract<CanvasRunEvent, { type: 'node-stage' }> {
  return {
    version: 1,
    type: 'node-stage',
    runId: 'run-1',
    graphRevision: 'revision-1',
    sequence,
    at: `2026-08-17T01:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    nodeId: 'image',
    stage,
  }
}

describe('mergeCanvasRunEvent', () => {
  it('keeps the latest node stage and rejects duplicate or stale sequences', () => {
    const first = mergeCanvasRunEvent([record()], stageEvent(1))[0]
    const second = mergeCanvasRunEvent([first], stageEvent(2, 'saving'))[0]
    const stale = mergeCanvasRunEvent([second], stageEvent(1))[0]

    expect(second.nodes[0]).toMatchObject({ latestStage: 'saving', latestStageSequence: 2 })
    expect(second.events.map((event) => event.sequence)).toEqual([1, 2])
    expect(stale).toBe(second)
  })

  it('keeps same-stage progress changes as distinct ordered events', () => {
    const first = mergeCanvasRunEvent([record()], {
      ...stageEvent(1), progress: 12, progressMode: 'determinate', health: 'normal',
    })[0]
    const second = mergeCanvasRunEvent([first], {
      ...stageEvent(2), progress: 42, progressMode: 'determinate', health: 'normal',
    })[0]
    const delayed = mergeCanvasRunEvent([second], {
      ...stageEvent(3), progress: 42, progressMode: 'indeterminate', health: 'delayed',
    })[0]

    expect(delayed.events).toHaveLength(3)
    expect(delayed.nodes[0]).toMatchObject({
      latestStage: 'processing', latestProgress: 42,
      latestProgressMode: 'indeterminate', latestHealth: 'delayed', latestStageSequence: 3,
    })
  })

  it('bounds a long live renderer timeline without losing the latest stage', () => {
    let records = [record()]
    for (let sequence = 1; sequence <= canvasRunTimelineLimit + 900; sequence += 1) {
      records = mergeCanvasRunEvent(records, stageEvent(sequence, sequence % 2 ? 'processing' : 'saving'))
    }

    expect(records[0].events).toHaveLength(canvasRunTimelineLimit)
    expect(records[0].events[0].sequence).toBe(901)
    expect(records[0].events.at(-1)?.sequence).toBe(canvasRunTimelineLimit + 900)
    expect(records[0].nodes[0].latestStageSequence).toBe(canvasRunTimelineLimit + 900)
  })

  it('merges terminal status only into the owned graph revision', () => {
    const event: CanvasRunEvent = {
      version: 1,
      type: 'run-terminal',
      runId: 'run-1',
      graphRevision: 'revision-1',
      sequence: 1,
      at: '2026-08-17T01:00:10.000Z',
      status: 'succeeded',
      outcome: { succeeded: ['image'], failed: [], skipped: [], cancelled: [], cached: [] },
    }
    const merged = mergeCanvasRunEvent([record()], event)[0]
    expect(merged).toMatchObject({ status: 'succeeded', completedAt: event.at, outcome: event.outcome })

    const wrongRevision = { ...event, graphRevision: 'other-revision' }
    expect(mergeCanvasRunEvent([merged], wrongRevision)[0]).toBe(merged)
  })
})
