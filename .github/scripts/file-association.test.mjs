import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('portable presets are registered as one explicit cross-platform file type', async () => {
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  assert.deepEqual(config.bundle.fileAssociations, [
    {
      ext: ['dshpreset'],
      name: 'DSH Agent Preset',
      description: 'Portable DSH Agent Preset package',
      role: 'Editor',
      mimeType: 'application/vnd.dsh.agent-preset+zip',
      exportedType: {
        identifier: 'io.github.moresyl.dshstudio.agent-preset',
        conformsTo: ['public.zip-archive'],
      },
    },
  ])
})
