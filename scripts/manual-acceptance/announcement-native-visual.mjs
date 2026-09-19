import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

const root = path.resolve('.')
const attachment = process.env.XINGMANG_ANNOUNCEMENT_FIXTURE?.trim()
if (!attachment) {
  throw new Error('请通过 XINGMANG_ANNOUNCEMENT_FIXTURE 提供本地公告附件的绝对路径')
}
const output = path.join(root, 'artifacts', 'renderer-v2-announcement-native')

function roundedRect(rect) {
  return Object.fromEntries(
    Object.entries(rect).map(([key, value]) => [key, Math.round(value * 10) / 10]),
  )
}

function issue(condition, message, issues) {
  if (!condition) issues.push(message)
}

function parseRgb(value) {
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(value)
  return match ? match.slice(1, 4).map(Number) : null
}

function luminance(value) {
  const rgb = parseRgb(value)
  if (!rgb) return null
  const channels = rgb.map((entry) => {
    const channel = entry / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(foreground, background) {
  const first = luminance(foreground)
  const second = luminance(background)
  if (first === null || second === null) return null
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function effectiveBackground(value, fallback) {
  return /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value) ? fallback : value
}

const source = await fs.readFile(attachment, 'utf8')
assert.match(source, /data-xm-native="sub2api-0\.2\.1"/)
await fs.mkdir(output, { recursive: true })

const server = await createServer({
  root,
  configFile: false,
  plugins: [react()],
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
await server.listen()
const address = server.httpServer.address()
if (!address || typeof address === 'string') throw new Error('Vite 未返回测试端口')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
})

const results = []
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    const offOriginRequests = []
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith(`${origin}/`) || url === 'about:srcdoc' || url.startsWith('data:')) {
        await route.continue()
      } else {
        offOriginRequests.push(url)
        await route.abort()
      }
    })
    await page.goto(`${origin}/e2e/announcement-native-visual-fixture.html`)
    await page.waitForFunction(() => typeof window.announcementVisualHarness?.render === 'function')
    await page.evaluate(
      ({ text, activeTheme }) => window.announcementVisualHarness.render(text, activeTheme),
      { text: source, activeTheme: theme },
    )

    const dialog = page.getByTestId('announcement-visual-dialog')
    await dialog.waitFor()
    const frameElement = page.getByTestId('announcement-native-frame')
    await frameElement.waitFor()
    const frameHandle = await frameElement.elementHandle()
    const frame = await frameHandle?.contentFrame()
    if (!frame) throw new Error('公告 iframe 尚未建立内容 frame')
    await frame.locator('[data-xm-native="sub2api-0.2.1"]').waitFor()
    await frame.locator('.announcement').first().waitFor()
    await frame.locator('img').evaluateAll(async (images) => {
      await Promise.all(images.map(async (image) => {
        if (image.complete) return
        await new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true })
          image.addEventListener('error', resolve, { once: true })
        })
      }))
    })

    const host = await page.evaluate(() => {
      const rect = (selector, scope = document) => {
        const box = scope.querySelector(selector)?.getBoundingClientRect()
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null
      }
      const scrollables = [...document.querySelectorAll('*')].filter((element) => {
        const style = getComputedStyle(element)
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      }).map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }))
      return {
        dialog: rect('[data-testid="announcement-visual-dialog"]'),
        body: rect('[data-testid="announcement-visual-dialog"] .xm-dialog-body'),
        iframe: rect('[data-testid="announcement-native-frame"]'),
        footer: rect('[data-testid="announcement-visual-dialog"] footer'),
        scrollables,
        fallbackVisible: document.body.innerText.includes('[图片：Xingmang AI]'),
        errors: window.announcementVisualHarness.errors,
      }
    })
    const content = await frame.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
      }
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect()
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null
      }
      const stateElements = [...document.querySelectorAll('[data-xm-state]')]
      const visibleStates = stateElements.filter(visible).map((element) => element.getAttribute('data-xm-state'))
      const activeState = stateElements.find(visible) ?? document
      const style = (selector) => {
        const element = activeState.querySelector(selector)
        if (!element) return null
        const computed = getComputedStyle(element)
        return {
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          display: computed.display,
          opacity: computed.opacity,
          fontSize: computed.fontSize,
        }
      }
      const factBoxes = [...activeState.querySelectorAll('.facts > div')].map((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right }
      })
      const stepIcons = [...activeState.querySelectorAll('.bullet-icon')].map((element) => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      })
      const scrolling = document.scrollingElement
      return {
        documentClass: document.documentElement.className,
        documentLang: document.documentElement.lang,
        visibleStates,
        root: rect('[data-xm-native]'),
        preview: rect('.preview', activeState),
        article: rect('.announcement', activeState),
        logo: rect('.brand-lockup', activeState),
        title: rect('.notice-title', activeState),
        art: rect('.transparent-business-icon', activeState),
        qr: rect('.qr-image-link img', activeState),
        contact: rect('.contact-card', activeState),
        contactLink: rect('.contact-link', activeState),
        letterFooter: rect('.letter-footer', activeState),
        factBoxes,
        stepIcons,
        stepCount: activeState.querySelectorAll('.changes > li').length,
        titleCount: [...document.querySelectorAll('.notice-title')].filter(visible).length,
        styles: {
          article: style('.announcement'),
          body: style('.body'),
          factLabel: style('.fact-label'),
          factValue: style('.fact-value'),
          stepCopy: style('.changes p'),
          contact: style('.contact-card'),
          contactLink: style('.contact-link'),
        },
        visibleText: activeState.textContent ?? '',
        scroll: scrolling ? {
          clientWidth: scrolling.clientWidth,
          scrollWidth: scrolling.scrollWidth,
          clientHeight: scrolling.clientHeight,
          scrollHeight: scrolling.scrollHeight,
        } : null,
      }
    })

    await page.evaluate(async ({ text, dark }) => {
      const rawFrame = document.createElement('iframe')
      rawFrame.id = 'announcement-raw-reference'
      rawFrame.setAttribute('sandbox', 'allow-same-origin')
      rawFrame.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;height:508px;border:0'
      const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
      const theme = dark ? 'dark' : 'light'
      const loaded = new Promise((resolve) => rawFrame.addEventListener('load', resolve, { once: true }))
      rawFrame.srcdoc = `<!doctype html><html class="${dark ? 'dark' : ''}" data-theme="${theme}" lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{box-sizing:border-box;margin:0;min-width:0;background:transparent;color-scheme:${theme}}body{overflow:auto}</style></head><body>${text}</body></html>`
      document.body.append(rawFrame)
      await loaded
    }, { text: source, dark: theme === 'dark' })
    const rawHandle = await page.locator('#announcement-raw-reference').elementHandle()
    const rawFrame = await rawHandle?.contentFrame()
    if (!rawFrame) throw new Error('原始公告参考 frame 未建立')

    const inspectCss = (targetFrame) => targetFrame.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
      }
      const root = document.querySelector('[data-xm-native], [data-newapi-notice]')
      const rootClass = root ? [...root.classList].find((entry) => /^xm-(?:native|newapi)-/i.test(entry)) ?? '' : ''
      const state = [...document.querySelectorAll('[data-xm-state]')].find(visible) ?? document
      const computed = (selector) => {
        const element = state.querySelector(selector)
        if (!element) return null
        const style = getComputedStyle(element)
        return { color: style.color, backgroundColor: style.backgroundColor }
      }
      const rules = []
      const walk = (sourceRules) => {
        for (const rule of sourceRules) {
          if ('selectorText' in rule && typeof rule.selectorText === 'string'
            && rule.selectorText.includes(rootClass)
            && /(?:\.announcement(?:\b|\[)|\.contact-link\b|html\.dark\s+\.[^{ ]+$)/.test(rule.selectorText)) {
            rules.push({ selector: rule.selectorText, declarations: rule.style.cssText })
          }
          if ('cssRules' in rule) walk(rule.cssRules)
        }
      }
      for (const sheet of document.styleSheets) walk(sheet.cssRules)
      return {
        visibleState: state instanceof Element ? state.getAttribute('data-xm-state') : null,
        article: computed('.announcement'),
        contactLink: computed('.contact-link'),
        variables: root ? {
          surface: getComputedStyle(root).getPropertyValue('--surface').trim(),
          brandNavy: getComputedStyle(root).getPropertyValue('--brand-navy').trim(),
        } : null,
        rules,
      }
    })
    const [rawCss, sanitizedCss] = await Promise.all([inspectCss(rawFrame), inspectCss(frame)])
    await page.locator('#announcement-raw-reference').evaluate((element) => element.remove())

    const issues = []
    const expectedState = `zh-${theme}`
    issue(host.dialog && Math.abs(host.dialog.width - 640) <= 1, `Dialog 逻辑宽不是 640px：${host.dialog?.width}`, issues)
    issue(host.iframe && host.iframe.width >= 598 && host.iframe.width <= 602, `Dialog 可用正文宽不在约 600px：${host.iframe?.width}`, issues)
    issue(content.visibleStates.length === 1 && content.visibleStates[0] === expectedState, `可见状态应只有 ${expectedState}，实际 ${content.visibleStates.join(', ')}`, issues)
    issue(content.titleCount === 1, `可见主标题应为 1 个，实际 ${content.titleCount}`, issues)
    issue(content.visibleText.includes('开票中心') && !content.visibleText.includes('The Invoice Center'), '当前主题未只显示中文内容', issues)
    issue(host.fallbackVisible === false && !content.visibleText.includes('[图片：Xingmang AI]'), '品牌 Logo 仍降级为图片替代文本', issues)
    issue(content.logo && Math.abs(content.logo.width - 176) <= 2 && Math.abs(content.logo.height - 69) <= 2, `Logo 尺寸不是约 176×69：${JSON.stringify(content.logo)}`, issues)
    issue(content.art && content.art.width >= 140 && content.art.width <= 150 && content.art.height >= 140 && content.art.height <= 150, `主视觉没有保持约 148×148：${JSON.stringify(content.art)}`, issues)
    issue(content.qr && Math.abs(content.qr.width - 144) <= 2 && Math.abs(content.qr.height - 144) <= 2, `二维码尺寸不是约 144×144：${JSON.stringify(content.qr)}`, issues)
    issue(content.contactLink && content.contactLink.width > 80 && content.visibleText.includes('打开微信客服'), `微信客服入口没有可见文字：${JSON.stringify(content.contactLink)}`, issues)
    issue(content.factBoxes.length === 2 && Math.abs(content.factBoxes[0].y - content.factBoxes[1].y) <= 2 && content.factBoxes[1].x > content.factBoxes[0].x, '适用充值/不计入开票未保持双栏', issues)
    issue(content.stepCount === 4 && content.stepIcons.length === 4, `四步申请结构不完整：${content.stepCount} 步/${content.stepIcons.length} 图标`, issues)
    issue(content.stepIcons.every((box) => Math.abs(box.width - 32) <= 2 && Math.abs(box.height - 32) <= 2), `步骤图标位不是约 32×32：${JSON.stringify(content.stepIcons)}`, issues)
    issue(content.title && content.art && (content.title.right <= content.art.x || content.title.bottom <= content.art.y || content.art.right <= content.title.x || content.art.bottom <= content.title.y), '标题与主视觉发生重叠', issues)
    issue(content.scroll && content.scroll.scrollWidth <= content.scroll.clientWidth + 1, `iframe 内容出现横向溢出：${JSON.stringify(content.scroll)}`, issues)
    const articleBackground = content.styles.article?.backgroundColor ?? ''
    const factValueContrast = contrast(content.styles.factValue?.color ?? '', articleBackground)
    const stepCopyContrast = contrast(content.styles.stepCopy?.color ?? '', articleBackground)
    const contactBackground = content.styles.contact?.backgroundColor ?? articleBackground
    const contactLinkBackground = effectiveBackground(content.styles.contactLink?.backgroundColor ?? '', contactBackground)
    const contactLinkContrast = contrast(content.styles.contactLink?.color ?? '', contactLinkBackground)
    issue(theme !== 'dark' || (luminance(articleBackground) ?? 1) < 0.2, `暗色公告正文背景仍为亮色：${articleBackground}`, issues)
    issue(factValueContrast !== null && factValueContrast >= 4.5, `事实正文对比度不足：${factValueContrast?.toFixed(2) ?? '未知'} (${content.styles.factValue?.color} / ${articleBackground})`, issues)
    issue(stepCopyContrast !== null && stepCopyContrast >= 4.5, `步骤正文对比度不足：${stepCopyContrast?.toFixed(2) ?? '未知'} (${content.styles.stepCopy?.color} / ${articleBackground})`, issues)
    issue(contactLinkContrast !== null && contactLinkContrast >= 4.5, `微信客服入口对比度不足：${contactLinkContrast?.toFixed(2) ?? '未知'} (${content.styles.contactLink?.color} / ${contactLinkBackground})`, issues)
    const frameScrollable = Boolean(content.scroll && content.scroll.scrollHeight > content.scroll.clientHeight + 1)
    issue(host.scrollables.length + Number(frameScrollable) === 1, `纵向滚动容器不是 1 个：host=${JSON.stringify(host.scrollables)}, frame=${frameScrollable}`, issues)
    issue(host.footer && host.footer.bottom <= 820 && host.footer.y >= 0, `Dialog footer 不可达：${JSON.stringify(host.footer)}`, issues)
    issue(pageErrors.length === 0 && host.errors.length === 0, `页面错误：${[...pageErrors, ...host.errors].join('；')}`, issues)
    issue(offOriginRequests.length === 0, `测试期间发生外域请求：${offOriginRequests.join(', ')}`, issues)
    issue(sanitizedCss.article?.backgroundColor === rawCss.article?.backgroundColor, `sanitized 公告背景与 raw 不一致：${sanitizedCss.article?.backgroundColor} / ${rawCss.article?.backgroundColor}`, issues)
    issue(sanitizedCss.contactLink?.backgroundColor === rawCss.contactLink?.backgroundColor && sanitizedCss.contactLink?.color === rawCss.contactLink?.color, `sanitized 客服按钮与 raw 不一致：${JSON.stringify(sanitizedCss.contactLink)} / ${JSON.stringify(rawCss.contactLink)}`, issues)
    issue(sanitizedCss.rules.some((rule) => rule.selector.includes('.announcement') && /background:\s*var\(--surface\)/.test(rule.declarations)), 'sanitized cssText 缺少 dark announcement background shorthand', issues)
    issue(sanitizedCss.rules.some((rule) => rule.selector.includes('.contact-link') && /background:\s*var\(--brand-navy\)/.test(rule.declarations)), 'sanitized cssText 缺少 light contact-link background shorthand', issues)

    await page.screenshot({ path: path.join(output, `real-${theme}-top.png`) })
    if (host.scrollables.length) {
      await page.evaluate(() => {
        const owner = [...document.querySelectorAll('*')].find((element) => {
          const style = getComputedStyle(element)
          return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
        })
        if (owner) owner.scrollTop = owner.scrollHeight
      })
    }
    if (frameScrollable) await frame.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(100)
    await page.screenshot({ path: path.join(output, `real-${theme}-bottom.png`) })

    results.push({
      theme,
      fixture: 'XINGMANG_ANNOUNCEMENT_FIXTURE',
      sourceLength: source.length,
      host: {
        ...host,
        dialog: host.dialog && roundedRect(host.dialog),
        body: host.body && roundedRect(host.body),
        iframe: host.iframe && roundedRect(host.iframe),
        footer: host.footer && roundedRect(host.footer),
      },
      content: Object.fromEntries(Object.entries(content).map(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'width' in value) return [key, roundedRect(value)]
        return [key, key === 'visibleText' ? undefined : value]
      })),
      offOriginRequests,
      cssComparison: { raw: rawCss, sanitized: sanitizedCss },
      issues,
    })
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}

await fs.writeFile(path.join(output, 'result.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
const issueLines = results.flatMap((result) => result.issues.map((message) => `- ${result.theme}: ${message}`))
await fs.writeFile(
  path.join(output, 'README.md'),
  `# 公告原生富文档视觉验证\n\n附件由 \`XINGMANG_ANNOUNCEMENT_FIXTURE\` 提供，结果不记录个人路径。\n\n${issueLines.length ? `## 问题\n\n${issueLines.join('\n')}\n` : '亮色与暗色检查全部通过。\n'}\n`,
  'utf8',
)
if (issueLines.length) throw new Error(`公告视觉验证发现 ${issueLines.length} 项问题，见 ${path.join(output, 'README.md')}`)
console.log(`公告原生富文档视觉验证通过：${path.join(output, 'result.json')}`)
