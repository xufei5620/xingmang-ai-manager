import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  antigravityDefaultModel,
  antigravityGatewayVariableNames,
  buildAntigravityGatewayEnvironment,
  buildAntigravityModelMenu,
  normalizeAntigravityGatewayUrl,
} from './antigravity-gateway'
import { isCliModelName } from './cli-model-defaults'
import { relayProviderBaseUrls } from './relay-sites'

const key = 'sk-0123456789abcdefABCDEF'

describe('buildAntigravityModelMenu', () => {
  it('puts every listed model on the menu with the default first', () => {
    expect(buildAntigravityModelMenu(['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon-high', 'gemini-3.7-flash-high']))
      .toEqual(['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-4-argon-high', 'gemini-3.7-flash-high'])
  })

  it('keeps the listed order when the default is not on the list', () => {
    expect(buildAntigravityModelMenu(['gemini-4-hydrogen', 'gemini-4-argon'])).toEqual(['gemini-4-hydrogen', 'gemini-4-argon'])
  })

  it('drops repeats and names that cannot sit in a comma separated list', () => {
    expect(buildAntigravityModelMenu([' gemini-4-argon ', 'gemini-4-argon', 'a,b', 'two words', '"quoted"', '', 'gemini-3.8-flash']))
      .toEqual(['gemini-3.8-flash', 'gemini-4-argon'])
  })
})

describe('normalizeAntigravityGatewayUrl', () => {
  it('accepts the Gemini address of every line of both account sites', () => {
    for (const siteId of ['solov', 'solov-api']) {
      for (const endpointId of ['primary', 'direct'] as const) {
        const url = relayProviderBaseUrls(siteId, endpointId).gemini
        expect(normalizeAntigravityGatewayUrl(url)).toBe(url)
        expect(normalizeAntigravityGatewayUrl(`${url}/`)).toBe(url)
      }
    }
  })

  it.each([
    ['plain http', 'http://xm.solov.cc'],
    ['a path', 'https://xm.solov.cc/v1'],
    ['a query', 'https://xm.solov.cc/?key=1'],
    ['a fragment', 'https://xm.solov.cc/#x'],
    ['credentials', 'https://user:pass@xm.solov.cc'],
    ['a host that is not a relay line', 'https://xm.solov.cc.evil.com'],
    ['a retired alias', 'https://38.147.105.28:8443'],
    ['no URL at all', 'xm.solov.cc'],
  ])('refuses %s', (_name, value) => {
    expect(() => normalizeAntigravityGatewayUrl(value)).toThrow('连接地址无效，未修改 Antigravity 的设置')
  })
})

describe('buildAntigravityGatewayEnvironment', () => {
  it('gives the four variables in order, the Gemini native protocol and the menu', () => {
    const environment = buildAntigravityGatewayEnvironment({
      baseUrl: 'https://xm-direct.solov.cc',
      apiKey: ` ${key} `,
      models: ['gemini-4-argon', 'gemini-3.8-flash'],
    })
    expect(Object.keys(environment)).toEqual([...antigravityGatewayVariableNames])
    expect(environment).toEqual({
      AGY_LLM_GATEWAY_URL: 'https://xm-direct.solov.cc',
      AGY_LLM_GATEWAY_API_KEY: key,
      AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'genai',
      AGY_LLM_GATEWAY_MODELS: 'gemini-3.8-flash,gemini-4-argon',
    })
  })

  it.each([
    ['empty', ''],
    ['too short', 'sk-1'],
    ['with a space', 'sk-0123 456789'],
    ['with a quote', "sk-0123456789'"],
    ['with a percent sign', 'sk-%USERPROFILE%'],
    ['with a dollar sign', 'sk-$(whoami)xx'],
    ['with a newline', 'sk-0123456789\nexport X=1'],
  ])('refuses a key that is %s', (_name, apiKey) => {
    expect(() => buildAntigravityGatewayEnvironment({ baseUrl: 'https://xm.solov.cc', apiKey, models: ['gemini-3.8-flash'] }))
      .toThrow('密钥格式无效，未修改 Antigravity 的设置')
  })

  it('refuses a key list with no usable model', () => {
    expect(() => buildAntigravityGatewayEnvironment({ baseUrl: 'https://xm.solov.cc', apiKey: key, models: ['a,b', ' '] }))
      .toThrow('当前密钥没有可用的模型，未修改 Antigravity 的设置')
  })

  it('refuses an address that is not a relay line before looking at the key', () => {
    expect(() => buildAntigravityGatewayEnvironment({ baseUrl: 'https://example.com', apiKey: '', models: [] }))
      .toThrow('连接地址无效')
  })
})

describe('antigravity-gateway with random inputs', () => {
  const modelName = fc.oneof(
    fc.constantFrom('gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-argon-high', 'gemini-3.1-pro-preview'),
    fc.string({ maxLength: 20 }),
  )

  it('keeps the menu to listed, distinct, list-safe names with the default first exactly when it was listed', () => {
    fc.assert(fc.property(fc.array(modelName, { maxLength: 12 }), (models) => {
      const menu = buildAntigravityModelMenu(models)
      const listed = new Set(models.map((model) => model.trim()))
      expect(new Set(menu).size).toBe(menu.length)
      for (const model of menu) {
        expect(listed.has(model)).toBe(true)
        expect(isCliModelName(model)).toBe(true)
        expect(model).not.toContain(',')
      }
      expect(menu[0] === antigravityDefaultModel).toBe(listed.has(antigravityDefaultModel))
      // Nothing listed and usable is left off.
      expect(menu.length).toBe([...listed].filter(isCliModelName).length)
    }))
  })

  it('never hands back a key or menu that could break out of a registry value or an export line', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), fc.array(modelName, { maxLength: 6 }), (apiKey, models) => {
      let environment
      try {
        environment = buildAntigravityGatewayEnvironment({ baseUrl: 'https://xm.solov.cc', apiKey, models })
      } catch {
        return
      }
      for (const value of Object.values(environment)) {
        expect(value).not.toMatch(/[\s'"`$%\\;&|<>()\x00-\x1f\x7f]/)
      }
    }))
  })
})
