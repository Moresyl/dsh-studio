import type { InstalledPlugin, PluginDetail } from './ipc'

/** Keep the exact package identity nearby; this is only a readable heading. */
export function pluginDisplayName(name: string): string {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  const words = leaf.replace(/^dsh-/, '').replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

/** A local detail manages an installation; a registry detail can replace it. */
export function pluginVersionAction(
  installed: InstalledPlugin | null,
  detail: Pick<PluginDetail, 'version'> | null,
  source: string | null,
): 'install' | 'replace' | 'current' | 'manage' {
  if (!installed) return 'install'
  if (installed.builtin || source === 'profile' || !detail) return 'manage'
  return (installed.installedVersion || installed.spec) === detail.version ? 'current' : 'replace'
}
