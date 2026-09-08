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
export function ToastProvider({ children, testId }: BaseProps & { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]); const sequence = useRef(0); const timers = useRef(new Set<number>());
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);
  const show = useCallback((text: string, tone: Tone = 'neutral') => {
    const id = ++sequence.current; setItems(current => [...current.slice(-2), { id, text, tone }]);
    const timer = window.setTimeout(() => { setItems(current => current.filter(item => item.id !== id)); timers.current.delete(timer); }, 2400); timers.current.add(timer);
  }, []);
  return <ToastContext.Provider value={{ show }}>{children}<div className="xm-toasts" data-testid={testId} aria-live="polite" aria-atomic="false">{items.map(item => <Toast key={item.id} text={item.text} tone={item.tone} />)}</div></ToastContext.Provider>;
}
export function Toast({ text, tone = 'neutral', testId }: BaseProps & { text: ReactNode; tone?: Tone }) { return <div className={'xm-toast xm-tone-' + tone} data-testid={testId} role="status">{text}</div>; }
export const useToast = () => useContext(ToastContext);
