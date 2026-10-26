import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRendererDelivery, deliverToMainRenderer, detachRendererDelivery, type RendererDelivery } from './renderer-delivery-bridge'

const attached: RendererDelivery[] = []
afterEach(() => {
  for (const sink of attached.splice(0)) detachRendererDelivery(sink)
})

function attach(sink: RendererDelivery) {
  attached.push(sink)
  attachRendererDelivery(sink)
}

describe('renderer delivery bridge', () => {
  it('sends straight away when nothing is attached', () => {
    const send = vi.fn()
    deliverToMainRenderer('onNavigate', send)
    expect(send).toHaveBeenCalledOnce()
  })

  it('hands deliveries to the attached sink instead', () => {
    const sink = vi.fn()
    attach(sink)
    const send = vi.fn()
    deliverToMainRenderer('onNavigate', send)
    expect(send).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledWith('onNavigate', send)
  })

  it('lets only the current sink detach itself', () => {
    const previous = vi.fn()
    const current = vi.fn()
    attach(previous)
    attach(current)
    detachRendererDelivery(previous)
    deliverToMainRenderer('onNavigate', vi.fn())
    expect(current).toHaveBeenCalledOnce()
    expect(previous).not.toHaveBeenCalled()
  })
})
