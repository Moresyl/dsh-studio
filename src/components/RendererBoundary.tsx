import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import { crashPayload } from '@/lib/crash'
import { frontendCrash } from '@/lib/ipc'
import { reloadPreservingPresentation } from '@/lib/presentation/renderer-recovery'
import { describe } from '@/lib/errors'
import { PresentationPendingInputs } from '@/components/PresentationPendingInputs'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
  recovering: boolean
  error: string | null
}

/** The root-level last resort for a committed renderer that later fails. */
export class RendererBoundary extends Component<Props, State> {
  state: State = { failed: false, recovering: false, error: null }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  recover = async () => {
    if (this.state.recovering) return
    this.setState({ recovering: true, error: null })
    try {
      await reloadPreservingPresentation(() => window.location.reload())
    } catch (cause) {
      this.setState({ recovering: false, error: describe(cause) })
    }
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
        {/* The confirm dialog's own surface and status tile: this is the same
            kind of thing — a failure that has to be read — with the window to
            itself instead of a dimmed one behind it. */}
        <section className="w-full max-w-[520px] rounded-xl border border-line-strong bg-surface p-5 shadow-lift">
          <div
            aria-hidden="true"
            className="mb-4 grid size-9 place-items-center rounded-lg bg-danger/12 text-danger"
          >
            <TriangleAlert size={18} strokeWidth={2} />
          </div>
          <h1 className="text-ui-xl font-semibold text-text">{copy.title}</h1>
          <p className="mt-2 text-ui-base text-muted">{copy.body}</p>
          <PresentationPendingInputs />
          {this.state.error && (
            <p className="selectable mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger">
              {this.state.error}
            </p>
          )}
          <div className="mt-5 flex justify-end">
            <Button
              variant="primary"
              onClick={() => void this.recover()}
              disabled={this.state.recovering}
            >
              {this.state.recovering ? copy.working : copy.retry}
            </Button>
          </div>
        </section>
      </main>
    )
  }
}

export function rendererFailureCopy(language: string) {
  if (language.toLowerCase().startsWith('zh')) {
    return {
      title: '界面未能完成加载',
      body: '重新加载前会尝试保存当前文稿，包括尚未提交的输入。输入无效或保存失败会停止重载；你可以在下方修正或放弃相应输入。已保存的 Profile、会话和 Harness 数据不会被删除。',
      retry: '保存文稿并重新加载',
      working: '正在准备重新加载…',
    }
  }
  return {
    title: 'The interface could not finish loading',
    body: 'The current presentation, including unfinished input, will be saved before reloading. Invalid input or a failed save stops the reload; correct or discard unfinished fields below. Saved Profiles, sessions and Harness data will not be deleted.',
    retry: 'Save presentation and reload',
    working: 'Preparing to reload…',
  }
}
