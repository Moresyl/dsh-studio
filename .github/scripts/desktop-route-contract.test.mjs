import assert from 'node:assert/strict'
import test from 'node:test'

import { DESKTOP_ROUTES } from './desktop-route-contract.mjs'

test('desktop acceptance covers every visible workbench page in rail order', () => {
  assert.deepEqual(DESKTOP_ROUTES, [
    { label: '运行状态', heading: '运行状态' },
    { label: '终端', heading: '终端' },
    { label: '会话', heading: '会话' },
    { label: '插件', heading: '插件市场' },
    { label: '远程', heading: '远程访问' },
    { label: '演示文稿', heading: '演示文稿' },
    { label: '关于', heading: '关于' },
    { label: '设置', heading: '设置' },
  ])
  assert.equal(new Set(DESKTOP_ROUTES.map(({ label }) => label)).size, DESKTOP_ROUTES.length)
})
