/**
 * Two languages, one flat dictionary.
 *
 * A desktop tool for agent work is used just as much in Chinese as in English,
 * and bolting localisation on later is what makes it never happen. The type of
 * `zh` is derived from `en`, so a missing translation is a build error.
 */

const en = {
  'app.tagline': 'A native shell for the DeepSeek Harness',

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
  'check.workspace': 'Workspace',

  'source.path': 'on PATH',
  'source.nvm': 'via nvm',
  'source.fnm': 'via fnm',
  'source.volta': 'via Volta',
  'source.system': 'system install',

  'action.start': 'Start harness',
  'action.starting': 'Starting…',
  'action.retry': 'Try again',
  'action.stop': 'Stop',
  'action.open': 'Open workspace',
  'action.recheck': 'Check again',
  'action.install': 'Install',
  'action.installing': 'Installing…',
  'action.getNode': 'Get Node.js',

  'install.working': 'Fetching the harness and its dependencies',
  'install.progress': '{count} packages so far',
  'install.slow': 'This takes several minutes on a first install.',

  'chip.openPanel': 'Open control panel',
  'chip.backToHarness': 'Back to the harness',

  'log.show': 'Show output',
  'log.hide': 'Hide output',
  'log.empty': 'No output yet.',
  'log.title': 'Harness output',

  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.restore': 'Restore',
  'window.close': 'Close',
} as const

export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  'app.tagline': 'DeepSeek Harness 的原生桌面外壳',

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
  'check.workspace': '工作目录',

  'source.path': '来自 PATH',
  'source.nvm': '来自 nvm',
  'source.fnm': '来自 fnm',
  'source.volta': '来自 Volta',
  'source.system': '系统安装',

  'action.start': '启动 Harness',
  'action.starting': '启动中…',
  'action.retry': '重试',
  'action.stop': '停止',
  'action.open': '打开工作目录',
  'action.recheck': '重新检测',
  'action.install': '安装',
  'action.installing': '安装中…',
  'action.getNode': '获取 Node.js',

  'install.working': '正在获取 Harness 及其依赖',
  'install.progress': '已处理 {count} 个包',
  'install.slow': '首次安装需要几分钟。',

  'chip.openPanel': '打开控制面板',
  'chip.backToHarness': '返回 Harness',

  'log.show': '查看输出',
  'log.hide': '收起输出',
  'log.empty': '暂无输出。',
  'log.title': 'Harness 输出',

  'window.minimize': '最小化',
  'window.maximize': '最大化',
  'window.restore': '还原',
  'window.close': '关闭',
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
