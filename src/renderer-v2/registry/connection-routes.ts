import { relayRoutePreferenceAllowed } from '../../../electron/relay-sites';
import type { RelayRoutePreference, RelayRoutePreferences } from '../../../electron/relay-sites';

// 说明和下面的选项名都是直连适配方案第六节第 1、2 条的原话（yoyo 10-6 回「改」）。
export const connectionRouteSettings = [
  { siteId: 'solov', id: 'relay-route-solov', label: '星芒账号线路', description: '自动会先走直连，直连连不上时改走默认线路。保存后重启星芒生效，不会切换账号。' },
  { siteId: 'solov-api', id: 'relay-route-solov-api', label: '历史账号线路', description: '历史账号单独设置，用法和上面一样。保存后重启星芒生效，不会切换账号。' },
] as const;

export interface ConnectionRoutePreferences {
  relayEndpointIds?: RelayRoutePreferences;
  activeRelayEndpointIds?: RelayRoutePreferences;
}

const connectionRouteChoices: ReadonlyArray<{ value: RelayRoutePreference; label: string }> = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'direct', label: '只用直连' },
  { value: 'primary', label: '只用默认线路' },
];

export function connectionRouteOptions(siteId: string): Array<{ value: string; label: string }> {
  return connectionRouteChoices
    .filter((choice) => relayRoutePreferenceAllowed(siteId, choice.value))
    .map((choice) => ({ value: choice.value, label: choice.label }));
}

/** Nothing stored means 'auto'; a choice saved before 'auto' existed keeps meaning that one line. */
export function connectionRouteSelection(settings: ConnectionRoutePreferences, siteId: (typeof connectionRouteSettings)[number]['siteId']): RelayRoutePreference {
  return settings.relayEndpointIds?.[siteId] ?? 'auto';
}

export function connectionRouteNeedsRestart(settings: ConnectionRoutePreferences): boolean {
  return connectionRouteSettings.some(({ siteId }) => connectionRouteSelection(settings, siteId) !== (settings.activeRelayEndpointIds?.[siteId] ?? 'auto'));
}

/** Keep each site's choice separate; a future site's settings must survive changing this one. */
export function buildConnectionRoutePatch(settings: ConnectionRoutePreferences, siteId: string, value: string): { relayEndpointIds: RelayRoutePreferences } | null {
  if (!connectionRouteSettings.some((route) => route.siteId === siteId)) return null;
  if (!relayRoutePreferenceAllowed(siteId, value)) return null;
  return { relayEndpointIds: { ...settings.relayEndpointIds, [siteId]: value } };
}
