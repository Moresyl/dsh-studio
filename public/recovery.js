;(() => {
  const invoke = window.__TAURI_INTERNALS__?.invoke
  const chinese = navigator.language.toLowerCase().startsWith('zh')
  const text = chinese
    ? {
        title: '应用界面未能启动',
        summary: 'DSH Studio 已打开独立恢复界面；它不依赖 React、Harness、Node 或网络。',
        loading: '正在读取启动证据…',
        retry: '重试界面',
        export: '导出诊断包',
        quit: '退出',
        failed: '操作失败：',
        saved: '诊断包已保存：',
        unavailable: '原生恢复通道不可用。请使用命令行参数 --export-diagnostics。',
      }
    : {
        title: 'The application interface did not start',
        summary:
          'DSH Studio opened a recovery surface that does not depend on React, Harness, Node, or the network.',
        loading: 'Loading startup evidence…',
        retry: 'Retry interface',
        export: 'Export diagnostics',
        quit: 'Quit',
        failed: 'Action failed: ',
        saved: 'Diagnostics saved: ',
        unavailable: 'Native recovery is unavailable. Run the app with --export-diagnostics.',
      }

  const byId = (id) => document.getElementById(id)
  const reason = byId('reason')
  const result = byId('result')
  byId('title').textContent = text.title
  byId('summary').textContent = text.summary
  byId('retry').textContent = text.retry
  byId('export').textContent = text.export
  byId('quit').textContent = text.quit
  reason.textContent = text.loading

  const run = async (button, command) => {
    if (!invoke) {
      result.textContent = text.unavailable
      return undefined
    }
    button.disabled = true
    result.textContent = ''
    try {
      return await invoke(command)
    } catch (error) {
      result.textContent = text.failed + String(error)
      return undefined
    } finally {
      button.disabled = false
    }
  }

  if (!invoke) {
    reason.textContent = text.unavailable
    return
  }
  void invoke('recovery_state').then(
    (state) => {
      reason.textContent = state ? `${state.window}: ${state.reason}` : text.loading
    },
    (error) => {
      reason.textContent = text.failed + String(error)
    },
  )
  byId('retry').addEventListener('click', (event) => {
    void run(event.currentTarget, 'recovery_retry')
  })
  byId('export').addEventListener('click', async (event) => {
    const path = await run(event.currentTarget, 'recovery_export_diagnostics')
    if (typeof path === 'string') result.textContent = text.saved + path
  })
  byId('quit').addEventListener('click', (event) => {
    void run(event.currentTarget, 'recovery_quit')
  })
})()
