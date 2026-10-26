import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { valueReferencesInSource } from './type-only-imports.test-support'

const file = path.join(__dirname, 'diagnostics-example.ts')
const target = path.join(__dirname, 'diagnostics.ts')

function scan(sourceText: string): string[] {
  return valueReferencesInSource(file, sourceText, target)
}

describe('type-only-imports test support', () => {
  it('accepts type-only imports, including ones spread over several lines', () => {
    expect(scan("import type { A } from './diagnostics'\n")).toEqual([])
    expect(scan("import type {\n  A,\n  B,\n} from './diagnostics'\n")).toEqual([])
    expect(scan("export type { A } from './diagnostics'\n")).toEqual([])
    expect(scan("type Lazy = import('./diagnostics').A\n")).toEqual([])
  })

  it('accepts a clause whose every name is marked type, since the build erases it too', () => {
    expect(scan("import { type A, type B } from './diagnostics'\n")).toEqual([])
    expect(scan("export { type A } from './diagnostics'\n")).toEqual([])
    expect(scan("import {} from './diagnostics'\n")).toHaveLength(1)
    expect(scan("import Default, { type A } from './diagnostics'\n")).toHaveLength(1)
  })

  it('flags every way of pulling a value, multi-line or not', () => {
    expect(scan("import {\n  runDiagnostics,\n} from './diagnostics'\n")).toHaveLength(1)
    expect(scan("import { type A, runDiagnostics } from './diagnostics'\n")).toHaveLength(1)
    expect(scan("import * as diagnostics from './diagnostics'\n")).toHaveLength(1)
    expect(scan("import './diagnostics'\n")).toHaveLength(1)
    expect(scan("export { runDiagnostics } from './diagnostics'\n")).toHaveLength(1)
    expect(scan("export * from './diagnostics'\n")).toHaveLength(1)
    expect(scan("import diagnostics = require('./diagnostics')\n")).toHaveLength(1)
    expect(scan("const diagnostics = require(\"./diagnostics\")\n")).toHaveLength(1)
    expect(scan('async function later() { return import(`./diagnostics`) }\n')).toHaveLength(1)
  })

  it('matches the module whichever way the path is spelled, and nothing else', () => {
    expect(scan("import { a } from './diagnostics.js'\n")).toHaveLength(1)
    expect(scan("import { a } from '../electron/diagnostics'\n")).toHaveLength(1)
    expect(scan("import { a } from './diagnostics-context'\n")).toEqual([])
    expect(scan("import { a } from 'diagnostics'\n")).toEqual([])
  })
})
