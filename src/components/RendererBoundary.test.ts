import { describe, expect, it } from 'vitest'

import { rendererFailureCopy } from '@/components/RendererBoundary'

describe('renderer failure fallback', () => {
  it('provides a self-contained Chinese recovery action', () => {
    expect(rendererFailureCopy('zh-CN')).toEqual({
      title: '界面未能完成加载',
      body: '重新加载前会尝试保存当前文稿；保存失败会停止重载。输入框中尚未提交的文字可能无法恢复。已保存的 Profile、会话和 Harness 数据不会被删除。',
      retry: '保存文稿并重新加载',
      working: '正在准备重新加载…',
    })
  })

  it('falls back to English for every other locale', () => {
    expect(rendererFailureCopy('en-US').retry).toBe('Save presentation and reload')
    expect(rendererFailureCopy('ja-JP').title).toBe('The interface could not finish loading')
  })
})
