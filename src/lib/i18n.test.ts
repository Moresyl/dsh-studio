import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The active dictionary is chosen once, when the module is first evaluated, so
 * every locale case needs a fresh evaluation with a different `navigator`.
 */
const load = async (language: string) => {
  vi.resetModules()
  vi.stubGlobal('navigator', { language })
  return import('@/lib/i18n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('locale detection', () => {
  it('uses Chinese for any Chinese tag, whatever the region', async () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hant-TW', 'ZH-hk']) {
      const { t } = await load(tag)
      expect(t('status.ready'), tag).toBe('运行中')
    }
  })

  it('falls back to English for everything else', async () => {
    for (const tag of ['en-US', 'de-DE', 'ja']) {
      const { t } = await load(tag)
      expect(t('status.ready'), tag).toBe('Running')
    }
  })
})

describe('t', () => {
  it('returns the template untouched when there is nothing to fill', async () => {
    const { t } = await load('en-US')
    expect(t('log.empty')).toBe('No output yet.')
  })

  it('fills placeholders, including numeric values', async () => {
    const { t } = await load('en-US')
    expect(t('status.restarting', { attempt: 3 })).toBe('Reconnecting (3)')
  })

  it('fills every occurrence in either language', async () => {
    const { t } = await load('zh-CN')
    expect(t('install.progress', { count: 587 })).toBe('已处理 587 个包')
  })

  // Better a visible `{minimum}` than a sentence that silently lost its subject.
  it('leaves a placeholder alone when no value was supplied for it', async () => {
    const { t } = await load('en-US')
    expect(t('check.node.missing', { unrelated: 'x' })).toBe('Node {minimum} or newer required')
  })

  it('does not treat a supplied value as a template of its own', async () => {
    const { t } = await load('en-US')
    expect(t('check.node.found', { version: '{source}', source: '20.0.0' })).toBe(
      '{source} · 20.0.0',
    )
  })
})
