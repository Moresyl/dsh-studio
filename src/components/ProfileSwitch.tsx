import { useEffect, type MouseEvent } from 'react'
import { Check, ChevronDown, Layers, Settings2 } from 'lucide-react'

import { t } from '@/lib/i18n'
import { useHarness } from '@/state/harness'
import { SEPARATOR, useMenu, type MenuEntry } from '@/state/menu'
import { switchProfile, useProfiles } from '@/state/profiles'

interface ProfileSwitchProps {
  /** Open the manager. Held by the window, because the manager covers it. */
  onManage: () => void
}

/**
 * Which profile this window works in, in the title bar.
 *
 * In the chrome rather than in a pane for the same reason the theme switch is: a
 * profile decides what the harness composes, so it is a property of the window
 * and not of one of the views inside it — and once the harness fills the window,
 * the title bar is the only place left that can still say which stack is running.
 *
 * A menu and not a segmented control. There is no fixed number of profiles, the
 * names are the user's own and can be long, and every one of them carries more
 * than a name: whether it can serve a window at all is worth knowing before
 * switching to it rather than after.
 */
export function ProfileSwitch({ onManage }: ProfileSwitchProps) {
  const roster = useProfiles((state) => state.roster)
  const refresh = useProfiles((state) => state.refresh)
  const phase = useHarness((state) => state.status.phase)

  // Read on arrival and whenever the harness settles. The first start is what
  // writes the shipped profile, so a window that looked only once would show an
  // empty switcher for the rest of the session — and a stop can be the moment a
  // profile finished installing.
  useEffect(() => {
    if (phase === 'starting' || phase === 'restarting') return
    void refresh()
  }, [phase, refresh])

  const selected = roster?.selected ?? ''
  if (!selected) return null

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const entries: MenuEntry[] = (roster?.profiles ?? []).map((profile) => ({
      // The tag is on the name because this is the last moment before the
      // switch, and "why is the window empty" is a worse question than a word.
      label: profile.servesWindow
        ? profile.name
        : `${profile.name} · ${t('profile.noInterfaceTag')}`,
      icon: profile.name === selected ? Check : undefined,
      run: () => void switchProfile(profile.name),
    }))
    entries.push(SEPARATOR, { label: t('profile.manage'), icon: Settings2, run: onManage })

    // Under the chip, the way a menu bar drops its menus — not at the pointer,
    // which for a control that is always in the same place would put the same
    // menu somewhere different every time.
    const box = event.currentTarget.getBoundingClientRect()
    useMenu.getState().show(box.left, box.bottom + 4, entries)
  }

  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={t('profile.switch')}
      data-hint={t('profile.switch')}
      onClick={open}
      className="ml-1 inline-flex h-[22px] max-w-[164px] shrink-0 items-center gap-1.5 rounded-control border border-line px-1.5 text-[11.5px] text-muted transition-colors duration-100 hover:border-line-strong hover:bg-surface-2 hover:text-text"
    >
      <Layers size={11} strokeWidth={2.1} className="shrink-0 text-brand" aria-hidden="true" />
      <span className="truncate">{selected}</span>
      <ChevronDown size={10} strokeWidth={2.4} className="shrink-0 opacity-55" aria-hidden="true" />
    </button>
  )
}
