export const DSH_STUDIO_PROTOCOL: 3
export const DSH_STUDIO_HOST_PROTOCOL: 1

export interface DshStudioHostProfile {
  readonly name: string
  readonly dir: string
  readonly initialized: boolean
  readonly servesWindow: boolean
  readonly packages: number
  readonly problem: 'unreadable-manifest' | null
}

export interface DshStudioHost {
  readonly protocol: 1
  readonly studio: { readonly name: 'DSH Studio'; readonly version: string }
  readonly harness: { readonly version: string }
  readonly platform: string
  readonly capabilities: readonly ('profiles.read' | 'runtime.read')[]
  readonly restrictions: {
    readonly arbitraryCommands: false
    readonly nativeHandles: false
    readonly packageMutation: false
    readonly profileMutation: false
  }
  readonly profiles: {
    readonly current: { readonly name: string; readonly dir: string }
    list(): readonly DshStudioHostProfile[]
  }
}

export interface DshStudioHostContext {
  readonly dshStudioHost?: DshStudioHost | { readonly protocol?: unknown }
  get?(name: 'dshStudioHost'): DshStudioHost | { readonly protocol?: unknown } | undefined
}

export interface DshStudioLink {
  readonly url: string
  readonly route: string
  readonly query: Readonly<Record<string, string>>
}

export type DshStudioCapability =
  'notify' | 'pick' | 'badge' | 'link' | 'profiles' | 'plugins' | 'workspace'

export interface DshStudioOffer {
  readonly protocol: 3
  readonly app: string
  readonly version: string
  readonly platform: string
  readonly scheme: 'dsh'
  readonly capabilities: readonly DshStudioCapability[]
  readonly link: DshStudioLink | null
}

export interface DshStudioProfile {
  readonly name: string
  readonly dir: string
  readonly initialized: boolean
  readonly shipped: boolean
  readonly servesWindow: boolean
  readonly plugins: number
  readonly disabled: number
}

export interface DshStudioProfileRoster {
  readonly profiles: readonly DshStudioProfile[]
  readonly selected: string
  readonly root: string
}

export interface DshStudioInstalledPlugin {
  readonly name: string
  readonly spec: string
  readonly active: boolean
  readonly disabled: boolean
  readonly builtin: boolean
  readonly marketReceipt: string | null
}

export interface DshStudioPluginState {
  readonly profile: string
  readonly profileDir: string
  readonly initialized: boolean
  readonly plugins: readonly DshStudioInstalledPlugin[]
  readonly packageManager: boolean
}

export interface DshStudioWorkspaceAdmission {
  readonly allowed: boolean
  readonly reason: string
}

export interface DshStudioPickOptions {
  readonly mode?: 'open' | 'save' | 'directory'
  readonly title?: string
  readonly defaultPath?: string
  readonly filters?: readonly {
    readonly name: string
    readonly extensions: readonly string[]
  }[]
}

export interface DshStudio {
  readonly protocol: 3
  hello(): Promise<DshStudioOffer>
  notify(options: { readonly title: string; readonly body?: string }): Promise<void>
  pick(options?: DshStudioPickOptions): Promise<{ readonly path: string | null }>
  badge(count: number): Promise<void>
  readonly profiles: {
    list(): Promise<DshStudioProfileRoster>
    select(name: string): Promise<{
      readonly roster: DshStudioProfileRoster
      readonly restartRequired: true
    }>
  }
  readonly plugins: {
    install(request: {
      readonly name: string
      readonly version: string
      readonly displayName?: string
    }): Promise<DshStudioPluginState>
    remove(name: string): Promise<DshStudioPluginState>
  }
  readonly workspace: {
    validate(path: string): Promise<DshStudioWorkspaceAdmission>
    onDrop(handler: (path: string) => void): () => void
  }
  onLink(handler: (link: DshStudioLink) => void): () => void
}

export interface DshStudioScope {
  readonly dshStudio?: DshStudio | { readonly protocol?: unknown }
}

export function getDshStudio(scope?: unknown): DshStudio | undefined
export function requireDshStudio(scope?: unknown): DshStudio
export function hasDshStudioCapability(
  offer: unknown,
  capability: string,
): capability is DshStudioCapability
export function onDshStudioWorkspaceDrop(
  handler: (path: string) => void,
  scope?: unknown,
): () => void
export function getDshStudioHost(ctx?: unknown): DshStudioHost | undefined
export function requireDshStudioHost(ctx?: unknown): DshStudioHost

declare global {
  interface Window {
    readonly dshStudio?: DshStudio
  }
}
