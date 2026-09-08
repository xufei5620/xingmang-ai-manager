import { createContext, useContext, useEffect } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Icon = LucideIcon;
export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'neutral';
export type Size = 'md' | 'sm' | 'xs';
export type BaseProps = { testId?: string };
export const cx = (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ');
export const iconSize: Record<Size, number> = { md: 18, sm: 16, xs: 14 };

const copy = {
  close: '关闭', cancel: '取消', expand: '展开', collapse: '收起', show: '显示密码', hide: '隐藏密码',
  search: '搜索', more: '更多操作', open: '打开', archived: '已归档', brand: '星芒 AI',
  discardTitle: '要放弃未保存的修改吗？', discardBody: '关闭后，这次修改不会保存。',
  keepEditing: '继续编辑', discard: '放弃修改', acknowledge: '我已了解影响',
  loading: '正在加载', progress: '进度', notifications: '通知', unknownTool: '其他工具',
  dialog: '详情', menu: '操作', popover: '说明',
  skip: '跳过', next: '下一步', start: '开始使用',
} as const;
type CopyKey = keyof typeof copy;
const CopyContext = createContext<(key: CopyKey) => string>(key => copy[key]);
export const UiCopyProvider = CopyContext.Provider;
export const useUiText = () => useContext(CopyContext);
const BalanceTierContext = createContext<'ok' | 'warn' | 'bad' | 'zero' | 'neutral'>('neutral');
export const BalanceTierProvider = BalanceTierContext.Provider;
export const useBalanceTier = () => useContext(BalanceTierContext);

export function useReducedMotion() {
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { document.documentElement.dataset.systemReducedMotion = String(query.matches); };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
}

export function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]'))
    .filter(el => !el.matches(':disabled, [tabindex="-1"]') && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}
