import type { UpdateSnapshot } from '../../../../electron/ipc-contract'

export interface ReleaseNotesSection {
  title: string
  /** 一条一行显示的改动；为 null 时显示 `text`。 */
  items: readonly string[] | null
  text: string
}

// release-notes.md 里一版的开头只有一行版本号，没有 Markdown 标题（scripts/extract-release-notes.cjs 同一条边界）。
const versionHeading = /^\d+\.\d+\.\d+$/

function isAsciiWordCharacter(character: string | undefined): boolean {
  return /[A-Za-z0-9]/.test(character ?? '')
}

// 续行在源文件里只是为了折行，拼回去时中文之间不该多出空格，英文单词之间则要补一个
// （和 scripts/bundle-release-notes.cjs 装完后那份同一个拼法，两边显示的字一样）。
function joinWrappedLine(previous: string, next: string): string {
  if (!previous) return next
  const needsSpace = isAsciiWordCharacter(previous[previous.length - 1]) && isAsciiWordCharacter(next[0])
  return `${previous}${needsSpace ? ' ' : ''}${next}`
}

function plainText(item: string): string {
  return item.replace(/`([^`\n]+)`/g, '「$1」').replace(/\s+/g, ' ').trim()
}

/**
 * 更新清单带下来的说明拆成一条一行。原来 electron-builder 把整份 release-notes.md 原样写进 latest.yml，
 * 主进程只截前 20000 字：版本卡把这些整段塞进一个 <p>，换行被吃掉，要装的那一版后面还接着前几版的说明，
 * 「重启并安装」被挤到最底（11-10 客户截图）。现在清单只带这一版、不带版本号那一行（scripts/extract-release-notes.cjs
 * 的 feedReleaseNotes），测试包版本号对不上时才照旧整份。
 * 这里只取要装的那一版那一节；找不到这一版就取第一节，一行版本号都没有的当成就是这一版。
 * 一条「- 」开头的都没有时返回 null，照旧整段显示。
 */
export function releaseNoteItems(text: string | null | undefined, version: string | null | undefined): string[] | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const headings = lines.flatMap((line, index) => versionHeading.test(line.trim()) ? [{ version: line.trim(), index }] : [])
  const start = headings.find((heading) => heading.version === version) ?? headings[0]
  const end = start ? headings.find((heading) => heading.index > start.index)?.index ?? lines.length : lines.length
  const body = start ? lines.slice(start.index + 1, end) : lines
  if (!body.some((line) => line.startsWith('- '))) return null
  const items: string[] = []
  for (const rawLine of body) {
    const line = rawLine.trim()
    if (!line) continue
    if (rawLine.startsWith('- ')) items.push(line.slice(2).trim())
    else if (items.length > 0) items[items.length - 1] = joinWrappedLine(items[items.length - 1], line)
    else items.push(line)
  }
  const cleaned = items.map(plainText).filter(Boolean)
  return cleaned.length > 0 ? cleaned : null
}

/**
 * 版本卡上的更新内容说哪一版。有待下载的新版本时说新版本（「v0.3.0 更新内容」，更新清单带下来的说明）；
 * 没有时说正在用的这一版（「v0.2.9 更新了什么」，随包带的说明）——更新装完之后用户最想知道的就是
 * 这版改了什么，而原来这里只会写「暂无更新说明」。
 */
export function releaseNotesSection(update: Pick<UpdateSnapshot, 'availableVersion' | 'currentVersion' | 'releaseNotesText' | 'installedRelease'> | null | undefined): ReleaseNotesSection {
  if (update?.availableVersion) {
    const items = releaseNoteItems(update.releaseNotesText, update.availableVersion)
    return { title: `v${update.availableVersion} 更新内容`, items, text: items ? '' : update.releaseNotesText || '暂无更新说明。' }
  }
  const items = update?.installedRelease?.notes
  if (update?.currentVersion && items?.length) {
    return { title: `v${update.currentVersion} 更新了什么`, items, text: '' }
  }
  return { title: '更新内容', items: null, text: update?.releaseNotesText || '暂无更新说明。' }
}
