import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react'
import { Film, Image as ImageIcon, Music2 } from 'lucide-react'
import { isCanvasImagePreviewUrl } from './MediaPreview'
import {
  clipPromptEditorValue,
  dataTransferHasPromptMention,
  deleteAtomicMention,
  ensureMentionThumbSlots,
  insertMentionAt,
  isCompletedMentionToken,
  mentionDisplayName,
  mentionRenderParts,
  mentionThumbSlot,
  promptEditorMaxLength,
  promptMentionMime,
  splitPromptSegments,
  type PromptMentionSegment,
} from './prompt-mentions'
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
  if (isCompletedMentionToken(beforeCaret.slice(start))) return null
  return { start, end: caret, query: match[1] ?? '' }
}

export function insertUpstreamMention(value: string, mention: string, query: MentionQuery): { value: string; caret: number } {
  const suffix = value.slice(query.end)
  const separator = /^\s/.test(suffix) ? '' : ' '
  const nextValue = `${value.slice(0, query.start)}${mention}${mentionThumbSlot}${separator}${suffix}`
  return { value: nextValue, caret: query.start + mention.length + mentionThumbSlot.length + (separator ? 1 : 0) }
}

function copyTextareaBox(mirror: HTMLElement, textarea: HTMLTextAreaElement): void {
  const style = window.getComputedStyle(textarea)
  const keys = [
    'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily',
    'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing',
    'whiteSpace', 'wordBreak', 'overflowWrap',
  ] as const
  for (const key of keys) mirror.style[key] = style[key]
}

function textOffsetIn(root: Node, node: Node, offset: number): number {
  if (node === root) return offset
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let index = 0
  let current = walker.nextNode()
  while (current) {
    if (current === node) return index + offset
    index += current.textContent?.length ?? 0
    current = walker.nextNode()
  }
  return index
}

function textareaCaretIndexFromPoint(textarea: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const rect = textarea.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return textarea.value.length
  }
  const mirror = document.createElement('div')
  copyTextareaBox(mirror, textarea)
  mirror.textContent = textarea.value
  mirror.style.position = 'fixed'
  mirror.style.left = `${rect.left}px`
  mirror.style.top = `${rect.top}px`
  mirror.style.margin = '0'
  mirror.style.opacity = '0'
  mirror.style.pointerEvents = 'auto'
  document.body.appendChild(mirror)
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
  try {
    const doc = document as Document & {
      caretRangeFromPoint?(x: number, y: number): Range | null
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null
    }
    const range = doc.caretRangeFromPoint?.(clientX, clientY)
    if (range && mirror.contains(range.startContainer)) {
      return Math.max(0, Math.min(textarea.value.length, textOffsetIn(mirror, range.startContainer, range.startOffset)))
    }
    const position = doc.caretPositionFromPoint?.(clientX, clientY)
    if (position && mirror.contains(position.offsetNode)) {
      return Math.max(0, Math.min(textarea.value.length, textOffsetIn(mirror, position.offsetNode, position.offset)))
    }
    return textarea.value.length
  } finally {
    mirror.remove()
  }
}

function syncPromptHighlight(textarea: HTMLTextAreaElement | null, highlight: HTMLDivElement | null): void {
  if (!textarea || !highlight) return
  highlight.scrollTop = textarea.scrollTop
  highlight.scrollLeft = textarea.scrollLeft
  highlight.style.paddingRight = `${Math.max(0, textarea.offsetWidth - textarea.clientWidth)}px`
}

interface PromptEditorProps {
  label: string
  value: string
  placeholder: string
  references: readonly UpstreamMediaReference[]
  rows?: number
  onChange(value: string): void
  onCommit?(value: string): void
  onSubmit?(): void
}

function MentionThumb({ reference }: { reference?: UpstreamMediaReference }) {
  const [failed, setFailed] = useState(false)
  const url = reference?.asset?.kind === 'image' ? reference.asset.localUrl : undefined
  if (isCanvasImagePreviewUrl(url) && !failed) {
    return <img className="wf-prompt-mention-thumb" src={url} alt="" onError={() => setFailed(true)} />
  }
  const Icon = reference?.kind === 'video' ? Film : reference?.kind === 'audio' ? Music2 : ImageIcon
  return <span className={`wf-prompt-mention-thumb is-icon${reference ? ` is-${reference.kind}` : ''}`}><Icon size={14} aria-hidden="true" /></span>
}

function PromptMention({ segment }: { segment: PromptMentionSegment }) {
  const parts = mentionRenderParts(segment.text)
  return (
    <span
      className={`wf-prompt-mention${segment.kind ? ` is-${segment.kind}` : ''}`}
      title={mentionDisplayName(segment)}
    >
      <span className="wf-prompt-mention-glyph">
        <span className="wf-prompt-mention-at">{parts.marker}</span>
      </span>
      {parts.rest}
      {(segment.reference || isCompletedMentionToken(segment.text)) && <MentionThumb reference={segment.reference} />}
    </span>
  )
}

export function PromptEditor({ label, value, placeholder, references, rows = 3, onChange, onCommit, onSubmit }: PromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(value)
  const menuId = useId()
  const [draft, setDraft] = useState(value)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [dropping, setDropping] = useState(false)
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
  const segments = useMemo(() => splitPromptSegments(draft, references), [draft, references])

  useEffect(() => {
    const slotted = ensureMentionThumbSlots(value, null, references)
    if (slotted.value === draftRef.current) return
    draftRef.current = slotted.value
    setDraft(slotted.value)
    if (slotted.value !== value) onChange(slotted.value)
  }, [value, references, onChange])

  useEffect(() => {
    if (activeIndex < filtered.length) return
    setActiveIndex(Math.max(0, filtered.length - 1))
  }, [activeIndex, filtered.length])

  useLayoutEffect(() => {
    syncPromptHighlight(textareaRef.current, highlightRef.current)
  }, [draft])

  const emit = (nextValue: string, caret: number | null) => {
    const slotted = ensureMentionThumbSlots(nextValue, caret, references)
    const clipped = clipPromptEditorValue(slotted.value, slotted.caret)
    draftRef.current = clipped.value
    setDraft(clipped.value)
    onChange(clipped.value)
    setMentionQuery(clipped.caret === null ? null : mentionQueryAt(clipped.value, clipped.caret))
    setActiveIndex(0)
  }
  const updateFromInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    emit(event.target.value, event.target.selectionStart)
  }
  const insertReference = (reference: UpstreamMediaReference | undefined) => {
    if (!reference || !mentionQuery) return
    const inserted = insertUpstreamMention(draftRef.current, reference.mention, mentionQuery)
    emit(inserted.value, inserted.caret)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const acceptPromptMention = (event: { dataTransfer: DataTransfer; preventDefault(): void }) => {
    if (!dataTransferHasPromptMention([...event.dataTransfer.types])) return false
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    return true
  }
  const dropMentionAt = (clientX: number, clientY: number, mention: string) => {
    const textarea = textareaRef.current
    const index = textarea ? textareaCaretIndexFromPoint(textarea, clientX, clientY) : draftRef.current.length
    const inserted = insertMentionAt(draftRef.current, mention, index)
    emit(inserted.value, inserted.caret)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      onCommit?.(draftRef.current)
      onSubmit?.()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const deleted = deleteAtomicMention(
        draftRef.current,
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
        event.key === 'Backspace' ? 'backward' : 'forward',
        references,
      )
      if (deleted) {
        event.preventDefault()
        emit(deleted.value, deleted.caret)
        window.requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(deleted.caret, deleted.caret)
        })
        return
      }
    }
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
  const syncHighlightScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    syncPromptHighlight(event.currentTarget, highlightRef.current)
  }

  // nowheel as well as nodrag: a prompt longer than the textarea is
  // scrollable, and without it the wheel zooms the canvas instead.
  return (
    <div
      className={`wf-prompt-editor nodrag nowheel${mentionQuery ? ' is-mentioning' : ''}${draft ? ' is-filled' : ''}${dropping ? ' is-dropping' : ''}${segments.some((segment) => segment.type === 'mention') ? ' has-mentions' : ''}`}
      onDragEnter={(event) => {
        if (acceptPromptMention(event)) setDropping(true)
      }}
      onDragOver={(event) => {
        if (!acceptPromptMention(event)) return
        const textarea = textareaRef.current
        if (!textarea) return
        const index = textareaCaretIndexFromPoint(textarea, event.clientX, event.clientY)
        textarea.focus()
        textarea.setSelectionRange(index, index)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDropping(false)
      }}
      onDrop={(event) => {
        const mention = event.dataTransfer.getData(promptMentionMime)
        if (!mention) return
        event.preventDefault()
        event.stopPropagation()
        setDropping(false)
        dropMentionAt(event.clientX, event.clientY, mention)
      }}
    >
      <div ref={highlightRef} className="wf-prompt-highlight" aria-hidden="true">
        {segments.map((segment, index) => (
          segment.type === 'text'
            ? <span key={index}>{segment.text}</span>
            : <PromptMention key={index} segment={segment} />
        ))}
      </div>
      <textarea
        ref={textareaRef}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={mentionQuery ? menuId : undefined}
        aria-expanded={Boolean(mentionQuery)}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        maxLength={promptEditorMaxLength}
        onChange={updateFromInput}
        onScroll={syncHighlightScroll}
        onClick={(event) => setMentionQuery(mentionQueryAt(event.currentTarget.value, event.currentTarget.selectionStart))}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            setMentionQuery(mentionQueryAt(event.currentTarget.value, event.currentTarget.selectionStart))
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          onCommit?.(draftRef.current)
          window.setTimeout(() => setMentionQuery(null), 80)
        }}
        rows={rows}
      />
      <p className={`wf-prompt-count${draft.length >= promptEditorMaxLength ? ' is-limit' : ''}`} aria-live="polite">
        {draft.length}/{promptEditorMaxLength}
      </p>
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
