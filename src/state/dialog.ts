import { create } from 'zustand'

/**
 * The application-owned modal state for confirmations and blocking errors.
 *
 * Kept as state with a promise attached rather than as a `confirm()` call, for
 * the reason every desktop application eventually learns: the webview's own
 * dialog is drawn by the browser, in the browser's shape, with the browser's
 * buttons and the page's URL printed above them. It says out loud that this
 * window is a web page. Everything about the replacement — the panel, the type,
 * the accent, the two buttons and their order — is the app's own.
 */
export interface Question {
  title: string
  body: string
  /** The one thing the question is about — a name, a path — shown verbatim. */
  subject?: string
  /** The label on the button that goes through with it. */
  confirm: string
  /** `danger` for anything that removes or destroys. */
  tone?: 'danger' | 'brand'
}

export interface ErrorNotice {
  title: string
  body: string
  /** The complete native error, kept selectable and copyable. */
  details: string
  close: string
  copy: string
  copied: string
}

interface PendingQuestion extends Question {
  kind: 'question'
  answer: (taken: boolean) => void
}

interface PendingNotice extends ErrorNotice {
  kind: 'error'
}

export type PendingDialog = PendingQuestion | PendingNotice

interface DialogState {
  pending: PendingDialog | null
  put: (pending: PendingDialog) => void
  settle: (taken: boolean) => void
}

export const useDialog = create<DialogState>((set, get) => ({
  pending: null,

  put: (pending) => {
    // One question at a time. A second one arriving means the first is no
    // longer what is on screen, so it is answered "no" rather than left holding
    // a promise nobody will ever resolve.
    const previous = get().pending
    if (previous?.kind === 'question') previous.answer(false)
    set({ pending })
  },

  settle: (taken) => {
    const pending = get().pending
    if (!pending) return
    set({ pending: null })
    if (pending.kind === 'question') pending.answer(taken)
  },
}))

/**
 * Ask, and wait for the answer.
 *
 * `if (!(await ask({…}))) return` at the top of a handler, which is the shape
 * the old global `confirm()` had and the reason it survived this long.
 */
export const ask = (question: Question): Promise<boolean> =>
  new Promise((resolve) =>
    useDialog.getState().put({ ...question, kind: 'question', answer: resolve }),
  )

/** Show a blocking, copyable application error without creating a promise. */
export const showError = (notice: ErrorNotice): void =>
  useDialog.getState().put({ ...notice, kind: 'error' })
