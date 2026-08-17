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

  'nav.console': 'Console',
  'nav.plugins': 'Plugins',
  'nav.remote': 'Remote',
  'nav.about': 'About',

  'plugins.title': 'Plugin marketplace',
  'plugins.subtitle': 'Packages that add a layer to the {profile} profile',
  'plugins.tab.discover': 'Discover',
  'plugins.tab.installed': 'Installed',
  'plugins.search': 'Search the registry',
  'plugins.searching': 'Searching the registry…',
  'plugins.noResults': 'Nothing published matches that.',
  'plugins.noneInstalled': 'No plugins installed yet.',
  'plugins.uninitialized': 'The profile is created the first time the harness runs.',
  'plugins.downloads': '{count}/week',
  'plugins.updated': 'Updated {date}',
  'plugins.builtin': 'in box',
  'plugins.layer': 'layer',
  'plugins.library': 'library',
  'plugins.install': 'Install',
  'plugins.installing': 'Installing…',
  'plugins.installed': 'Installed',
  'plugins.remove': 'Remove',
  'plugins.removing': 'Removing…',
  'plugins.confirmRemove': 'Remove this plugin?',
  'plugins.confirmRemoveBody':
    'The package is uninstalled from the profile, and its layer stops loading at the next start. Nothing else in the profile is touched.',
  'plugins.clearSearch': 'Clear search',
  'plugins.restart': 'Layers are composed at startup — restart the harness to apply a change.',
  'plugins.bootstrap':
    'No package manager on this machine. The first change installs one first, which takes a few minutes.',
  'plugins.declaresPatch': 'Declares a profile patch',
  'plugins.noPatch': 'Declares no profile patch — this is a plain library',
  'plugins.license': 'License',
  'plugins.dependencies': 'Dependencies',
  'plugins.homepage': 'Homepage',
  'plugins.repository': 'Repository',
  'plugins.profile': 'Profile',
  'plugins.pick': 'Pick a package to see what it declares.',
  'plugins.detailFailed': 'Could not read the published manifest.',

  'remote.title': 'Remote access',
  'remote.subtitle': 'Reach the harness from a phone on the same network',
  'remote.open': 'Open access',
  'remote.opening': 'Opening…',
  'remote.close': 'Close access',
  'remote.state.open': 'Open',
  'remote.state.closed': 'Closed',
  'remote.needsHarness': 'Start the harness first — there is nothing to reach yet.',
  'remote.scan': 'Scan to pair',
  'remote.scanHint':
    'Scanning once pairs that device and gives it a key of its own. The code works one time only.',
  'remote.address': 'Address',
  'remote.copyPairing': 'Copy pairing link',
  'remote.expiresIn': 'Expires in {seconds}s',
  'remote.expired': 'This code has expired',
  'remote.expiredHint': 'A code works once, and for two minutes. Devices already paired are fine.',
  'remote.newCode': 'New code',
  'remote.active': 'Connected',
  'remote.served': 'Relayed',
  'remote.refused': 'Refused',
  'remote.reachableAt': 'This machine is reachable at',
  'remote.noNetwork': 'No network another device could reach this machine on.',
  'remote.devices': 'Paired devices',
  'remote.noDevices': 'Nothing has paired yet.',
  'remote.unknownDevice': 'Unnamed device',
  'remote.pairedAgo': 'Paired {when}',
  'remote.lastSeen': 'last seen {when}',
  'remote.forget': 'Forget',
  'remote.confirmForget': 'Forget this device?',
  'remote.confirmForgetBody':
    'It loses access immediately, including anything it has open right now. Pair it again with a new code.',
  'remote.note.loopback':
    'The harness stays on 127.0.0.1. This opens a separate door in front of it, and the door closes when the harness stops.',
  'remote.note.secret':
    'Every key is made when it is needed and is never written to disk. Closing the door throws them all away.',
  'remote.note.perDevice':
    'Each device gets its own key, so one can be forgotten without turning the others away.',
  'remote.note.oneAddress':
    'One address, not every interface — a VPN or a virtual switch does not quietly become a second way in.',

  'when.now': 'just now',
  'when.minutes': '{count} min ago',
  'when.hours': '{count} h ago',
  'when.days': '{count} d ago',

  'about.title': 'About',
  'about.subtitle': 'What this build is, and where it keeps things',
  'about.version': 'Version',
  'about.platform': 'Platform',
  'about.appData': 'App data',
  'about.harnessDir': 'Harness',
  'about.profileDir': 'Profile',
  'about.check': 'Check for updates',
  'about.checking': 'Checking…',
  'about.current': 'You are on the latest release.',
  'about.available': 'Version {version} is available.',
  'about.release': 'Open the release',
  'about.source': 'Source code',
  'about.license': 'MIT licensed',
  'about.paths': 'Locations',

  'update.available': 'Update {version}',
  'update.view': 'See what changed in this release',
  'update.dismiss': 'Not now',

  'menu.copy': 'Copy',
  'menu.copyAll': 'Copy everything',
  'menu.clearLog': 'Clear console',
  'menu.copyAddress': 'Copy address',
  'menu.copyPath': 'Copy path',
  'menu.copyPid': 'Copy process id',

  'dialog.cancel': 'Cancel',
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

  'nav.console': '控制台',
  'nav.plugins': '插件',
  'nav.remote': '远程',
  'nav.about': '关于',

  'plugins.title': '插件市场',
  'plugins.subtitle': '为 {profile} 配置追加图层的扩展包',
  'plugins.tab.discover': '发现',
  'plugins.tab.installed': '已安装',
  'plugins.search': '在源中搜索',
  'plugins.searching': '正在搜索…',
  'plugins.noResults': '没有匹配的已发布扩展包。',
  'plugins.noneInstalled': '尚未安装任何插件。',
  'plugins.uninitialized': '首次运行 Harness 时才会创建该配置目录。',
  'plugins.downloads': '每周 {count} 次',
  'plugins.updated': '更新于 {date}',
  'plugins.builtin': '内置',
  'plugins.layer': '图层',
  'plugins.library': '依赖库',
  'plugins.install': '安装',
  'plugins.installing': '安装中…',
  'plugins.installed': '已安装',
  'plugins.remove': '移除',
  'plugins.removing': '移除中…',
  'plugins.confirmRemove': '要移除这个插件吗？',
  'plugins.confirmRemoveBody':
    '这个扩展包会从配置中卸载，它的图层在下次启动时不再加载。配置里的其他东西不受影响。',
  'plugins.clearSearch': '清除搜索',
  'plugins.restart': '图层在启动时组合，重启 Harness 后改动才会生效。',
  'plugins.bootstrap': '本机没有包管理器，首次改动会先安装一个，需要几分钟。',
  'plugins.declaresPatch': '声明了配置补丁',
  'plugins.noPatch': '未声明配置补丁，这只是一个普通依赖库',
  'plugins.license': '许可证',
  'plugins.dependencies': '依赖',
  'plugins.homepage': '主页',
  'plugins.repository': '仓库',
  'plugins.profile': '配置',
  'plugins.pick': '选择一个扩展包，查看它声明了什么。',
  'plugins.detailFailed': '无法读取已发布的清单。',

  'remote.title': '远程访问',
  'remote.subtitle': '在同一网络下用手机访问 Harness',
  'remote.open': '开启访问',
  'remote.opening': '开启中…',
  'remote.close': '关闭访问',
  'remote.state.open': '已开启',
  'remote.state.closed': '已关闭',
  'remote.needsHarness': '请先启动 Harness，否则没有可访问的服务。',
  'remote.scan': '扫码配对',
  'remote.scanHint': '扫描一次即可完成配对，该设备会拿到属于它自己的密钥。配对码只能用一次。',
  'remote.address': '地址',
  'remote.copyPairing': '复制配对链接',
  'remote.expiresIn': '{seconds} 秒后失效',
  'remote.expired': '配对码已失效',
  'remote.expiredHint': '配对码只能用一次，且两分钟后失效。已经配对的设备不受影响。',
  'remote.newCode': '换一个',
  'remote.active': '当前连接',
  'remote.served': '已转发',
  'remote.refused': '已拒绝',
  'remote.reachableAt': '本机可被访问的地址',
  'remote.noNetwork': '当前没有其它设备能够访问本机的网络。',
  'remote.devices': '已配对的设备',
  'remote.noDevices': '还没有设备配对。',
  'remote.unknownDevice': '未具名的设备',
  'remote.pairedAgo': '{when}配对',
  'remote.lastSeen': '最近一次是{when}',
  'remote.forget': '移除',
  'remote.confirmForget': '要移除这台设备吗？',
  'remote.confirmForgetBody':
    '它会立刻失去访问权限，包括此刻正在进行的连接。之后需要用新的配对码重新配对。',
  'remote.note.loopback':
    'Harness 始终只监听 127.0.0.1。这里开启的是它前面的一道独立的门，Harness 一停止，门就随之关闭。',
  'remote.note.secret': '每一把密钥都在需要时才生成，不会写入磁盘；关闭访问即全部丢弃。',
  'remote.note.perDevice': '每台设备各持一把密钥，因此移除其中一台不会影响其它设备。',
  'remote.note.oneAddress': '只绑定一个地址而不是全部网卡，VPN 或虚拟网卡不会悄悄变成第二个入口。',

  'when.now': '刚刚',
  'when.minutes': '{count} 分钟前',
  'when.hours': '{count} 小时前',
  'when.days': '{count} 天前',

  'about.title': '关于',
  'about.subtitle': '这个版本是什么，以及它把东西放在哪里',
  'about.version': '版本',
  'about.platform': '平台',
  'about.appData': '应用数据',
  'about.harnessDir': 'Harness',
  'about.profileDir': '配置目录',
  'about.check': '检查更新',
  'about.checking': '检查中…',
  'about.current': '已是最新版本。',
  'about.available': '发现新版本 {version}。',
  'about.release': '查看发布页',
  'about.source': '源代码',
  'about.license': 'MIT 许可证',
  'about.paths': '目录位置',

  'update.available': '新版本 {version}',
  'update.view': '查看这个版本改了什么',
  'update.dismiss': '暂不提醒',

  'menu.copy': '复制',
  'menu.copyAll': '复制全部',
  'menu.clearLog': '清空控制台',
  'menu.copyAddress': '复制地址',
  'menu.copyPath': '复制路径',
  'menu.copyPid': '复制进程号',

  'dialog.cancel': '取消',
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
