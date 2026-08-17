/**
 * One tab in a segmented strip.
 *
 * Segments rather than underlined tabs, because these strips sit inside pane
 * headers and toolbars where an underline would be a second horizontal rule
 * next to the one already there. The selected one is raised out of a recessed
 * track — the shape a desktop toolbar has used for thirty years — so which one
 * is on can be read without reading the labels.
 *
 * `onClick` is dropped while active: re-selecting the tab you are on is a
 * state change to nothing, and leaving the handler attached is what makes an
 * active tab hover like something that would do something.
 */
export function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={active ? undefined : onClick}
      className={[
        'h-[22px] rounded-[3px] px-2.5 text-[11.5px] transition-colors duration-100',
        active
          ? 'cursor-default bg-surface-2 text-text shadow-panel'
          : 'text-faint hover:bg-surface-2/60 hover:text-text',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
