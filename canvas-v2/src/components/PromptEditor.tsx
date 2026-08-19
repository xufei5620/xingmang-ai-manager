import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { UpstreamMediaReference } from './upstream-references'

export interface MentionQuery {
  start: number
  end: number
  query: string
}

export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null
  const beforeCaret = value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return null
  const start = beforeCaret.lastIndexOf('@')
  return { start, end: caret, query: match[1] ?? '' }
}

export function insertUpstreamMention(value: string, mention: string, query: MentionQuery): { value: string; caret: number } {
  const suffix = value.slice(query.end)
  const separator = /^\s/.test(suffix) ? '' : ' '
  const nextValue = `${value.slice(0, query.start)}${mention}${separator}${suffix}`
  return { value: nextValue, caret: query.start + mention.length + 1 }
}

interface PromptEditorProps {
  label: string
  value: string
  placeholder: string
  references: readonly UpstreamMediaReference[]
  onChange(value: string): void
}

export function PromptEditor({ label, value, placeholder, references, onChange }: PromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuId = useId()
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const filtered = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.toLocaleLowerCase()
    return references.filter((reference) => (
      !query
      || reference.label.toLocaleLowerCase().includes(query)
      || reference.mention.toLocaleLowerCase().includes(query)
    ))
  }, [mentionQuery, references])

  useEffect(() => {
    if (activeIndex < filtered.length) return
    setActiveIndex(Math.max(0, filtered.length - 1))
  }, [activeIndex, filtered.length])

  const updateQuery = (nextValue: string, caret: number | null) => {
    setMentionQuery(caret === null ? null : mentionQueryAt(nextValue, caret))
    setActiveIndex(0)
  }
  const updateFromInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value)
    updateQuery(event.target.value, event.target.selectionStart)
  }
  const insertReference = (reference: UpstreamMediaReference | undefined) => {
    if (!reference || !mentionQuery) return
    const inserted = insertUpstreamMention(value, reference.mention, mentionQuery)
    onChange(inserted.value)
    setMentionQuery(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionQuery) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setMentionQuery(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0)
    } else if ((event.key === 'Enter' || event.key === 'Tab') && filtered[activeIndex]) {
      event.preventDefault()
      insertReference(filtered[activeIndex])
    }
  }

  // nowheel as well as nodrag: a prompt longer than the textarea is
  // scrollable, and without it the wheel zooms the canvas instead.
  return (
    <div className={`wf-prompt-editor nodrag nowheel${mentionQuery ? ' is-mentioning' : ''}`}>
      <textarea
        ref={textareaRef}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={mentionQuery ? menuId : undefined}
        aria-expanded={Boolean(mentionQuery)}
        value={value}
        placeholder={placeholder}
        onChange={updateFromInput}
        onClick={(event) => updateQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            updateQuery(event.currentTarget.value, event.currentTarget.selectionStart)
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => window.setTimeout(() => setMentionQuery(null), 80)}
        rows={3}
      />
      {mentionQuery && (
        <div id={menuId} className="wf-mention-menu" role="listbox" aria-label="已连接的上游素材">
          {filtered.map((reference, index) => (
            <button
              key={reference.edgeId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'is-active' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => insertReference(reference)}
            >
              <span className={`wf-mention-kind is-${reference.kind}`}>{reference.kind === 'image' ? '图' : reference.kind === 'video' ? '视' : '音'}</span>
              <span><strong>{reference.label}</strong><small>{reference.mention}</small></span>
              <em>{reference.status === 'ready'
                ? reference.relationLabel
                : reference.kind === 'image' ? '等待产物' : '提示词引用 · 等待'}</em>
            </button>
          ))}
          {filtered.length === 0 && <p>没有已连接的上游素材</p>}
        </div>
      )}
    </div>
  )
}
