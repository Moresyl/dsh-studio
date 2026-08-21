import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const report = resolve(process.argv[2] ?? 'src-tauri/target/llvm-cov.json')
const document = JSON.parse(await readFile(report, 'utf8'))
const files = document?.data?.[0]?.files
if (!Array.isArray(files)) throw new Error('cargo-llvm-cov report has no files')

// Safety-critical pure/native cores. Tauri command adapters and platform GUI
// calls are covered by the three-OS test/build matrix instead of being counted
// as unexecuted Linux lines in this gate.
const required = [
  'src/desktop/badge.rs',
  'src/harness/health.rs',
  'src/harness/readiness.rs',
  'src/plugins/archive.rs',
  'src/plugins/receipts.rs',
  'src/plugins/switches.rs',
  'src/remote/access.rs',
  'src/remote/gateway.rs',
  'src/remote/lan.rs',
  'src/remote/qr.rs',
  'src/sessions/artifact.rs',
  'src/sessions/export.rs',
  'src/sessions/find.rs',
  'src/sessions/mod.rs',
  'src/sessions/read.rs',
  'src/terminal/decoder.rs',
  'src/terminal/shell.rs',
]
const minimum = 80

const normalized = files.map((file) => ({
  ...file,
  filename: String(file.filename).replaceAll('\\', '/'),
}))
for (const suffix of required) {
  const file = normalized.find((candidate) => candidate.filename.endsWith(suffix))
  if (!file) throw new Error(`coverage report is missing ${suffix}`)
  const percent = Number(file.summary?.lines?.percent)
  if (!Number.isFinite(percent) || percent < minimum) {
    throw new Error(`${suffix} line coverage is ${percent.toFixed(2)}%, below ${minimum}%`)
  }
  console.log(`${suffix}: ${percent.toFixed(2)}% lines`)
}
