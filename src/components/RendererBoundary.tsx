import { Component, type ErrorInfo, type ReactNode } from 'react'

import { crashPayload } from '@/lib/crash'
import { frontendCrash } from '@/lib/ipc'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

/** The root-level last resort for a committed renderer that later fails. */
export class RendererBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(cause: unknown, _info: ErrorInfo) {
    const payload = crashPayload(cause, window.location.href)
    void frontendCrash(payload).catch(() => {
      // The fallback remains usable even when native diagnostics are not.
    })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const copy = rendererFailureCopy(window.navigator.language)
    return (
      <main role="alert" className="grid h-full place-items-center bg-canvas px-6 text-text">
        <section className="w-full max-w-[520px] rounded-panel border border-line bg-surface p-6 shadow-2xl">
          <div className="mb-4 grid size-11 place-items-center rounded-panel bg-danger/10 text-xl text-danger">
            !
          </div>
          <h1 className="text-lg font-semibold">{copy.title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted">{copy.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 min-h-9 rounded-control bg-brand px-4 text-sm font-medium text-on-brand enabled:hover:brightness-[1.08] enabled:active:brightness-95"
          >
            {copy.retry}
          </button>
        </section>
      </main>
    )
  }
}

export function rendererFailureCopy(language: string) {
  if (language.toLowerCase().startsWith('zh')) {
    return {
      title: '界面未能完成加载',
      body: 'DSH Studio 已保留本地诊断信息。你可以安全地重新加载界面；Profile、会话和 Harness 数据不会被删除。',
      retry: '重新加载',
    }
  }
  return {
    title: 'The interface could not finish loading',
    body: 'DSH Studio kept local diagnostic evidence. You can safely reload the interface; Profiles, sessions and Harness data will not be deleted.',
    retry: 'Reload interface',
  }
}
