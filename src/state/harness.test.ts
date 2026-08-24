import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessEvent } from '@/lib/ipc'
import * as ipc from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useHarness } from '@/state/harness'

// The store only reaches for the command surface inside its async actions; the
// reducer under test never does. Stubbing it keeps these tests off Tauri
// globals that only exist inside a real window.
vi.mock('@/lib/ipc', () => ({
  environment: vi.fn(),
  status: vi.fn(),
  log: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  install: vi.fn(),
  nodeProvision: vi.fn(),
  nodeSelect: vi.fn(),
  onHarnessEvent: vi.fn(),
  onNodeProgress: vi.fn(),
  formatVersion: vi.fn(),
}))

/** Mirrors `MAX_LINES` in the store, which mirrors the ring the supervisor keeps. */
const MAX_LINES = 2000

const say = (line: string, stream: 'stdout' | 'stderr' = 'stdout'): HarnessEvent => ({
  kind: 'log',
  stream,
  line,
})

const apply = (event: HarnessEvent) => useHarness.getState().apply(event)

beforeEach(() => {
  vi.clearAllMocks()
  useHarness.setState({
    environment: null,
    status: { phase: 'stopped' },
    lines: [],
    busy: false,
    installing: false,
    installProgress: 0,
    provisioningNode: false,
    nodeProgress: null,
    error: null,
  })
  useDialog.setState({ pending: null })
  vi.mocked(ipc.environment).mockResolvedValue({} as never)
  vi.mocked(ipc.status).mockResolvedValue({ phase: 'stopped' })
  vi.mocked(ipc.log).mockResolvedValue([])
})

describe('supervisor actions', () => {
  it('reports a failed environment re-check to coordinated callers', async () => {
    vi.mocked(ipc.environment).mockRejectedValue('environment probe failed')

    await expect(useHarness.getState().inspect()).rejects.toBe('environment probe failed')

    expect(useHarness.getState().error).toBe('environment probe failed')
  })

  it('shows a start failure globally and releases the operation slot', async () => {
    vi.mocked(ipc.start).mockRejectedValue(new Error('duplicate loader entry id'))

    await useHarness.getState().start()

    expect(useHarness.getState()).toMatchObject({
      busy: false,
      error: 'duplicate loader entry id',
    })
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'duplicate loader entry id',
    })
  })

  it('shows a runtime provisioning failure globally and clears stale progress', async () => {
    useHarness.setState({ nodeProgress: { phase: 'download', downloaded: 10, total: 20 } as never })
    vi.mocked(ipc.nodeProvision).mockRejectedValue(new Error('Node archive checksum mismatch'))

    await useHarness.getState().provisionNode()

    expect(useHarness.getState()).toMatchObject({
      provisioningNode: false,
      nodeProgress: null,
      error: 'Node archive checksum mismatch',
    })
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'Node archive checksum mismatch',
    })
  })

  it('sends only one stop while the first request is still in flight', async () => {
    let finish!: () => void
    vi.mocked(ipc.stop).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )

    const first = useHarness.getState().stop()
    await useHarness.getState().stop()

    expect(ipc.stop).toHaveBeenCalledOnce()
    finish()
    await first
  })

  it('does not start another runtime-changing action during installation', async () => {
    let finish!: () => void
    vi.mocked(ipc.install).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )

    const installation = useHarness.getState().install()
    await Promise.all([
      useHarness.getState().start(),
      useHarness.getState().stop(),
      useHarness.getState().provisionNode(),
      useHarness.getState().selectNode('C:\\node.exe'),
    ])

    expect(ipc.start).not.toHaveBeenCalled()
    expect(ipc.stop).not.toHaveBeenCalled()
    expect(ipc.nodeProvision).not.toHaveBeenCalled()
    expect(ipc.nodeSelect).not.toHaveBeenCalled()
    finish()
    await installation
  })

  it('does not begin installation while a start request is in flight', async () => {
    let finish!: (origin: string) => void
    vi.mocked(ipc.start).mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      }),
    )

    const starting = useHarness.getState().start()
    await useHarness.getState().install()

    expect(ipc.install).not.toHaveBeenCalled()
    finish('http://127.0.0.1:57652')
    await starting
  })
})

describe('log events', () => {
  it('keeps lines in the order they arrived, with their stream', () => {
    apply(say('first'))
    apply(say('second', 'stderr'))

    expect(useHarness.getState().lines).toEqual([
      { stream: 'stdout', line: 'first' },
      { stream: 'stderr', line: 'second' },
    ])
  })

  it('stops growing at the cap and drops the oldest line, not the newest', () => {
    for (let i = 0; i < MAX_LINES + 5; i += 1) apply(say(`line ${i}`))

    const kept = useHarness.getState().lines.map((entry) => entry.line)
    expect(kept).toHaveLength(MAX_LINES)
    expect(kept[0]).toBe('line 5')
    expect(kept.at(-1)).toBe(`line ${MAX_LINES + 4}`)
  })

  it('holds exactly the cap before it starts dropping', () => {
    for (let i = 0; i < MAX_LINES; i += 1) apply(say(`line ${i}`))

    const kept = useHarness.getState().lines.map((entry) => entry.line)
    expect(kept).toHaveLength(MAX_LINES)
    expect(kept[0]).toBe('line 0')
  })
})

describe('install progress', () => {
  it('counts the npm lines that stand for one resolved package each', () => {
    useHarness.setState({ installing: true })

    apply(say('npm http fetch GET 200 https://registry.npmjs.org/zod 240ms'))
    apply(say('npm http cache zod 1ms (cache hit)'))

    expect(useHarness.getState().installProgress).toBe(2)
  })

  it('ignores npm output that is not a package line', () => {
    useHarness.setState({ installing: true })

    apply(say('npm warn deprecated inflight@1.0.6'))
    apply(say('added 587 packages in 4m'))
    apply(say('  npm http fetch GET 200 https://registry.npmjs.org/zod 240ms'))

    expect(useHarness.getState().installProgress).toBe(0)
  })

  // The harness logs over the same channel once it is running, and nothing it
  // says should look like installation making progress.
  it('does not count anything while no install is running', () => {
    apply(say('npm http fetch GET 200 https://registry.npmjs.org/zod 240ms'))

    expect(useHarness.getState().installProgress).toBe(0)
  })
})

describe('status events', () => {
  it('replaces the status and leaves the tag out of it', () => {
    apply({ kind: 'status', phase: 'ready', origin: 'http://127.0.0.1:57652', pid: 4242 })

    expect(useHarness.getState().status).toEqual({
      phase: 'ready',
      origin: 'http://127.0.0.1:57652',
      pid: 4242,
    })
  })

  it('does not carry fields over from the status it replaced', () => {
    apply({ kind: 'status', phase: 'ready', origin: 'http://127.0.0.1:57652', pid: 4242 })
    apply({ kind: 'status', phase: 'stopped' })

    expect(useHarness.getState().status).toEqual({ phase: 'stopped' })
  })

  it('leaves the log alone', () => {
    apply(say('still here'))
    apply({ kind: 'status', phase: 'starting' })

    expect(useHarness.getState().lines).toHaveLength(1)
  })
})
