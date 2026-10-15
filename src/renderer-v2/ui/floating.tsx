import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Check, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { focusable, useUiText, type BaseProps, type Icon } from './shared';
import { Button } from './core';

type TriggerProps = { onClick?: (event: MouseEvent) => void; 'aria-expanded'?: boolean; 'aria-controls'?: string; 'aria-haspopup'?: 'menu' | 'dialog' };
function Trigger({ anchor, open, id, kind, label, toggle }: { anchor: ReactNode; open: boolean; id: string; kind: 'menu' | 'dialog'; label: string; toggle: () => void }) {
  if (isValidElement<TriggerProps>(anchor) && (anchor.type === Button || anchor.type === 'button')) {
    return cloneElement(anchor as ReactElement<TriggerProps>, { 'aria-expanded': open, 'aria-controls': open ? id : undefined, 'aria-haspopup': kind, onClick: event => { anchor.props.onClick?.(event); if (!event.defaultPrevented) toggle(); } });
  }
  return <button type="button" className="xm-icon-btn" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup={kind} onClick={toggle}>{anchor ?? <MoreHorizontal size={18} aria-hidden="true" />}</button>;
}
// align: which edge of the trigger the panel lines up with. A picker at the left end of a toolbar opens
// along its left edge, so the list reads from where the eye already is.
function useFloating(open: boolean, onClose?: () => void, align: 'start' | 'end' = 'end') {
  const anchor = useRef<HTMLSpanElement>(null); const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const latest = useRef(onClose); latest.current = onClose;
  useLayoutEffect(() => {
    if (!open || !panel.current || !anchor.current) return;
    const element = panel.current; element.setAttribute('popover', 'manual'); element.showPopover();
    const place = () => {
      const trigger = anchor.current!.getBoundingClientRect(); const bounds = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(align === 'start' ? trigger.left : trigger.right - bounds.width, window.innerWidth - bounds.width - 8));
      const top = trigger.bottom + 6 + bounds.height <= window.innerHeight - 8 ? trigger.bottom + 6 : Math.max(8, trigger.top - bounds.height - 6);
      setPosition({ left, top, visibility: 'visible' });
    };
    place(); const observer = new ResizeObserver(place); observer.observe(element);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (element.matches(':popover-open')) element.hidePopover(); };
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) latest.current?.(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const restore = () => anchor.current?.querySelector<HTMLButtonElement>('button')?.focus();
  return { anchor, panel, position, restore };
}
export type MenuItem = { label: string; icon?: Icon; danger?: boolean; disabled?: boolean; testId?: string; onSelect: () => void };
// A row-level overflow trigger reads as a bare "more" button to a screen reader,
// so the label is required rather than defaulted: twenty key rows each offering
// "revoke" behind an unnamed menu is indistinguishable by ear.
export function Menu({ items, anchor, testId, label }: BaseProps & { items: Array<MenuItem | 'divider'> | 'divider'; anchor: ReactNode; label: string }) {
  const [open, setOpen] = useState(false); const id = useId();
  const float = useFloating(open, () => setOpen(false)); const search = useRef({ text: '', at: 0 });
  const entries = items === 'divider' ? [] : items;
  const close = (restore = true) => { setOpen(false); if (restore) float.restore(); };
  useEffect(() => { if (open && float.position.visibility === 'visible' && float.panel.current) focusable(float.panel.current)[0]?.focus(); }, [open, float.position.visibility]);
  return <span className="xm-menu" data-testid={testId} ref={float.anchor}><Trigger anchor={anchor} open={open} id={id} kind="menu" label={label} toggle={() => setOpen(value => !value)} />{open && <div id={id} ref={float.panel} className="xm-menu-pop" style={float.position} role="menu" aria-label={label} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    const options = focusable(event.currentTarget); const current = options.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') { close(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; options[index]?.focus();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); const now = Date.now(); search.current.text = now - search.current.at > 600 ? event.key : search.current.text + event.key; search.current.at = now;
      const candidate = options.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase())); candidate?.focus();
    }
  }}>{entries.map((item, index) => item === 'divider' ? <hr role="separator" key={'divider-' + index} /> : <button className={item.danger ? 'is-danger' : undefined} disabled={item.disabled} data-testid={item.testId} key={index} onClick={() => { close(); item.onSelect(); }} role="menuitem" type="button">{item.icon && <item.icon size={16} aria-hidden="true" />}{item.label}</button>)}</div>}</span>;
}
export function Popover({ anchor, title, children, onClose, testId, label }: BaseProps & { anchor: ReactNode; title?: ReactNode; children?: ReactNode; onClose?: () => void; label?: string }) {
  const [open, setOpen] = useState(false); const id = useId(); const t = useUiText();
  const close = (restore = true) => { setOpen(false); onClose?.(); if (restore) float.restore(); };
  const float = useFloating(open, () => close(false));
  useEffect(() => { if (open && float.position.visibility === 'visible' && float.panel.current) (focusable(float.panel.current)[0] ?? float.panel.current).focus(); }, [open, float.position.visibility]);
  return <span className="xm-popover" ref={float.anchor} data-testid={testId}><Trigger anchor={anchor} open={open} id={id} kind="dialog" label={label ?? t('popover')} toggle={() => { if (open) close(); else setOpen(true); }} />{open && <div id={id} tabIndex={-1} ref={float.panel} className="xm-popover-panel" style={float.position} role="dialog" aria-label={typeof title === 'string' ? title : label ?? t('popover')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>{title && <header><strong>{title}</strong><button type="button" className="xm-icon-btn" aria-label={t('close')} onClick={() => close()}><X size={16} aria-hidden="true" /></button></header>}{children}</div>}</span>;
}
export type ChoiceOption = { value: string; label: string; hint?: string; disabled?: boolean };
export type ChoiceSection = { label: string; value: string; options: ChoiceOption[]; onChange: (value: string) => void; keepOpen?: boolean; empty?: ReactNode; testId?: string };
export type ChoiceAction = { label: string; icon?: Icon; loading?: boolean; disabled?: boolean; keepOpen?: boolean; testId?: string; onSelect: () => void };
// Radio choices under headings, with plain actions at the bottom. A keepOpen section leaves the menu open
// after a pick: choosing a group changes the models listed under it, and picking one of those should not
// mean opening the menu again. A hint (a group's own description) is hidden from the item's name and read
// as its description instead, so the name stays the bare choice.
export function ChoiceMenu({ anchor, label, sections, actions = [], onOpen, align = 'end', testId }: BaseProps & { anchor: ReactNode; label: string; sections: ChoiceSection[]; actions?: ChoiceAction[]; onOpen?: () => void; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false); const id = useId();
  const float = useFloating(open, () => setOpen(false), align); const search = useRef({ text: '', at: 0 });
  const close = (restore = true) => { setOpen(false); if (restore) float.restore(); };
  useEffect(() => {
    if (!open || float.position.visibility !== 'visible' || !float.panel.current) return;
    (float.panel.current.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? focusable(float.panel.current)[0])?.focus();
  }, [open, float.position.visibility]);
  const pick = (section: ChoiceSection, value: string) => { if (!section.keepOpen) close(); section.onChange(value); };
  const run = (action: ChoiceAction) => { if (!action.keepOpen) close(); action.onSelect(); };
  return <span className="xm-menu" data-testid={testId} ref={float.anchor}><Trigger anchor={anchor} open={open} id={id} kind="menu" label={label} toggle={() => { if (!open) onOpen?.(); setOpen(value => !value); }} />{open && <div id={id} ref={float.panel} className="xm-menu-pop xm-choice-menu" style={float.position} role="menu" aria-label={label} onKeyDown={event => menuKeys(event, close, search.current)}>
    {sections.map((section, index) => <div key={index} role="group" aria-label={section.label} data-testid={section.testId}>
      {index > 0 && <hr role="separator" />}
      <div className="xm-menu-heading" aria-hidden="true">{section.label}</div>
      {section.options.length ? section.options.map((option, place) => {
        const checked = option.value === section.value; const hintId = id + '-' + index + '-' + place;
        return <button key={option.value} type="button" role="menuitemradio" aria-checked={checked} aria-describedby={option.hint ? hintId : undefined} disabled={option.disabled} title={option.hint} onClick={() => pick(section, option.value)}>
          {checked ? <Check size={15} aria-hidden="true" /> : <span className="xm-menu-check" aria-hidden="true" />}
          <span className="xm-menu-choice"><span>{option.label}</span>{option.hint && <small id={hintId} aria-hidden="true">{option.hint}</small>}</span>
        </button>;
      }) : section.empty && <p className="xm-menu-empty">{section.empty}</p>}
    </div>)}
    {actions.length > 0 && <hr role="separator" />}
    {actions.map((action, index) => <button key={index} type="button" role="menuitem" disabled={action.disabled || action.loading} aria-busy={action.loading || undefined} data-testid={action.testId} onClick={() => run(action)}>{action.loading ? <RefreshCw className="xm-spin" size={16} aria-hidden="true" /> : action.icon && <action.icon size={16} aria-hidden="true" />}{action.label}</button>)}
  </div>}</span>;
}
function menuKeys(event: KeyboardEvent<HTMLDivElement>, close: () => void, search: { text: string; at: number }) {
  if (event.nativeEvent.isComposing) return;
  const options = focusable(event.currentTarget); const current = options.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  else if (event.key === 'Tab') { close(); }
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; options[index]?.focus();
  } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); const now = Date.now(); search.text = now - search.at > 600 ? event.key : search.text + event.key; search.at = now;
    const candidate = options.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(search.text.toLocaleLowerCase())); candidate?.focus();
  }
}
