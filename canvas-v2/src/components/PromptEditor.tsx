import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type UIEvent } from 'react'
import { flushSync } from 'react-dom'
import { Film, Image as ImageIcon, Music2 } from 'lucide-react'
import { isCanvasImagePreviewUrl } from './MediaPreview'
import {
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
import { usePromptCatalogValue } from './PromptCatalogContext'
import { PromptShortcutMenu } from './PromptShortcutMenu'
import { synchronizePromptScroll } from './prompt-editor-scroll'
import { promptShortcutOwnsFocus, promptShortcutShouldDismiss } from './prompt-menu-position'
import { filterPromptShortcuts, insertPromptShortcut, maximumVisiblePromptShortcuts, promptShortcutComposing, promptShortcutItems, promptShortcutQueryAt, type PromptShortcut, type PromptShortcutQuery, type PromptShortcutSource } from './prompt-shortcuts'
import { applyPromptDisplayInput, copyPromptSelection, createPromptExternalSync, deletePromptReference, maximumPromptReferences, officialPromptSnapshot, projectPrompt, promptDocument, promptReferenceContainsCaret, promptSelection, publishPromptDocument, receivePromptDocument, rememberPromptEdit, replacePromptSelection, restorePromptEdit, transformPromptText, type PromptDocument, type PromptEditHistory, type PromptReference } from '../library/prompt-references'
import './prompt-references.css'

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
  synchronizePromptScroll(textarea, highlight, Number.parseFloat(window.getComputedStyle(textarea).paddingRight) || 0)
}

interface PromptEditorProps {
  label: string
  value: string
  placeholder: string
  references: readonly UpstreamMediaReference[]
  promptReferences?: readonly PromptReference[]
  rows?: number
  onChange(value: string, references?: PromptReference[]): void
  onInsert?(value: string, references?: PromptReference[]): void
  onCommit?(value: string, references?: PromptReference[]): void
  onSubmit?(): void
}

function MentionThumb({ reference }: { reference?: UpstreamMediaReference }) {
  const [failed, setFailed] = useState(false)
  const url = reference?.asset?.kind === 'image' ? reference.asset.localUrl : undefined
  if (isCanvasImagePreviewUrl(url) && !failed) {
    return <img className="wf-prompt-mention-thumb" src={resolveCanvasAssetDisplayUrl(url)} alt="" onError={() => setFailed(true)} />
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

export function PromptEditor({ label, value, placeholder, references, promptReferences, rows = 3, onChange, onInsert, onCommit, onSubmit }: PromptEditorProps) {
  const catalog = usePromptCatalogValue()
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef(promptDocument(value, promptReferences))
  const draftRef = useRef(projectPrompt(documentRef.current).text)
  const historyRef = useRef<PromptEditHistory>({ undo: [], redo: [] })
  const externalSyncRef = useRef(createPromptExternalSync(documentRef.current))
  const initializedExternalRef = useRef(false)
  const pendingCommitRef = useRef(false)
  const composingRef = useRef(false)
  const menuId = useId()
  const [promptState, setDocument] = useState(documentRef.current)
  const draft = projectPrompt(promptState).text
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [dropping, setDropping] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [shortcutQuery, setShortcutQuery] = useState<PromptShortcutQuery | null>(null)
  const [shortcutSearch, setShortcutSearch] = useState('')
  const [shortcutSource, setShortcutSource] = useState<PromptShortcutSource>('all')
  const [shortcutGroup, setShortcutGroup] = useState<string | null>(null)
  const [insertError, setInsertError] = useState<string | null>(null)
  const shortcutItems = useMemo(() => promptShortcutItems(catalog.items), [catalog.items])
  const shortcutMatches = useMemo(() => filterPromptShortcuts(shortcutItems, shortcutSearch, shortcutSource, shortcutGroup), [shortcutItems, shortcutSearch, shortcutSource, shortcutGroup])
  const shortcuts = useMemo(() => shortcutMatches.slice(0, maximumVisiblePromptShortcuts), [shortcutMatches])
  const filtered = useMemo(() => {
    if (!mentionQuery) return []
    const query = mentionQuery.query.toLocaleLowerCase()
    return references.filter((reference) => (
      !query
      || reference.label.toLocaleLowerCase().includes(query)
      || reference.mention.toLocaleLowerCase().includes(query)
    ))
  }, [mentionQuery, references])
  const projection = useMemo(() => projectPrompt(promptState), [promptState])
  const segments = useMemo(() => {
    const result: (ReturnType<typeof splitPromptSegments>[number] | { type: 'official'; text: string; reference: PromptReference })[] = []
    let cursor = 0
    for (const range of projection.ranges) {
      result.push(...splitPromptSegments(projection.text.slice(cursor, range.start), references), { type: 'official', text: projection.text.slice(range.start, range.end), reference: range.reference })
      cursor = range.end
    }
    result.push(...splitPromptSegments(projection.text.slice(cursor), references))
    return result
  }, [projection, references])

  useEffect(() => {
    const received = promptDocument(value, promptReferences)
    const source = receivePromptDocument(externalSyncRef.current, received)
    const initialized = initializedExternalRef.current
    initializedExternalRef.current = true
    // React Flow can deliver the same old node props while a context/callback
    // changes, before it echoes our edit. That is not an external document or
    // a reason to clear undo. Intermediate echoes also must not replace a
    // newer local edit whose acknowledgement is still pending.
    if (source === 'acknowledged' || source === 'repeat' && (initialized || pendingCommitRef.current)) return
    const slotted = transformPromptText(received, null, (text, caret) => ensureMentionThumbSlots(text, caret, references))
    if (JSON.stringify(slotted.document) === JSON.stringify(documentRef.current)) return
    pendingCommitRef.current = slotted.document.prompt !== value
    documentRef.current = slotted.document
    draftRef.current = projectPrompt(slotted.document).text
    setDocument(slotted.document)
    historyRef.current = { undo: [], redo: [] }
    setShortcutQuery(null)
    if (slotted.document.prompt !== value) { publishPromptDocument(externalSyncRef.current, slotted.document); onChange(slotted.document.prompt, slotted.document.references) }
  }, [value, promptReferences, references, onChange])

  useEffect(() => {
    const count = shortcutQuery ? shortcuts.length : filtered.length
    if (activeIndex < count) return
    setActiveIndex(Math.max(0, count - 1))
  }, [activeIndex, filtered.length, shortcuts.length, shortcutQuery])

  useEffect(() => {
    if (!catalog.enabled) { setShortcutQuery(null); setInsertError(null) }
  }, [catalog.enabled])

  useEffect(() => {
    if (shortcutQuery && catalog.enabled) void catalog.load()
  }, [Boolean(shortcutQuery), catalog.enabled, catalog.load])

  useEffect(() => {
    if (!shortcutQuery) return
    function outsidePointer(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null
      const insideEditor = event.target instanceof Node && Boolean(editorRef.current?.contains(event.target))
      if (promptShortcutShouldDismiss(menuId, 'pointer', target, insideEditor)) setShortcutQuery(null)
    }
    document.addEventListener('pointerdown', outsidePointer, true)
    return () => document.removeEventListener('pointerdown', outsidePointer, true)
  }, [Boolean(shortcutQuery), menuId])

  useLayoutEffect(() => {
    syncPromptHighlight(textareaRef.current, highlightRef.current)
  }, [draft])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const observer = new ResizeObserver(() => syncPromptHighlight(textarea, highlightRef.current))
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])

  const updateQueries = (nextValue: string, start: number, end = start) => {
    if (composingRef.current) return
    const inReference = promptReferenceContainsCaret(documentRef.current, start)
    const next = catalog.enabled && !inReference ? promptShortcutQueryAt(nextValue, start, end) : null
    setShortcutQuery(next)
    if (next) { setShortcutSearch(next.query); setActiveIndex(0) }
    setMentionQuery(next || inReference || start !== end ? null : mentionQueryAt(nextValue, start))
  }
  const emit = (nextValue: string, caret: number | null, sync = false, discrete = false, prepared?: PromptDocument, remember = true) => {
    const changed = prepared ? { document: prepared, caret } : applyPromptDisplayInput(documentRef.current, nextValue, caret ?? nextValue.length)
    const slotted = transformPromptText(changed.document, caret === null ? null : changed.caret, (text, localCaret) => ensureMentionThumbSlots(text, localCaret, references))
    if (slotted.document.prompt.length > promptEditorMaxLength) {
      setInsertError(`超过 ${promptEditorMaxLength} 字，原内容已保留，请先缩短正文。`)
      return false
    }
    const clipped = { value: projectPrompt(slotted.document).text, caret: slotted.caret }
    setInsertError(null)
    if (JSON.stringify(slotted.document) !== JSON.stringify(documentRef.current)) {
      pendingCommitRef.current = true
      if (remember) rememberPromptEdit(historyRef.current, { document: documentRef.current, caret: textareaRef.current?.selectionStart ?? 0 })
    }
    documentRef.current = slotted.document
    draftRef.current = clipped.value
    setDocument(slotted.document)
    const publish = discrete && onInsert ? onInsert : onChange
    publishPromptDocument(externalSyncRef.current, slotted.document)
    if (sync) flushSync(() => publish(slotted.document.prompt, slotted.document.references))
    else publish(slotted.document.prompt, slotted.document.references)
    if (clipped.caret === null) { setMentionQuery(null); setShortcutQuery(null) }
    else updateQueries(clipped.value, clipped.caret)
    setActiveIndex(0)
    return true
  }
  const updateFromInput = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const caret = event.target.selectionStart
    const edited = applyPromptDisplayInput(documentRef.current, event.target.value, caret)
    if (emit(event.target.value, edited.caret, false, false, edited.document) && projectPrompt(edited.document).text !== event.target.value) {
      window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(edited.caret, edited.caret))
    }
  }
  const insertReference = (reference: UpstreamMediaReference | undefined) => {
    if (!reference || !mentionQuery) return
    const inserted = insertUpstreamMention(draftRef.current, reference.mention, mentionQuery)
    // A menu selection is a discrete edit. Flush the controlled parent update
    // before the key event returns so the textarea cannot briefly re-render
    // with the pre-selection query (for example just "@").
    if (!emit(inserted.value, inserted.caret, true, true)) return
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const insertShortcut = (item: PromptShortcut) => {
    if (!shortcutQuery || !catalog.enabled) return
    // Re-resolve the selected ID against the current owner-scoped catalog;
    // a deletion or refresh must not insert a stale button's retained text.
    const current = shortcutItems.find((candidate) => candidate.id === item.id)
    if (!current) { setInsertError('该提示词已更新或删除，请重新选择。'); return }
    const inserted = insertPromptShortcut(draftRef.current, current.prompt, shortcutQuery)
    if (!inserted.ok) { setInsertError(inserted.message); return }
    const snapshot = current.source === 'builtin' ? officialPromptSnapshot(current.id.slice('builtin:'.length)) : null
    if (snapshot && documentRef.current.references.length >= maximumPromptReferences) { setInsertError(`一个提示词最多保留 ${maximumPromptReferences} 个官方标签，请先移除部分标签。`); return }
    const edited = replacePromptSelection(documentRef.current, shortcutQuery.start, shortcutQuery.end, current.prompt, snapshot ?? undefined)
    if (!emit(projectPrompt(edited.document).text, edited.caret, true, true, edited.document)) return
    setShortcutQuery(null)
    setMentionQuery(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(edited.caret, edited.caret)
    })
  }
  const handleShortcutKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!shortcutQuery || promptShortcutComposing(event.nativeEvent) || composingRef.current) return false
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setShortcutQuery(null); textareaRef.current?.focus()
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      setActiveIndex((index) => shortcuts.length ? (index + (event.key === 'ArrowDown' ? 1 : shortcuts.length - 1)) % shortcuts.length : 0)
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey && shortcuts[activeIndex]) {
      event.preventDefault(); event.stopPropagation(); insertShortcut(shortcuts[activeIndex])
      return true
    }
    return false
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
    // Drag-and-drop is another discrete insertion; keep the controlled value
    // in lockstep before the browser dispatches the next pointer event.
    if (!emit(inserted.value, inserted.caret, true, true)) return
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }
  const commitDraft = () => {
    if (!pendingCommitRef.current) return
    pendingCommitRef.current = false
    onCommit?.(documentRef.current.prompt, documentRef.current.references)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (promptShortcutComposing(event.nativeEvent) || composingRef.current) return
    if (handleShortcutKeyDown(event)) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault(); event.stopPropagation()
      const direction = event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'
      const restored = restorePromptEdit(historyRef.current, { document: documentRef.current, caret: event.currentTarget.selectionStart }, direction)
      if (restored && emit(projectPrompt(restored.document).text, restored.caret, true, true, restored.document, false)) window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(restored.caret, restored.caret))
      return
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const start = event.currentTarget.selectionStart
      const end = event.currentTarget.selectionEnd
      if (start === end) {
        const hit = projectPrompt(documentRef.current).ranges.find((range) => event.key === 'ArrowLeft' ? range.start < start && start <= range.end : range.start <= start && start < range.end)
        if (hit) { event.preventDefault(); const caret = event.key === 'ArrowLeft' ? hit.start : hit.end; event.currentTarget.setSelectionRange(caret, caret); updateQueries(draftRef.current, caret); return }
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      commitDraft()
      onSubmit?.()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const atomic = deletePromptReference(documentRef.current, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.key === 'Backspace' ? 'backward' : 'forward')
      if (atomic) {
        event.preventDefault()
        emit(projectPrompt(atomic.document).text, atomic.caret, true, true, atomic.document)
        window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(atomic.caret, atomic.caret))
        return
      }
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
      ref={editorRef}
      className={`wf-prompt-editor nodrag nowheel${mentionQuery || shortcutQuery ? ' is-mentioning' : ''}${draft ? ' is-filled' : ''}${dropping ? ' is-dropping' : ''}${segments.some((segment) => segment.type === 'mention') ? ' has-mentions' : ''}`}
      onBlurCapture={(event) => {
        const target = event.relatedTarget instanceof Element ? event.relatedTarget : null
        const insideEditor = event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
        if (shortcutQuery && !promptShortcutShouldDismiss(menuId, 'blur', target, insideEditor)) return
        if (insideEditor || promptShortcutOwnsFocus(menuId, target)) return
        setMentionQuery(null); setShortcutQuery(null)
      }}
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
            : segment.type === 'official'
              ? <span key={index} contentEditable={false} className="wf-prompt-official" title={`${segment.reference.name} · 官方 v${segment.reference.version}\n${segment.reference.prompt}`}>{segment.text.slice(0, -3)}<span className="wf-prompt-official-badge"> 官方</span></span>
              : <PromptMention key={index} segment={segment} />
        ))}
      </div>
      <textarea
        ref={textareaRef}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={mentionQuery || shortcutQuery ? menuId : undefined}
        aria-expanded={Boolean(mentionQuery || shortcutQuery)}
        aria-activedescendant={shortcutQuery && shortcuts[activeIndex] ? `${menuId}-${activeIndex}` : mentionQuery && filtered[activeIndex] ? `${menuId}-${activeIndex}` : undefined}
        value={draft}
        placeholder={`${placeholder} · # 调用提示词`}
        spellCheck={false}
        maxLength={promptEditorMaxLength}
        onChange={updateFromInput}
        onSelect={(event) => {
          if (composingRef.current) return
          const input = event.currentTarget
          const selection = promptSelection(projectPrompt(documentRef.current), input.selectionStart, input.selectionEnd)
          if (selection.start !== input.selectionStart || selection.end !== input.selectionEnd) input.setSelectionRange(selection.start, selection.end, input.selectionDirection)
        }}
        onCopy={(event) => {
          const input = event.currentTarget
          if (input.selectionStart === input.selectionEnd) return
          event.preventDefault()
          event.clipboardData.setData('text/plain', copyPromptSelection(documentRef.current, input.selectionStart, input.selectionEnd))
        }}
        onCut={(event) => {
          const input = event.currentTarget
          if (input.selectionStart === input.selectionEnd) return
          event.preventDefault()
          event.clipboardData.setData('text/plain', copyPromptSelection(documentRef.current, input.selectionStart, input.selectionEnd))
          const edited = replacePromptSelection(documentRef.current, input.selectionStart, input.selectionEnd, '')
          if (emit(projectPrompt(edited.document).text, edited.caret, true, true, edited.document)) window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(edited.caret, edited.caret))
        }}
        onPaste={(event) => {
          event.preventDefault()
          const input = event.currentTarget
          const edited = replacePromptSelection(documentRef.current, input.selectionStart, input.selectionEnd, event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'))
          if (emit(projectPrompt(edited.document).text, edited.caret, true, true, edited.document)) window.requestAnimationFrame(() => textareaRef.current?.setSelectionRange(edited.caret, edited.caret))
        }}
        onScroll={syncHighlightScroll}
        onClick={(event) => updateQueries(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            if (!promptShortcutComposing(event.nativeEvent)) updateQueries(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          }
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; setShortcutQuery(null); setMentionQuery(null) }}
        onCompositionEnd={(event) => { composingRef.current = false; updateQueries(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd) }}
        onBlur={commitDraft}
        rows={rows}
      />
      <p className={`wf-prompt-count${promptState.prompt.length >= promptEditorMaxLength ? ' is-limit' : ''}`} aria-live="polite">
        {promptState.prompt.length}/{promptEditorMaxLength}
      </p>
      {promptState.references.length > 0 && <button type="button" className="wf-prompt-expand-official" aria-label="展开全部官方标签为可编辑正文" title="保留完整正文，移除整体标签，可撤销" onClick={() => {
        const expanded = { prompt: documentRef.current.prompt, references: [] }
        if (emit(expanded.prompt, expanded.prompt.length, true, true, expanded)) window.requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(expanded.prompt.length, expanded.prompt.length) })
      }}>展开为正文</button>}
      {insertError && !shortcutQuery && <p role="alert" className="wf-prompt-insert-error">{insertError}</p>}
      {shortcutQuery && catalog.enabled && <PromptShortcutMenu
        id={menuId} anchorRef={textareaRef} items={shortcuts} total={shortcutMatches.length} query={shortcutSearch} source={shortcutSource} activeIndex={activeIndex}
        draft={replacePromptSelection(documentRef.current, shortcutQuery.start, shortcutQuery.end, '').document.prompt} error={insertError}
        group={shortcutGroup} onGroup={(group) => { setShortcutGroup(group); if (group !== null && shortcutSource === 'builtin') setShortcutSource('mine'); setActiveIndex(0) }}
        onQuery={(query) => { setShortcutSearch(query); setActiveIndex(0) }} onSource={(source) => { setShortcutSource(source); if (source === 'builtin') setShortcutGroup(null); setActiveIndex(0) }}
        onActive={setActiveIndex} onInsert={insertShortcut} onClose={() => { setShortcutQuery(null); textareaRef.current?.focus() }} onKeyDown={handleShortcutKeyDown}
      />}
      {mentionQuery && (
        <div id={menuId} className="wf-mention-menu" role="listbox" aria-label="已连接的上游素材">
          {filtered.map((reference, index) => (
            <button
              key={reference.referenceId ?? reference.mention}
              id={`${menuId}-${index}`}
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
