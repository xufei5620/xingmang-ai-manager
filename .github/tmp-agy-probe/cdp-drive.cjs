// 临时：连上 Antigravity 桌面端的调试端口，看界面上有什么、能不能发一句话，核完就删。
const { chromium } = require(process.env.PW_DIR + '/node_modules/playwright-core')

const port = process.argv[2]
const mode = process.argv[3]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clean(text) {
  return String(text || '').replace(/#t=[^\s"']*/g, '#t=REDACTED').replace(/\n{3,}/g, '\n\n')
}

async function describe(page, label) {
  console.log(`--- ${label}: url=${clean(page.url())}`)
  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch((e) => `evaluate failed: ${e.message}`)
  console.log(clean(text).slice(0, 2500))
  const controls = await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    return Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"], button, [role="button"], [role="combobox"]'))
      .filter(visible)
      .slice(0, 60)
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? '[' + el.getAttribute('role') + ']' : ''} ${(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim().slice(0, 60)}`)
  }).catch((e) => [`controls failed: ${e.message}`])
  console.log('controls:', JSON.stringify(controls))
}

async function findEditor(page) {
  for (const selector of ['textarea', '[contenteditable="true"]', '[role="textbox"]']) {
    const handles = await page.$$(selector)
    for (const handle of handles) {
      if (await handle.isVisible().catch(() => false)) return handle
    }
  }
  return null
}

async function main() {
  let browser = null
  for (let i = 0; i < 40 && !browser; i += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(1000)
    }
  }
  if (!browser) {
    console.log('CDP connect failed')
    return
  }
  await sleep(8000)
  const pages = browser.contexts().flatMap((c) => c.pages())
  for (const p of pages) console.log('page:', clean(p.url()), JSON.stringify(await p.title().catch(() => '')))
  const page = pages.find((p) => p.url().startsWith('https://127.0.0.1')) || pages[0]
  if (!page) {
    console.log('no page')
    return
  }
  await describe(page, 'first look')
  if (mode !== 'chat') return

  let editor = await findEditor(page)
  for (let step = 0; step < 8 && !editor; step += 1) {
    const buttons = await page.$$('button, [role="button"], a')
    let clicked = false
    for (const b of buttons) {
      const label = ((await b.innerText().catch(() => '')) || '').trim()
      if (/^(continue|next|skip|get started|start|accept|agree|i agree|done|ok|got it|let'?s go|finish|use default|dark|light)\b/i.test(label) && await b.isVisible().catch(() => false)) {
        console.log(`click: ${label.slice(0, 40)}`)
        await b.click().catch((e) => console.log('click failed', e.message))
        clicked = true
        break
      }
    }
    await sleep(3000)
    await describe(page, `after step ${step}`)
    editor = await findEditor(page)
    if (!clicked) break
  }
  if (!editor) {
    console.log('no chat editor found')
    return
  }
  await editor.click()
  await page.keyboard.type('Reply with the single word pong.')
  await page.keyboard.press('Enter')
  console.log('sent a prompt, waiting')
  await sleep(45000)
  await describe(page, 'after prompt')
}

main().catch((e) => console.log('driver error:', e.message)).finally(() => process.exit(0))
