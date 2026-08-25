/** A native event listener's teardown function. */
export type Dispose = () => void

/**
 * Acquire several listeners as one transaction.
 *
 * `Promise.all` loses the teardown handles that resolved before one sibling
 * rejected. Waiting for every acquisition lets us put those listeners back
 * before exposing the failure, so a retry cannot receive every event twice.
 */
export async function acquireTogether(acquire: (() => Promise<Dispose>)[]): Promise<Dispose> {
  const acquired: Dispose[] = []
  try {
    // Start each acquisition only after its predecessor returned a teardown
    // handle. If the next one fails, nothing is still racing in without an
    // owner while the already acquired listeners are rolled back.
    for (const next of acquire) acquired.push(await next())
  } catch (cause) {
    disposeAll(acquired)
    throw cause
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    disposeAll(acquired)
  }
}

/**
 * Own an asynchronously acquired listener for one React effect lifetime.
 *
 * The rejection handler is attached immediately, rather than only from the
 * cleanup path. That prevents a native listener refusal during startup from
 * becoming an unhandled rejection while the component remains mounted.
 */
export function ownAsync(pending: Promise<Dispose>, failed: (cause: unknown) => void): Dispose {
  let active = true
  let dispose: Dispose | null = null

  void pending.then((acquired) => {
    if (active) dispose = acquired
    else disposeSafely(acquired, failed)
  }, failed)

  return () => {
    if (!active) return
    active = false
    if (dispose) disposeSafely(dispose, failed)
    dispose = null
  }
}

/** Best-effort teardown: one broken listener must not strand its siblings. */
function disposeAll(disposers: Dispose[]): void {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // The acquisition failure is the useful error. Teardown is still
      // attempted for every sibling before that original failure is rethrown.
    }
  }
}

function disposeSafely(dispose: Dispose, failed: (cause: unknown) => void): void {
  try {
    dispose()
  } catch (cause) {
    failed(cause)
  }
}
