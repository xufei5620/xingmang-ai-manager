import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

// Markdown 排版这一套只有点开公告、用户协议、隐私政策时才用，约 150KB（总单 77，R9）。静态引它的文件
// 只能是本身就按需加载的那几块，否则这一整套又回到首屏包里，每次开机都要多解析一遍。
// 客服二维码库 qrcode 不在这里：欢迎页首屏就要那张图，改成按需加载会拖慢 Mac 开发版开机（见 useSupportContact.ts）。
const onDemandLibraries = ['react-markdown', 'remark-gfm']
const allowedStaticImporters = new Map([
  // markdown-view.tsx 用 import() 读它，公告和用户协议都经那里。
  ['markdown-renderer.tsx', 'loaded by markdown-view.tsx through import()'],
  // 聊天页整页由 App.tsx 按需加载。
  ['features/chat/ChatPage.tsx', 'the chat page is a lazy chunk'],
])
// 静态的 import … from '…'（不含 import type，它编译后就没了；不含 import()，那正是按需加载）。
const staticImportPattern = new RegExp(String.raw`^\s*import\s+(?!type\b)[^;]*?\bfrom\s+'(${onDemandLibraries.join('|')})'`, 'm')

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('renderer-v2 first-screen imports', () => {
  it('imports the Markdown libraries statically only from modules that are loaded on demand', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(root)) {
      const relative = path.relative(root, file).replaceAll('\\', '/')
      const match = fs.readFileSync(file, 'utf8').match(staticImportPattern)
      if (match && !allowedStaticImporters.has(relative)) offenders.push(`${relative} -> ${match[1]}`)
    }
    expect(offenders).toEqual([])
  })

  it('recognises the static imports it allows, so the check is not passing vacuously', () => {
    for (const relative of allowedStaticImporters.keys()) {
      expect(fs.readFileSync(path.join(root, relative), 'utf8'), relative).toMatch(staticImportPattern)
    }
  })
})
