import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Keyboard, X } from 'lucide-react'
import { canvasShortcutHelp, canvasShortcutKeyLabels } from '../editor/shortcut-help'
import '../theme/editor-shortcuts.css'

export function CanvasShortcutHelp() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [open])

  return <>
    <button ref={triggerRef} type="button" className="canvas-shortcut-trigger" title="查看画布快捷键和操作方式" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <Keyboard size={15} aria-hidden="true" /><span>快捷键</span>
    </button>
    {open && createPortal(
      <div className="canvas-shortcut-backdrop" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
        <section className="canvas-shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          if (event.key !== 'Tab') return
          const active = document.activeElement
          if (event.shiftKey && active === closeRef.current) { event.preventDefault(); contentRef.current?.focus() }
          else if (!event.shiftKey && active === contentRef.current) { event.preventDefault(); closeRef.current?.focus() }
        }}>
          <header>
            <div><span className="canvas-shortcut-eyebrow">让创作更顺手</span><h2 id={titleId}>画布快捷键</h2></div>
            <button ref={closeRef} className="canvas-shortcut-close" type="button" aria-label="关闭快捷键帮助" title="关闭（Esc）" onClick={() => setOpen(false)}><X size={18} /></button>
          </header>
          <p id={descriptionId} className="canvas-shortcut-description">在画布中使用，输入框内保留文字编辑操作。Mac 使用 ⌘，Windows 使用 Ctrl。</p>
          <div ref={contentRef} className="canvas-shortcut-content" tabIndex={0} role="region" aria-label="快捷键和鼠标操作列表">
            <div className="canvas-shortcut-grid">
              {canvasShortcutHelp.map((group) => <section key={group.title}>
                <h3>{group.title}</h3><p>{group.hint}</p>
                <dl>{group.items.map((item) => <div key={item.command}>
                  <dt>{item.label}</dt><dd>{canvasShortcutKeyLabels(item.event).map((key) => <kbd key={key}>{key}</kbd>)}</dd>
                </div>)}</dl>
              </section>)}
              <section>
                <h3>鼠标与选择</h3><p>画布空白处支持框选与平移</p>
                <dl>
                  <div><dt>框选节点</dt><dd><kbd>左键拖动空白处</kbd></dd></div>
                  <div><dt>追加 / 取消选中</dt><dd><kbd>Shift</kbd><kbd>单击节点</kbd></dd></div>
                  <div><dt>平移画布</dt><dd><kbd>空格</kbd><kbd>拖动</kbd></dd></div>
                  <div><dt>在此添加节点</dt><dd><kbd>双击空白处</kbd></dd></div>
                </dl>
                <p className="canvas-shortcut-tip">选中节点后，上方浮动工具栏可对齐、编组或查看详情。右键未选中的节点，只操作该节点。</p>
              </section>
            </div>
          </div>
          <footer><span>随时从右下角打开帮助</span><span><kbd>Esc</kbd> 关闭</span></footer>
        </section>
      </div>, document.body,
    )}
  </>
}
