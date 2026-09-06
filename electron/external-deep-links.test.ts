import { describe, expect, it } from 'vitest'
import { createExternalDeepLinkInbox, parseExternalDeepLink } from './external-deep-links'

describe('external deep links', () => {
  it('parses payment callbacks as a query intent, with no payment outcome', () => {
    expect(parseExternalDeepLink('xingmang://pay/success?order=XM20260906-0107')).toEqual({ kind: 'pay', order: 'XM20260906-0107' })
    expect(parseExternalDeepLink('xingmang://pay')).toEqual({ kind: 'pay', order: null })
    expect(parseExternalDeepLink('xingmang://invite?code=XM-7K2Q')).toEqual({ kind: 'invite', code: 'XM-7K2Q' })
  })
  it.each([
    'https://pay/success', 'xingmang://app/index.html', 'xingmang://pay.evil/success',
    'xingmang://user@pay', 'xingmang://pay:80', 'xingmang://pay/unsupported',
    'xingmang://pay/success?order=a&order=b', 'xingmang://pay?status=success',
    'xingmang://pay?order=', 'xingmang://pay?order=%0a', 'xingmang://invite?code=%3Cscript%3E',
    'xingmang://invite?code=a&redirect=https://evil.test', 'xingmang://invite',
    'xingmang://pay#success', 'xingmang://pay\\success', 'xingmang://invite?code=' + 'x'.repeat(2050),
  ])('rejects malformed or unauthorized input %s', (url) => {
    expect(parseExternalDeepLink(url).kind).toBe('invalid')
  })
  it('retains cold-start intent, deduplicates OS delivery, and bounds pending lifetime', () => {
    let time = 0
    const inbox = createExternalDeepLinkInbox(() => time)
    expect(inbox.accept('--inspect')).toBe(false)
    expect(inbox.accept('xingmang://pay')).toBe(true)
    expect(inbox.accept('xingmang://pay')).toBe(false)
    expect(inbox.take()).toEqual({ kind: 'pay', order: null })
    expect(inbox.take()).toBeNull()
    time = 3000
    expect(inbox.accept('xingmang://pay')).toBe(true)
    inbox.accept('xingmang://invite?code=latest')
    expect(inbox.take()).toEqual({ kind: 'invite', code: 'latest' })
    inbox.accept('xingmang://unsupported')
    time += 10 * 60_000
    expect(inbox.take()).toBeNull()
  })
})
