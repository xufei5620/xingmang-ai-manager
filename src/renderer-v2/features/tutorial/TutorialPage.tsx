import { useEffect, useId, useRef, useState } from 'react'
import { AppWindow, Archive, ArrowLeft, ArrowLeftRight, ArrowRight, BookOpen, CheckCircle2, ChevronLeft, Clock, Clock3, Code2, Compass, Copy, CreditCard, Download, Globe2, InfinityIcon, Laptop, LifeBuoy, MessageSquare, MessageSquareWarning, Package, Plug, Rocket, Search, SlidersHorizontal, Sparkles, Terminal, type LucideIcon } from 'lucide-react'
import { Button, Card, Chips, Empty, PageHead, Pill, SearchInput } from '../../ui'
import type { BusinessActions } from '../../pages-maintenance'
import { tutorialCategories, tutorialTopicsFor, type TutorialCategoryFilter, type TutorialTopic } from '../../registry/tutorials'
import { useLatestRequest } from '../../latest-request'
import { currentWindowOs, type WindowOs } from '../app/window-os'
import type { V2Page } from '../../types'
import { TutorialIllustration } from './TutorialIllustration'
import { searchWords, splitSearchHits, textHasSearchWord, tutorialMatchesSearch } from './tutorial-search'
import { buildTutorialCardState, getTutorialProgressStorage, readTutorialProgress, recordTutorialProgress } from './tutorial-progress'
import './tutorial.css'

const viewKey = 'xingmang-v2-tutorial-reading'

// 卡片左上角的小图标，一篇一个；新加一篇忘了配，测试会红，书本只是兜底。
export const tutorialIcons: Readonly<Partial<Record<string, LucideIcon>>> = {
  start: Rocket, install: Download, config: SlidersHorizontal, 'switch-account': ArrowLeftRight, launch: AppWindow,
  account: CreditCard, chat: MessageSquare, sessions: Clock, canvas: InfinityIcon, acceleration: Globe2,
  cli: Terminal, mcp: Plug, skills: Sparkles, plugins: Package, safety: Archive,
  'runtime-mac': Code2, 'mac-desktop-apps': Laptop, messages: MessageSquareWarning, trouble: LifeBuoy,
}

interface TutorialView {
  /** 正在读的那一篇；null = 卡片列表。 */
  open: string | null
  query: string
  category: TutorialCategoryFilter
}

function isTutorialCategory(value: unknown): value is TutorialCategoryFilter {
  return tutorialCategories.some(entry => entry.value === value)
}

function initialView(tutorialTopics: readonly TutorialTopic[], topic?: { id: string; query?: string }): TutorialView {
  const fallback: TutorialView = { open: null, query: '', category: 'all' }
  // 顶部搜索「去教程里搜」带着字过来：停在卡片列表上搜；只指名一篇（命令面板、安装指南）就直接打开那一篇。
  if (topic) return topic.query !== undefined ? { ...fallback, query: topic.query.slice(0, 200) }
    : { ...fallback, open: tutorialTopics.some(entry => entry.id === topic.id) ? topic.id : null }
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(viewKey)
    if (!raw || raw.length > 2_000) return fallback
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return fallback
    return {
      open: 'open' in value && typeof value.open === 'string' && tutorialTopics.some(topic => topic.id === value.open) ? value.open : null,
      query: 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 200) : '',
      category: 'category' in value && isTutorialCategory(value.category) ? value.category : 'all',
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
  const lifetime = useLatestRequest()
  const pending = useRef(false)
  async function copy() {
    if (pending.current) return
    const ticket = lifetime.capture()
    pending.current = true
    setStatus('copying')
    try {
      await navigator.clipboard.writeText(text)
      if (ticket()) setStatus('success')
    } catch {
      if (ticket()) setStatus('error')
    } finally { pending.current = false }
  }
  return <div className="v2-tutorial-example">
    <div className="v2-tutorial-example-head"><span>{firstMessage ? '先试着发这句话' : '可以照着用的示例'}</span><Button size="sm" icon={Copy} loading={status === 'copying'} onClick={() => void copy()} testId={testId}>{firstMessage ? '复制这句话' : '复制示例'}</Button></div>
    <pre><Hits text={text} words={words} /></pre>
    {status === 'success' && <p role="status">{firstMessage ? '已复制，粘贴到 Codex 的输入框里即可。' : '已复制，可以粘贴使用了。'}</p>}
    {status === 'error' && <p role="status">没能自动复制，请选中上面的文字，右键复制。</p>}
  </div>
}

function TutorialCard({ topic, done, lead, words, onOpen }: { topic: TutorialTopic; done: number; lead: boolean; words: readonly string[]; onOpen: (id: string, step: number) => void }) {
  const titleId = useId()
  const state = buildTutorialCardState(done, topic.steps.length, topic.minutes)
  const Icon = tutorialIcons[topic.id] ?? BookOpen
  return <section className={lead ? 'v2-tutorial-card is-lead' : 'v2-tutorial-card'} aria-labelledby={titleId} data-testid={`tutorial-card-${topic.id}`}>
    <div className="v2-tutorial-card-head">
      <span className="v2-tutorial-tile" aria-hidden="true"><Icon size={18} /></span>
      <div><h2 id={titleId}><Hits text={topic.title} words={words} /></h2><p><Hits text={topic.lead} words={words} /></p></div>
    </div>
    {/* 进度条只是把下面那句「已完成 k / n 步」画出来，读屏读那句就够了。 */}
    <div className="v2-tutorial-card-steps" aria-hidden="true">{topic.steps.map((step, index) => <i key={step.title} className={index < done ? 'is-done' : undefined} />)}</div>
    <div className="v2-tutorial-card-foot">
      <span>{state.text}</span>
      <Button size="sm" variant={lead && state.action !== '再看一遍' ? 'primary' : 'secondary'} aria-describedby={titleId} onClick={() => onOpen(topic.id, state.resumeAt)} testId={`tutorial-topic-${topic.id}`}>{state.action}</Button>
    </div>
  </section>
}

export type TutorialPageProps = Omit<BusinessActions, 'navigate'> & {
  /** section 是那一页里要落的分页；外壳按它切，缺省 = 只跳页（旧行为）。 */
  navigate?: (page: V2Page, section?: string) => void
  /**
   * query：从顶部搜索「去教程里搜」过来时带上的字，停在卡片列表上搜；缺省 = 直接打开 id 那一篇。
   * extra：要展开并翻到的那一条补充说明的标题（外壳 navigate 的 section 带 #），缺省 = 一条都不展开。
   */
  topic?: { sequence: number; id: string; query?: string; extra?: string }
  /** 哪个系统的教程；缺省按窗口当前的系统（外壳挂载前就写好了）。Linux 有自己的一份。 */
  os?: WindowOs
}

export function TutorialPage({ navigate, openGuide, openHelp, topic, os }: TutorialPageProps) {
  const tutorialTopics = tutorialTopicsFor(os ?? currentWindowOs())
  const [view, setView] = useState(() => initialView(tutorialTopics, topic))
  const [focusExtra, setFocusExtra] = useState(() => topic?.extra ? { title: topic.extra, sequence: topic.sequence } : null)
  const [progress, setProgress] = useState(() => readTutorialProgress(getTutorialProgressStorage(), tutorialTopics))
  // Native details can be closed manually; a new search must reveal its matches again.
  const searchKey = view.query.trim().toLocaleLowerCase()
  const words = searchWords(view.query)
  const page = useRef<HTMLElement>(null)
  const article = useRef<HTMLElement>(null)
  const head = useRef<HTMLElement>(null)
  const matching = tutorialTopics.filter(entry => tutorialMatchesSearch(entry, view.query))
  const topics = view.category === 'all' ? matching : matching.filter(entry => entry.category === view.category)
  const current = view.open === null ? undefined : tutorialTopics.find(entry => entry.id === view.open)
  // 上一篇、下一篇在点进来的那一组里走；从别处直接打开的、或者这一篇不在当前筛选里，就在全部教程里走。
  const sequence = current && topics.includes(current) ? topics : tutorialTopics
  const currentIndex = current ? sequence.indexOf(current) : -1
  const shownTopic = useRef(current?.id)
  // 点卡片打开时要翻到的那一步（「继续」落在没读完的第一步）；从别的页指名打开时不抢焦点。
  const opening = useRef<{ step: number; focus: boolean } | null>(null)
  // 回到卡片列表时，焦点放回刚才读的那一张卡片的按钮上。
  const returnTo = useRef<string | null>(null)
  // 文章开头滚出去以后，正文顶上吸住一条「第几步，共几步」。点了圆点跳过去的那一步记下来，
  // 滚到底时最后两步可能都到不了顶上，没记的话会亮错一颗。
  const [headHidden, setHeadHidden] = useState(false)
  const [readingStep, setReadingStep] = useState(0)
  const jumped = useRef<{ index: number; scrollTop: number } | null>(null)

  useEffect(() => {
    if (!topic) return
    // The shell keeps this page mounted; each guide request must clear the old search.
    opening.current = { step: 0, focus: false }
    setView(initialView(tutorialTopics, topic))
    setFocusExtra(topic.extra ? { title: topic.extra, sequence: topic.sequence } : null)
    scrollParent(page.current)?.scrollTo({ top: 0, behavior: 'instant' })
  }, [topic])

  useEffect(() => {
    if (shownTopic.current === current?.id) return
    shownTopic.current = current?.id
    const pane = scrollParent(page.current)
    if (current) {
      const request = opening.current
      opening.current = null
      const target = request?.step ? document.getElementById(`tutorial-${current.id}-step-${request.step}`) : null
      if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' })
      else pane?.scrollTo({ top: 0, behavior: 'instant' })
      // 点卡片的那颗按钮跟着列表一起没了，焦点交给文章，键盘和读屏从标题接着往下读。
      if (request?.focus) article.current?.focus({ preventScroll: true })
      return
    }
    const card = returnTo.current ? page.current?.querySelector<HTMLElement>(`[data-testid="tutorial-topic-${returnTo.current}"]`) : null
    returnTo.current = null
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'instant' })
      card.focus({ preventScroll: true })
    } else pane?.scrollTo({ top: 0, behavior: 'instant' })
  }, [current?.id])

  // 搜索时翻到第一处命中：命中的字带底色，含这个词的补充说明已经展开。
  useEffect(() => {
    if (!searchKey || !current) return
    article.current?.querySelector('mark.v2-tutorial-hit')?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [searchKey, current?.id])

  useEffect(() => {
    if (!focusExtra || searchKey) return
    const target = [...(article.current?.querySelectorAll<HTMLElement>('details[data-extra-title]') ?? [])].find(note => note.dataset.extraTitle === focusExtra.title)
    target?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [focusExtra, current?.id, searchKey])

  useEffect(() => {
    setReadingStep(0)
    setHeadHidden(false)
    jumped.current = null
    const container = scrollParent(article.current)
    if (!current || !container) return
    const pane = container
    const reading = current
    let frame = 0
    function measure() {
      frame = 0
      const header = head.current
      if (!header) return
      const top = pane.getBoundingClientRect().top
      setHeadHidden(header.getBoundingClientRect().bottom <= top)
      const pinned = jumped.current
      if (pinned && Math.abs(pane.scrollTop - pinned.scrollTop) < 2) {
        setReadingStep(pinned.index)
        markRead(reading, pinned.index)
        return
      }
      jumped.current = null
      const steps = [...(article.current?.querySelectorAll<HTMLElement>('.v2-tutorial-steps > li') ?? [])]
      const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
      // 细条约 36 高，一步的开头越过细条下面一点就算读到这一步；跳过去的落点（scroll-margin-top）在这条线以内。
      const index = readingStepAt(steps.map(step => step.getBoundingClientRect().top - top), atEnd ? pane.clientHeight - 1 : 60)
      setReadingStep(index)
      // 读到第几步，它前面那几步就算读完了；真往下滚到了底才算整篇读完，刚打开、一下都没滚时不算。
      markRead(reading, atEnd && pane.scrollTop > 0 ? reading.steps.length : index)
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
    try { window.sessionStorage.setItem(viewKey, JSON.stringify(view)) } catch { /* Reading remains usable without storage. */ }
  }, [view])

  function markRead(entry: TutorialTopic, done: number) {
    setProgress(value => recordTutorialProgress(getTutorialProgressStorage(), value, entry, done))
  }

  function search(query: string) {
    setView(value => ({ ...value, query: query.slice(0, 200) }))
    // 从技能页点进来翻到的那条补充说明，一开始搜索就作废：清空搜索时不再跳回去。
    setFocusExtra(null)
  }

  function filter(category: string) {
    if (isTutorialCategory(category)) setView(value => ({ ...value, category }))
  }

  function openTopic(id: string, step = 0) {
    opening.current = { step, focus: true }
    setView(value => ({ ...value, open: id }))
    setFocusExtra(null)
  }

  function closeTopic() {
    returnTo.current = current?.id ?? null
    setView(value => ({ ...value, open: null }))
    setFocusExtra(null)
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
  const categoryLabel = current && tutorialCategories.find(entry => entry.value === current.category)?.label
  const lead = view.category === 'all' && !searchKey

  return <section ref={page} className="v2-page v2-tutorial" data-page-id="tutorial" data-testid="page-tutorial">
    <PageHead title="教程" actions={openGuide && <Button icon={Compass} onClick={openGuide} testId="tutorial-open-guide">打开新手引导</Button>} />
    {current ? <>
      <button type="button" className="v2-tutorial-back" onClick={closeTopic} data-testid="tutorial-back"><ChevronLeft size={14} aria-hidden="true" />全部教程</button>
      <article ref={article} className="v2-tutorial-article" tabIndex={-1} aria-labelledby="tutorial-article-title" data-testid="tutorial-article">
        <header className="v2-tutorial-article-head" ref={head}>
          <div className="v2-tutorial-meta"><Pill tone="accent">{categoryLabel}</Pill><span><Clock3 size={14} aria-hidden="true" />{current.steps.length} 步，约 {current.minutes} 分钟</span></div>
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
              {/* 搜索时只展开含这个词的补充说明；从别处指名某一条过来时只展开那一条。 */}
              {step.extra?.map(note => <details className="v2-tutorial-extra" key={`${note.title}:${searchKey}:${focusExtra?.sequence ?? 0}`} data-extra-title={note.title}
                open={searchKey ? textHasSearchWord(`${note.title} ${note.detail}`, words) : focusExtra?.title === note.title}>
                <summary><Hits text={note.title} words={words} /></summary><p><Hits text={note.detail} words={words} /></p>
              </details>)}
            </div>
          </li>)}
        </ol>
        {current.reminders && <aside className="v2-tutorial-reminders"><strong>用之前，记住这两点</strong><ul>{current.reminders.map(note => <li key={note}><Hits text={note} words={words} /></li>)}</ul></aside>}
        <footer className="v2-tutorial-footer">
          {currentIndex > 0 ? <Button icon={ArrowLeft} onClick={() => openTopic(sequence[currentIndex - 1].id)}>上一篇：{sequence[currentIndex - 1].title}</Button> : <span><BookOpen size={16} aria-hidden="true" />看完就去试一次，随时回来继续。</span>}
          {currentIndex + 1 < sequence.length && <Button iconRight={ArrowRight} onClick={() => openTopic(sequence[currentIndex + 1].id)}>下一篇：{sequence[currentIndex + 1].title}</Button>}
        </footer>
        {openHelp && <div className="v2-tutorial-support" data-testid="tutorial-support"><span>还是不会？</span><Button variant="ghost" size="sm" onClick={openHelp}>联系客服</Button></div>}
      </article>
    </> : <>
      <div className="v2-tutorial-filter">
        <Chips label="按类别筛选" value={view.category} onChange={filter} testId="tutorial-categories"
          options={tutorialCategories.map(entry => ({ value: entry.value, label: entry.label, count: entry.value === 'all' ? matching.length : matching.filter(topic => topic.category === entry.value).length, testId: `tutorial-group-${entry.value}` }))} />
        <SearchInput value={view.query} onChange={search} label="搜索教程" placeholder="搜索教程，比如「切换账号」" testId="tutorial-search" />
      </div>
      {topics.length ? <div className="v2-tutorial-grid" data-testid="tutorial-cards">
        {topics.map((entry, index) => <TutorialCard key={entry.id} topic={entry} done={progress[entry.id] ?? 0} lead={lead && index === 0} words={words} onOpen={openTopic} />)}
      </div> : <Card><Empty icon={Search} title="没有找到相关教程" description="换个说法试试，或者直接问客服。" action={<><Button onClick={() => search('')}>清除搜索</Button>{support}</>} testId="tutorial-empty" /></Card>}
    </>}
  </section>
}
