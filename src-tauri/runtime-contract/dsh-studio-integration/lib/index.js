/** Read-only Host contract exposed to plugins running inside this Studio generation. */

import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

export const name = 'dsh-studio-integration'
export const inject = []
export const DSH_STUDIO_HOST_PROTOCOL = 1

const MAX_PROFILES = 128
const MAX_MANIFEST_BYTES = 256 * 1024
const WEB_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
])

/** Build one generation-scoped service from launcher-authenticated values. */
export function createStudioHostService(environment = process.env) {
  const profileName = requireText(environment.DSH_STUDIO_PROFILE, 'profile name')
  if (!isProfileName(profileName)) {
    throw new Error('dsh-studio: Host profile name is invalid')
  }

  const profileDir = requireAbsoluteDirectory(
    environment.DSH_STUDIO_PROFILE_DIR,
    'profile directory',
  )
  if (basename(profileDir) !== profileName) {
    throw new Error('dsh-studio: Host profile identity does not match its directory')
  }
  const profilesRoot = dirname(profileDir)
  const studioVersion = requireText(environment.DSH_STUDIO_VERSION, 'Studio version')
  const harnessVersion = requireText(environment.DSH_STUDIO_RUNTIME_VERSION, 'Harness version')
  let active = true

  const assertActive = () => {
    if (!active) throw new Error('dsh-studio: Host service generation is closed')
  }
  const current = Object.freeze({ name: profileName, dir: profileDir })
  const capabilities = Object.freeze([
    'profiles.read',
    'runtime.read',
  ])
  const restrictions = Object.freeze({
    arbitraryCommands: false,
    nativeHandles: false,
    packageMutation: false,
    profileMutation: false,
  })
  const profiles = Object.freeze({
    current,
    list() {
      assertActive()
      return readProfileRoster(profilesRoot)
    },
  })
  const service = Object.freeze({
    protocol: DSH_STUDIO_HOST_PROTOCOL,
    studio: Object.freeze({ name: 'DSH Studio', version: studioVersion }),
    harness: Object.freeze({ version: harnessVersion }),
    platform: process.platform,
    capabilities,
    restrictions,
    profiles,
  })

  return Object.freeze({
    service,
    dispose() {
      active = false
    },
  })
}

/** Publish the service through Cordis and bind retained references to this fiber. */
export function apply(ctx) {
  const lifetime = createStudioHostService()
  ctx.provide('dshStudioHost', lifetime.service)
  ctx.effect(
    () => () => lifetime.dispose(),
    'dsh-studio: Host service lifetime',
  )
}

function readProfileRoster(profilesRoot) {
  const candidates = readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isProfileName(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (candidates.length > MAX_PROFILES) {
    throw new Error(
      `dsh-studio: Host profile roster exceeds the ${MAX_PROFILES}-profile safety limit`,
    )
  }
  return Object.freeze(candidates.map((entry) => readProfile(profilesRoot, entry.name)))
}

function readProfile(profilesRoot, profileName) {
  const profileDir = resolve(profilesRoot, profileName)
  const metadata = lstatSync(profileDir)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`dsh-studio: Host profile ${JSON.stringify(profileName)} is not a safe directory`)
  }

  const manifestPath = resolve(profileDir, 'package.json')
  let manifest
  let problem = null
  try {
    const manifestMetadata = lstatSync(manifestPath)
    if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
      throw new Error('manifest is not a regular file')
    }
    if (manifestMetadata.size > MAX_MANIFEST_BYTES) {
      throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`)
    }
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    if (cause?.code !== 'ENOENT') {
      // One hand-edited Profile must not hide every healthy Profile from a
      // discovery-only caller. Report a stable state rather than filesystem or
      // parser details that could include private paths/content.
      problem = 'unreadable-manifest'
    }
  }

  const dependencies = plainRecord(manifest?.dependencies)
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((bundle) => typeof bundle === 'string')
    : []
  return Object.freeze({
    name: profileName,
    dir: profileDir,
    initialized: manifest !== undefined,
    servesWindow: WEB_BUNDLES.every((bundle) => bundles.includes(bundle)),
    packages: Object.keys(dependencies).length,
    problem,
  })
}

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`dsh-studio: Host ${label} is missing or invalid`)
  }
  return value
}

function requireAbsoluteDirectory(value, label) {
  const path = requireText(value, label)
  if (!isAbsolute(path)) {
    throw new Error(`dsh-studio: Host ${label} must be absolute`)
  }
  const resolved = resolve(path)
  const metadata = lstatSync(resolved)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`dsh-studio: Host ${label} is not a safe directory`)
  }
  return resolved
}

function isProfileName(value) {
  return value.length > 0
    && value.length <= 64
    && !value.startsWith('.')
    && !value.includes('/')
    && !value.includes('\\')
    && value !== 'node_modules'
}
