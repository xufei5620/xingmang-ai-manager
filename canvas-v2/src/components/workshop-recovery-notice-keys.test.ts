import { readFileSync } from 'node:fs'
import { createElement, Fragment, type ReactElement } from 'react'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function actualNoticeElements(scope: string): ReactElement[] {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), notices: string[] = []
  function visit(node: ts.Node) { if (ts.isJsxSelfClosingElement(node) && ['WorkshopContentRecoveryNotice', 'WorkshopCreationRecoveryNotice'].includes(node.tagName.getText(source))) notices.push(node.getText(source)); ts.forEachChild(node, visit) }
  visit(source)
  const compiled = ts.transpileModule(`return (<>${notices.join('')}</>)`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
  function Notice() { return null }
  const result = new Function('React', 'WorkshopContentRecoveryNotice', 'WorkshopCreationRecoveryNotice', 'layerEditorScope', compiled)({ createElement, Fragment }, Notice, Notice, scope) as ReactElement<{ children: ReactElement[] }>
  return result.props.children
}

describe('actual App workshop recovery notice identities', () => {
  it('assigns different keys to adjacent creation and content notices while retaining the original account scope prop', () => {
    for (const scope of ['account-a:project-a', 'account-b:project-b']) {
      const elements = actualNoticeElements(scope)
      expect(elements).toHaveLength(3)
      const siblings = elements.slice(-2)
      expect(siblings.map((element) => element.key)).toEqual([`content:${scope}`, `creation:${scope}`])
      expect(new Set(siblings.map((element) => element.key)).size).toBe(siblings.length)
      expect(elements[0].key).toBe(`creation:${scope}`)
      for (const element of elements) expect(element.props).toMatchObject({ scopeKey: scope })
    }
  })
})
