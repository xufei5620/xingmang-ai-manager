import { useEffect, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import ClaudeIcon from '@lobehub/icons/es/Claude/components/Color';
import OpenAIIcon from '@lobehub/icons/es/OpenAI/components/Mono';
import GeminiIcon from '@lobehub/icons/es/Gemini/components/Color';
import GrokIcon from '@lobehub/icons/es/Grok/components/Mono';
import { siAlipay, siNodedotjs, siNpm, siPython, siStripe, siWechat } from 'simple-icons';
import microLight from '../../../assets/brand/v3/micro32-standard.svg';
import microDark from '../../../assets/brand/v3/micro32-dark.svg';
import symbolLight from '../../../assets/brand/v3/symbol-standard.svg';
import symbolDark from '../../../assets/brand/v3/symbol-dark.svg';
import horizontalLight from '../../../assets/brand/v3/horizontal-standard.svg';
import horizontalDark from '../../../assets/brand/v3/horizontal-dark.svg';
import wordmarkLight from '../../../assets/brand/v3/wordmark-navy.svg';
import wordmarkDark from '../../../assets/brand/v3/wordmark-dark.svg';
import { tools } from '../registry/tools';
import { useUiText, type BaseProps } from './shared';

export type ToolId = string;
const brandComponents = { Claude: ClaudeIcon, OpenAI: OpenAIIcon, Gemini: GeminiIcon, Grok: GrokIcon } as const;
const environmentBrands = { node: siNodedotjs, npm: siNpm, python: siPython, stripe: siStripe, alipay: siAlipay, wechat: siWechat } as const;
const modelBrand = (model: string) => /^claude/i.test(model) ? 'Claude' : /^(gpt|o[134]|chatgpt|codex)/i.test(model) ? 'OpenAI' : /^gemini/i.test(model) ? 'Gemini' : /^grok/i.test(model) ? 'Grok' : '';
export function BrandIcon({ tool, model, size = 24, variant = 'inline', testId }: BaseProps & { tool?: ToolId; model?: string; size?: number; variant?: 'tile' | 'inline' | 'xs' }) {
  const t = useUiText();
  const definition = tools.find(item => item.id === tool || item.name === tool);
  const key = definition?.brandIcon ?? modelBrand(model ?? tool ?? '');
  const Icon = brandComponents[key as keyof typeof brandComponents];
  const environment = environmentBrands[tool as keyof typeof environmentBrands];
  const imageSize = variant === 'tile' ? Math.round(size * .6) : size;
  return <span className={'xm-brand xm-brand-' + variant} style={{ width: size, height: size }} data-testid={testId}>
    {Icon ? <Icon size={imageSize} role="img" aria-label={definition?.vendor ?? model ?? tool ?? ''} /> : environment ? <svg viewBox="0 0 24 24" width={imageSize} height={imageSize} role="img" aria-label={environment.title} fill={'#' + environment.hex}><path d={environment.path} /></svg> : <CircleHelp size={imageSize} aria-label={t('unknownTool')} />}
  </span>;
}
const logoSources = { micro: [microLight, microDark], symbol: [symbolLight, symbolDark], horizontal: [horizontalLight, horizontalDark], wordmark: [wordmarkLight, wordmarkDark] } as const;
export function Logo({ kind = 'horizontal', height = 32, testId }: BaseProps & { kind?: keyof typeof logoSources; height?: number }) {
  const t = useUiText();
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setDark(document.documentElement.dataset.theme === 'dark');
    return () => observer.disconnect();
  }, []);
  return <img className={'xm-logo xm-logo-' + kind} src={logoSources[kind][dark ? 1 : 0]} alt={t('brand')} height={height} data-testid={testId} />;
}
export function Kbd({ keys, testId }: BaseProps & { keys: string }) {
  const platform = typeof document === 'undefined' ? undefined : document.documentElement.dataset.os;
  const mac = platform ? platform === 'mac' : typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return <kbd className="xm-kbd" data-testid={testId}>{mac ? keys : keys.replaceAll('⌘', 'Ctrl')}</kbd>;
}
