/**
 * Two languages, one flat dictionary.
 *
 * A desktop tool for agent work is used just as much in Chinese as in English,
 * and bolting localisation on later is what makes it never happen. The type of
 * `zh` is derived from `en`, so a missing translation is a build error.
 */

const en = {
  'section.environment': 'Environment',
  'section.service': 'Service',
  'section.runtimes': 'Node runtimes',

  'status.stopped': 'Not running',
  'status.starting': 'Starting the harness',
  'status.ready': 'Running',
  'status.restarting': 'Reconnecting ({attempt})',
  'status.failed': 'Stopped on an error',

  'check.node': 'Node.js runtime',
  'check.node.missing': 'Node {minimum} or newer required',
  'check.node.found': '{version} · {source}',
  'check.harness': 'DeepSeek Harness',
  'check.harness.missing': 'Not installed yet',
  'check.harness.installed': 'Ready',

  'service.address': 'Address',
  'service.process': 'Process',

  'runtime.active': 'in use',
  'runtime.tooOld': 'too old',

  'source.path': 'on PATH',
  'source.nvm': 'via nvm',
  'source.fnm': 'via fnm',
  'source.volta': 'via Volta',
  'source.system': 'system install',

  'action.start': 'Start harness',
  'action.starting': 'Starting…',
  'action.retry': 'Try again',
  'action.stop': 'Stop',
  'action.recheck': 'Check again',
  'action.install': 'Install',
  'action.installing': 'Installing…',
  'action.getNode': 'Get Node.js',

  'install.working': 'Fetching the harness and its dependencies',
  'install.progress': '{count} packages so far',
  'install.slow': 'This takes several minutes on a first install.',

  'view.harness': 'Harness',
  'view.panel': 'Control panel',

  'statusbar.open': 'Open in your browser',
  'statusbar.copy': 'right-click to copy',
  'statusbar.copied': 'Copied',
  'statusbar.reveal': 'Show in file manager',

  'log.empty': 'No output yet.',
  'log.title': 'Harness output',
  'log.lines': '{count} lines',

  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.restore': 'Restore',
  'window.close': 'Close',
  // Said on the button rather than discovered afterwards: while the harness is
  // up, closing the window leaves it running under the tray icon.
  'window.hide': 'Close to tray — the harness keeps running',
} as const

export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  'section.environment': '运行环境',
  'section.service': '服务',
  'section.runtimes': 'Node 运行时',

  'status.stopped': '未运行',
  'status.starting': '正在启动',
  'status.ready': '运行中',
  'status.restarting': '正在重连（第 {attempt} 次）',
  'status.failed': '已因错误停止',

  'check.node': 'Node.js 运行时',
  'check.node.missing': '需要 Node {minimum} 或更高版本',
  'check.node.found': '{version} · {source}',
  'check.harness': 'DeepSeek Harness',
  'check.harness.missing': '尚未安装',
  'check.harness.installed': '就绪',

  'service.address': '地址',
  'service.process': '进程',

  'runtime.active': '使用中',
  'runtime.tooOld': '版本过低',

  'source.path': '来自 PATH',
  'source.nvm': '来自 nvm',
  'source.fnm': '来自 fnm',
  'source.volta': '来自 Volta',
  'source.system': '系统安装',

  'action.start': '启动 Harness',
  'action.starting': '启动中…',
  'action.retry': '重试',
  'action.stop': '停止',
  'action.recheck': '重新检测',
  'action.install': '安装',
  'action.installing': '安装中…',
  'action.getNode': '获取 Node.js',

  'install.working': '正在获取 Harness 及其依赖',
  'install.progress': '已处理 {count} 个包',
  'install.slow': '首次安装需要几分钟。',

  'view.harness': 'Harness',
  'view.panel': '控制面板',

  'statusbar.open': '在浏览器中打开',
  'statusbar.copy': '右键复制',
  'statusbar.copied': '已复制',
  'statusbar.reveal': '在文件管理器中显示',

  'log.empty': '暂无输出。',
  'log.title': 'Harness 输出',
  'log.lines': '{count} 行',

  'window.minimize': '最小化',
  'window.maximize': '最大化',
  'window.restore': '还原',
  'window.close': '关闭',
  'window.hide': '关闭到托盘（Harness 继续运行）',
}

const dictionaries = { en, zh }

/** Chinese for any Chinese locale tag, English for everything else. */
const detect = (): keyof typeof dictionaries =>
  navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'

const active = dictionaries[detect()]

/** Look up a message and fill in any `{placeholder}` values. */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const template: string = active[key]
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  )
}
