import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TutorialIllustrationId } from '../../registry/tutorials'
import { TutorialIllustration } from './TutorialIllustration'

// Record 漏键或多键都是编译错，新加一张示意图不会悄悄躲过下面的文案检查。
const everyIllustration: Record<TutorialIllustrationId, true> = {
  'desktop-home': true,
  'desktop-install': true,
  'desktop-config': true,
  'desktop-project': true,
  'desktop-message': true,
  home: true,
  account: true,
  install: true,
  config: true,
  launch: true,
  chat: true,
  canvas: true,
  acceleration: true,
  extensions: true,
  skills: true,
  plugins: true,
  backup: true,
  health: true,
}

function renderedText(kind: TutorialIllustrationId): string {
  // aria-label 读屏会念出来，和看得见的字一样算客户读到的文案。
  const markup = renderToStaticMarkup(<TutorialIllustration kind={kind} />)
  const label = /aria-label="([^"]*)"/.exec(markup)?.[1] ?? ''
  return `${label} ${markup.replace(/<[^>]+>/g, ' ')}`
}

describe('tutorial illustrations', () => {
  it.each(Object.keys(everyIllustration) as TutorialIllustrationId[])('keeps technical words out of the %s illustration', (kind) => {
    const text = renderedText(kind)
    expect(text).not.toMatch(/npm|PATH|TOML|环境变量/i)
    expect(text.replace(/(Codex|Gemini|Grok) CLI/g, '')).not.toMatch(/CLI/)
  })

  it('names the runtimes the way the home runtime card lists them', () => {
    expect(renderedText('install')).toContain('Node.js · Python')
  })
})
