/** Customer-visible prices are USD per million tokens, before the group ratio. */
export interface NewApiAccountUsageUnitPrices {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheCreation: number | null
  cacheCreation5m: number | null
  cacheCreation1h: number | null
  imageInput: number | null
  imageOutput: number | null
  audioInput: number | null
  audioOutput: number | null
}

export interface NewApiAccountUsagePricingTier {
  label: string
  conditions: Array<{
    variable: 'input' | 'output' | 'length'
    operator: '<' | '<=' | '>' | '>='
    value: number
  }>
  prices: NewApiAccountUsageUnitPrices
}

export interface NewApiAccountUsagePricing {
  unitPrices?: NewApiAccountUsageUnitPrices
  pricingTiers?: NewApiAccountUsagePricingTier[]
}

const priceFields = {
  p: 'input', c: 'output', cr: 'cacheRead', cc: 'cacheCreation',
  cc1h: 'cacheCreation1h', img: 'imageInput', img_o: 'imageOutput',
  ai: 'audioInput', ao: 'audioOutput',
} as const
const conditionFields = { p: 'input', c: 'output', len: 'length' } as const
const maxExpressionLength = 32_768
const maxTokens = 4_096
const maxTiers = 32
const maxConditions = 8
const numericLiteral = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function emptyPrices(): NewApiAccountUsageUnitPrices {
  return {
    input: null, output: null, cacheRead: null, cacheCreation: null,
    cacheCreation5m: null, cacheCreation1h: null, imageInput: null,
    imageOutput: null, audioInput: null, audioOutput: null,
  }
}

function price(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function product(left: number | null, right: unknown): number | null {
  const multiplier = price(right)
  return left === null || multiplier === null ? null : price(left * multiplier)
}

/**
 * The server writes the billing expression used for this request to expr_b64.
 * Accept only the visual editor's linear tier/conditional grammar. This is a
 * data parser, never an expression evaluator: no calls, executable strings or
 * raw expression data reach the renderer. An unfamiliar formula stays unknown
 * instead of extracting a coefficient from only part of its calculation.
 */
class TierParser {
  private cursor = 0
  private tierCount = 0

  constructor(private readonly tokens: string[]) {}

  parse(): NewApiAccountUsagePricingTier[] {
    const tiers = this.chain(0)
    if (this.cursor !== this.tokens.length) throw new Error('Trailing pricing expression')
    return tiers
  }

  private take(expected: string): void {
    if (this.tokens[this.cursor++] !== expected) throw new Error('Unsupported pricing syntax')
  }

  private number(): number {
    const token = this.tokens[this.cursor++] ?? ''
    const value = Number(token)
    if (!numericLiteral.test(token) || !Number.isFinite(value) || value < 0) {
      throw new Error('Invalid pricing number')
    }
    return value
  }

  private linear(): NewApiAccountUsageUnitPrices {
    const result = emptyPrices()
    let terms = 0
    do {
      if (terms++) this.take('+')
      if (terms > Object.keys(priceFields).length) throw new Error('Too many pricing terms')
      const variable = this.tokens[this.cursor++] as keyof typeof priceFields
      if (!Object.hasOwn(priceFields, variable)) throw new Error('Unsupported price variable')
      const field = priceFields[variable]
      if (result[field] !== null) throw new Error('Duplicate price variable')
      this.take('*')
      result[field] = this.number()
    } while (this.tokens[this.cursor] === '+')
    return result
  }

  private tier(): NewApiAccountUsagePricingTier {
    if (++this.tierCount > maxTiers) throw new Error('Too many pricing tiers')
    this.take('tier')
    this.take('(')
    const token = this.tokens[this.cursor++] ?? ''
    if (!token.startsWith('"')) throw new Error('Invalid tier label')
    const label: unknown = JSON.parse(token)
    if (typeof label !== 'string' || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw new Error('Invalid tier label')
    }
    this.take(',')
    const prices = this.linear()
    this.take(')')
    return { label, conditions: [], prices }
  }

  private conditions(): NewApiAccountUsagePricingTier['conditions'] {
    const conditions: NewApiAccountUsagePricingTier['conditions'] = []
    do {
      if (conditions.length) this.take('&&')
      if (conditions.length >= maxConditions) throw new Error('Too many tier conditions')
      const variable = this.tokens[this.cursor++] as keyof typeof conditionFields
      const operator = this.tokens[this.cursor++]
      if (!Object.hasOwn(conditionFields, variable)
        || !['<', '<=', '>', '>='].includes(operator)) throw new Error('Unsupported tier condition')
      conditions.push({
        variable: conditionFields[variable],
        operator: operator as NewApiAccountUsagePricingTier['conditions'][number]['operator'],
        value: this.number(),
      })
    } while (this.tokens[this.cursor] === '&&')
    return conditions
  }

  private chain(depth: number): NewApiAccountUsagePricingTier[] {
    if (depth > maxTiers) throw new Error('Pricing expression nesting limit')
    if (this.tokens[this.cursor] === '(') {
      this.take('(')
      const result = this.chain(depth + 1)
      this.take(')')
      return result
    }
    if (this.tokens[this.cursor] === 'tier') return [this.tier()]
    if (Object.hasOwn(conditionFields, this.tokens[this.cursor])
      && ['<', '<=', '>', '>='].includes(this.tokens[this.cursor + 1])) {
      const conditions = this.conditions()
      this.take('?')
      const tier = this.tier()
      tier.conditions = conditions
      this.take(':')
      return [tier, ...this.chain(depth + 1)]
    }
    // The editor emits p * 0 + c * 0 as the fall-through for a single
    // conditional tier. It has no label and must never be shown as a match.
    const fallback = this.linear()
    if (Object.values(fallback).some((value) => value !== null && value !== 0)) {
      throw new Error('Unlabelled pricing tier')
    }
    return []
  }
}

function tokenize(body: string): string[] {
  const tokenPattern = /\s+|"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-z_][a-z_0-9]*|<=|>=|&&|[()+*,:?<>]/y
  const tokens: string[] = []
  let cursor = 0
  while (cursor < body.length) {
    tokenPattern.lastIndex = cursor
    const match = tokenPattern.exec(body)
    if (!match || tokens.length >= maxTokens) throw new Error('Invalid pricing token')
    cursor = tokenPattern.lastIndex
    if (match[0].trim()) tokens.push(match[0])
  }
  return tokens
}

export function parseUsagePricingTiers(encoded: unknown): NewApiAccountUsagePricingTier[] {
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(maxExpressionLength / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return []
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > maxExpressionLength) return []
    const expression = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    const body = expression.replace(/^v[12]:\s*/, '')
    return new TierParser(tokenize(body)).parse()
  } catch {
    return []
  }
}

function normalizedLabel(label: string): string {
  return label.replace(/\s+/g, '').toLowerCase()
}

export function parseNewApiUsagePricing(other: Record<string, unknown>): NewApiAccountUsagePricing {
  if (other.billing_mode === 'tiered_expr') {
    const pricingTiers = parseUsagePricingTiers(other.expr_b64)
    if (!pricingTiers.length) return {}
    const matchedLabel = typeof other.matched_tier === 'string' ? normalizedLabel(other.matched_tier) : ''
    const matching = matchedLabel ? pricingTiers.filter((tier) => normalizedLabel(tier.label) === matchedLabel) : []
    return {
      pricingTiers,
      ...(matching.length === 1 ? { unitPrices: { ...matching[0].prices } } : {}),
    }
  }
  // model_price is a per-call price; zero/negative means per-token in new-api.
  if (typeof other.model_price === 'number' && other.model_price > 0) return {}
  const input = product(price(other.model_ratio), 2)
  if (input === null) return {}
  return {
    unitPrices: {
      input,
      output: product(input, other.completion_ratio),
      cacheRead: product(input, other.cache_ratio),
      cacheCreation: product(input, other.cache_creation_ratio),
      cacheCreation5m: product(input, other.cache_creation_ratio_5m),
      cacheCreation1h: product(input, other.cache_creation_ratio_1h),
      imageInput: product(input, other.image_ratio),
      imageOutput: null,
      audioInput: product(input, other.audio_ratio),
      // Audio output is relative to the audio input tariff in new-api's
      // calculateAudioQuota, so both audio ratios are required.
      audioOutput: product(product(input, other.audio_ratio), other.audio_completion_ratio),
    },
  }
}
