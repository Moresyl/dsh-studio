import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'

import { t, type MessageKey } from '@/lib/i18n'
import { useTheme, type Theme } from '@/state/theme'

/** System first: it is the default, and the one the other two are a departure from. */
const CHOICES: { id: Theme; icon: LucideIcon; label: MessageKey }[] = [
  { id: 'system', icon: Monitor, label: 'theme.system' },
  { id: 'light', icon: Sun, label: 'theme.light' },
  { id: 'dark', icon: Moon, label: 'theme.dark' },
]

/**
 * Light, dark, or whatever the machine says.
 *
 * All three on screen at once rather than one button that cycles: a cycling
 * button cannot show what it would do next, and with three states it cannot
 * even show which one it is in without a legend. This is the same segmented
 * control the view switch beside it uses, so it reads as chrome rather than as
 * a setting that wandered into the title bar.
 *
 * Icon-only because the title bar is 36px tall and these three concepts are the
 * ones every operating system already draws with these three icons. The names
 * are on the tooltips and on the accessible labels.
 */
export function ThemeSwitch() {
  const theme = useTheme((state) => state.theme)
  const choose = useTheme((state) => state.choose)

  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline"
    >
      {CHOICES.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={theme === id}
          aria-label={t(label)}
          data-hint={t(label)}
          onClick={theme === id ? undefined : () => choose(id)}
          className={[
            'grid h-[20px] w-[24px] place-items-center rounded-[3px] transition-colors duration-100',
            // Same rule as the view switch: the selected segment is inert, so it
            // shows the arrow and the other two carry the hover surface.
            theme === id
              ? 'cursor-default bg-surface-2 text-text shadow-panel'
              : 'text-faint hover:bg-surface-2/60 hover:text-text',
          ].join(' ')}
        >
          <Icon size={12} strokeWidth={2.1} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
