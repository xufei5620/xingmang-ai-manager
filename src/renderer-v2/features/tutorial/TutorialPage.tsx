import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ChevronRight, Clock3, Compass, Copy, Search } from 'lucide-react'
import { Button, Card, Empty, PageHead, Pill, SearchInput } from '../../ui'
import type { BusinessActions } from '../../pages-maintenance'
import { tutorialTopicsFor, type TutorialTopic } from '../../registry/tutorials'
import { currentWindowOs, type WindowOs } from '../app/window-os'
import type { V2Page } from '../../types'
import { TutorialIllustration } from './TutorialIllustration'
import { searchWords, splitSearchHits, textHasSearchWord, tutorialMatchesSearch } from './tutorial-search'
import './tutorial.css'

const readingKey = 'xingmang-v2-tutorial-reading'
const groups = [
  { id: 'start', label: '第一次用，先看这里' },
  { id: 'everyday', label: '充值、聊天和画布' },
  { id: 'advanced', label: '更多用法与问题处理' },
] as const

function initialReading(tutorialTopics: readonly TutorialTopic[], topic?: { id: string; query?: string }) {
  const fallback = { selected: 'start', query: '' }
  if (topic) return { selected: tutorialTopics.some(entry => entry.id === topic.id) ? topic.id : 'start', query: topic.query?.slice(0, 200) ?? '' }
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(readingKey)
    if (!raw || raw.length > 2_000) return fallback
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return fallback
    return {
      selected: 'selected' in value && typeof value.selected === 'string' && tutorialTopics.some(topic => topic.id === value.selected) ? value.selected : 'start',
      query: 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 200) : '',
    }
  } catch { return fallback }
}

/** 外壳在自己的内容区里滚，不是整个窗口在滚；吸顶条和「读到第几步」都按这一层算。 */
function scrollParent(element: HTMLElement | null) {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement)
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return node
  return null
}

/**
 * 正在读第几步：开头已经越过 limit 这条线的最后一步；一步都没越过时算第一步。
 * tops 是各步开头离滚动区上沿的距离。滚到底时调用方把 limit 放到滚动区下沿，看得见开头的最后一步就算在读。
 */
export function readingStepAt(tops: readonly number[], limit: number) {
  let reading = 0
  tops.forEach((top, index) => { if (top <= limit) reading = index })
  return reading
}

/** 搜索命中的字加底色；没在搜时原样返回。 */
function Hits({ text, words }: { text: string; words: readonly string[] }) {
  if (!words.length) return <>{text}</>
  return <>{splitSearchHits(text, words).map((part, index) => part.hit ? <mark className="v2-tutorial-hit" key={index}>{part.text}</mark> : part.text)}</>
}

function TutorialExample({ text, firstMessage, words, testId }: { text: string; firstMessage: boolean; words: readonly string[]; testId: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'success' | 'error'>('idle')
  const lifetime = useRef(0)
  const pending = useRef(false)
  useEffect(() => () => { lifetime.current += 1 }, [])
  async function copy() {
    if (pending.current) return
    const ticket = lifetime.current
    pending.current = true
    setStatus('copying')
    try {
      await navigator.clipboard.writeText(text)
      if (ticket === lifetime.current) setStatus('success')
    } catch {
      if (ticket === lifetime.current) setStatus('error')
    } finally { pending.current = false }
  }
  return <div className="v2-tutorial-example">
    <div className="v2-tutorial-example-head"><span>{firstMessage ? '先试着发这句话' : '可以照着用的示例'}</span><Button size="sm" icon={Copy} loading={status === 'copying'} onClick={() => void copy()} testId={testId}>{firstMessage ? '复制这句话' : '复制示例'}</Button></div>
    <pre><Hits text={text} words={words} /></pre>
    {status === 'success' && <p role="status">{firstMessage ? '已复制，粘贴到 Codex 的输入框里即可。' : '已复制，可以粘贴使用了。'}</p>}
    {status === 'error' && <p role="status">没能自动复制，请选中上面的文字，右键复制。</p>}
  </div>
}

export type TutorialPageProps = Omit<BusinessActions, 'navigate'> & {
  /** section 是那一页里要落的分页；外壳按它切，缺省 = 只跳页（旧行为）。 */
  navigate?: (page: V2Page, section?: string) => void
  /**
   * query：从顶部搜索「去教程里搜」过来时带上的字，缺省 = 清空搜索（旧行为）。
   * extra：要展开并翻到的那一条补充说明的标题（技能页「看怎么放」），缺省 = 一条都不展开。
   */
  topic?: { sequence: number; id: string; query?: string; extra?: string }
  /** 哪个系统的教程；缺省按窗口当前的系统（外壳挂载前就写好了）。Linux 有自己的一份。 */
  os?: WindowOs
}

export function TutorialPage({ navigate, openGuide, openHelp, topic, os }: TutorialPageProps) {
  const tutorialTopics = tutorialTopicsFor(os ?? currentWindowOs())
  const [reading, setReading] = useState(() => initialReading(tutorialTopics, topic))
  const [focusExtra, setFocusExtra] = useState(() => topic?.extra ? { title: topic.extra, sequence: topic.sequence } : null)
  // Native details can be closed manually; a new search must reveal its matches again.
  const searchKey = reading.query.trim().toLocaleLowerCase()
  const words = searchWords(reading.query)
  const article = useRef<HTMLElement>(null)
  const head = useRef<HTMLElement>(null)
  const directory = useRef<HTMLElement>(null)
  const topics = tutorialTopics.filter(topic => tutorialMatchesSearch(topic, reading.query))
  const current = topics.find(topic => topic.id === reading.selected) ?? topics[0]
  const currentIndex = current ? topics.indexOf(current) : -1
  const previousTopic = useRef(current?.id)
  // 文章开头滚出去以后，正文顶上吸住一条「第几步，共几步」。点了圆点跳过去的那一步记下来，
  // 滚到底时最后两步可能都到不了顶上，没记的话会亮错一颗。
  const [headHidden, setHeadHidden] = useState(false)
  const [readingStep, setReadingStep] = useState(0)
  const jumped = useRef<{ index: number; scrollTop: number } | null>(null)

  useEffect(() => {
    if (!topic) return
    // The shell keeps this page mounted; each guide request must clear the old search.
    setReading(initialReading(tutorialTopics, topic))
    setFocusExtra(topic.extra ? { title: topic.extra, sequence: topic.sequence } : null)
    article.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [topic])

  useEffect(() => {
    if (previousTopic.current !== current?.id) {
      // Search can replace a long article while focus stays in the sticky directory.
      article.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      previousTopic.current = current?.id
    }
    // 目录跟着翻到正在看的那一篇：只滚目录自己，不动页面。
    const list = directory.current
    const entry = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (list && entry) {
      const top = entry.offsetTop, bottom = top + entry.offsetHeight
      if (top < list.scrollTop) list.scrollTop = Math.max(0, top - 8)
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8
    }
  }, [current?.id])

  // 搜索时翻到第一处命中：命中的字带底色，含这个词的补充说明已经展开。
  useEffect(() => {
    if (!searchKey) return
    article.current?.querySelector('mark.v2-tutorial-hit')?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [searchKey, current?.id])

  useEffect(() => {
    if (!focusExtra || searchKey) return
    const target = [...(article.current?.querySelectorAll<HTMLElement>('details[data-extra-title]') ?? [])].find(note => note.dataset.extraTitle === focusExtra.title)
    target?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [focusExtra, current?.id, searchKey])

  useEffect(() => {
    setReadingStep(0)
    jumped.current = null
    const container = scrollParent(article.current)
    if (!container) return
    const pane = container
    let frame = 0
    function measure() {
      frame = 0
      const header = head.current
      if (!header) return
      const top = pane.getBoundingClientRect().top
      setHeadHidden(header.getBoundingClientRect().bottom <= top)
      const pinned = jumped.current
      if (pinned && Math.abs(pane.scrollTop - pinned.scrollTop) < 2) return setReadingStep(pinned.index)
      jumped.current = null
      const steps = [...(article.current?.querySelectorAll<HTMLElement>('.v2-tutorial-steps > li') ?? [])]
      const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
      // 细条约 36 高，一步的开头越过细条下面一点就算读到这一步；跳过去的落点（scroll-margin-top）在这条线以内。
      setReadingStep(readingStepAt(steps.map(step => step.getBoundingClientRect().top - top), atEnd ? pane.clientHeight - 1 : 60))
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    pane.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      pane.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [current?.id])

  useEffect(() => {
    try { window.sessionStorage.setItem(readingKey, JSON.stringify(reading)) } catch { /* Reading remains usable without storage. */ }
  }, [reading])

  function search(query: string) {
    setReading(value => ({ ...value, query: query.slice(0, 200) }))
    // 从技能页点进来翻到的那条补充说明，一开始搜索就作废：清空搜索时不再跳回去。
    setFocusExtra(null)
  }

  function selectTopic(id: string, focusArticle = false) {
    setReading(value => ({ ...value, selected: id }))
    setFocusExtra(null)
    // The application scrolls inside its content pane, not the browser window.
    article.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
    if (focusArticle) article.current?.focus({ preventScroll: true })
  }

  function jumpToStep(index: number) {
    if (!current) return
    document.getElementById(`tutorial-${current.id}-step-${index}`)?.scrollIntoView({ block: 'start', behavior: 'instant' })
    const pane = scrollParent(article.current)
    jumped.current = pane ? { index, scrollTop: pane.scrollTop } : null
    setReadingStep(index)
  }

  const support = openHelp && <Button onClick={openHelp} testId="tutorial-contact-support">联系客服</Button>
  const step = current?.steps[readingStep]

  return <section className="v2-page v2-tutorial" data-page-id="tutorial" data-testid="page-tutorial">
    <PageHead title="教程" lead="先让 Codex 回你一句话。跟着第一篇做，不用先学专业词。" actions={openGuide && <Button icon={Compass} onClick={openGuide} testId="tutorial-open-guide">打开新手引导</Button>} />
    <div className="v2-tutorial-layout">
      <aside className="v2-tutorial-directory" ref={directory}>
        <SearchInput value={reading.query} onChange={search} label="搜索教程" placeholder="搜问题，如打不开、充值…" testId="tutorial-search" />
        <nav aria-label="教程目录">
          {groups.map(group => {
            const entries = topics.filter(topic => topic.category === group.id)
            if (!entries.length) return null
            const buttons = entries.map(topic => <button type="button" key={topic.id} data-testid={`tutorial-topic-${topic.id}`} aria-current={topic.id === current?.id ? 'page' : undefined} onClick={() => selectTopic(topic.id)}>
                {topic.title}
              </button>)
            return group.id === 'start' ? <div className="v2-tutorial-group" key={group.id}><p>{group.label}</p>{buttons}</div>
              : <details className="v2-tutorial-group v2-tutorial-group-more" key={`${group.id}:${searchKey}`} open={Boolean(searchKey) || current?.category === group.id} data-testid={`tutorial-group-${group.id}`}>
                <summary><ChevronRight size={15} aria-hidden="true" /><span>{group.label}</span></summary>{buttons}
              </details>
          })}
        </nav>
        <p className="v2-tutorial-search-count" role="status">{reading.query.trim() ? `找到 ${topics.length} 篇教程` : '先看第一篇，其他内容用到时再看。'}</p>
        {reading.query && current && <Button variant="ghost" size="sm" onClick={() => setReading(value => ({ ...value, query: '' }))}>清除搜索</Button>}
      </aside>
      {current ? <article ref={article} className="v2-tutorial-article" tabIndex={-1} aria-labelledby="tutorial-article-title" data-testid="tutorial-article">
        <header className="v2-tutorial-article-head" ref={head}>
          <div className="v2-tutorial-meta"><Pill tone="accent">{groups.find(group => group.id === current.category)?.label}</Pill><span><Clock3 size={14} aria-hidden="true" />约 {current.minutes} 分钟 · {current.steps.length} 步</span></div>
          <h2 id="tutorial-article-title"><Hits text={current.title} words={words} /></h2>
          <p><Hits text={current.lead} words={words} /></p>
          <div className="v2-tutorial-step-links" aria-label="本篇步骤">
            {current.steps.map((step, index) => <a key={step.title} href={`#tutorial-${current.id}-step-${index}`} onClick={() => jumpToStep(index)}><span>{index + 1}</span>{step.title}</a>)}
          </div>
        </header>
        {step && <nav className="v2-tutorial-progress" aria-label="读到第几步" hidden={!headHidden} data-testid="tutorial-progress">
          <span>第 {readingStep + 1} 步，共 {current.steps.length} 步 · {step.title}</span>
          <span className="v2-tutorial-progress-dots">{current.steps.map((entry, index) => <button type="button" key={entry.title} aria-label={`第 ${index + 1} 步：${entry.title}`} aria-current={index === readingStep ? 'step' : undefined} onClick={() => jumpToStep(index)}>{index + 1}</button>)}</span>
        </nav>}
        <ol className="v2-tutorial-steps">
          {current.steps.map((step, index) => <li id={`tutorial-${current.id}-step-${index}`} key={`${current.id}:${index}`}>
            <div className="v2-tutorial-step-title"><span aria-hidden="true">{index + 1}</span><h3><Hits text={step.title} words={words} /></h3></div>
            <div className="v2-tutorial-step-body">
              {step.where && <p className="v2-tutorial-where"><strong>在哪里</strong><span><Hits text={step.where} words={words} /></span></p>}
              <p><Hits text={step.detail} words={words} /></p>
              {step.bullets && <ol className="v2-tutorial-instructions">{step.bullets.map(bullet => <li key={bullet}><Hits text={bullet} words={words} /></li>)}</ol>}
              {step.illustration && <TutorialIllustration kind={step.illustration} />}
              {step.example && <TutorialExample text={step.example} firstMessage={current.id === 'start'} words={words} testId={`tutorial-${current.id}-copy-${index}`} />}
              {step.expected && <div className="v2-tutorial-expected"><CheckCircle2 size={17} aria-hidden="true" /><p><strong>看到这样，就做好了</strong><Hits text={step.expected} words={words} /></p></div>}
              {step.tip && <p className="v2-tutorial-tip"><strong>小提醒：</strong><Hits text={step.tip} words={words} /></p>}
              {navigate && <Button size="sm" iconRight={ArrowRight} onClick={() => navigate(step.page, step.section)} testId={`tutorial-${current.id}-action-${index}`}>{step.action}</Button>}
              {/* 搜索时只展开含这个词的补充说明；从别处点「看怎么放」过来时只展开指名的那一条。 */}
              {step.extra?.map(note => <details className="v2-tutorial-extra" key={`${note.title}:${searchKey}:${focusExtra?.sequence ?? 0}`} data-extra-title={note.title}
                open={searchKey ? textHasSearchWord(`${note.title} ${note.detail}`, words) : focusExtra?.title === note.title}>
                <summary><Hits text={note.title} words={words} /></summary><p><Hits text={note.detail} words={words} /></p>
              </details>)}
            </div>
          </li>)}
        </ol>
        {current.reminders && <aside className="v2-tutorial-reminders"><strong>用之前，记住这两点</strong><ul>{current.reminders.map(note => <li key={note}><Hits text={note} words={words} /></li>)}</ul></aside>}
        <footer className="v2-tutorial-footer">
          {currentIndex > 0 ? <Button icon={ArrowLeft} onClick={() => selectTopic(topics[currentIndex - 1].id, true)}>上一篇：{topics[currentIndex - 1].title}</Button> : <span><BookOpen size={16} aria-hidden="true" />看完就去试一次，随时回来继续。</span>}
          {currentIndex + 1 < topics.length && <Button iconRight={ArrowRight} onClick={() => selectTopic(topics[currentIndex + 1].id, true)}>下一篇：{topics[currentIndex + 1].title}</Button>}
        </footer>
        {openHelp && <div className="v2-tutorial-support" data-testid="tutorial-support"><span>还是不会？</span><Button variant="ghost" size="sm" onClick={openHelp}>联系客服</Button></div>}
      </article> : <Card><Empty icon={Search} title="没找到相关教程" description="换个说法试试，例如「安装」「登录」「收不到回复」。" action={<><Button onClick={() => setReading({ selected: 'start', query: '' })}>清除搜索</Button>{support}</>} testId="tutorial-empty" /></Card>}
    </div>
  </section>
}
