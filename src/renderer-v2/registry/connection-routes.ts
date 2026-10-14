import { relayRoutePreferenceAllowed } from '../../../electron/relay-sites';
import type { RelayRoutePreference, RelayRoutePreferences } from '../../../electron/relay-sites';

// 线路只叫线路1、线路2，不说在哪（yoyo 10-14「默认直连是线路1 然后洛杉矶加速是线路2 香港加速是线路3」）。
// 两个账号按入口对应：默认那条（CF）是线路1，直连（洛杉矶）是线路2，客服对报告时同一个名字指同一种入口。
// 星芒账号「自动」先走直连，所以它的说明是先走线路2；历史账号先走 CF（yoyo 10-14），先走线路1。
export const connectionRouteSettings = [
  { siteId: 'solov', id: 'relay-route-solov', label: '星芒账号线路', description: '自动会先走线路2，连不上时改走线路1。保存后重启星芒生效，不会切换账号。' },
  { siteId: 'solov-api', id: 'relay-route-solov-api', label: '历史账号线路', description: '自动会先走线路1，线路1连不上时改走线路2。保存后重启星芒生效，不会切换账号。' },
] as const;

export interface ConnectionRoutePreferences {
  relayEndpointIds?: RelayRoutePreferences;
  activeRelayEndpointIds?: RelayRoutePreferences;
}

// 存下的值不变（direct / primary），以前选「只用洛杉矶」「只用直连」的照旧认，显示成「只用线路2」。
// 线路1 排在线路2 前面。
const connectionRouteChoices: ReadonlyArray<{ value: RelayRoutePreference; label: string }> = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'primary', label: '只用线路1' },
  { value: 'direct', label: '只用线路2' },
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
