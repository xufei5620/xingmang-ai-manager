import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinNodeDefinitions } from './builtin-node-definitions'

// Node kinds whose body renders the label/control parameter subgrid.
// Mirrors imageOperation / videoOperation in WorkflowNodes.tsx.
const parameterGridKinds = new Set(['image', 'image-generate', 'image-edit', 'video', 'video-generate'])

const nodeBorderWidth = 2
const parameterBlockInlineMargin = 10

function themeToken(name: string): number {
  const theme = fs.readFileSync(path.join(import.meta.dirname, '..', 'theme.css'), 'utf8')
  const match = theme.match(new RegExp(`${name}:\\s*([0-9]+)px`))
  expect(match, `${name} 未在 theme.css 中定义`).not.toBeNull()
  return Number(match?.[1])
}

describe('node parameter width floor', () => {
  it('keeps every parameter-rendering node wide enough for its label and control tracks', () => {
    // Three selects abreast used to leave about 93px each, which truncated
    // every size and quality label. The subgrid guarantees a control track of
    // --node-control-min, but only if the node itself is wide enough to hold it.
    const labelTrackMinimum = 40
    const columnGap = 6
    const controlMinimum = themeToken('--node-control-min')
    const floor = nodeBorderWidth + parameterBlockInlineMargin * 2 + labelTrackMinimum + columnGap + controlMinimum

    const offenders = builtinNodeDefinitions
      .filter((definition) => parameterGridKinds.has(definition.type))
      .filter((definition) => definition.dimensions.width < floor)
      .map((definition) => `${definition.type}: ${definition.dimensions.width}px < ${floor}px`)

    expect(offenders).toEqual([])
  })

  it('never lets a node definition fall below the documented minimum width', () => {
    const minimum = themeToken('--node-width-min')
    const offenders = builtinNodeDefinitions
      .filter((definition) => !definition.structural)
      .filter((definition) => definition.dimensions.width < minimum)
      .map((definition) => `${definition.type}: ${definition.dimensions.width}px`)

    // router is the one functional node below the token today. Pinning it here
    // makes the exception explicit instead of silently drifting wider.
    expect(offenders).toEqual(['router: 224px'])
  })
})
