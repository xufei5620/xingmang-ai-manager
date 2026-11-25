import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { presentAntigravity } from './antigravity'
import { installedToolCount } from './installed-count'

function cli(id: string, installed: boolean) {
  return { id, status: { installed } } as unknown as Parameters<typeof installedToolCount>[0][number]
}

describe('renderer-v2 installed tool count', () => {
  it('counts the Antigravity cards together with the command line tools and desktop clients', () => {
    const tools = [cli('claude', true), cli('codex', true), cli('codexDesktop', true), cli('grok', false)]
    const external = [{ id: 'claudeDesktop', status: { installed: false } }, { id: 'opencode', status: { installed: true } }]
    const antigravity = presentAntigravity({ supported: true, cliInstalled: true, desktopInstalled: true, configured: true })
    expect(installedToolCount(tools, external, antigravity, {})).toBe(6)
  })

  it('counts a card that is installing right now, since the home card already shows its progress', () => {
    const antigravity = presentAntigravity({ supported: true, cliInstalled: false, desktopInstalled: false, configured: false })
    const jobs = { grok: { label: '正在安装' }, antigravity: { label: '正在安装' }, claudeDesktop: { label: '正在安装' } }
    expect(installedToolCount([cli('grok', false)], [{ id: 'claudeDesktop', status: { installed: false } }], antigravity, jobs)).toBe(3)
  })

  it('counts nothing when nothing is installed or no card is shown', () => {
    expect(installedToolCount([cli('claude', false)], [], presentAntigravity(null), {})).toBe(0)
  })

  it('is the one count behind both the home tool heading and the status bar', () => {
    const root = path.resolve(__dirname, '../..')
    const home = readFileSync(path.join(root, 'features/tools/Home.tsx'), 'utf8')
    const app = readFileSync(path.join(root, 'App.tsx'), 'utf8')
    expect(home).toMatch(/const installedCount = installedToolCount\(/)
    expect(app).toMatch(/installedCount=\{toolbox\.snapshot \? installedToolCount\(/)
  })
})
