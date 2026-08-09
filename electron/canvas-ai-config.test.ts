import { describe, expect, it } from 'vitest'
import {
  buildCanvasAiConfigInjection,
  canvasAiConfigHasApiKey,
  canvasAiConfigStorageKey,
  type CanvasAuthToken,
} from './canvas-ai-config'

const token: CanvasAuthToken = { baseUrl: 'https://xm.solov.cc', apiKey: 'sk-relay-secret' }

describe('canvasAiConfigStorageKey', () => {
  it('matches the literal zustand persist key infinite-canvas uses', () => {
    expect(canvasAiConfigStorageKey).toBe('infinite-canvas:ai_config_store')
  })
})

describe('canvasAiConfigHasApiKey', () => {
  it('is false for no stored value', () => {
    expect(canvasAiConfigHasApiKey(null)).toBe(false)
  })

  it('is false for malformed JSON', () => {
    expect(canvasAiConfigHasApiKey('{not json')).toBe(false)
  })

  it('is false when config.apiKey is empty and there are no channels', () => {
    const raw = JSON.stringify({ state: { config: { apiKey: '' } }, version: 0 })
    expect(canvasAiConfigHasApiKey(raw)).toBe(false)
  })

  it('is true when the top-level apiKey is set', () => {
    const raw = JSON.stringify({ state: { config: { apiKey: 'sk-user-typed' } }, version: 0 })
    expect(canvasAiConfigHasApiKey(raw)).toBe(true)
  })

  it('is true when any channel (not just "default") already has a key', () => {
    const raw = JSON.stringify({
      state: {
        config: {
          apiKey: '',
          channels: [
            { id: 'default', apiKey: '' },
            { id: 'my-own-openai', apiKey: 'sk-mine' },
          ],
        },
      },
      version: 0,
    })
    expect(canvasAiConfigHasApiKey(raw)).toBe(true)
  })

  it('is false when a channel exists but every key is blank/whitespace', () => {
    const raw = JSON.stringify({
      state: { config: { channels: [{ id: 'default', apiKey: '   ' }] } },
      version: 0,
    })
    expect(canvasAiConfigHasApiKey(raw)).toBe(false)
  })
})

describe('buildCanvasAiConfigInjection', () => {
  it('returns null for a null token (never writes when logged out / no key)', () => {
    expect(buildCanvasAiConfigInjection(null, null)).toBeNull()
    expect(buildCanvasAiConfigInjection('{"state":{"config":{}}}', null)).toBeNull()
  })

  it('returns null for a token with a blank baseUrl or apiKey', () => {
    expect(buildCanvasAiConfigInjection(null, { baseUrl: '  ', apiKey: 'sk-x' })).toBeNull()
    expect(buildCanvasAiConfigInjection(null, { baseUrl: 'https://xm.solov.cc', apiKey: ' ' })).toBeNull()
  })

  it('seeds only baseUrl/apiKey (no channels key) on a fresh install with no prior value', () => {
    const written = buildCanvasAiConfigInjection(null, token)
    expect(written).not.toBeNull()
    const parsed = JSON.parse(written!)
    expect(parsed).toEqual({
      state: { config: { baseUrl: token.baseUrl, apiKey: token.apiKey } },
      version: 0,
    })
  })

  it('leaves channels unset when the existing value has none, so normalizeChannels can build a full default channel', () => {
    const existing = JSON.stringify({ state: { config: { model: 'default::gpt-image-2', apiKey: '' } }, version: 0 })
    const written = buildCanvasAiConfigInjection(existing, token)
    const parsed = JSON.parse(written!)
    expect(parsed.state.config.channels).toBeUndefined()
    expect(parsed.state.config.model).toBe('default::gpt-image-2')
    expect(parsed.state.config.baseUrl).toBe(token.baseUrl)
    expect(parsed.state.config.apiKey).toBe(token.apiKey)
  })

  it('updates only the "default" channel baseUrl/apiKey in place, preserving its models/name and any other channel', () => {
    // Neither channel has a key yet (an unconfigured "my-own" channel the
    // user started setting up but hasn't pasted a key into) -- if either
    // did, canvasAiConfigHasApiKey's gate would make this a no-op instead,
    // which is covered by the dedicated "already stored" test below.
    const existing = JSON.stringify({
      state: {
        config: {
          apiKey: '',
          channels: [
            { id: 'default', name: '默认渠道', baseUrl: 'https://old.example', apiKey: '', apiFormat: 'openai', models: [{ name: 'gpt-image-2', capability: 'image' }] },
            { id: 'my-own', name: '我的密钥', baseUrl: 'https://api.openai.com', apiKey: '', apiFormat: 'openai', models: [] },
          ],
        },
      },
      version: 0,
    })
    const written = buildCanvasAiConfigInjection(existing, token)
    const parsed = JSON.parse(written!)
    expect(parsed.state.config.channels).toHaveLength(2)
    expect(parsed.state.config.channels[0]).toEqual({
      id: 'default',
      name: '默认渠道',
      baseUrl: token.baseUrl,
      apiKey: token.apiKey,
      apiFormat: 'openai',
      models: [{ name: 'gpt-image-2', capability: 'image' }],
    })
    expect(parsed.state.config.channels[1]).toEqual({
      id: 'my-own',
      name: '我的密钥',
      baseUrl: 'https://api.openai.com',
      apiKey: '',
      apiFormat: 'openai',
      models: [],
    })
  })

  it('prepends a synthetic "default" channel when channels exist but none is named "default"', () => {
    const existing = JSON.stringify({
      state: { config: { apiKey: '', channels: [{ id: 'custom', apiKey: '' }] } },
      version: 0,
    })
    const written = buildCanvasAiConfigInjection(existing, token)
    const parsed = JSON.parse(written!)
    expect(parsed.state.config.channels).toHaveLength(2)
    expect(parsed.state.config.channels[0]).toMatchObject({ id: 'default', baseUrl: token.baseUrl, apiKey: token.apiKey })
    expect(parsed.state.config.channels[1]).toEqual({ id: 'custom', apiKey: '' })
  })

  it('is a no-op (returns null) when a real key is already stored, so it is safe to call unconditionally', () => {
    const existingTopLevel = JSON.stringify({ state: { config: { apiKey: 'sk-user-typed' } }, version: 0 })
    expect(buildCanvasAiConfigInjection(existingTopLevel, token)).toBeNull()

    const existingChannel = JSON.stringify({
      state: { config: { channels: [{ id: 'default', apiKey: 'sk-user-typed' }] } },
      version: 0,
    })
    expect(buildCanvasAiConfigInjection(existingChannel, token)).toBeNull()
  })

  it('preserves unrelated top-level and state fields (e.g. webdav, a future version bump)', () => {
    const existing = JSON.stringify({
      state: { config: { apiKey: '' }, webdav: { url: 'https://nas.example.com/webdav' } },
      version: 3,
    })
    const written = buildCanvasAiConfigInjection(existing, token)
    const parsed = JSON.parse(written!)
    expect(parsed.version).toBe(3)
    expect(parsed.state.webdav).toEqual({ url: 'https://nas.example.com/webdav' })
  })

  it('treats malformed existing JSON as absent rather than throwing', () => {
    expect(() => buildCanvasAiConfigInjection('{not json', token)).not.toThrow()
    const written = buildCanvasAiConfigInjection('{not json', token)
    expect(JSON.parse(written!)).toEqual({
      state: { config: { baseUrl: token.baseUrl, apiKey: token.apiKey } },
      version: 0,
    })
  })
})
