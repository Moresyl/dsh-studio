import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'

import { Segmented } from '@/components/Segmented'
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
    <Segmented
      size="sm"
      iconOnly
      label={t('theme.label')}
      value={theme}
      onChange={choose}
      items={CHOICES.map(({ id, icon, label }) => ({ value: id, label: t(label), icon }))}
    />
  )
}
