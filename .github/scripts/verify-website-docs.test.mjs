import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyWebsiteDocs } from './verify-website-docs.mjs'

test('website documentation pages expose both languages and recovery links', async () => {
  const files = new Map([
    ['website/docs.html', '<a href="docs.zh.html"></a><a href="docs/user-guide.md"></a><a href="docs/troubleshooting.md"></a>'],
    ['website/docs.zh.html', '<a href="docs.html"></a><a href="docs/user-guide.zh-CN.md"></a><a href="docs/troubleshooting.zh-CN.md"></a>'],
    ['website/style.css', '.docs-home .doc-grid .doc-card .doc-callout'],
    ['website/404.html', '404'],
    ['website/sitemap.xml', '<urlset>'],
    ['website/robots.txt', 'Sitemap:'],
  ])
  await assert.doesNotReject(() => verifyWebsiteDocs('fixture', async (path) => {
    const name = path.replaceAll('\\', '/').split('/').slice(-2).join('/')
    return files.get(name) ?? ''
  }))
})

test('repository website documentation contract stays enforced', async () => {
  const result = await verifyWebsiteDocs()
  assert.equal(result.pages, 2)
})
