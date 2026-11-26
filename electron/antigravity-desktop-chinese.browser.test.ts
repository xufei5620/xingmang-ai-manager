import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from '@playwright/test'
import {
  BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH,
  buildAntigravityChineseDictionary,
  buildAntigravityChineseInjection,
  parseAntigravityChineseInjectionResult,
  readBundledAntigravityChinesePack,
  type AntigravityChineseDictionary,
} from './antigravity-desktop-chinese'

let browser: Browser
let deep: AntigravityChineseDictionary
let light: AntigravityChineseDictionary

// A stand-in for the Antigravity 2.x window: interface strings the word list
// knows, next to the places that must stay as written (a reply, a user
// message, code, an icon ligature, an editable box).
const fixture = `<!doctype html><html lang="en"><body>
  <nav>
    <button id="new">New Conversation</button>
    <button id="icon"><span class="material-symbols-outlined">settings</span></button>
    <span id="padded">  Settings  </span>
    <span id="agent">Agent</span>
    <span id="days">3 days</span>
    <span id="unknown">Something the word list has never seen</span>
  </nav>
  <textarea id="composer" placeholder="Ask anything, @ to mention, / for actions">Settings</textarea>
  <button id="labelled" title="Settings" aria-label="Cancel">x</button>
  <div data-testid="planner-response-text"><p id="reply">Settings</p><button id="reply-button" title="Copy">c</button></div>
  <div data-testid="user-message-content"><span id="user">New Conversation</span></div>
  <pre><code id="code">Settings</code></pre>
  <div contenteditable="true"><span id="editable">Cancel</span></div>
  <div id="later"></div>
</body></html>`

async function freshPage(): Promise<Page> {
  const page = await browser.newPage()
  await page.setContent(fixture)
  return page
}

function textOf(page: Page, id: string): Promise<string | null> {
  return page.evaluate((elementId) => document.getElementById(elementId)?.textContent ?? null, id)
}

beforeAll(async () => {
  const pack = await readBundledAntigravityChinesePack(path.join(process.cwd(), ...BUNDLED_ANTIGRAVITY_CHINESE_RELATIVE_PATH))
  deep = buildAntigravityChineseDictionary(pack, 'deep')
  light = buildAntigravityChineseDictionary(pack, 'light')
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
}, 30_000)

afterAll(async () => {
  await browser?.close()
})

describe('Antigravity Chinese runtime in a real Chromium document', () => {
  it('translates interface text and hint attributes but leaves content, code, icons and editable areas alone', async () => {
    const page = await freshPage()
    try {
      const reported = parseAntigravityChineseInjectionResult(await page.evaluate(buildAntigravityChineseInjection(deep)))
      expect(reported).toMatchObject({ runtimeVersion: 1, version: deep.version, depth: 'deep' })
      expect(reported?.translated).toBeGreaterThan(5)

      expect(await textOf(page, 'new')).toBe('新建对话')
      expect(await textOf(page, 'padded')).toBe('  设置  ')
      expect(await textOf(page, 'agent')).toBe('智能体')
      expect(await textOf(page, 'days')).toBe('3 天')
      expect(await textOf(page, 'unknown')).toBe('Something the word list has never seen')

      const attributes = await page.evaluate(() => ({
        placeholder: document.getElementById('composer')?.getAttribute('placeholder'),
        composerText: (document.getElementById('composer') as HTMLTextAreaElement | null)?.value,
        title: document.getElementById('labelled')?.getAttribute('title'),
        ariaLabel: document.getElementById('labelled')?.getAttribute('aria-label'),
        replyButtonTitle: document.getElementById('reply-button')?.getAttribute('title'),
      }))
      expect(attributes).toEqual({ placeholder: '输入任何问题，@ 提及内容，/ 调用操作', composerText: 'Settings', title: '设置', ariaLabel: '取消', replyButtonTitle: 'Copy' })

      expect(await textOf(page, 'icon')).toBe('settings')
      expect(await textOf(page, 'reply')).toBe('Settings')
      expect(await textOf(page, 'user')).toBe('New Conversation')
      expect(await textOf(page, 'code')).toBe('Settings')
      expect(await textOf(page, 'editable')).toBe('Cancel')
    } finally {
      await page.close()
    }
  })

  it('keeps translating what the page adds or switches back to English afterwards', async () => {
    const page = await freshPage()
    try {
      await page.evaluate(buildAntigravityChineseInjection(deep))
      await page.evaluate(() => {
        const later = document.getElementById('later')
        if (!later) throw new Error('fixture missing')
        later.innerHTML = '<button id="added" title="Search">Cancel</button><div data-testid="planner-response-text"><span id="streamed">Send</span></div>'
        const button = document.getElementById('new')
        if (button?.firstChild) button.firstChild.nodeValue = 'Send'
        document.getElementById('labelled')?.setAttribute('title', 'Copy')
      })
      await page.waitForFunction(() => document.getElementById('added')?.textContent === '取消')
      expect(await textOf(page, 'added')).toBe('取消')
      expect(await page.evaluate(() => document.getElementById('added')?.getAttribute('title'))).toBe('搜索')
      expect(await textOf(page, 'new')).toBe('发送')
      expect(await page.evaluate(() => document.getElementById('labelled')?.getAttribute('title'))).toBe('复制')
      expect(await textOf(page, 'streamed')).toBe('Send')
    } finally {
      await page.close()
    }
  })

  it('replaces the previous runtime when injected again instead of stacking a second one', async () => {
    const page = await freshPage()
    try {
      await page.evaluate(() => {
        const active = new Set<MutationObserver>()
        const observe = MutationObserver.prototype.observe
        const disconnect = MutationObserver.prototype.disconnect
        MutationObserver.prototype.observe = function (target, options) {
          active.add(this)
          return observe.call(this, target, options)
        }
        MutationObserver.prototype.disconnect = function () {
          active.delete(this)
          return disconnect.call(this)
        }
        Reflect.set(window, 'activeObservers', () => active.size)
      })
      await page.evaluate(buildAntigravityChineseInjection(light))
      expect(await textOf(page, 'agent')).toBe('Agent')
      const second = parseAntigravityChineseInjectionResult(await page.evaluate(buildAntigravityChineseInjection(deep)))
      expect(second?.depth).toBe('deep')
      expect(await textOf(page, 'agent')).toBe('智能体')
      expect(await page.evaluate(() => (Reflect.get(window, 'activeObservers') as () => number)())).toBe(1)
      await page.evaluate(() => {
        const later = document.getElementById('later')
        if (later) later.textContent = 'Agent'
      })
      await page.waitForFunction(() => document.getElementById('later')?.textContent === '智能体')
    } finally {
      await page.close()
    }
  })
})
