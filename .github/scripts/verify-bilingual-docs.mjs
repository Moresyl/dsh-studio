import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

export const BILINGUAL_PAIRS = Object.freeze([
  ['README.md', 'README.zh-CN.md'],
  ['docs/architecture.md', 'docs/architecture.zh-CN.md'],
  ['docs/accessibility-acceptance.md', 'docs/accessibility-acceptance.zh-CN.md'],
  ['docs/plugin-development.md', 'docs/plugin-development.zh-CN.md'],
  ['docs/plugin-interoperability.md', 'docs/plugin-interoperability.zh-CN.md'],
  ['docs/troubleshooting.md', 'docs/troubleshooting.zh-CN.md'],
  ['docs/user-guide.md', 'docs/user-guide.zh-CN.md'],
  ['docs/ROADMAP.md', 'docs/ROADMAP.zh-CN.md'],
])

const CONTRACTS = Object.freeze([
  {
    pair: 'docs/accessibility-acceptance.md|docs/accessibility-acceptance.zh-CN.md',
    english: ['pnpm verify:a11y', '200% zoom', 'No Apple device'],
    chinese: ['pnpm verify:a11y', '200% 缩放', '没有 Apple 设备'],
  },
  {
    pair: 'README.md|README.zh-CN.md',
    english: ['Renderer-independent startup recovery', 'Read-only Host plugin contract'],
    chinese: ['独立于 renderer 的启动恢复', '只读 Host 插件合同'],
  },
  {
    pair: 'docs/user-guide.md|docs/user-guide.zh-CN.md',
    english: ['**Extended**', 'Host Protocol 1', '1024 to', 'static native recovery window'],
    chinese: ['**扩展模式**', 'Host Protocol 1', '1024–65535', '静态原生恢复窗口'],
  },
  {
    pair: 'docs/plugin-interoperability.md|docs/plugin-interoperability.zh-CN.md',
    english: ['Read-only Host Protocol 1', 'unreadable-manifest'],
    chinese: ['只读 Host Protocol 1', 'unreadable-manifest'],
  },
  {
    pair: 'docs/ROADMAP.md|docs/ROADMAP.zh-CN.md',
    english: ['Benchmark\n2.0.4', '87047b54', 'v0.8.0 release candidate'],
    chinese: ['对标 2.0.4', '87047b54', 'v0.8.0 发布候选'],
  },
])

/** Check one pair's required facts without pretending translations are byte-equal. */
export function validateBilingualPair(englishPath, english, chinesePath, chinese) {
  const problems = []
  if (english.trim().length < 100) problems.push(`${englishPath} is empty or implausibly short`)
  if (chinese.trim().length < 100) problems.push(`${chinesePath} is empty or implausibly short`)

  const normalizedEnglish = english.replaceAll('\r\n', '\n')
  const normalizedChinese = chinese.replaceAll('\r\n', '\n')

  const contract = CONTRACTS.find((candidate) => candidate.pair === `${englishPath}|${chinesePath}`)
  for (const marker of contract?.english ?? []) {
    if (!normalizedEnglish.includes(marker))
      problems.push(`${englishPath} is missing ${JSON.stringify(marker)}`)
  }
  for (const marker of contract?.chinese ?? []) {
    if (!normalizedChinese.includes(marker))
      problems.push(`${chinesePath} is missing ${JSON.stringify(marker)}`)
  }
  return problems
}

/** Verify tracked bilingual capability documents and known stale-claim regressions. */
export async function verifyBilingualDocs(root = DEFAULT_ROOT, load = readFile) {
  const problems = []
  for (const [englishPath, chinesePath] of BILINGUAL_PAIRS) {
    let english = ''
    let chinese = ''
    try {
      ;[english, chinese] = await Promise.all([
        load(join(root, englishPath), 'utf8'),
        load(join(root, chinesePath), 'utf8'),
      ])
    } catch (cause) {
      problems.push(`${englishPath}|${chinesePath} cannot be read: ${cause.message}`)
      continue
    }
    problems.push(...validateBilingualPair(englishPath, english, chinesePath, chinese))
  }

  const mirrors = await load(join(root, 'packaging/MIRRORS.md'), 'utf8')
  if (mirrors.includes('builds are also code-signed')) {
    problems.push('packaging/MIRRORS.md claims OS signatures without artifact evidence')
  }
  if (problems.length > 0) {
    throw new Error(`bilingual documentation verification failed:\n- ${problems.join('\n- ')}`)
  }
  return { pairs: BILINGUAL_PAIRS.length }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const result = await verifyBilingualDocs(
    process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT,
  )
  console.log(`verified ${result.pairs} bilingual documentation pairs and shared capability facts`)
}
