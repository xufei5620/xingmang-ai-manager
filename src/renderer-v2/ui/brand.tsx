import { useEffect, useState } from 'react';
import { BriefcaseBusiness, CircleHelp, type LucideIcon } from 'lucide-react';
import { ChatGLMIcon, ClaudeIcon, DeepSeekIcon, GeminiIcon, GrokIcon, MiniMaxIcon, MoonshotIcon, OpenAIIcon, OpenCodeIcon, QwenIcon, ZhipuIcon } from './vendor-icons';
import { siAlipay, siGit, siNodedotjs, siNpm, siPython, siStripe, siWechat } from 'simple-icons';
import microLight from '../../../assets/brand/v3/micro32-standard.svg';
import microDark from '../../../assets/brand/v3/micro32-dark.svg';
import symbolLight from '../../../assets/brand/v3/symbol-standard.svg';
import symbolDark from '../../../assets/brand/v3/symbol-dark.svg';
import horizontalLight from '../../../assets/brand/v3/horizontal-standard.svg';
import horizontalDark from '../../../assets/brand/v3/horizontal-dark.svg';
import wordmarkLight from '../../../assets/brand/v3/wordmark-navy.svg';
import wordmarkDark from '../../../assets/brand/v3/wordmark-dark.svg';
import { tools } from '../registry/tools';
import { clientConnections } from '../registry/clients';
import type { PluginIconSource } from '../registry/plugin-icons';
import { useUiText, type BaseProps } from './shared';
import type { CSSProperties } from 'react';

export type ToolId = string;
const brandComponents = { Claude: ClaudeIcon, OpenAI: OpenAIIcon, Gemini: GeminiIcon, Grok: GrokIcon, DeepSeek: DeepSeekIcon, Qwen: QwenIcon, ChatGLM: ChatGLMIcon, Moonshot: MoonshotIcon, MiniMax: MiniMaxIcon, Zhipu: ZhipuIcon } as const;
const environmentBrands = { node: siNodedotjs, npm: siNpm, python: siPython, git: siGit, stripe: siStripe, alipay: siAlipay, wechat: siWechat } as const;
// 跟聊天模型菜单的分节（features/chat/state.ts 的 vendorPatterns）认同一批前缀：菜单把 sora、veo、qwq 这些归到哪家，
// 按钮和回复头像就画哪家的标。即梦在 vendor-icons 里没有现成的标，仍落到问号。
function modelBrand(model: string) { return /^claude/i.test(model) ? 'Claude' : /^(gpt|o\d|chatgpt|codex|dall-e|sora)/i.test(model) ? 'OpenAI' : /^(gemini|imagen|veo|nano-banana)/i.test(model) ? 'Gemini' : /^grok/i.test(model) ? 'Grok' : /^deepseek/i.test(model) ? 'DeepSeek' : /^(qwen|qwq|qvq)/i.test(model) ? 'Qwen' : /^(chatglm|glm)/i.test(model) ? 'ChatGLM' : /^(kimi|moonshot)/i.test(model) ? 'Moonshot' : /^(minimax|abab|hailuo)/i.test(model) ? 'MiniMax' : /^(zhipu|智谱|cogview)/i.test(model) ? 'Zhipu' : ''; }
export function BrandIcon({ tool, model, size = 24, variant = 'inline', testId }: BaseProps & { tool?: ToolId; model?: string; size?: number; variant?: 'tile' | 'inline' | 'xs' }) {
  const t = useUiText();
  const definition = tools.find(item => item.id === tool || item.name === tool) ?? clientConnections.find(item => item.id === tool || item.name === tool);
  const key = definition?.brandIcon ?? modelBrand(model ?? tool ?? '');
  const Icon = key === 'WorkBuddy' ? BriefcaseBusiness : key === 'OpenCode' ? OpenCodeIcon : brandComponents[key as keyof typeof brandComponents];
  const environment = environmentBrands[tool as keyof typeof environmentBrands];
  const imageSize = variant === 'tile' ? Math.round(size * .6) : size;
  return <span className={'xm-brand xm-brand-' + variant} style={{ width: size, height: size }} data-testid={testId}>
    {Icon ? <Icon size={imageSize} role="img" aria-label={definition?.vendor ?? model ?? tool ?? ''} /> : environment ? <svg viewBox="0 0 24 24" width={imageSize} height={imageSize} role="img" aria-label={environment.title} fill={'#' + environment.hex}><path d={environment.path} /></svg> : <CircleHelp size={imageSize} aria-label={t('unknownTool')} />}
  </span>;
}
// 深色界面里本身是黑色的品牌标（GitHub、Vercel）换成白色，不然看不见；别的照品牌色原样画。
function brandDarkFill(hex: string) {
  const channel = (offset: number) => { const value = parseInt(hex.slice(offset, offset + 2), 16) / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
  return .2126 * channel(0) + .7152 * channel(2) + .0722 * channel(4) < .08 ? '#ffffff' : '#' + hex;
}
/**
 * 「插件」页一行左边那个图标（扩展合并方案三、4 节）：目录自带的图片放在白底小方块上（深色界面也看得清，带深色版的换成深色版、
 * 底色跟着换深）；图标包里的品牌标照品牌色画；都没有的用表示用途的图标，再没有用 fallback。全是随包带的，不联网。
 */
export function PluginIcon({ source, fallback: Fallback, size = 38, testId }: BaseProps & { source: PluginIconSource | null; fallback: LucideIcon; size?: number }) {
  // 侧栏清单里那种 20 上下的小图标不画底板，图形要撑满；卡片上的留出底板的边。
  const small = size <= 24;
  const inner = Math.round(size * (small ? .8 : .55));
  if (source?.type === 'image') return <span className={'xm-plugin-icon is-image' + (source.dark ? ' has-dark' : '')} style={{ width: size, height: size }} data-testid={testId} aria-hidden="true">
    <img className="xm-plugin-icon-light" src={source.light} alt="" draggable={false} />{source.dark && <img className="xm-plugin-icon-dark" src={source.dark} alt="" draggable={false} />}
  </span>;
  if (source?.type === 'brand') return <span className="xm-plugin-icon is-brand" style={{ width: size, height: size, '--plugin-brand': '#' + source.icon.hex, '--plugin-brand-dark': brandDarkFill(source.icon.hex) } as CSSProperties} data-testid={testId} aria-hidden="true">
    <svg viewBox="0 0 24 24" width={inner} height={inner}><path d={source.icon.path} /></svg>
  </span>;
  const Glyph = source?.type === 'glyph' ? source.icon : Fallback;
  return <span className="xm-plugin-icon" style={{ width: size, height: size }} data-testid={testId} aria-hidden="true"><Glyph size={Math.round(size * (small ? .8 : .47))} /></span>;
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
