import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// 「插件」页里 GPT 官方那一组的图标（扩展合并方案三、4 节）。只在我们这边出版本前跑，客户电脑上不跑：
// 客户那边只读这里生成好、随包带走的 96×96 PNG，不碰插件目录里第三方写的图标路径，也就不用在客户那边
// 防路径穿越、防 SVG 里的脚本。
//
// 用法：
//   node scripts/build-plugin-icons.mjs --catalog <openai/plugins 的本地目录> [--repo <插件名>=<那个插件仓库的本地目录>]...
// --catalog 用存储桶里那份 Codex 插件目录同一个提交（codex-plugin-catalog.ts 下的就是 openai/plugins 的 main）；
// 目录里不带、放在插件自己仓库里的（CrowdStrike 两个、Qodo），用 --repo 给出钉住提交的那份克隆。
// 结果写进 bundled-catalog/plugin-icons/：codex/<插件名>.png（带深色版的另有 -dark.png）和 index.json
// （每个文件的 sha256、来源提交，没图标的、拒收的各记一笔）。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const outputDirectory = path.join(root, 'bundled-catalog', 'plugin-icons')
const runFile = promisify(execFile)

/** 单个原图最大 1 MB：目录里最大的一张不到 200 KB，大得离谱的多半不是图标。 */
export const maximumSourceBytes = 1024 * 1024
export const iconSize = 96
const renderSize = 512

/** 按开头几个字节认类型，不信扩展名。SVG 是文本，只认以 <svg 或 <?xml 开头、里面真有 <svg 的。 */
export function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  const head = buffer.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart()
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && /<svg[\s>]/.test(head)) return 'svg'
  return null
}

/**
 * SVG 转图片之前先扫一遍：带脚本、foreignObject、事件属性、外部链接、实体声明的一律不收，改用通用图标并记下来。
 * 转的时候浏览器把它当图片加载，本来就不跑脚本、不取外部资源；这一道是再多一层，免得哪天换了转法就漏过去。
 */
export function svgProblem(text) {
  if (/<script[\s>/]/i.test(text)) return '带脚本'
  if (/<foreignObject[\s>/]/i.test(text)) return '带 foreignObject'
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) return '带实体声明'
  if (/\son[a-z]+\s*=/i.test(text)) return '带事件属性'
  // href / xlink:href 只许指向文件里自己的 #id；url(...) 同理。别的（http、//、data:、相对路径）都算外部。
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!match[2].trim().startsWith('#')) return '带外部链接'
  }
  for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith('#')) return '带外部链接'
  }
  if (/@import/i.test(text)) return '带外部链接'
  return null
}

/** 插件名只收小写字母、数字和 -，同时就是输出文件名，不许带路径。 */
export function safeIconName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/**
 * plugin.json 里写的图标路径（比如 ./assets/logo.png）换成插件目录里的绝对路径。绝对路径、反斜杠、
 * 跳出插件目录的一律不收：这份清单是第三方写的。
 */
export function resolveLogoPath(pluginDirectory, logo) {
  if (typeof logo !== 'string' || !logo.trim()) return null
  if (logo.includes('\\') || logo.includes('\0') || path.isAbsolute(logo) || /^[a-z]+:/i.test(logo)) throw new Error('图标路径不在插件目录里')
  const base = path.resolve(pluginDirectory)
  const resolved = path.resolve(base, logo)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('图标路径不在插件目录里')
  return resolved
}

/** 目录里一个插件放在哪：local 在目录自己里面；url / git-subdir 要 --repo 给出那份克隆。 */
export function pluginDirectoryFor(entry, catalogDirectory, repos) {
  const source = entry.source ?? {}
  if (source.source === 'local') return resolveLogoPath(catalogDirectory, source.path)
  const repo = repos.get(entry.name)
  if (!repo) return null
  if (source.source === 'git-subdir') return resolveLogoPath(repo, source.path)
  return path.resolve(repo)
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function gitCommit(directory) {
  try {
    const { stdout } = await runFile('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeout: 10_000 })
    const commit = stdout.trim()
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null
  } catch {
    return null
  }
}

async function readSource(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile()) throw new Error('图标不是普通文件')
  if (stat.size > maximumSourceBytes) throw new Error('图标超过 1 MB')
  const buffer = await fs.readFile(file)
  const type = sniffImageType(buffer)
  if (!type) throw new Error('认不出图标的格式')
  if (type === 'svg') {
    const problem = svgProblem(buffer.toString('utf8'))
    if (problem) throw new Error(`SVG ${problem}`)
  }
  return { buffer, type }
}

const mimeTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }

/**
 * 两步转：第一步关脚本、拦下所有网络请求，页面只放行 data: 图片，第三方的图只当 <img> 画成 512×512；
 * 第二步拿第一步截下来的那张（我们自己画出来的像素，不再是第三方文件）裁白边、缩到 96×96。
 * 只有 SVG 裁白边，而且标只占画布不到六成时才裁（Temporal 那个只占中间三分之一）；位图本来就是铺满的。
 */
async function createRasterizer() {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true, ...(process.env.XINGMANG_E2E_CHROMIUM ? { executablePath: process.env.XINGMANG_E2E_CHROMIUM } : {}) })
  const sandbox = await browser.newContext({ javaScriptEnabled: false, offline: true, deviceScaleFactor: 1 })
  let blocked = 0
  await sandbox.route('**/*', (route) => {
    blocked += 1
    return route.abort()
  })
  const worker = await browser.newContext({ offline: true, deviceScaleFactor: 1 })
  await worker.route('**/*', (route) => {
    blocked += 1
    return route.abort()
  })
  const workerPage = await worker.newPage()
  await workerPage.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'">`)
  return {
    blocked: () => blocked,
    async render({ buffer, type }) {
      const page = await sandbox.newPage({ viewport: { width: renderSize, height: renderSize } })
      try {
        await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent}img{display:block;width:${renderSize}px;height:${renderSize}px;object-fit:contain}</style><img id="icon" alt="" src="data:${mimeTypes[type]};base64,${buffer.toString('base64')}">`)
        const rendered = await page.locator('#icon').screenshot({ omitBackground: true, type: 'png' })
        const output = await workerPage.evaluate(async ({ source, trim, size }) => {
          const image = new Image()
          image.src = source
          await image.decode()
          const full = document.createElement('canvas')
          full.width = image.naturalWidth
          full.height = image.naturalHeight
          const fullContext = full.getContext('2d')
          fullContext.drawImage(image, 0, 0)
          let box = { x: 0, y: 0, width: full.width, height: full.height }
          if (trim) {
            const { data } = fullContext.getImageData(0, 0, full.width, full.height)
            let left = full.width, top = full.height, right = -1, bottom = -1
            for (let y = 0; y < full.height; y += 1)
              for (let x = 0; x < full.width; x += 1)
                if (data[(y * full.width + x) * 4 + 3] > 8) {
                  if (x < left) left = x
                  if (x > right) right = x
                  if (y < top) top = y
                  if (y > bottom) bottom = y
                }
            if (right >= 0) {
              const width = right - left + 1
              const height = bottom - top + 1
              if (Math.max(width, height) < full.width * 0.6) {
                // 裁成正方形、四周留一成，标不贴边。
                const side = Math.ceil(Math.max(width, height) * 1.2)
                box = { x: Math.round(left + width / 2 - side / 2), y: Math.round(top + height / 2 - side / 2), width: side, height: side }
              }
            }
          }
          const out = document.createElement('canvas')
          out.width = size
          out.height = size
          const context = out.getContext('2d')
          context.imageSmoothingQuality = 'high'
          context.drawImage(full, box.x, box.y, box.width, box.height, 0, 0, size, size)
          return out.toDataURL('image/png').slice('data:image/png;base64,'.length)
        }, { source: `data:image/png;base64,${rendered.toString('base64')}`, trim: type === 'svg', size: iconSize })
        return Buffer.from(output, 'base64')
      } finally {
        await page.close()
      }
    },
    close: () => browser.close(),
  }
}

export function parseArguments(argv) {
  const repos = new Map()
  let catalog = null
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--catalog' && value) {
      catalog = value
      index += 1
    } else if (flag === '--repo' && value && value.includes('=')) {
      const [name, directory] = [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]
      if (!safeIconName(name) || !directory) throw new Error(`--repo ${value} 写法不对，应为 插件名=目录`)
      repos.set(name, directory)
      index += 1
    } else throw new Error(`不认识的参数：${flag}`)
  }
  if (!catalog) throw new Error('要用 --catalog 指定 openai/plugins 的本地目录')
  return { catalog, repos }
}

async function main() {
  const { catalog, repos } = parseArguments(process.argv.slice(2))
  const marketplace = JSON.parse(await fs.readFile(path.join(catalog, '.agents', 'plugins', 'api_marketplace.json'), 'utf8'))
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  const codexDirectory = path.join(outputDirectory, 'codex')
  await fs.rm(codexDirectory, { recursive: true, force: true })
  await fs.mkdir(codexDirectory, { recursive: true })
  const rasterizer = await createRasterizer()
  const icons = {}
  const missing = []
  const rejected = []
  const repoSources = {}
  try {
    for (const entry of plugins) {
      if (!safeIconName(entry?.name)) {
        rejected.push({ name: String(entry?.name ?? ''), reason: '插件名不合规' })
        continue
      }
      try {
        const directory = pluginDirectoryFor(entry, catalog, repos)
        if (!directory) {
          missing.push(entry.name)
          continue
        }
        if (entry.source?.source !== 'local') {
          repoSources[entry.name] = { url: String(entry.source?.url ?? ''), commit: await gitCommit(repos.get(entry.name)) }
        }
        const manifest = JSON.parse(await fs.readFile(path.join(directory, '.codex-plugin', 'plugin.json'), 'utf8'))
        const light = resolveLogoPath(directory, manifest.interface?.logo)
        if (!light) {
          missing.push(entry.name)
          continue
        }
        const record = {}
        for (const [variant, file] of [['light', light], ['dark', resolveLogoPath(directory, manifest.interface?.logoDark)]]) {
          if (!file) continue
          const png = await rasterizer.render(await readSource(file))
          const relative = `codex/${entry.name}${variant === 'dark' ? '-dark' : ''}.png`
          await fs.writeFile(path.join(outputDirectory, relative), png)
          record[variant] = { file: relative, sha256: sha256(png) }
        }
        icons[entry.name] = record
      } catch (error) {
        rejected.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    await rasterizer.close()
  }
  const index = {
    note: '由 scripts/build-plugin-icons.mjs 生成，别手改。',
    source: { catalog: 'openai/plugins', commit: await gitCommit(catalog), repos: repoSources },
    size: iconSize,
    icons,
    missing: missing.sort(),
    rejected,
  }
  await fs.writeFile(path.join(outputDirectory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
  const count = Object.keys(icons).length
  console.log(`生成 ${count} 个插件图标；没有图标 ${missing.length} 个；拒收 ${rejected.length} 个；拦下网络请求 ${rasterizer.blocked()} 次`)
  if (rejected.length) for (const entry of rejected) console.log(`  拒收 ${entry.name}：${entry.reason}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
