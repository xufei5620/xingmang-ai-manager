import { siAirtable, siAmd, siApollographql, siAppwrite, siAsana, siAtlassian, siAuth0, siBox, siBuildkite, siCircle, siClickhouse, siCloudflare, siCloudinary, siCockroachlabs, siCoderabbit, siConvex, siCoursera, siDash0, siDatabricks, siDatadog, siDiscord, siDropbox, siDuckdb, siDynatrace, siExpo, siFastly, siFigma, siFirebase, siGithub, siGitkraken, siGitlab, siGooglebigquery, siGooglechrome, siGooglecloud, siGooglecloudspanner, siGooglecloudstorage, siGrafana, siHostinger, siHubspot, siHuggingface, siImessage, siIntercom, siJfrog, siLaravel, siLinear, siLooker, siMapbox, siMercadopago, siMintlify, siMiro, siMlflow, siMongodb, siNeon, siNetlify, siNewrelic, siNotion, siNvidia, siOry, siPagerduty, siPaypal, siPlanetscale, siPosthog, siPostiz, siPostman, siPrisma, siPydantic, siQdrant, siQodo, siQuarkus, siQuickbooks, siRailway, siRedis, siRender, siResend, siRevenuecat, siSanity, siSap, siSentry, siShopify, siSnowflake, siSonarqubeserver, siSonatype, siSpotify, siStackhawk, siStripe, siSupabase, siTeamcity, siTelegram, siTerraform, siUnity, siUnrealengine, siUpstash, siVercel, siWix, siWordpress, siXcode, siZapier, siZoho, siZoom, siZyte, type SimpleIcon } from 'simple-icons';
import { Brain, Code2, FileText, Folder, GitPullRequest, Globe, GraduationCap, Hammer, LayoutTemplate, ListChecks, ListOrdered, Palette, Search, ShieldCheck, Sigma, type LucideIcon } from 'lucide-react';

/**
 * 「插件」页每一行左边那个图标从哪来（扩展合并方案三、4 节）：有官方图标用官方图标；目录里没带的查 Simple Icons 图标包；
 * 只有没有自己品牌的才用表示用途的图标（lucide），再没有由页面落到通用图标。全部随包带走，客户电脑上不联网、不读第三方的图标文件。
 */
export type PluginIconSource =
  | { type: 'image'; light: string; dark?: string }
  | { type: 'brand'; icon: SimpleIcon }
  | { type: 'glyph'; icon: LucideIcon };

/**
 * GPT 官方（OpenAI 插件目录）那批：scripts/build-plugin-icons.mjs 在我们这边按目录快照转好的 96×96 PNG，带深色版的另有 -dark。
 * 发版以后目录里新加的插件这里没有，落到通用图标，下一版重跑脚本补上。
 */
const codexIconFiles = import.meta.glob<string>('../../../bundled-catalog/plugin-icons/codex/*.png', { eager: true, query: '?url', import: 'default' });
export const codexPluginIcons: Readonly<Record<string, { light: string; dark?: string }>> = (() => {
  const icons: Record<string, { light: string; dark?: string }> = {};
  for (const [file, url] of Object.entries(codexIconFiles)) {
    const match = /\/([a-z0-9-]+?)(-dark)?\.png$/.exec(file);
    if (!match) continue;
    const entry = icons[match[1]] ?? (icons[match[1]] = { light: '' });
    if (match[2]) entry.dark = url;
    else entry.light = url;
  }
  return Object.fromEntries(Object.entries(icons).filter(([, entry]) => entry.light));
})();

/**
 * Claude 官方（Anthropic 官方市场）里第三方出的插件：市场清单没有图标这一项，按插件名对上 Simple Icons 里那一家的标。
 * 名字和出品方都对得上的、逐个看过的才进表（共 133 个，2026-11-20）；同一家的产品优先用产品自己的标。表外的落到通用图标。
 */
export const claudePluginBrands: Readonly<Record<string, SimpleIcon>> = {
  airtable: siAirtable,
  alloydb: siGooglecloud,
  'alloydb-omni': siGooglecloud,
  'amd-skills': siAmd,
  'apollo-skills': siApollographql,
  appwrite: siAppwrite,
  asana: siAsana,
  atlassian: siAtlassian,
  'atlassian-twg-cli': siAtlassian,
  auth0: siAuth0,
  'bigquery-data-analytics': siGooglebigquery,
  box: siBox,
  'build-with-wordpress': siWordpress,
  buildkite: siBuildkite,
  'catalyst-by-zoho': siZoho,
  'cds-mcp': siSap,
  'chrome-devtools-mcp': siGooglechrome,
  'circle-skills': siCircle,
  clickhouse: siClickhouse,
  'clickhouse-best-practices': siClickhouse,
  'cloud-sql-mysql': siGooglecloud,
  'cloud-sql-postgresql': siGooglecloud,
  'cloud-sql-sqlserver': siGooglecloud,
  cloudflare: siCloudflare,
  cloudinary: siCloudinary,
  cockroachdb: siCockroachlabs,
  coderabbit: siCoderabbit,
  confidence: siSpotify,
  context7: siUpstash,
  convex: siConvex,
  dash0: siDash0,
  'data-agent-kit': siGooglecloud,
  databricks: siDatabricks,
  datadog: siDatadog,
  dataproc: siGooglecloud,
  discord: siDiscord,
  dropbox: siDropbox,
  'duckdb-skills': siDuckdb,
  dynatrace: siDynatrace,
  expo: siExpo,
  'fastly-agent-toolkit': siFastly,
  figma: siFigma,
  firebase: siFirebase,
  'firestore-native': siGooglecloud,
  'forge-skills': siAtlassian,
  github: siGithub,
  gitkraken: siGitkraken,
  gitlab: siGitlab,
  'google-cloud-storage': siGooglecloudstorage,
  'grafana-assistant': siGrafana,
  'grafana-cloud-mcp': siGrafana,
  'grafana-mcp': siGrafana,
  hostinger: siHostinger,
  'hubspot-sales': siHubspot,
  'huggingface-skills': siHuggingface,
  imessage: siImessage,
  intercom: siIntercom,
  'intuit-quickbooks': siQuickbooks,
  jfrog: siJfrog,
  'knowledge-catalog': siGooglecloud,
  'laravel-boost': siLaravel,
  'learn-with-coursera': siCoursera,
  linear: siLinear,
  'liquid-lsp': siShopify,
  'liquid-skills': siShopify,
  logfire: siPydantic,
  looker: siLooker,
  lumen: siOry,
  mapbox: siMapbox,
  mercadopago: siMercadopago,
  mintlify: siMintlify,
  miro: siMiro,
  mlflow: siMlflow,
  'modern-web-guidance': siGooglechrome,
  mongodb: siMongodb,
  'mongodb-atlas': siMongodb,
  neon: siNeon,
  'netlify-skills': siNetlify,
  newrelic: siNewrelic,
  notion: siNotion,
  'nvidia-skills': siNvidia,
  oracledb: siGooglecloud,
  pagerduty: siPagerduty,
  paypal: siPaypal,
  planetscale: siPlanetscale,
  posthog: siPosthog,
  postiz: siPostiz,
  postman: siPostman,
  prisma: siPrisma,
  'pydantic-ai': siPydantic,
  'qdrant-skills': siQdrant,
  qodo: siQodo,
  'qodo-standards': siQodo,
  'quarkus-agent': siQuarkus,
  railway: siRailway,
  rc: siRevenuecat,
  'redis-development': siRedis,
  render: siRender,
  resend: siResend,
  revenuecat: siRevenuecat,
  sanity: siSanity,
  'sap-cds-mcp': siSap,
  'sap-hana-cli': siSap,
  'sap-mdk-server': siSap,
  'sap-ux-fiori-tools': siSap,
  'save-to-spotify': siSpotify,
  sentry: siSentry,
  'sentry-cli': siSentry,
  'shopify-ai-toolkit': siShopify,
  'snowflake-cortex-code': siSnowflake,
  sonarqube: siSonarqubeserver,
  'sonatype-guide': siSonatype,
  spanner: siGooglecloudspanner,
  'spotify-ads-api': siSpotify,
  'stackhawk-api': siStackhawk,
  'stackhawk-hawkscan': siStackhawk,
  stripe: siStripe,
  supabase: siSupabase,
  'teamcity-cli': siTeamcity,
  telegram: siTelegram,
  terraform: siTerraform,
  'ui-theme-designer': siSap,
  ui5: siSap,
  'ui5-modernization': siSap,
  'ui5-typescript-conversion': siSap,
  unity: siUnity,
  'unreal-engine-skills-for-claude-code': siUnrealengine,
  vercel: siVercel,
  wix: siWix,
  xcode: siXcode,
  zapier: siZapier,
  'zoom-plugin': siZoom,
  'zyte-web-data': siZyte,
};

/** Anthropic 自己出的插件没有单独的标，按市场里写的分类用表示用途的图标。 */
const categoryGlyphs = { development: Code2, productivity: ListChecks, security: ShieldCheck, learning: GraduationCap, math: Sigma, design: Palette } as const;
const anthropicPluginCategories: Readonly<Record<string, keyof typeof categoryGlyphs>> = {
  'agent-sdk-dev': 'development',
  'champion-kit': 'productivity',
  'clangd-lsp': 'development',
  'claude-code-setup': 'productivity',
  'claude-md-management': 'productivity',
  'claude-security': 'security',
  'code-modernization': 'development',
  'code-review': 'productivity',
  'code-simplifier': 'productivity',
  'commit-commands': 'productivity',
  'csharp-lsp': 'development',
  'cwc-makers': 'productivity',
  'explanatory-output-style': 'learning',
  'feature-dev': 'development',
  'frontend-design': 'development',
  'gopls-lsp': 'development',
  'hookify': 'productivity',
  'jdtls-lsp': 'development',
  'kotlin-lsp': 'development',
  'learning-output-style': 'learning',
  'lua-lsp': 'development',
  'math-olympiad': 'math',
  'math-proof': 'math',
  'mcp-apps': 'development',
  'mcp-server-dev': 'development',
  'mcp-tunnels': 'development',
  'php-lsp': 'development',
  'playground': 'development',
  'plugin-dev': 'development',
  'pr-review-toolkit': 'productivity',
  'project-artifact': 'productivity',
  'pyright-lsp': 'development',
  'ralph-loop': 'development',
  'receipts': 'productivity',
  'ruby-lsp': 'development',
  'rust-analyzer-lsp': 'development',
  'security-guidance': 'security',
  'session-report': 'productivity',
  'skill-creator': 'development',
  'swift-lsp': 'development',
  'theme-examples': 'design',
  'typescript-lsp': 'development',
};

/**
 * 星芒精选：GitHub 用它自己的标；「浏览器」是微软 Playwright 出的，图标包里没有微软的标，用地球；MCP 官方示例工具和
 * Anthropic 出的那几个没有单独的标，用表示用途的图标。键是精选清单里的 id，清单里新加的落到按类型的通用图标。
 */
const curatedGlyphs: Readonly<Record<string, LucideIcon>> = {
  files: Folder, memory: Brain, 'sequential-thinking': ListOrdered, browser: Globe,
  'code-review': Search, 'commit-commands': GitPullRequest, 'feature-dev': Hammer, 'frontend-design': LayoutTemplate, 'claude-md-management': FileText,
};
const curatedBrands: Readonly<Record<string, SimpleIcon>> = { github: siGithub };

export function curatedPluginIcon(id: string): PluginIconSource | null {
  const brand = curatedBrands[id];
  if (brand) return { type: 'brand', icon: brand };
  const glyph = curatedGlyphs[id];
  return glyph ? { type: 'glyph', icon: glyph } : null;
}

/** 官方目录里一个插件（名字是 插件名@市场名 里 @ 前面那段）用哪个图标；对不上的回 null，页面用通用图标。 */
export function officialPluginIcon(vendor: 'claude' | 'codex', name: string): PluginIconSource | null {
  if (vendor === 'codex') {
    const image = codexPluginIcons[name];
    return image ? { type: 'image', ...image } : null;
  }
  const brand = claudePluginBrands[name];
  if (brand) return { type: 'brand', icon: brand };
  const category = anthropicPluginCategories[name];
  return category ? { type: 'glyph', icon: categoryGlyphs[category] } : null;
}
