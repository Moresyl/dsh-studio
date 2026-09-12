import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const version = manifest.version

const changelogSection = async (file) => {
  const changelog = await readFile(new URL(file, root), 'utf8')
  const heading = `## [${version}]`
  const start = changelog.indexOf(heading)
  if (start < 0) throw new Error(`${file} has no ${heading} section`)

  const bodyStart = changelog.indexOf('\n', start)
  const next = changelog.indexOf('\n## [', bodyStart)
  return changelog.slice(bodyStart + 1, next < 0 ? undefined : next).trim()
}

const notes = async (language, changelog) => {
  try {
    return (
      await readFile(new URL(`.github/release-notes/${version}.${language}.md`, root), 'utf8')
    ).trim()
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw cause
    return changelogSection(changelog)
  }
}

const validate = (language, content) => {
  if (!content || content.length < 80) {
    throw new Error(`release notes for ${language} are empty or too short`)
  }
  const headings = language === 'zh-CN'
    ? [/^## .*修复/m, /^## .*验证/m]
    : [/^## .*Fix/m, /^## .*Verif/m]
  if (!headings.every((pattern) => pattern.test(content))) {
    throw new Error(`release notes for ${language} must include fix and verification sections`)
  }
  if ((content.match(/^[-*] /gm) ?? []).length < 2) {
    throw new Error(`release notes for ${language} must include at least two concrete bullets`)
  }
  return content
}

const [zh, en] = await Promise.all([
  notes('zh-CN', 'CHANGELOG.zh-CN.md'),
  notes('en', 'CHANGELOG.md'),
])

validate('zh-CN', zh)
validate('en', en)

process.stdout.write(`<!-- dsh-notes:zh -->
${zh}

<!-- dsh-notes:en -->
${en}

<!-- dsh-notes:end -->
`)
