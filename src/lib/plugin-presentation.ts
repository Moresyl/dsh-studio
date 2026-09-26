/** Keep the exact package identity nearby; this is only a readable heading. */
export function pluginDisplayName(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  const words = leaf.replace(/^dsh-/, '').replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}
