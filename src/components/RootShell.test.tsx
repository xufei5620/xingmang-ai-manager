import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'
import { RootShell } from './RootShell'

function noop(): void {}

describe('RootShell (R-S10)', () => {
  it('puts an error boundary above everything the entry renders', () => {
    const app = <p data-testid="app">工作台</p>

    // Calling the component directly inspects the tree it builds. A rendered
    // assertion cannot tell a wrapped tree from an unwrapped one, because a
    // healthy boundary renders its children and nothing else.
    const tree = RootShell({ children: app })

    expect(isValidElement(tree)).toBe(true)
    expect((tree as ReactElement).type).toBe(ErrorBoundary)
    expect((tree as ReactElement).props.children).toBe(app)
  })

  it('renders children untouched while nothing has thrown', () => {
    const markup = renderToStaticMarkup(<RootShell><p data-testid="app">工作台</p></RootShell>)

    expect(markup).toContain('data-testid="app"')
    expect(markup).not.toContain('页面出现异常')
  })
})

describe('ErrorBoundary at the root (R-S10)', () => {
  // react-dom/server never invokes error boundaries -- it rethrows instead --
  // so the crash path is driven through the boundary's own lifecycle API,
  // which is the exact pair React calls: getDerivedStateFromError to record
  // the throw, then render to produce what the user sees.
  function crashedMarkup(thrown: unknown): string {
    const app = <p data-testid="app">工作台</p>
    const boundary = new ErrorBoundary({ resetKey: 'root', onReturnOverview: noop, children: app })
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(thrown) }
    return renderToStaticMarkup(<>{boundary.render()}</>)
  }

  it('shows the crash panel instead of a blank window when the shell throws', () => {
    const markup = crashedMarkup(new Error('侧栏渲染失败'))

    expect(markup).toContain('页面出现异常')
    expect(markup).toContain('侧栏渲染失败')
    expect(markup).toContain('导出诊断日志')
    // The whole point of R-S10: the crashed tree is gone, but the window is
    // not blank.
    expect(markup).not.toContain('data-testid="app"')
  })

  it('still shows the crash panel when the thrown value is null', () => {
    expect(ErrorBoundary.getDerivedStateFromError(null).hasError).toBe(true)
    expect(crashedMarkup(null)).toContain('页面出现异常')
  })
})
