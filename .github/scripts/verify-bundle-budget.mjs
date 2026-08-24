import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST = resolve(HERE, '..', '..', 'dist')
const ENTRY_CEILING = 450 << 10
const TERMINAL_CEILING = 450 << 10

/** Keep expensive terminal emulation out of startup and bound both payloads. */
export function validateBundleInventory(files, entryName) {
  const problems = []
  const entry = files.find((file) => file.name === entryName)
  if (!entry) problems.push(`entry script ${entryName} is missing`)
  else if (entry.size > ENTRY_CEILING) {
    problems.push(`entry script is ${entry.size} bytes; limit is ${ENTRY_CEILING}`)
  }

  const terminals = files.filter(
    (file) => file.name.startsWith('terminals-') && file.name.endsWith('.js'),
  )
  if (terminals.length !== 1) problems.push('exactly one lazy terminal JavaScript chunk is required')
  else if (terminals[0].size > TERMINAL_CEILING) {
    problems.push(`terminal chunk is ${terminals[0].size} bytes; limit is ${TERMINAL_CEILING}`)
  }
  if (entryName.startsWith('terminals-')) problems.push('the terminal chunk cannot be the entry script')
  return problems
}

export async function verifyBundleBudget(dist = DEFAULT_DIST) {
  const html = await readFile(join(dist, 'index.html'), 'utf8')
  const source = /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/.exec(html)?.[1]
  if (!source) throw new Error('built index has no module entry script')
  const entryName = basename(source)
  const assets = join(dist, 'assets')
  const files = await Promise.all(
    (await readdir(assets))
      .filter((name) => name.endsWith('.js'))
      .map(async (name) => ({ name, size: (await stat(join(assets, name))).size })),
  )
  const problems = validateBundleInventory(files, entryName)
  if (problems.length > 0) throw new Error(`bundle budget failed:\n- ${problems.join('\n- ')}`)
  return {
    entryBytes: files.find((file) => file.name === entryName).size,
    terminalBytes: files.find((file) => file.name.startsWith('terminals-')).size,
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const result = await verifyBundleBudget(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIST)
  console.log(
    `verified bundle budget: entry ${result.entryBytes} bytes, lazy terminal ${result.terminalBytes} bytes`,
  )
}
