# DSH Studio 插件互操作合同

[English](plugin-interoperability.md)

状态：**支持 DSH Studio 0.7.x**。线协议为 Protocol 3，目录 Schema 为 1.0.0，SDK
包版本跟随应用版本。文中的“必须”“不得”“应该”是有意设定的规范要求。

本合同明确分开三类扩展面：

1. **Harness Host 插件**在 Harness 下运行本地代码，使用上游 Cordis 服务；Studio 额外
   提供只读 Host Protocol 1，用于读取当前代身份和有界 Profile 清单，但不开放原始原生
   能力、命令执行器、包管理器或 Profile 修改权限。
2. **Harness Web Client 插件**运行在受监管回环页面中，可以通过
   `@moresyl/dsh-studio-sdk` 探测 Protocol 3。
3. **Studio 托管集成**随锁定运行时一起交付和验证，不是第三方权限入口；预期上游 seam
   变化时必须关闭失败。

## Manifest 与兼容性

Studio 市场中的包必须具有合法 npm 身份和已发布精确版本。Harness 插件应该声明：

```json
{
  "peerDependencies": {
    "@deepseek-ai/dsh": "^0.1.0-rc.8"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

市场会拒绝格式错误/不兼容的 peer 范围、已弃用版本、缺少 SHA-512 registry 完整性以及
安装期生命周期脚本。目录不得放宽这些规则。标准目录使用公开的
[`catalog-1.0.0` JSON Schema](schemas/catalog-1.0.0.schema.json)，但通过 Schema 只代表
发现数据合法；两阶段原生检查仍是安装权威。

## 能力与事件

插件依赖可选桌面功能前必须调用 `hello()` 并检查 `capabilities`。只有
`protocol === 3` 时，`window.dshStudio` 才代表兼容宿主；SDK 会强制这个检查。

Protocol 3 有两类推送事件：

- `onLink(handler)` 交付一个解析后的 `dsh://` 链接；启动前等待的链接由第一次
  `hello()` 响应消费。
- `workspace.onDrop(handler)` 向合格的顶层 Harness 客户端交付一个通过准入的原生目录
  路径；它不是文件系统读取权限。

每次订阅都返回 disposer。插件必须随自己的 UI 生命周期解除监听，Harness 导航或重启后
必须重新探测。

### 只读 Host Protocol 1

Host 插件可以通过 `getDshStudioHost(ctx)` 探测 `dshStudioHost`。该服务不可变且只属于
当前 Cordis generation；`profiles.current` 不会原地改变，而 `profiles.list()` 每次重新读取
最多 128 个安全、非符号链接的 Profile 目录，每个 manifest 最多读取 256 KiB。手工损坏的
manifest 会返回稳定的 `unreadable-manifest` 状态，不泄露解析器或文件系统细节，也不会让
一个坏 Profile 隐藏其他健康 Profile。

服务只声明 `profiles.read` 与 `runtime.read`，并明确把任意命令、原生句柄、包修改和
Profile 修改设为禁用。Cordis fiber 卸载后，旧引用会失败。插件必须保留普通 Harness
回退路径，不得把 `DSH_DESKTOP` 等进程环境值解释成授权。

## 展示、调用与传输

公共展示面只有 `window.dshStudio`，不存在原始 preload、Tauri command 或 Shell bridge。
插件 UI 使用冻结的 SDK 合同调用。Studio 内部通过 `postMessage` 传输，但消息形状是实现
细节，插件不得自己构造。

只有发送方属于当前 Studio 窗口后代 frame，且来源与当前受监管回环 Harness 完全相同，
Studio 才接受调用。重启会改变来源并使等待中的调用失效。原生选择器由用户控制，可以长时
等待；其他调用有固定超时。

## 提供者与组合

第三方包仍是普通 Harness 插件。Agent、Session、模型、工具与 Workspace 行为必须使用
上游 Host route、RPC、service 和 slot。桌面支持应该是可选适配器：

```js
import { getDshStudio } from '@moresyl/dsh-studio-sdk'

export function mountDesktopAdapter(scope = window) {
  const desktop = getDshStudio(scope)
  if (!desktop) return () => {}
  return desktop.onLink((link) => {
    scope.dispatchEvent(new CustomEvent('plugin:desktop-link', { detail: link }))
  })
}
```

跨环境插件必须保留 Studio 缺席时的普通 Harness 路径；不得猜测 Profile、寻找私有 CLI，
也不得把 `workspace.onDrop` 解释成打开任意文件的权限。

## 来源、变更与诊断

目录发现、npm 解析和 Profile 变更是三个阶段。市场安装要求可见检查，以及绑定 Profile、
单次使用、两分钟有效的 token。提交时会重新验证来源成员、规范仓库身份、精确 npm 元数据、
兼容范围、弃用状态、生命周期脚本和 SHA-512 完整性；并发包变更会被拒绝。

成功后，Studio 写入精确来源、提供者、包名、版本和完整性回执。只有磁盘状态仍与回执一致
时才可显示“市场托管”。Profile 控制文件具有持久 before-image；启动恢复会报告中断变更，
而不是静默删除用户 Profile。

诊断必须脱敏并限制每类数据量。Studio 诊断包包含公开安全的运行状态、近期轮转日志和崩溃
证据，只有用户明确分享才会离开本机。插件应该记录稳定错误码与非秘密事实，不应输出环境
变量全集、token、registry header 或完整 Prompt 内容。

## 版本与兼容承诺

- 保持现有含义的新增能力可以继续使用 Protocol 3；移除方法、改变结果含义或扩大信任边界
  必须升级协议。
- Catalog Schema 1.0.0 会忽略不支持的元数据；新增必填字段或安装权威必须升级 Schema。
- SDK 跟随 Studio 版本，只描述相符的公共协议。只使用类型和探测时，插件应该把 SDK
  声明为开发依赖。
- 托管运行时合同是精确的；未知上游依赖图或客户端 seam 变化会进入“修复”，不会乐观接受。

## 兼容性检查清单

- 测试普通浏览器/Harness 缺席以及不兼容协议版本。
- 测试导航后的释放，以及反复挂载/卸载。
- 测试每个公共调用的空值、畸形值和边界值。
- 把 Profile 切换测试为重启边界，而不是原地变更。
- 测试安装检查过期/重放以及中断变更恢复。
- 测试 Windows 路径和 Linux/macOS 大小写、规范化差异。
- 不得要求开启局域网远程：它默认关闭，是独立认证网关，Harness 始终只监听回环。
