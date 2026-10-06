import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Button } from './core';
import { focusable, useUiText, type BaseProps, type Icon } from './shared';

// headless: no visible title row or close button; the title stays as the accessible name and the box
// pins near the top so a growing result list never moves it (the command palette). Esc and the
// backdrop still close it.
// A drawer is not modal: the list behind it stays usable, so picking another row swaps the drawer's
// content instead of closing it. It sits in the top layer as a manual popover so dialogs and menus
// still stack above it, takes no backdrop and keeps no focus trap; Esc still closes it unless the key
// belongs to a text field outside it.
export type ModalProps = BaseProps & { open: boolean; title: ReactNode; subtitle?: ReactNode; icon?: Icon; onClose: () => void; footer?: ReactNode; dirty?: boolean; initialFocus?: RefObject<HTMLElement | null>; children?: ReactNode; busy?: boolean; headless?: boolean };
function Modal({ open, title, subtitle, icon: Icon, onClose, footer, dirty, initialFocus, children, testId, busy, headless, kind, width = 480 }: ModalProps & { kind: 'dialog' | 'drawer'; width?: 480 | 640 }) {
  const ref = useRef<HTMLElement | null>(null); const returnFocus = useRef<HTMLElement | null>(null); const content = useRef<HTMLDivElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false); const titleId = useId(); const subtitleId = useId(); const t = useUiText();
  const current = useRef({ onClose, dirty, busy }); current.current = { onClose, dirty, busy };
  const modal = kind === 'dialog'; const setNode = useCallback((node: HTMLElement | null) => { ref.current = node; }, []);
  const requestClose = useCallback(() => { if (current.current.busy) return; if (current.current.dirty) setConfirmDiscard(true); else current.current.onClose(); }, []);
  useLayoutEffect(() => {
    const element = ref.current; if (!element || !open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element instanceof HTMLDialogElement) element.showModal(); else { element.setAttribute('popover', 'manual'); element.showPopover(); }
    (initialFocus?.current ?? focusable(element).find(item => item.dataset.modalClose !== 'true') ?? element).focus();
    // Picking another row while the drawer is open: closing it returns focus to that row, not the first one.
    const track = (event: FocusEvent) => { if (event.target instanceof HTMLElement && !element.contains(event.target)) returnFocus.current = event.target; };
    if (!modal) document.addEventListener('focusin', track);
    return () => {
      if (!modal) document.removeEventListener('focusin', track);
      // Focus already taken over outside a drawer (a row, a search box) stays there when it closes.
      const active = document.activeElement; const owned = modal || !active || active === document.body || element.contains(active);
      if (element instanceof HTMLDialogElement) { if (element.open) element.close(); } else if (element.matches(':popover-open')) element.hidePopover();
      if (owned && returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, [open, initialFocus, modal]);
  useEffect(() => {
    if (!open || modal) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector(':modal')) return;
      if (event.target instanceof Element && !ref.current?.contains(event.target) && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); requestClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, modal, requestClose]);
  useEffect(() => { if (!open) setConfirmDiscard(false); }, [open]);
  useLayoutEffect(() => { if (confirmDiscard) ref.current?.querySelector<HTMLButtonElement>('[data-keep-editing]')?.focus(); }, [confirmDiscard]);
  if (!open) return null;
  const cancelDiscard = () => { setConfirmDiscard(false); requestAnimationFrame(() => (initialFocus?.current ?? (content.current && focusable(content.current)[0]) ?? ref.current)?.focus()); };
  const className = 'xm-modal xm-' + kind + ' xm-dialog-' + width + (headless ? ' xm-dialog-headless' : '');
  const inner = <>
    {headless ? <h2 id={titleId} className="xm-visually-hidden">{title}</h2> : <header>{Icon && <Icon size={20} aria-hidden="true" />}<div><h2 id={titleId}>{title}</h2>{subtitle && <small id={subtitleId}>{subtitle}</small>}</div><button type="button" data-modal-close="true" className="xm-icon-btn" aria-label={t('close')} onClick={requestClose} disabled={busy}><X size={18} aria-hidden="true" /></button></header>}
    <div ref={content} className="xm-modal-content" hidden={confirmDiscard}><div className="xm-dialog-body">{children}</div>{footer && <footer>{footer}</footer>}</div>
    {confirmDiscard && <div className="xm-discard" role="alert"><h3>{t('discardTitle')}</h3><p>{t('discardBody')}</p><div><Button data-keep-editing="true" onClick={cancelDiscard}>{t('keepEditing')}</Button><Button variant="danger" onClick={() => { setConfirmDiscard(false); onClose(); }}>{t('discard')}</Button></div></div>}
  </>;
  if (!modal) return <div ref={setNode} role="dialog" className={className} data-testid={testId} tabIndex={-1} aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined}>{inner}</div>;
  return <dialog ref={setNode} className={className} data-testid={testId} tabIndex={-1} aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} onCancel={event => { event.preventDefault(); if (confirmDiscard) cancelDiscard(); else requestClose(); }} onClick={event => {
    if (event.target !== event.currentTarget || dirty || busy || confirmDiscard) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose();
  }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const targets = focusable(event.currentTarget);
    const first = targets[0]; const last = targets[targets.length - 1];
    if (!first) { event.preventDefault(); ref.current?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>{inner}</dialog>;
}
export function Dialog(props: ModalProps & { width?: 480 | 640 }) { return <Modal {...props} kind="dialog" />; }
export function Drawer(props: ModalProps) { return <Modal {...props} kind="drawer" />; }
export function Confirm({ open = true, title, body, okLabel, cancelLabel, danger, requireAck, ackLabel, onOk, onClose, loading, testId }: BaseProps & { open?: boolean; title: ReactNode; body: ReactNode; okLabel: string; cancelLabel?: string; danger?: boolean; requireAck?: boolean; ackLabel?: string; onOk: () => void; onClose?: () => void; loading?: boolean }) {
  const [ack, setAck] = useState(false); const [dismissed, setDismissed] = useState(false); const t = useUiText(); const initial = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) { setAck(false); setDismissed(false); } }, [open]);
  const close = () => { if (loading) return; if (onClose) onClose(); else setDismissed(true); };
  return <Dialog open={open && !dismissed} title={title} onClose={close} initialFocus={initial} busy={loading} testId={testId} footer={<><Button ref={initial} onClick={close} disabled={loading}>{cancelLabel ?? t('cancel')}</Button><Button variant={danger ? 'danger' : 'primary'} disabled={Boolean(requireAck && !ack)} loading={loading} onClick={onOk}>{okLabel}</Button></>}>{body}{requireAck && <label className="xm-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />{ackLabel ?? t('acknowledge')}</label>}</Dialog>;
}
