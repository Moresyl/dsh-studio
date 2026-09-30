import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const sources = await Promise.all(
  ['ci.yml', 'release.yml', 'packaging.yml'].map((name) =>
    readFile(`.github/workflows/${name}`, 'utf8'),
  ),
)
const commands = sources.flatMap((source) => source.match(/sudo find \/etc\/apt[^\n]+/g) ?? [])

test('every Linux dependency bootstrap repairs both APT source and mirror-list files', () => {
  assert.equal(commands.length, 5)
  for (const command of commands) {
    for (const pattern of ["-name '*.list'", "-name '*.sources'", "-name '*mirrors.txt'"]) {
      assert(command.includes(pattern), `missing source form: ${pattern}`)
    }
  }
  assert.equal(new Set(commands).size, 1, 'Linux bootstraps must use the same mirror replacement')
})

test('actual sed rule repairs HTTP/HTTPS Azure lists while preserving unrelated repositories', () => {
  const rule = commands[0].match(/sed -i '([^']+)'/)[1]
  const fixture =
    [
      'http://azure.archive.ubuntu.com/ubuntu priority:1',
      'https://azure.archive.ubuntu.com/ubuntu priority:2',
      'URIs: http://azure.archive.ubuntu.com/ubuntu',
      'deb http://azure.archive.ubuntu.com/ubuntu jammy main',
      'https://packages.microsoft.com/ubuntu/22.04/prod',
      'http://azureXarchiveXubuntuXcom/ubuntu',
    ].join('\n') + '\n'
  const sed =
    process.platform === 'win32'
      ? join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'sed.exe')
      : 'sed'
  const result = execFileSync(sed, [rule], { input: fixture, encoding: 'utf8' })
  assert.equal(
    result,
    fixture.replaceAll(
      /https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu/g,
      'https://archive.ubuntu.com/ubuntu',
    ),
  )
})

test('APT index and package downloads have retries and bounded network waits', () => {
  const downloads = sources.flatMap(
    (source) => source.match(/sudo apt-get (?:update|install)[^\n]+/g) ?? [],
  )
  assert.equal(downloads.length, 10)
  for (const command of downloads) {
    assert(command.includes('Acquire::Retries=3'))
    assert(command.includes('Acquire::http::Timeout=30'))
    assert(command.includes('Acquire::https::Timeout=30'))
  }
})
