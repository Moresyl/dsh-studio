import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const version = manifest.version

const section = async (file) => {
  const changelog = await readFile(new URL(file, root), 'utf8')
  const heading = `## [${version}]`
  const start = changelog.indexOf(heading)
  if (start < 0) throw new Error(`${file} has no ${heading} section`)

  const bodyStart = changelog.indexOf('\n', start)
  const next = changelog.indexOf('\n## [', bodyStart)
  return changelog.slice(bodyStart + 1, next < 0 ? undefined : next).trim()
}

const [zh, en] = await Promise.all([section('CHANGELOG.zh-CN.md'), section('CHANGELOG.md')])

process.stdout.write(`<!-- dsh-notes:zh -->
${zh}

<!-- dsh-notes:en -->
${en}

<!-- dsh-notes:end -->

### Downloads

Pick the installer for your platform from the assets below. Windows users can
also install this and future versions directly inside DSH Studio.

macOS builds are currently unsigned. On first launch, use the system security
settings to approve the app.
`)
