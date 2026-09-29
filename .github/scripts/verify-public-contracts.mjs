import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

function tomlSection(source, heading, label) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headings = [...source.matchAll(new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, 'gm'))]
  if (headings.length !== 1) {
    throw new Error(`${label} must contain exactly one [${heading}] section`)
  }
  const start = (headings[0].index ?? 0) + headings[0][0].length
  const remainder = source.slice(start)
  const nextHeading = remainder.search(/^\s*\[\[?[^\]\r\n]+\]\]?\s*(?:#.*)?$/m)
  return nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)
}

function oneTomlString(section, key, label) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [
    ...section.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"\\r\\n]+)"\\s*(?:#.*)?$`, 'gm')),
  ]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`${label} must contain exactly one ${key} string declaration`)
  }
  return matches[0][1]
}

function cargoManifestProjectVersion(source) {
  const workspace = tomlSection(source, 'workspace.package', 'src-tauri/Cargo.toml')
  const packageSection = tomlSection(source, 'package', 'src-tauri/Cargo.toml')
  const workspaceVersion = oneTomlString(
    workspace,
    'version',
    'src-tauri/Cargo.toml [workspace.package]',
  )
  const packageName = oneTomlString(packageSection, 'name', 'src-tauri/Cargo.toml [package]')
  if (packageName !== 'dsh-studio') {
    throw new Error(`src-tauri/Cargo.toml package name must be dsh-studio, found ${packageName}`)
  }

  const inheritsWorkspace = /^\s*version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(packageSection)
  const directVersions = [
    ...packageSection.matchAll(/^\s*version\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/gm),
  ]
  if (Number(inheritsWorkspace) + directVersions.length !== 1) {
    throw new Error(
      'src-tauri/Cargo.toml [package] must declare exactly one version or version.workspace = true',
    )
  }
  return inheritsWorkspace ? workspaceVersion : directVersions[0][1]
}

function cargoLockProjectVersion(source) {
  const versions = []
  for (const section of source.split('[[package]]').slice(1)) {
    const name = /(?:^|\r?\n)name = "([^"\r\n]+)"/.exec(section)?.[1]
    if (name !== 'dsh-studio') continue
    // Workspace packages have no registry/git source. Ignore a dependency that
    // merely happens to use the same package name.
    if (/(?:^|\r?\n)source = "[^"\r\n]+"/.test(section)) continue
    const version = /(?:^|\r?\n)version = "([^"\r\n]+)"/.exec(section)?.[1]
    if (version) versions.push(version)
  }
  if (versions.length !== 1) {
    throw new Error(
      `src-tauri/Cargo.lock must contain exactly one local dsh-studio package, found ${versions.length}`,
    )
  }
  return versions[0]
}

/** Extract one integer protocol declaration and reject ambiguity. */
export function protocolNumber(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`${label} must contain exactly one protocol declaration`)
  }
  const value = Number(matches[0][1])
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} has an invalid protocol declaration`)
  }
  return value
}

/** Validate the published catalog schema facts enforced by native parsing. */
export function validateCatalogSchema(schema) {
  if (schema?.properties?.schemaVersion?.const !== '1.0.0') {
    throw new Error('catalog schema must require schemaVersion 1.0.0')
  }
  if (schema?.properties?.items?.maxItems !== 10_000) {
    throw new Error('catalog schema must retain the native 10,000 item limit')
  }
  const required = schema?.$defs?.item?.required
  if (
    !Array.isArray(required) ||
    !required.includes('package') ||
    !required.includes('latestVersion')
  ) {
    throw new Error('catalog items must require package and latestVersion')
  }
}

/** Keep every public JavaScript and native release version in one release train. */
export function validateVersions(rootPackage, sdkPackage, tauriConfig, cargoManifest, cargoLock) {
  const versions = [
    ['package.json', rootPackage?.version],
    ['sdk/package.json', sdkPackage?.version],
    ['src-tauri/tauri.conf.json', tauriConfig?.version],
    ['src-tauri/Cargo.toml', cargoManifestProjectVersion(cargoManifest ?? '')],
    ['src-tauri/Cargo.lock', cargoLockProjectVersion(cargoLock ?? '')],
  ]
  const unstable = versions.find(([, version]) => !STABLE_VERSION.test(version ?? ''))
  if (unstable) {
    throw new Error(
      `${unstable[0]} version must be one stable semantic version, found ${unstable[1]}`,
    )
  }
  if (new Set(versions.map(([, version]) => version)).size !== 1) {
    throw new Error(
      `application, SDK and Tauri versions differ: ${versions
        .map(([label, version]) => `${label}=${version}`)
        .join(', ')}`,
    )
  }
}

/** Keep the local renderer on the smallest native plugin permission surface it uses. */
export function validateCapabilities(capabilities) {
  const permissions = capabilities?.permissions
  if (!Array.isArray(permissions)) {
    throw new Error('desktop capabilities must declare a permission list')
  }
  const identifiers = permissions.map((permission) =>
    typeof permission === 'string' ? permission : permission?.identifier,
  )
  const exact = [
    'dialog:allow-open',
    'dialog:allow-save',
    'clipboard-manager:allow-read-text',
    'opener:allow-reveal-item-in-dir',
    'opener:allow-open-url',
  ]
  for (const identifier of exact) {
    if (!identifiers.includes(identifier)) {
      throw new Error(`desktop capabilities must retain ${identifier}`)
    }
  }
  for (const broad of [
    'dialog:default',
    'opener:default',
    'process:default',
    'process:allow-restart',
    'updater:default',
    'updater:allow-download-and-install',
    'updater:allow-install',
  ]) {
    if (identifiers.includes(broad)) {
      throw new Error(`desktop capabilities must not grant broad ${broad}`)
    }
  }
  if (!identifiers.includes('shell-commands')) {
    throw new Error('desktop capabilities must retain the shell-commands permission set')
  }
}

/** Keep renderer calls, native registration and the loopback-origin ACL in lockstep. */
export function validateCommandAcl(ipcSource, rustSource, permissionSource) {
  const invoked = new Set(
    [...ipcSource.matchAll(/\binvoke(?:<[^>]+>)?\s*\(\s*['"]([a-z0-9_]+)['"]/g)].map(
      (match) => match[1],
    ),
  )
  const handler = rustSource.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)
  if (!handler) throw new Error('native command handler list is missing')
  const registered = new Set(
    [...handler[1].matchAll(/^\s*(?:[a-z0-9_]+::)*([a-z0-9_]+),?\s*$/gim)].map((match) => match[1]),
  )
  const allow = permissionSource.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)
  if (!allow) throw new Error('shell command ACL allow list is missing')
  const allowed = new Set([...allow[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]))

  if (invoked.size === 0 || registered.size === 0 || allowed.size === 0) {
    throw new Error('command contract extraction returned an empty surface')
  }
  for (const command of invoked) {
    if (!registered.has(command)) {
      throw new Error(`renderer command ${command} is not registered by the native handler`)
    }
    if (!allowed.has(command)) {
      throw new Error(`renderer command ${command} is not allowed by the shell ACL`)
    }
  }
  for (const command of allowed) {
    if (!registered.has(command)) {
      throw new Error(`shell ACL command ${command} is not registered by the native handler`)
    }
  }

  return { invoked: invoked.size, registered: registered.size, allowed: allowed.size }
}

/** Verify every duplicated public-contract marker against authoritative source. */
export async function verifyPublicContracts(root = DEFAULT_ROOT) {
  const files = await Promise.all(
    [
      'src/lib/bridge.ts',
      'src-tauri/src/desktop/mod.rs',
      'src-tauri/runtime-contract/dsh-studio-integration/lib/index.js',
      'sdk/index.js',
      'sdk/index.d.ts',
      'docs/plugin-development.md',
      'docs/plugin-development.zh-CN.md',
      'docs/plugin-interoperability.md',
      'docs/plugin-interoperability.zh-CN.md',
      '.github/release-notes/0.7.4.en.md',
      '.github/release-notes/0.7.4.zh-CN.md',
      'docs/schemas/catalog-1.0.0.schema.json',
      'package.json',
      'sdk/package.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/capabilities/default.json',
      'src/lib/ipc.ts',
      'src-tauri/src/lib.rs',
      'src-tauri/permissions/shell.toml',
    ].map((path) => readFile(join(root, path), 'utf8')),
  )
  const [
    bridge,
    rust,
    hostIntegration,
    sdk,
    sdkTypes,
    docsEn,
    docsZh,
    interoperabilityEn,
    interoperabilityZh,
    notesEn,
    notesZh,
    schemaRaw,
    rootPackageRaw,
    sdkPackageRaw,
    tauriConfigRaw,
    cargoManifest,
    cargoLock,
    capabilitiesRaw,
    ipcSource,
    rustSource,
    permissionSource,
  ] = files

  const protocols = [
    protocolNumber(bridge, /export const PROTOCOL = (\d+)/g, 'browser bridge'),
    protocolNumber(rust, /const PROTOCOL: u32 = (\d+);/g, 'native bridge'),
    protocolNumber(sdk, /export const DSH_STUDIO_PROTOCOL = (\d+)/g, 'SDK runtime'),
    protocolNumber(sdkTypes, /export const DSH_STUDIO_PROTOCOL: (\d+)/g, 'SDK types'),
  ]
  if (new Set(protocols).size !== 1 || protocols[0] !== 3) {
    throw new Error(`public protocol declarations differ: ${protocols.join(', ')}`)
  }
  const hostProtocols = [
    protocolNumber(
      hostIntegration,
      /export const DSH_STUDIO_HOST_PROTOCOL = (\d+)/g,
      'managed Host integration',
    ),
    protocolNumber(sdk, /export const DSH_STUDIO_HOST_PROTOCOL = (\d+)/g, 'SDK Host runtime'),
    protocolNumber(sdkTypes, /export const DSH_STUDIO_HOST_PROTOCOL: (\d+)/g, 'SDK Host types'),
  ]
  if (new Set(hostProtocols).size !== 1 || hostProtocols[0] !== 1) {
    throw new Error(`Host protocol declarations differ: ${hostProtocols.join(', ')}`)
  }
  for (const [label, text] of [
    ['English plugin documentation', docsEn],
    ['Chinese plugin documentation', docsZh],
    ['English release notes', notesEn],
    ['Chinese release notes', notesZh],
  ]) {
    if (!text.includes('Protocol 3') || text.includes('Protocol 2')) {
      throw new Error(`${label} does not describe only Protocol 3`)
    }
  }
  for (const [label, text] of [
    ['English plugin interoperability documentation', interoperabilityEn],
    ['Chinese plugin interoperability documentation', interoperabilityZh],
  ]) {
    if (!text.includes('Host Protocol 1') || text.includes('Host Protocol 2')) {
      throw new Error(`${label} does not describe only Host Protocol 1`)
    }
  }

  validateCatalogSchema(JSON.parse(schemaRaw))
  validateVersions(
    JSON.parse(rootPackageRaw),
    JSON.parse(sdkPackageRaw),
    JSON.parse(tauriConfigRaw),
    cargoManifest,
    cargoLock,
  )
  validateCapabilities(JSON.parse(capabilitiesRaw))
  const commands = validateCommandAcl(ipcSource, rustSource, permissionSource)
  return {
    protocol: protocols[0],
    hostProtocol: hostProtocols[0],
    schema: '1.0.0',
    version: JSON.parse(rootPackageRaw).version,
    commands,
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const result = await verifyPublicContracts(
    process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT,
  )
  console.log(
    `verified public contracts: Protocol ${result.protocol}, Host Protocol ${result.hostProtocol}, catalog ${result.schema}, SDK ${result.version}, ${result.commands.invoked} renderer commands`,
  )
}
