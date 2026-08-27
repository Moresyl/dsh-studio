import { describe, expect, it } from 'vitest'

import { rendererFailureCopy } from '@/components/RendererBoundary'

describe('renderer failure fallback', () => {
  it('provides a self-contained Chinese recovery action', () => {
    expect(rendererFailureCopy('zh-CN')).toEqual({
      title: '界面未能完成加载',
      body: 'DSH Studio 已保留本地诊断信息。你可以安全地重新加载界面；Profile、会话和 Harness 数据不会被删除。',
      retry: '重新加载',
    })
  })

  it('falls back to English for every other locale', () => {
    expect(rendererFailureCopy('en-US').retry).toBe('Reload interface')
    expect(rendererFailureCopy('ja-JP').title).toBe('The interface could not finish loading')
  })
})
