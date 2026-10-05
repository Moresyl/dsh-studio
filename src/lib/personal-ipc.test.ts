import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  libraryExportSave,
  libraryImportApply,
  libraryImportPreview,
  sessionAnnotateMany,
  workspaceFileRead,
  workspaceFiles,
} from './ipc'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
describe('private desktop personal-data and file commands', () => {
  it('passes the exact preview binding and explicit conflict policy', async () => {
    const preview = {
      revision: 'reviewed',
      sourceHash: 'content',
      prompts: 1,
      sessions: 0,
      conflicts: 0,
      names: [],
      promptsOnly: true,
    }
    await libraryImportPreview('source')
    expect(invoke).toHaveBeenLastCalledWith('library_import_preview', { source: 'source' })
    await libraryImportApply('source', preview, true)
    expect(invoke).toHaveBeenLastCalledWith('library_import_apply', {
      source: 'source',
      revision: 'reviewed',
      sourceHash: 'content',
      overwrite: true,
    })
    await libraryExportSave('C:/backup.json', true)
    expect(invoke).toHaveBeenLastCalledWith('library_export_save', {
      path: 'C:/backup.json',
      promptsOnly: true,
    })
    await sessionAnnotateMany(['one'], { removeTags: ['old'] })
    expect(invoke).toHaveBeenLastCalledWith('session_annotate_many', {
      ids: ['one'],
      annotation: { removeTags: ['old'] },
    })
  })
  it('browses the selected root initially and binds all subsequent reads to it', async () => {
    await workspaceFiles('')
    expect(invoke).toHaveBeenLastCalledWith('workspace_files', {
      relative: '',
      expectedRoot: null,
      query: null,
    })
    await workspaceFiles('src', 'C:/project')
    expect(invoke).toHaveBeenLastCalledWith('workspace_files', {
      relative: 'src',
      expectedRoot: 'C:/project',
      query: null,
    })
    await workspaceFiles('', 'C:/project', '中文 title')
    expect(invoke).toHaveBeenLastCalledWith('workspace_files', {
      relative: '',
      expectedRoot: 'C:/project',
      query: '中文 title',
    })
    await workspaceFileRead('src/main.ts', 'C:/project')
    expect(invoke).toHaveBeenLastCalledWith('workspace_file_read', {
      relative: 'src/main.ts',
      expectedRoot: 'C:/project',
    })
  })
})
