import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StorageUsagePartReport } from '../../../../electron/ipc-contract'
import type { V2Bridge } from '../../types'
import {
  StorageCard,
  StorageCardView,
  storageCleanedText,
  storageRowDescription,
  storageRows,
  storageRowValue,
  storageSizeText,
  storageTotalText,
  type StorageCardViewProps,
} from './StorageCard'

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte

const settled = {
  works: { bytes: 2.1 * gigabyte },
  thumbnails: { bytes: 120 * megabyte },
  'chat-history': { bytes: 35 * megabyte },
  logs: { bytes: 20 * megabyte },
  backups: { bytes: 15 * megabyte, backupCount: 24 },
  downloads: { bytes: 800 * megabyte, installing: false },
} satisfies Record<string, StorageUsagePartReport>

function render(patch: Partial<StorageCardViewProps> = {}) {
  return renderToStaticMarkup(
    <StorageCardView reports={settled} busy="" onOpenWorks={() => undefined} onClean={() => undefined} onAskBackupCleanup={() => undefined} {...patch} />,
  )
}

function rowMarkup(markup: string, part: string): string {
  const start = markup.indexOf(`data-testid="settings-storage-row-${part}"`)
  const next = markup.indexOf('data-testid="settings-storage-row-', start + 1)
  return markup.slice(start, next === -1 ? undefined : next)
}

function button(markup: string, testId: string): string {
  return markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? ''
}

describe('storage card wording (D100, 空间页改)', () => {
  it('writes KB and MB as whole numbers and GB with one decimal', () => {
    expect(storageSizeText(820 * 1024)).toBe('约 820 KB')
    expect(storageSizeText(35 * megabyte)).toBe('约 35 MB')
    expect(storageSizeText(2.1 * gigabyte)).toBe('约 2.1 GB')
    expect(storageSizeText(0)).toBe('约 0 KB')
    expect(storageSizeText(-1)).toBe('约 0 KB')
    // A few bytes are not nothing, and rounding up never reads 1024 of the smaller unit.
    expect(storageSizeText(10)).toBe('约 1 KB')
    expect(storageSizeText(megabyte - 100)).toBe('约 1 MB')
    expect(storageSizeText(gigabyte - 100)).toBe('约 1.0 GB')
  })

  it('says it is still working out a row, could not work it out, or how big it is', () => {
    expect(storageRowValue(undefined)).toBe('正在计算…')
    expect(storageRowValue({ bytes: null })).toBe('无法计算')
    expect(storageRowValue({ bytes: 20 * megabyte })).toBe('约 20 MB')
  })

  it('adds the rows up only once all of them are back, leaving out the ones it could not work out', () => {
    expect(storageTotalText({})).toBe('正在计算…')
    expect(storageTotalText({ ...settled, logs: undefined })).toBe('正在计算…')
    expect(storageTotalText({ ...settled, works: { bytes: 2 * gigabyte }, thumbnails: { bytes: 0.5 * gigabyte }, 'chat-history': { bytes: 0.5 * gigabyte }, logs: { bytes: null }, backups: { bytes: 0.2 * gigabyte }, downloads: { bytes: 0 } })).toBe('共约 3.2 GB')
    const nothing = Object.fromEntries(storageRows.map((row) => [row.part, { bytes: null }]))
    expect(storageTotalText(nothing)).toBe('无法计算')
  })

  it('counts the backups in the row only once it knows how many there are', () => {
    const row = storageRows.find((entry) => entry.part === 'backups')!
    expect(storageRowDescription(row, { bytes: 1, backupCount: 24 })).toBe('修改工具配置前自动保存的配置，共 24 份。')
    expect(storageRowDescription(row, undefined)).toBeNull()
  })

  it('tells how much a clean freed, and when some files were in use', () => {
    expect(storageCleanedText({ freedBytes: 120 * megabyte, kept: 0 })).toBe('已清理，释放约 120 MB。')
    expect(storageCleanedText({ freedBytes: 80 * megabyte, kept: 3 })).toBe('部分文件正被占用，未能删除，已释放约 80 MB。关闭正在使用的工具后可再次清理。')
  })
})

describe('storage card', () => {
  it('shows the approved title, lead and six rows in order with their sizes', () => {
    const markup = render()
    expect(markup).toContain('<h2>星芒占用空间</h2>')
    expect(markup).toContain('星芒在本机保存的内容及占用空间。清理仅删除可重新生成或重新下载的内容，作品和聊天记录不受影响。')
    expect(markup).toContain('data-testid="settings-storage-total">共约 3.1 GB</div>')
    const titles = ['AI 作品', '作品缩略图', '聊天记录', '运行日志', '工具配置备份', '安装工具时下载的文件']
    expect(storageRows.map((row) => row.title)).toEqual(titles)
    const parts = ['works', 'thumbnails', 'chat-history', 'logs', 'backups', 'downloads']
    const positions = parts.map((part) => markup.indexOf(`data-testid="settings-storage-row-${part}"`))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    parts.forEach((part, index) => expect(rowMarkup(markup, part)).toContain(titles[index]))
    expect(markup).toContain('创作中生成的图片、视频和音频。')
    expect(markup).toContain('作品库中的缩略图，删除后查看作品库时将重新生成。')
    expect(markup).toContain('更换电脑时，可通过上方「导出设置和聊天记录」迁移。')
    expect(markup).toContain('供客服排查问题使用。')
    expect(markup).toContain('修改工具配置前自动保存的配置，共 24 份。')
    expect(markup).toContain('安装和更新命令行工具时下载的文件，删除后下次安装时将重新下载。')
    expect(markup).toContain('data-testid="settings-storage-size-works">约 2.1 GB</span>')
    expect(markup).toContain('data-testid="settings-storage-size-downloads">约 800 MB</span>')
  })

  it('gives buttons only to what can be opened or rebuilt, never to chat history or logs', () => {
    const markup = render()
    expect(rowMarkup(markup, 'works')).toContain('打开文件夹')
    expect(rowMarkup(markup, 'thumbnails')).toContain('<span>清理</span></button>')
    expect(rowMarkup(markup, 'backups')).toContain('清理旧备份')
    expect(rowMarkup(markup, 'downloads')).toContain('<span>清理</span></button>')
    expect(rowMarkup(markup, 'chat-history')).not.toContain('<button')
    expect(rowMarkup(markup, 'logs')).not.toContain('<button')
    expect(button(markup, 'settings-storage-clean-backups')).not.toContain('disabled')
    expect(button(markup, 'settings-storage-clean-downloads')).not.toContain('disabled')
  })

  it('greys out 清理旧备份 with a note when only the newest ten are there', () => {
    const markup = render({ reports: { ...settled, backups: { bytes: 4000, backupCount: 10 } } })
    expect(button(markup, 'settings-storage-clean-backups')).toContain('disabled')
    expect(rowMarkup(markup, 'backups')).toContain('仅保留最近 10 份，无需清理')
  })

  it('greys out the download clean with a note while a tool is installing', () => {
    const markup = render({ reports: { ...settled, downloads: { bytes: 0, installing: true } } })
    expect(button(markup, 'settings-storage-clean-downloads')).toContain('disabled')
    expect(rowMarkup(markup, 'downloads')).toContain('正在安装工具，请在安装完成后清理')
  })

  it('says 正在计算… on every row and the total before anything is back, and 无法计算 on a row that failed', () => {
    const pending = render({ reports: {} })
    expect(pending.match(/正在计算…/g)).toHaveLength(7)
    expect(button(pending, 'settings-storage-clean-thumbnails')).toContain('disabled')
    const failed = render({ reports: { ...settled, logs: { bytes: null } } })
    expect(failed).toContain('data-testid="settings-storage-size-logs">无法计算</span>')
  })

  it('starts out working everything out', () => {
    const markup = renderToStaticMarkup(<StorageCard api={{} as V2Bridge} />)
    expect(markup).toContain('data-testid="settings-storage"')
    expect(markup).toContain('data-testid="settings-storage-total">正在计算…</div>')
  })
})
