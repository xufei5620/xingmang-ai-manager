import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ChevronRight, Clock3, Compass, Copy, Search } from 'lucide-react'
import { Button, Card, Empty, PageHead, Pill, SearchInput } from '../../ui'
import type { BusinessActions } from '../../pages-maintenance'
import { tutorialTopics, type TutorialTopic } from '../../registry/tutorials'
import { TutorialIllustration } from './TutorialIllustration'
import './tutorial.css'

const readingKey = 'xingmang-v2-tutorial-reading'
const groups = [
  { id: 'start', label: '第一次用，先看这里' },
  { id: 'everyday', label: '充值、聊天和画布' },
  { id: 'advanced', label: '更多用法与问题处理' },
] as const

function initialReading() {
  const fallback = { selected: 'start', query: '' }
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

function matchesSearch(topic: TutorialTopic, query: string) {
  const text = [topic.title, topic.lead, ...topic.keywords, ...(topic.reminders ?? []), ...topic.steps.flatMap(step => [
    step.title, step.detail, step.where ?? '', step.expected ?? '', step.tip ?? '', step.example ?? '', ...(step.bullets ?? []),
    ...(step.extra ?? []).flatMap(note => [note.title, note.detail]),
  ])].join(' ').toLocaleLowerCase()
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word))
}

function TutorialExample({ text, firstMessage, testId }: { text: string; firstMessage: boolean; testId: string }) {
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
    <pre>{text}</pre>
    {status === 'success' && <p role="status">{firstMessage ? '已复制，粘贴到 Codex 的输入框里即可。' : '已复制，可以粘贴使用了。'}</p>}
    {status === 'error' && <p role="status">没能自动复制，请选中上面的文字，右键复制。</p>}
  </div>
}

export function TutorialPage({ navigate, openGuide, openHelp }: BusinessActions) {
  const [reading, setReading] = useState(initialReading)
  // Native details can be closed manually; a new search must reveal its matches again.
  const searchKey = reading.query.trim().toLocaleLowerCase()
  const article = useRef<HTMLElement>(null)
  const topics = tutorialTopics.filter(topic => matchesSearch(topic, reading.query))
  const current = topics.find(topic => topic.id === reading.selected) ?? topics[0]
  const currentIndex = current ? topics.indexOf(current) : -1
  const previousTopic = useRef(current?.id)

  useEffect(() => {
    if (previousTopic.current !== current?.id) {
      // Search can replace a long article while focus stays in the sticky directory.
      article.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
      previousTopic.current = current?.id
    }
  }, [current?.id])

  useEffect(() => {
    try { window.sessionStorage.setItem(readingKey, JSON.stringify(reading)) } catch { /* Reading remains usable without storage. */ }
  }, [reading])

  function selectTopic(id: string, focusArticle = false) {
    setReading(value => ({ ...value, selected: id }))
    // The application scrolls inside its content pane, not the browser window.
    article.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
    if (focusArticle) article.current?.focus({ preventScroll: true })
  }

  return <section className="v2-page v2-tutorial" data-page-id="tutorial" data-testid="page-tutorial">
    <PageHead title="教程" lead="先让 Codex 回你一句话。跟着第一篇做，不用先学专业词。" actions={openGuide && <Button icon={Compass} onClick={openGuide} testId="tutorial-open-guide">打开新手引导</Button>} />
    <div className="v2-tutorial-layout">
      <aside className="v2-tutorial-directory">
        <SearchInput value={reading.query} onChange={query => setReading(value => ({ ...value, query: query.slice(0, 200) }))} label="搜索教程" placeholder="搜问题，如打不开、充值…" testId="tutorial-search" />
        <nav aria-label="教程目录">
          {groups.map(group => {
            const entries = topics.filter(topic => topic.category === group.id)
            if (!entries.length) return null
            const buttons = entries.map(topic => <button type="button" key={topic.id} data-testid={`tutorial-topic-${topic.id}`} aria-current={topic.id === current?.id ? 'page' : undefined} onClick={() => selectTopic(topic.id)}>
                <span>{topic.title}</span><span className="v2-tutorial-duration">{topic.minutes} 分钟</span>
              </button>)
            return group.id === 'start' ? <div className="v2-tutorial-group" key={group.id}><p>{group.label}</p>{buttons}</div>
              : <details className="v2-tutorial-group v2-tutorial-group-more" key={`${group.id}:${searchKey}`} open={Boolean(searchKey) || current?.category === group.id} data-testid={`tutorial-group-${group.id}`}>
                <summary><ChevronRight size={15} aria-hidden="true" /><span>{group.label}</span></summary>{buttons}
              </details>
          })}
        </nav>
        <p className="v2-tutorial-search-count" role="status">{reading.query.trim() ? `找到 ${topics.length} 篇教程` : '先看第一篇，其他内容用到时再看。'}</p>
        {reading.query && current && <Button variant="ghost" size="sm" onClick={() => setReading(value => ({ ...value, query: '' }))}>清除搜索</Button>}
        {openHelp && <div className="v2-tutorial-support"><span>还是不知道怎么操作？</span><Button variant="ghost" size="sm" onClick={openHelp}>联系帮助与客服</Button></div>}
      </aside>
      {current ? <article ref={article} className="v2-tutorial-article" tabIndex={-1} aria-labelledby="tutorial-article-title" data-testid="tutorial-article">
        <header className="v2-tutorial-article-head">
          <div className="v2-tutorial-meta"><Pill tone="accent">{groups.find(group => group.id === current.category)?.label}</Pill><span><Clock3 size={14} aria-hidden="true" />约 {current.minutes} 分钟 · {current.steps.length} 步</span></div>
          <h2 id="tutorial-article-title">{current.title}</h2>
          <p>{current.lead}</p>
          <div className="v2-tutorial-step-links" aria-label="本篇步骤">
            {current.steps.map((step, index) => <a key={step.title} href={`#tutorial-${current.id}-step-${index}`}><span>{index + 1}</span>{step.title}</a>)}
          </div>
        </header>
        <ol className="v2-tutorial-steps">
          {current.steps.map((step, index) => <li id={`tutorial-${current.id}-step-${index}`} key={`${current.id}:${index}`}>
            <div className="v2-tutorial-step-title"><span aria-hidden="true">{index + 1}</span><h3>{step.title}</h3></div>
            <div className="v2-tutorial-step-body">
              {step.where && <p className="v2-tutorial-where"><strong>在哪里</strong><span>{step.where}</span></p>}
              <p>{step.detail}</p>
              {step.bullets && <ol className="v2-tutorial-instructions">{step.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}</ol>}
              {step.illustration && <TutorialIllustration kind={step.illustration} />}
              {step.example && <TutorialExample text={step.example} firstMessage={current.id === 'start'} testId={`tutorial-${current.id}-copy-${index}`} />}
              {step.expected && <div className="v2-tutorial-expected"><CheckCircle2 size={17} aria-hidden="true" /><p><strong>看到这样，就做好了</strong>{step.expected}</p></div>}
              {step.tip && <p className="v2-tutorial-tip"><strong>小提醒：</strong>{step.tip}</p>}
              {navigate && <Button size="sm" iconRight={ArrowRight} onClick={() => navigate(step.page)} testId={`tutorial-${current.id}-action-${index}`}>{step.action}</Button>}
              {step.extra?.map(note => <details className="v2-tutorial-extra" key={`${note.title}:${searchKey}`} open={Boolean(searchKey)}><summary>{note.title}</summary><p>{note.detail}</p></details>)}
            </div>
          </li>)}
        </ol>
        {current.reminders && <aside className="v2-tutorial-reminders"><strong>用之前，记住这两点</strong><ul>{current.reminders.map(note => <li key={note}>{note}</li>)}</ul></aside>}
        <footer className="v2-tutorial-footer">
          {currentIndex > 0 ? <Button icon={ArrowLeft} onClick={() => selectTopic(topics[currentIndex - 1].id, true)}>上一篇：{topics[currentIndex - 1].title}</Button> : <span><BookOpen size={16} aria-hidden="true" />看完就去试一次，随时回来继续。</span>}
          {currentIndex + 1 < topics.length && <Button iconRight={ArrowRight} onClick={() => selectTopic(topics[currentIndex + 1].id, true)}>下一篇：{topics[currentIndex + 1].title}</Button>}
        </footer>
      </article> : <Card><Empty icon={Search} title="没找到相关教程" description="换个说法试试，例如「安装」「登录」「收不到回复」。" action={<Button onClick={() => setReading({ selected: 'start', query: '' })}>清除搜索</Button>} testId="tutorial-empty" /></Card>}
    </div>
  </section>
}
