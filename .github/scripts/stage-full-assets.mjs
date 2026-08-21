import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { basename, extname, join, parse, resolve } from 'node:path'
import process from 'node:process'

const root = process.argv[2]
const target = process.argv[3]
const output = process.argv[4] ?? 'full-assets'
if (!root || !target) {
  throw new Error('usage: node stage-full-assets.mjs <bundle-directory> <rust-target> [output]')
}

const extensions = new Set(
  process.platform === 'win32'
    ? ['.exe', '.msi']
    : process.platform === 'darwin'
      ? ['.dmg']
      : ['.AppImage', '.deb', '.rpm'],
)
const files = (await walk(resolve(root))).filter(
  (file) => extensions.has(extname(file)) && !file.endsWith('.sig'),
)
const expected = process.platform === 'win32' ? 2 : process.platform === 'darwin' ? 1 : 3
if (files.length !== expected) {
  throw new Error(
    `expected ${expected} Full package artifacts for ${target}, found ${files.length}`,
  )
}

await mkdir(output, { recursive: true })
for (const file of files) {
  const parsed = parse(basename(file))
  const name = `${parsed.name}-full-${target}${parsed.ext}`
  await copyFile(file, join(output, name))
  console.log(name)
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    }),
  )
  return nested.flat()
}
