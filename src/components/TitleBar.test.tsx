import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  label: 'main',
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }))
vi.mock('@/lib/platform', () => ({ drawsWindowControls: true, isMac: false }))
vi.mock('@/components/ThemeSwitch', () => ({ ThemeSwitch: () => null }))
vi.mock('@/state/dialog', async (original) => {
  const module = await original<typeof import('@/state/dialog')>()
  return {
    ...module,
    useDialog: Object.assign(
      (selector: (state: ReturnType<typeof module.useDialog.getState>) => unknown) =>
        selector(module.useDialog.getState()),
      module.useDialog,
    ),
  }
})
vi.mock('@/state/failure', () => ({
  reportAction: (action: () => void) => action(),
  reportFailure: vi.fn(),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: vi.fn(),
  useState: () => [false, vi.fn()],
}))

import { TitleBar } from './TitleBar'
import { Dialog } from './Dialog'
import { useDialog } from '@/state/dialog'

const props = {
  serving: false,
  mode: 'advanced',
  sidebarCollapsed: false,
  pageTitle: 'Harness',
} as const

beforeEach(() => {
  vi.clearAllMocks()
  useDialog.setState({ pending: null })
})

it('keeps native controls above an error backdrop without lifting workspace navigation', () => {
  useDialog.getState().put({
    kind: 'error',
    title: 'Install failed',
    body: 'Retry',
    details: 'timeout',
    close: 'Close',
    copy: 'Copy',
    copied: 'Copied',
  })
  const markup = renderToStaticMarkup(
    <>
      <TitleBar {...props} />
      <Dialog />
    </>,
  )
  const header = /<header[^>]*class="([^"]*)"/.exec(markup)![1]!
  const controls = /data-window-controls="true" class="([^"]*)"/.exec(markup)![1]!
  const backdrop = /class="dialog-backdrop ([^"]*)"/.exec(markup)![1]!
  // An ancestor stacking context would trap the controls below the backdrop.
  expect(header).not.toMatch(/\bz-/)
  expect(controls).toContain('relative')
  const layer = (classes: string) => Number(/\bz-(\d+)\b/.exec(classes)![1])
  expect(layer(controls)).toBeGreaterThan(layer(backdrop))
})

it('dispatches every window button to its native action while an error is pending', () => {
  const notice = {
    kind: 'error',
    title: 'Install failed',
    body: 'Retry',
    details: 'timeout',
    close: 'Close',
    copy: 'Copy',
    copied: 'Copied',
  } as const
  useDialog.getState().put(notice)
  const header = TitleBar(props)
  const controls = header.props.children.find(
    (child: { props?: Record<string, unknown> }) => child?.props?.['data-window-controls'],
  )
  const buttons = controls.props.children.filter(
    (child: { props?: { onClick?: () => void } }) => child?.props?.onClick,
  )
  expect(buttons).toHaveLength(3)
  for (const button of buttons) button.props.onClick()
  expect(native.minimize).toHaveBeenCalledOnce()
  expect(native.toggleMaximize).toHaveBeenCalledOnce()
  expect(native.close).toHaveBeenCalledOnce()
  expect(useDialog.getState().pending).toEqual(notice)
})
