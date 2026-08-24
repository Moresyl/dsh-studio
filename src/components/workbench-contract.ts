import {
  Gauge,
  History,
  Info,
  Puzzle,
  Settings,
  Smartphone,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'

import type { MessageKey } from '@/lib/i18n'
import { ACCELERATOR } from '@/lib/platform'

export type View = 'console' | 'terminal' | 'sessions' | 'plugins' | 'remote' | 'about' | 'settings'

/** Rail order, which is also the order the number accelerators follow. */
export const VIEWS: { id: View; icon: LucideIcon; label: MessageKey }[] = [
  { id: 'console', icon: Gauge, label: 'nav.console' },
  { id: 'terminal', icon: SquareTerminal, label: 'nav.terminal' },
  { id: 'sessions', icon: History, label: 'nav.sessions' },
  { id: 'plugins', icon: Puzzle, label: 'nav.plugins' },
  { id: 'remote', icon: Smartphone, label: 'nav.remote' },
  { id: 'about', icon: Info, label: 'nav.about' },
]

export const SETTINGS = { id: 'settings' as View, icon: Settings, label: 'nav.settings' as const }

/** What the tooltips and the palette print for it, on either platform. */
export const SETTINGS_KEYS = `${ACCELERATOR},`
