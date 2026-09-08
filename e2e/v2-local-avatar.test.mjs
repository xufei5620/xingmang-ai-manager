import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

let server, browser, origin
before(async () => {
  process.env.XINGMANG_RENDERER = 'v2'
  server = await createServer({
    root: path.resolve('.'),
    cacheDir: 'node_modules/.vite-v2-avatar',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5196, strictPort: false },
  })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
  })
})
after(async () => {
  await browser?.close()
  await server?.close()
})
async function fixture(init) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(7000)
  page.setDefaultNavigationTimeout(30000)
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  )
  if (init) await page.addInitScript(init)
  await page.goto(`${origin}/e2e/v2-local-avatar-fixture.html`)
  await page.getByRole('button', { name: '更换头像', exact: true }).click()
  return page
}
async function imageFile(page, mime = 'image/png') {
  const encoded = await page.evaluate((type) => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 320
    const context = canvas.getContext('2d')
    context.fillStyle = '#ff0000'
    context.fillRect(0, 0, 320, 320)
    context.fillStyle = '#0000ff'
    context.fillRect(320, 0, 320, 320)
    return canvas.toDataURL(type).split(',')[1]
  }, mime)
  return {
    name:
      mime === 'image/jpeg'
        ? 'portrait.jpg'
        : mime === 'image/webp'
          ? 'portrait.webp'
          : 'portrait.png',
    mimeType: mime,
    buffer: Buffer.from(encoded, 'base64'),
  }
}
test('crops a local image to a 256px PNG and persists it only for the selected account', async () => {
  const page = await fixture()
  try {
    await page
      .getByTestId('account-avatar-file')
      .setInputFiles(await imageFile(page))
    await page.getByTestId('account-avatar-preview').waitFor()
    await page.getByTestId('account-avatar-horizontal').fill('100')
    await page.getByTestId('account-avatar-save').click()
    await page
      .getByTestId('account-avatar-dialog')
      .waitFor({ state: 'detached' })
    const saved = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(
            document.querySelector('[data-testid="avatar-key"]').textContent,
          ),
        ).dataUrl,
    )
    const bytes = Buffer.from(saved.split(',')[1], 'base64')
    assert.equal(bytes.readUInt32BE(16), 256)
    assert.equal(bytes.readUInt32BE(20), 256)
    assert.equal(
      await page.getByTestId('avatar-current').locator('img').count(),
      1,
    )
    const center = await page.evaluate(async () => {
      const image = document.querySelector('[data-testid="avatar-current"] img')
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return [...context.getImageData(128, 128, 1, 1).data]
    })
    assert.deepEqual(center, [0, 0, 255, 255])
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('avatar-switch', { detail: 8 })),
    )
    await page
      .getByTestId('avatar-user')
      .getByText('8', { exact: true })
      .waitFor()
    assert.equal(await page.getByTestId('avatar-current').innerText(), '另')
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('avatar-switch', { detail: 7 })),
    )
    await page.getByTestId('avatar-current').locator('img').waitFor()
    assert.equal(
      await page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith('xingmang-v2-avatar:'),
          ).length,
      ),
      1,
    )
  } finally {
    await page.close()
  }
})
test('accepts JPEG and WebP but rejects forged types and images larger than 2MB', async () => {
  const page = await fixture()
  try {
    for (const mime of ['image/jpeg', 'image/webp']) {
      await page
        .getByTestId('account-avatar-file')
        .setInputFiles(await imageFile(page, mime))
      await page.getByTestId('account-avatar-preview').waitFor()
    }
    await page
      .getByTestId('account-avatar-file')
      .setInputFiles({
        name: 'fake.png',
        mimeType: 'image/png',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      })
    await page
      .getByText('请选择 PNG、JPEG 或 WebP 图片。', { exact: true })
      .waitFor()
    await page
      .getByTestId('account-avatar-file')
      .setInputFiles({
        name: 'large.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
      })
    await page
      .getByText('图片不能超过 2 MB，请换一张较小的图片。', { exact: true })
      .waitFor()
    assert.equal(await page.getByTestId('account-avatar-preview').count(), 1)
  } finally {
    await page.close()
  }
})
test('failed local storage keeps the crop preview and allows retry', async () => {
  const page = await fixture(() => {
    const original = Storage.prototype.setItem
    window.avatarStorageAllowed = false
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('xingmang-v2-avatar:') && !window.avatarStorageAllowed)
        throw new Error('quota exceeded')
      return original.call(this, key, value)
    }
  })
  try {
    await page
      .getByTestId('account-avatar-file')
      .setInputFiles(await imageFile(page))
    await page.getByTestId('account-avatar-save').click()
    await page
      .getByText(
        '头像没有保存成功，裁剪预览已保留。请释放本机存储空间后重试。',
        { exact: true },
      )
      .waitFor()
    assert.equal(
      await page.getByTestId('account-avatar-preview').isVisible(),
      true,
    )
    await page.evaluate(() => {
      window.avatarStorageAllowed = true
    })
    await page.getByTestId('account-avatar-save').click()
    await page
      .getByTestId('account-avatar-dialog')
      .waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})
test('late image decode is discarded when the account changes', async () => {
  const page = await fixture(() => {
    const original = window.createImageBitmap
    window.createImageBitmap = async (...args) => {
      const image = await original(...args)
      window.avatarDecodeReady = true
      await new Promise((resolve) => {
        window.releaseAvatarDecode = resolve
      })
      return image
    }
  })
  try {
    await page
      .getByTestId('account-avatar-file')
      .setInputFiles(await imageFile(page))
    await page.waitForFunction(() => window.avatarDecodeReady)
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('avatar-switch', { detail: 8 })),
    )
    await page
      .getByTestId('avatar-user')
      .getByText('8', { exact: true })
      .waitFor()
    await page.evaluate(() => window.releaseAvatarDecode())
    assert.equal(
      await page.getByTestId('account-avatar-save').isDisabled(),
      true,
    )
    assert.equal(await page.getByTestId('account-avatar-preview').count(), 0)
    assert.equal(
      await page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith('xingmang-v2-avatar:'),
          ).length,
      ),
      0,
    )
  } finally {
    await page.close()
  }
})

test('account header matches the return-and-identity layout and moves refresh into its menu', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.goto(`${origin}/e2e/v2-business-fixture.html?page=account`)
    await page
      .getByText('余额、Key、用量与订单都在这里。', { exact: true })
      .waitFor()
    const avatar = page.getByTestId('account-profile-avatar')
    assert.equal(await avatar.innerText(), '本')
    assert.deepEqual(
      await avatar.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
      {
        width: 72,
        height: 72,
        background: 'rgb(11, 31, 59)',
        color: 'rgb(212, 163, 85)',
      },
    )
    assert.equal(
      await page.getByRole('button', { name: '刷新', exact: true }).count(),
      0,
    )
    await page.getByTestId('account-identity-menu').click()
    await page
      .getByRole('menuitem', { name: '刷新账号资料', exact: true })
      .waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('account-back').click()
    assert.equal(
      await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.calls).some(
          (call) => call.name === 'navigate' && call.args === 'home',
        ),
      ),
      true,
    )
    assert.equal(
      await page
        .locator('.v2-business-profile-fields')
        .evaluate((element) => getComputedStyle(element).rowGap),
      '0px',
    )
  } finally {
    await page.close()
  }
})
