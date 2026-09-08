import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Button } from './core';
import { focusable, useUiText, type BaseProps, type Icon } from './shared';

export type ModalProps = BaseProps & { open: boolean; title: ReactNode; subtitle?: ReactNode; icon?: Icon; onClose: () => void; footer?: ReactNode; dirty?: boolean; initialFocus?: RefObject<HTMLElement | null>; children?: ReactNode; busy?: boolean };
function Modal({ open, title, subtitle, icon: Icon, onClose, footer, dirty, initialFocus, children, testId, busy, kind, width = 480 }: ModalProps & { kind: 'dialog' | 'drawer'; width?: 480 | 640 }) {
  const ref = useRef<HTMLDialogElement>(null); const returnFocus = useRef<HTMLElement | null>(null); const content = useRef<HTMLDivElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false); const titleId = useId(); const subtitleId = useId(); const t = useUiText();
  const current = useRef({ onClose, dirty, busy }); current.current = { onClose, dirty, busy };
  const requestClose = useCallback(() => { if (current.current.busy) return; if (current.current.dirty) setConfirmDiscard(true); else current.current.onClose(); }, []);
  useLayoutEffect(() => {
    const dialog = ref.current; if (!dialog || !open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    (initialFocus?.current ?? focusable(dialog).find(item => item.dataset.modalClose !== 'true') ?? dialog).focus();
    return () => { if (dialog.open) dialog.close(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, [open, initialFocus]);
  useEffect(() => { if (!open) setConfirmDiscard(false); }, [open]);
  useLayoutEffect(() => { if (confirmDiscard) ref.current?.querySelector<HTMLButtonElement>('[data-keep-editing]')?.focus(); }, [confirmDiscard]);
  if (!open) return null;
  const cancelDiscard = () => { setConfirmDiscard(false); requestAnimationFrame(() => (initialFocus?.current ?? (content.current && focusable(content.current)[0]) ?? ref.current)?.focus()); };
  return <dialog ref={ref} className={'xm-modal xm-' + kind + ' xm-dialog-' + width} data-testid={testId} tabIndex={-1} aria-modal="true" aria-labelledby={titleId} aria-describedby={subtitle ? subtitleId : undefined} onCancel={event => { event.preventDefault(); if (confirmDiscard) cancelDiscard(); else requestClose(); }} onClick={event => {
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
  }}>
    <header>{Icon && <Icon size={20} aria-hidden="true" />}<div><h2 id={titleId}>{title}</h2>{subtitle && <small id={subtitleId}>{subtitle}</small>}</div><button type="button" data-modal-close="true" className="xm-icon-btn" aria-label={t('close')} onClick={requestClose} disabled={busy}><X size={18} aria-hidden="true" /></button></header>
    <div ref={content} className="xm-modal-content" hidden={confirmDiscard}><div className="xm-dialog-body">{children}</div>{footer && <footer>{footer}</footer>}</div>
    {confirmDiscard && <div className="xm-discard" role="alert"><h3>{t('discardTitle')}</h3><p>{t('discardBody')}</p><div><Button data-keep-editing="true" onClick={cancelDiscard}>{t('keepEditing')}</Button><Button variant="danger" onClick={() => { setConfirmDiscard(false); onClose(); }}>{t('discard')}</Button></div></div>}
  </dialog>;
}
export function Dialog(props: ModalProps & { width?: 480 | 640 }) { return <Modal {...props} kind="dialog" />; }
export function Drawer(props: ModalProps) { return <Modal {...props} kind="drawer" />; }
export function Confirm({ open = true, title, body, okLabel, cancelLabel, danger, requireAck, ackLabel, onOk, onClose, loading, testId }: BaseProps & { open?: boolean; title: ReactNode; body: ReactNode; okLabel: string; cancelLabel?: string; danger?: boolean; requireAck?: boolean; ackLabel?: string; onOk: () => void; onClose?: () => void; loading?: boolean }) {
  const [ack, setAck] = useState(false); const [dismissed, setDismissed] = useState(false); const t = useUiText(); const initial = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!open) { setAck(false); setDismissed(false); } }, [open]);
  const close = () => { if (loading) return; if (onClose) onClose(); else setDismissed(true); };
  return <Dialog open={open && !dismissed} title={title} onClose={close} initialFocus={initial} busy={loading} testId={testId} footer={<><Button ref={initial} onClick={close} disabled={loading}>{cancelLabel ?? t('cancel')}</Button><Button variant={danger ? 'danger' : 'primary'} disabled={Boolean(requireAck && !ack)} loading={loading} onClick={onOk}>{okLabel}</Button></>}>{body}{requireAck && <label className="xm-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />{ackLabel ?? t('acknowledge')}</label>}</Dialog>;
}
