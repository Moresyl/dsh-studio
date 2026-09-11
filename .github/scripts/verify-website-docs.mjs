import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PAGES = Object.freeze([
  ['website/docs.html', ['docs.zh.html', 'docs/user-guide.md', 'docs/troubleshooting.md']],
  ['website/docs.zh.html', ['docs.html', 'docs/user-guide.zh-CN.md', 'docs/troubleshooting.zh-CN.md']],
])

export async function verifyWebsiteDocs(root = ROOT, load = readFile) {
  const problems = []
  for (const [page, links] of PAGES) {
    const source = await load(join(root, page), 'utf8')
    for (const link of links) {
      if (!source.includes(link)) problems.push(`${page} is missing ${link}`)
      if (!link.startsWith('http') && !link.startsWith('docs/')) {
        try {
          await access(join(root, 'website', link))
        } catch {
          problems.push(`${page} points to missing local target ${link}`)
        }
      }
    }
  }
  const css = await load(join(root, 'website/style.css'), 'utf8')
  for (const selector of ['.docs-home', '.doc-grid', '.doc-card', '.doc-callout']) {
    if (!css.includes(selector)) problems.push(`website/style.css is missing ${selector}`)
  }
  for (const file of ['website/404.html', 'website/sitemap.xml', 'website/robots.txt']) {
    await load(join(root, file), 'utf8')
  }
  if (problems.length) throw new Error(`website documentation verification failed:\n- ${problems.join('\n- ')}`)
  return { pages: PAGES.length }
}

if (process.argv[1]?.endsWith('verify-website-docs.mjs')) {
  const result = await verifyWebsiteDocs()
  console.log(`verified ${result.pages} website documentation pages`)
}
