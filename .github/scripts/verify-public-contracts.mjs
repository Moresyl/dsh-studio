import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

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

/** Keep the application, SDK and Tauri release versions in one release train. */
export function validateVersions(rootPackage, sdkPackage, tauriConfig) {
  const versions = [rootPackage?.version, sdkPackage?.version, tauriConfig?.version]
  if (versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version ?? ''))) {
    throw new Error('application, SDK and Tauri versions must be stable semantic versions')
  }
  if (new Set(versions).size !== 1) {
    throw new Error(`application, SDK and Tauri versions differ: ${versions.join(', ')}`)
  }
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
  )
  return {
    protocol: protocols[0],
    hostProtocol: hostProtocols[0],
    schema: '1.0.0',
    version: JSON.parse(rootPackageRaw).version,
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const result = await verifyPublicContracts(
    process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT,
  )
  console.log(
    `verified public contracts: Protocol ${result.protocol}, Host Protocol ${result.hostProtocol}, catalog ${result.schema}, SDK ${result.version}`,
  )
}
