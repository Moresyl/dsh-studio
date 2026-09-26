import type { LogLine } from './ipc'

export interface RuntimeNotice {
  name: string
  incompatible: boolean
}

/** Interpret only the launcher's explicit skipped-bundle record, never arbitrary errors. */
export function runtimeNotices(lines: LogLine[]): RuntimeNotice[] {
  const notices = new Map<string, RuntimeNotice>()
  for (const entry of lines) {
    const line = entry.line.replace(/\x1b\[[0-9;]*m/g, '').trimStart()
    // The supervisor prints this before each launch. Old attempts must not be
    // reported as current after a successful repair or a Profile switch.
    if (line.startsWith('GUI shell environment:')) notices.clear()
    const match = /^dsh: skipping profile bundle ("(?:[^"\\]|\\.)*"): (.+)$/.exec(line)
    if (!match?.[1] || !match[2]) continue
    try {
      const name: unknown = JSON.parse(match[1])
      if (typeof name !== 'string' || !name || name.length > 214) continue
      notices.set(name, { name, incompatible: /is incompatible with dsh /.test(match[2]) })
    } catch {
      // A truncated line remains available in the raw log.
    }
  }
  return [...notices.values()]
}
