import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import { Progress } from './core';
import { useUiText, type BaseProps, type Icon, type Tone } from './shared';

export function Notice({ tone, icon: Icon = Info, title, body, actions, onDismiss, progress, testId }: BaseProps & { tone: Tone; icon?: Icon; title: ReactNode; body: ReactNode; actions?: ReactNode; onDismiss?: () => void; progress?: number }) {
  const t = useUiText();
  return <aside className={'xm-notice xm-tone-' + tone} data-testid={testId} role={tone === 'bad' ? 'alert' : 'status'}><Icon size={18} aria-hidden="true" /><div><strong>{title}</strong><div className="xm-notice-body">{body}</div>{actions && <div className="xm-notice-actions">{actions}</div>}{typeof progress === 'number' && <Progress value={progress} />}</div>{onDismiss && <button className="xm-icon-btn" aria-label={t('close')} onClick={onDismiss} type="button"><X size={16} aria-hidden="true" /></button>}</aside>;
}
type ToastItem = { id: number; text: string; tone: Tone };
const ToastContext = createContext<{ show: (text: string, tone?: Tone) => void }>({ show: () => undefined });
// 2.4s covers about a dozen characters at the ~5 characters per second a
// first-time user reads; every character beyond that buys 0.2s, capped so a
// long line cannot pin the corner of the window for good.
const toastBaseMs = 2400;
const toastBaseCharacters = 12;
const toastPerCharacterMs = 200;
const toastMaxMs = 10000;
// Warnings and errors usually tell the user what to do next, so they stay until
// dismissed (null) instead of racing the reader.
export function toastDurationMs(text: string, tone: Tone = 'neutral'): number | null {
  if (tone === 'warn' || tone === 'bad') return null;
  const characters = Array.from(text.replace(/\s+/g, '')).length;
  return Math.min(toastMaxMs, toastBaseMs + Math.max(0, characters - toastBaseCharacters) * toastPerCharacterMs);
}
export function ToastProvider({ children, testId }: BaseProps & { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]); const sequence = useRef(0);
  const show = useCallback((text: string, tone: Tone = 'neutral') => {
    const id = ++sequence.current; setItems(current => [...current.slice(-2), { id, text, tone }]);
  }, []);
  const dismiss = useCallback((id: number) => { setItems(current => current.filter(item => item.id !== id)); }, []);
  return <ToastContext.Provider value={{ show }}>{children}<div className="xm-toasts" data-testid={testId} aria-live="polite" aria-atomic="false">{items.map(item => <TimedToast key={item.id} id={item.id} text={item.text} tone={item.tone} onDismiss={dismiss} />)}</div></ToastContext.Provider>;
}
// Each toast owns its countdown so hovering one pauses only that one; the
// remaining time survives the pause instead of restarting from the full length.
function TimedToast({ id, text, tone, onDismiss }: { id: number; text: string; tone: Tone; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false); const remaining = useRef(toastDurationMs(text, tone));
  useEffect(() => {
    if (paused || remaining.current === null) return;
    const startedAt = Date.now(); const timer = window.setTimeout(() => onDismiss(id), remaining.current);
    return () => { window.clearTimeout(timer); if (remaining.current !== null) remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt)); };
  }, [id, onDismiss, paused]);
  const sticky = remaining.current === null;
  return <Toast text={text} tone={tone} onDismiss={sticky ? () => onDismiss(id) : undefined} onPause={() => setPaused(true)} onResume={() => setPaused(false)} />;
}
export function Toast({ text, tone = 'neutral', onDismiss, onPause, onResume, testId }: BaseProps & { text: ReactNode; tone?: Tone; onDismiss?: () => void; onPause?: () => void; onResume?: () => void }) {
  const t = useUiText();
  return <div className={'xm-toast xm-tone-' + tone} data-testid={testId} role="status" onMouseEnter={onPause} onMouseLeave={onResume} onFocus={onPause} onBlur={onResume}><span>{text}</span>{onDismiss && <button className="xm-toast-close" aria-label={t('close')} onClick={onDismiss} type="button"><X size={14} aria-hidden="true" /></button>}</div>;
}
export function useToast() { return useContext(ToastContext); }
