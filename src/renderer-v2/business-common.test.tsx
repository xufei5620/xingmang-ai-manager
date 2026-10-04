import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListState, RelativeTime, ResultNotice, relativeTimeText, resultNoticeLead } from './business-common'

describe('renderer-v2 result notice', () => {
  it('leads with the catalog wording and keeps the backend sentence for support', () => {
    const raw = 'Grok CLI 安装失败：EBUSY: resource busy or locked'
    const markup = renderToStaticMarkup(<ResultNotice error={raw} />)
    // EBUSY 是文件被占用，不是杀毒拦截：这一句要把用户送去关工具窗口。
    expect(markup).toContain('工具正在运行')
    expect(markup).toContain('先关掉正在使用这个工具的窗口')
    expect(markup).toContain(raw)
  })

  it('leaves a failure the catalog cannot name exactly as the backend wrote it', () => {
    const raw = '请先准备 Node.js 运行环境，再安装命令行工具。'
    expect(renderToStaticMarkup(<ResultNotice error={raw} />)).toContain(raw)
  })

  it('names the failure from the original it folded away, without showing the original', () => {
    // useOperation 把带路径的英文换成通用兜底句以后，标题要靠原话认出来（第三十批 A）。
    const shown = '操作没有成功，请重试；还不行，到「反馈」页把报告发给客服。'
    const original = "EBUSY: resource busy or locked, rename '本地配置文件 -> '本地配置文件"
    const markup = renderToStaticMarkup(<ResultNotice error={shown} detail={original} />)
    expect(markup).toContain('工具正在运行')
    expect(markup).toContain(shown)
    expect(markup).not.toContain('EBUSY')
    expect(renderToStaticMarkup(<ResultNotice error={shown} detail="" />)).not.toContain('<strong>')
  })

  it('lets the shown sentence decide before the folded original', () => {
    const markup = renderToStaticMarkup(<ResultNotice error="Grok CLI 安装失败：ENOSPC: no space left on device" detail="EBUSY: resource busy or locked" />)
    expect(markup).toContain('磁盘空间不够')
    expect(markup).not.toContain('工具正在运行')
  })

  it('offers to reveal an exported file only when the page can act on it', () => {
    const exported = renderToStaticMarkup(
      <ResultNotice
        message="诊断报告已导出：C:\\Users\\a\\report.txt"
        revealPath="C:\\Users\\a\\report.txt"
        onReveal={async () => true}
      />,
    )
    expect(exported).toContain('打开所在位置')
    expect(exported).toContain('data-testid="result-notice-reveal"')
    // Spread from useOperation on a page that never wired onReveal: no dead button.
    expect(renderToStaticMarkup(
      <ResultNotice message="已导出" revealPath="C:\\report.txt" />,
    )).not.toContain('打开所在位置')
    expect(renderToStaticMarkup(
      <ResultNotice error="导出失败" revealPath="C:\\report.txt" onReveal={async () => true} />,
    )).not.toContain('打开所在位置')
  })

  it('offers support in plain words when the plugin catalog backups cannot be cleared', () => {
    const raw = 'Codex 插件目录里的旧备份清不掉，这次没有改动'
    const markup = renderToStaticMarkup(<ResultNotice error={raw} onSupport={() => undefined} />)
    expect(markup).toContain('插件目录暂时改不动')
    expect(markup).toContain('重启电脑后再试一次')
    expect(markup).toContain('data-testid="result-notice-support"')
    expect(markup).not.toContain('plugins-xingmang-backup')
    // A page that cannot open help, or a failure support cannot help with: no button.
    expect(renderToStaticMarkup(<ResultNotice error={raw} />)).not.toContain('result-notice-support')
    expect(renderToStaticMarkup(
      <ResultNotice error="Grok CLI 安装失败：EBUSY: resource busy or locked" onSupport={() => undefined} />,
    )).not.toContain('result-notice-support')
  })

  it('still renders success on its own', () => {
    const markup = renderToStaticMarkup(<ResultNotice message="工具已卸载" />)
    expect(markup).toContain('工具已卸载')
    expect(markup).toContain('已完成')
  })
})

// 安装卸载页没装上的那一行，名字下面写的就是红框领头的这一句。
describe('renderer-v2 result notice lead', () => {
  it('leads with the title the red banner shows when the catalog knows the failure', () => {
    const error = 'Gemini CLI 安装失败：npm 官方源：EPERM: operation not permitted, mkdir'
    expect(resultNoticeLead(error)).toBe('写不进安装目录')
    expect(renderToStaticMarkup(<ResultNotice error={error} />)).toContain('<strong>写不进安装目录</strong>')
  })

  it('falls back to the sentence itself when the catalog does not know it', () => {
    expect(resultNoticeLead('这一步没做完')).toBe('这一步没做完')
  })
})

describe('renderer-v2 relative time', () => {
  const now = new Date(2026, 9, 4, 15, 0).getTime()

  it('writes list times like the home page and keeps the full time on hover', () => {
    const value = new Date(2026, 9, 3, 9, 12)
    const markup = renderToStaticMarkup(<RelativeTime value={value.toISOString()} now={now} />)
    expect(markup).toContain('>昨天 09:12</time>')
    expect(markup).toContain(`title="${value.toLocaleString('zh-CN', { hour12: false })}"`)
    expect(markup).toContain(`dateTime="${value.toISOString()}"`)
  })

  it('reads unix seconds the way the session list sends them', () => {
    const seconds = new Date(2026, 8, 28, 20, 0).getTime() / 1000
    expect(renderToStaticMarkup(<RelativeTime value={seconds} now={now} />)).toContain('>9月28日</time>')
    expect(renderToStaticMarkup(<RelativeTime value={new Date(2025, 8, 28).getTime() / 1000} now={now} />)).toContain('>2025年9月28日</time>')
  })

  it('keeps the old wording when the time is missing or unreadable', () => {
    expect(renderToStaticMarkup(<RelativeTime value={null} now={now} />)).toBe('暂未记录')
    expect(renderToStaticMarkup(<RelativeTime value="not a date" now={now} />)).toBe('时间不可用')
  })

  // 备份页按列表上看到的字搜，搜的那份字和 RelativeTime 画出来的必须是同一句。
  it('gives the same words as text that the list shows', () => {
    for (const value of [new Date(2026, 9, 3, 9, 12).toISOString(), new Date(2026, 8, 28, 20, 0).getTime() / 1000, null, 'not a date']) {
      const markup = renderToStaticMarkup(<RelativeTime value={value} now={now} />)
      expect(markup.replace(/<[^>]+>/g, '')).toBe(relativeTimeText(value, now))
    }
  })
})

describe('renderer-v2 list empty states', () => {
  function emptyList(props: { filtered?: boolean; query?: string; action?: ReactNode }) {
    return renderToStaticMarkup(<ListState page="backups" noun="备份" loading={false} error="" count={0} retry={() => undefined} clear={() => undefined} {...props}>{null}</ListState>)
  }

  it('names the words that found nothing and offers to clear the search', () => {
    const markup = emptyList({ filtered: true, query: ' zzz ' })
    expect(markup).toContain('没有找到「zzz」')
    expect(markup).toContain('换个词试试。')
    expect(markup).toContain('>清除搜索<')
    expect(markup).not.toContain('清空筛选')
  })

  it('keeps the filter wording when only a range filter is set', () => {
    const markup = emptyList({ filtered: true, query: '' })
    expect(markup).toContain('没有符合条件的结果')
    expect(markup).toContain('>清空筛选<')
  })

  // 每处空着时说自己的去处，不再都是「从页面上的添加入口开始。」
  it('lets a page name its own empty title and next step', () => {
    const markup = renderToStaticMarkup(<ListState page="health" noun="检查结果" emptyDescription="点右上角「重新检查」。" loading={false} error="" count={0} retry={() => undefined}>{null}</ListState>)
    expect(markup).toContain('还没有检查结果')
    expect(markup).toContain('点右上角「重新检查」。')
    expect(markup).not.toContain('从页面上的添加入口开始。')
    const titled = renderToStaticMarkup(<ListState page="mcp" noun="外接工具" emptyTitle="还没有添加连接" loading={false} error="" count={0} retry={() => undefined}>{null}</ListState>)
    expect(titled).toContain('还没有添加连接')
    expect(titled).not.toContain('还没有外接工具')
  })

  it('lets a page say what to do when the list could not be read', () => {
    const markup = renderToStaticMarkup(<ListState page="feedback" noun="运行日志" errorDescription="点「重新加载」再试；还不行，点「打开日志目录」直接看日志文件。" loading={false} error="操作没有成功，请重试或查看反馈日志。" count={0} retry={() => undefined}>{null}</ListState>)
    expect(markup).toContain('运行日志暂时没有读到')
    expect(markup).toContain('点「重新加载」再试；还不行，点「打开日志目录」直接看日志文件。')
    expect(markup).not.toContain('请重试或查看反馈日志')
    expect(markup).toContain('>重新加载<')
  })

  it('puts the empty state buttons side by side in one row', () => {
    const markup = emptyList({ action: <><button type="button">添加</button><button type="button">看看精选</button></> })
    expect(markup).toContain('<div class="xm-empty-actions"><button type="button">添加</button><button type="button">看看精选</button></div>')
  })
})
