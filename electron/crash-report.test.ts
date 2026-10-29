import { describe, expect, it } from 'vitest'
import {
  buildCrashReportEnvelope,
  buildCrashReportEvent,
  crashReportDist,
  crashReportDsn,
  crashReportRelease,
  crashReportSignature,
  parseCrashReportDsn,
  parseCrashStackFrames,
  redactCrashText,
  resolveCrashFrameUrl,
  shouldReportCrashes,
  type CrashReportEnvironment,
} from './crash-report'

const runtime: CrashReportEnvironment = {
  release: 'xingmang-ai-manager@9.9.9',
  dist: 'win32-x64',
  environment: 'production',
  homeDirectory: 'C:\\Users\\yoyo',
  appVersion: '9.9.9',
  electronVersion: '43.0.0',
  nodeVersion: '22.0.0',
  osPlatform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
}

const fixedNow = new Date('2026-09-19T04:00:00.000Z')

describe('redactCrashText', () => {
  it('replaces the reporting machine home directory in every spelling', () => {
    expect(redactCrashText('C:\\Users\\yoyo\\AppData\\app.asar', 'C:\\Users\\yoyo'))
      .toBe('%USERPROFILE%\\AppData\\app.asar')
    expect(redactCrashText('C:/Users/yoyo/AppData/app.asar', 'C:\\Users\\yoyo'))
      .toBe('%USERPROFILE%/AppData/app.asar')
  })

  it('replaces another account name even when it is not this home directory', () => {
    expect(redactCrashText('D:\\Users\\alice\\proj\\a.js', 'C:\\Users\\yoyo'))
      .toBe('D:\\Users\\%USER%\\proj\\a.js')
    expect(redactCrashText('/Users/alice/proj/a.js', '/Users/bob'))
      .toBe('/Users/%USER%/proj/a.js')
    expect(redactCrashText('/home/alice/proj/a.js', '/home/bob'))
      .toBe('/home/%USER%/proj/a.js')
  })

  it('removes relay keys, bearer tokens and key-shaped assignments', () => {
    expect(redactCrashText('failed with sk-abcdef123456 retry', '')).toBe('failed with [REDACTED] retry')
    expect(redactCrashText('sent Bearer abcdef123456 upstream', '')).toBe('sent Bearer [REDACTED] upstream')
    expect(redactCrashText('Authorization: Bearer abcdef123456', '')).not.toContain('abcdef123456')
    expect(redactCrashText('{"api_key":"abcdef123456"}', '')).toBe('{"api_key":[REDACTED]}')
    // Over-redaction on purpose: the value rule swallows the rest of the query
    // rather than guess where a secret ends.
    expect(redactCrashText('https://example.com/x?token=abcdef&page=2', ''))
      .toBe('https://example.com/x?token=[REDACTED]')
  })

  it('removes the account email address', () => {
    expect(redactCrashText('登录失败：buyer@example.com', '')).toBe('登录失败：[REDACTED_EMAIL]')
  })

  // The next search starts where the last address ended, not only after a
  // character that cannot be part of one.
  it('removes an address that runs straight on from the previous one', () => {
    expect(redactCrashText('buyer@example.com_seller@example.org', ''))
      .toBe('[REDACTED_EMAIL][REDACTED_EMAIL]')
    expect(redactCrashText('buyer@example.cc5seller@example.org', ''))
      .toBe('[REDACTED_EMAIL][REDACTED_EMAIL]')
  })

  // Every position of a long run of address characters could start a match.
  // Before, each one read the rest of the run again looking for `@` or for a
  // domain ending, which took seconds here.
  it('scans a long run of address characters in linear time', () => {
    const runs = ['a'.repeat(100_000), 'AbC123xyz_%'.repeat(10_000)]
    const started = performance.now()
    for (const run of runs) {
      expect(redactCrashText(run, '')).toBe(run)
      expect(redactCrashText(`${run}@`, '')).toBe(`${run}@`)
      expect(redactCrashText(`${run}@example.com`, '')).toBe('[REDACTED_EMAIL]')
      expect(redactCrashText(`登录失败：buyer@${run}`, '')).toBe(`登录失败：buyer@${run}`)
    }
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('leaves scoped package paths alone', () => {
    expect(redactCrashText('/app/node_modules/@iarna/toml/index.js', ''))
      .toBe('/app/node_modules/@iarna/toml/index.js')
  })
})

describe('parseCrashReportDsn', () => {
  it('accepts the shipped DSN and builds the ingest envelope url', () => {
    const endpoint = parseCrashReportDsn(crashReportDsn, 'xingmang-ai-manager/9.9.9')
    expect(endpoint).not.toBeNull()
    expect(endpoint?.projectId).toBe('4512110923350016')
    expect(endpoint?.origin).toBe('https://o4512110916009984.ingest.us.sentry.io')
    expect(endpoint?.envelopeUrl).toContain('/api/4512110923350016/envelope/')
    expect(endpoint?.envelopeUrl).toContain('sentry_key=6c08296eec4f5104b41bf192f9c4ddbe')
    expect(endpoint?.envelopeUrl).toContain('sentry_version=7')
  })

  it.each([
    ['http, not https', 'http://key123456@o1.ingest.us.sentry.io/2'],
    ['a host outside sentry ingest', 'https://key123456@collector.evil.example/2'],
    ['a sentry-looking suffix on another domain', 'https://key123456@ingest.us.sentry.io.evil.test/2'],
    ['an explicit port', 'https://key123456@o1.ingest.us.sentry.io:8443/2'],
    ['a password component', 'https://key123456:secret@o1.ingest.us.sentry.io/2'],
    ['a non-numeric project', 'https://key123456@o1.ingest.us.sentry.io/not-a-project'],
    ['a missing public key', 'https://o1.ingest.us.sentry.io/2'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_label, dsn) => {
    expect(parseCrashReportDsn(dsn, 'client')).toBeNull()
  })
})

describe('parseCrashStackFrames', () => {
  it('orders frames oldest first and marks dependency frames out of app', () => {
    const stack = [
      'Error: boom',
      '    at saveConfig (C:\\Users\\yoyo\\app\\dist-electron\\config-files.js:12:5)',
      '    at C:\\Users\\yoyo\\app\\node_modules\\dep\\index.js:3:1',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n')
    const frames = parseCrashStackFrames(stack, 'C:\\Users\\yoyo')
    expect(frames).toHaveLength(3)
    expect(frames[0].filename).toBe('node:internal/process/task_queues')
    expect(frames[0].in_app).toBe(false)
    expect(frames[1].in_app).toBe(false)
    expect(frames[2]).toMatchObject({
      filename: '%USERPROFILE%\\app\\dist-electron\\config-files.js',
      function: 'saveConfig',
      lineno: 12,
      colno: 5,
      in_app: true,
    })
  })

  it('drops lines that are not frames instead of guessing', () => {
    expect(parseCrashStackFrames('Error: boom\n  caused by something', '')).toEqual([])
  })

  it('files packaged frames under the address their source maps were uploaded to', () => {
    const stack = [
      'Error: boom',
      '    at D.generate (D:\\软件\\xingmang-ai-manager\\resources\\app.asar\\dist-electron\\ai-video-service.js:1:4521)',
      '    at WebContents.<anonymous> (/Applications/星芒AI管理工具.app/Contents/Resources/app.asar/dist-electron/main.js:2:88)',
      '    at onClick (xingmang://app/assets/index-B1x2.js:3:77)',
    ].join('\n')
    const frames = parseCrashStackFrames(stack, 'C:\\Users\\yoyo')
    expect(frames.map((frame) => [frame.filename, frame.abs_path, frame.in_app])).toEqual([
      ['app:///dist/assets/index-B1x2.js', 'app:///dist/assets/index-B1x2.js', true],
      ['app:///dist-electron/main.js', 'app:///dist-electron/main.js', true],
      ['app:///dist-electron/ai-video-service.js', 'app:///dist-electron/ai-video-service.js', true],
    ])
    expect(JSON.stringify(frames)).not.toMatch(/软件|Applications|resources/i)
  })
})

describe('resolveCrashFrameUrl', () => {
  it('keeps only the path inside the archive, whatever folder it was installed in', () => {
    expect(resolveCrashFrameUrl('C:\\Program Files\\xingmang-ai-manager\\resources\\app.asar\\dist-electron\\ipc\\handlers\\config.js'))
      .toBe('app:///dist-electron/ipc/handlers/config.js')
    expect(resolveCrashFrameUrl('/home/yoyo/.local/opt/星芒/resources/app.asar/dist-electron/main.js')).toBe('app:///dist-electron/main.js')
    expect(resolveCrashFrameUrl('C:\\Program Files\\x\\resources\\app.asar.unpacked\\dist-electron\\worker.js')).toBe('app:///dist-electron/worker.js')
  })

  it('maps the main window renderer onto the dist directory it is served from', () => {
    expect(resolveCrashFrameUrl('xingmang://app/assets/index-B1x2.js')).toBe('app:///dist/assets/index-B1x2.js')
    expect(resolveCrashFrameUrl('xingmang://app/assets/chat-9.js?v=1#top')).toBe('app:///dist/assets/chat-9.js')
  })

  it('leaves frames that are not the packaged app alone', () => {
    for (const filename of [
      'node:internal/process/task_queues',
      'C:\\Users\\yoyo\\app\\dist-electron\\config-files.js',
      'xingmang-canvas://canvas/assets/index.js',
    ]) {
      expect(resolveCrashFrameUrl(filename), filename).toBeNull()
    }
  })
})

describe('crashReportRelease and crashReportDist', () => {
  it('name the release and the build the way the source map upload does', () => {
    expect(crashReportRelease('0.2.23')).toBe('xingmang-ai-manager@0.2.23')
    expect(crashReportDist('darwin', 'arm64')).toBe('darwin-arm64')
  })
})

describe('buildCrashReportEvent', () => {
  it('carries only the redacted exception, never identity or request data', () => {
    const error = new Error('保存失败 C:\\Users\\yoyo\\.codex\\auth.json sk-abcdef123456')
    error.stack = `Error: ${error.message}\n    at write (C:\\Users\\yoyo\\app\\a.js:3:9)`
    const event = buildCrashReportEvent(
      { mechanism: 'uncaughtException', source: 'main', error, level: 'fatal', context: '来自 C:\\Users\\yoyo' },
      runtime,
      fixedNow,
      'abc',
    )
    expect(event.exception.values[0].value).toBe('保存失败 %USERPROFILE%\\.codex\\auth.json [REDACTED]')
    expect(event.exception.values[0].stacktrace?.frames[0].filename).toBe('%USERPROFILE%\\app\\a.js')
    expect(event.extra).toEqual({ context: '来自 %USERPROFILE%' })
    expect(event.level).toBe('fatal')
    expect(event.dist).toBe('win32-x64')
    expect(event.timestamp).toBe(Math.floor(fixedNow.getTime() / 1000))
    expect(JSON.stringify(event)).not.toContain('yoyo')
    for (const forbidden of ['user', 'request', 'breadcrumbs', 'server_name']) {
      expect(Object.keys(event)).not.toContain(forbidden)
    }
  })

  it('accepts a thrown non-error without losing the report', () => {
    const event = buildCrashReportEvent(
      { mechanism: 'unhandledRejection', source: 'main', error: { code: 'EPERM' } },
      runtime,
      fixedNow,
      'abc',
    )
    expect(event.exception.values[0].type).toBe('Error')
    expect(event.exception.values[0].value).toBe('{"code":"EPERM"}')
    expect(event.exception.values[0].stacktrace).toBeUndefined()
    expect(event.level).toBe('error')
  })
})

describe('buildCrashReportEnvelope', () => {
  it('emits the three envelope lines with a byte-accurate item length', () => {
    const event = buildCrashReportEvent(
      { mechanism: 'uncaughtException', source: 'main', error: new Error('中文错误') },
      runtime,
      fixedNow,
      'abcdef',
    )
    const lines = buildCrashReportEnvelope(event, fixedNow).split('\n')
    expect(JSON.parse(lines[0])).toEqual({ event_id: 'abcdef', sent_at: fixedNow.toISOString() })
    const itemHeader = JSON.parse(lines[1])
    expect(itemHeader.type).toBe('event')
    expect(itemHeader.length).toBe(Buffer.byteLength(lines[2], 'utf8'))
    expect(JSON.parse(lines[2]).event_id).toBe('abcdef')
  })
})

describe('crashReportSignature', () => {
  it('matches two throws of the same bug and separates different ones', () => {
    const make = (message: string) => buildCrashReportEvent(
      { mechanism: 'uncaughtException', source: 'main', error: new Error(message) },
      runtime,
      fixedNow,
      'id',
    )
    expect(crashReportSignature(make('boom'))).toBe(crashReportSignature(make('boom')))
    expect(crashReportSignature(make('boom'))).not.toBe(crashReportSignature(make('other')))
  })
})

describe('shouldReportCrashes', () => {
  it('stays silent in development builds', () => {
    expect(shouldReportCrashes({ packaged: false, env: {} })).toBe(false)
  })

  it('reports by default once packaged', () => {
    expect(shouldReportCrashes({ packaged: true, env: {} })).toBe(true)
    expect(shouldReportCrashes({ packaged: true, crashReporting: true, env: {} })).toBe(true)
  })

  it('honours an explicit opt-out and the environment kill switch', () => {
    expect(shouldReportCrashes({ packaged: true, crashReporting: false, env: {} })).toBe(false)
    expect(shouldReportCrashes({ packaged: true, env: { XINGMANG_DISABLE_CRASH_REPORTING: '1' } })).toBe(false)
  })
})
