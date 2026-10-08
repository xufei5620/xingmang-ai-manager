import { relayRoutePreferenceAllowed } from '../../../electron/relay-sites';
import type { RelayRoutePreference, RelayRoutePreferences } from '../../../electron/relay-sites';

// 说明和下面的选项名：星芒账号是 xm 三线路计划附录 A 的原话（yoyo 10-8 回「改」）；历史账号仍叫「直连 / 默认线路」，
// 说明改成自己完整的一句（同一处批的），意思和直连适配方案第六节第 2 条一样。
export const connectionRouteSettings = [
  { siteId: 'solov', id: 'relay-route-solov', label: '星芒账号线路', description: '自动会先走洛杉矶线路，连不上时改走 CF 线路。保存后重启星芒生效，不会切换账号。' },
  { siteId: 'solov-api', id: 'relay-route-solov-api', label: '历史账号线路', description: '自动会先走直连，直连连不上时改走默认线路。保存后重启星芒生效，不会切换账号。' },
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

// 星芒账号的两条线路叫洛杉矶、CF；存下的值不变（direct / primary），老设置照旧认。
const solovRouteChoiceLabels: Readonly<Record<RelayRoutePreference, string>> = {
  auto: '自动（推荐）',
  direct: '只用洛杉矶',
  primary: '只用 CF',
};

export function connectionRouteOptions(siteId: string): Array<{ value: string; label: string }> {
  return connectionRouteChoices
    .filter((choice) => relayRoutePreferenceAllowed(siteId, choice.value))
    .map((choice) => ({ value: choice.value, label: siteId === 'solov' ? solovRouteChoiceLabels[choice.value] : choice.label }));
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
