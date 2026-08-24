# 插件与目录开发

[English](plugin-development.md)

## 插件包

能从市场安装的插件必须是合法 npm 包：发布 Harness 能识别的 Profile patch，并在
`peerDependencies` 中声明兼容的 `@deepseek-ai/dsh` 范围。Studio 必须先解析出一个
已发布的精确版本才会改动 Profile；`1.2.3-rc.1` 这类精确 SemVer 预发布版本受支持，
版本范围、tag 与构建元数据不属于精确目录身份。Harness peer 不兼容或格式错误、发布者已
弃用、缺少可验证的 SHA-512 registry 完整性，或者声明了 `preinstall`、`install`、
`postinstall`、`prepare` 中任一生命周期脚本，都会被阻止。

目录只负责发现，不是安装权威。它无权要求 Studio 执行命令、允许构建、接受范围或 tag、
安装 Git 来源或传入包管理器参数。非 npm 目录项还必须给出规范化 HTTPS 仓库回链，且与
npm manifest 中的仓库身份一致。

测试至少覆盖：空 Profile、重复安装、卸载/启停、Harness peer 两端边界、生命周期脚本
拒绝、过期预览、安装中断恢复和 Windows 路径。不要把密钥写入包、日志、目录元数据或
示例配置。

## 标准目录 Schema 1.0.0

自定义目录是无凭据的 HTTPS JSON endpoint，只允许 443 端口。响应最大 2 MiB，最多
10,000 项；重定向不能离开已登记源，内网/回环/特殊地址、控制字符以及未通过公网地址
校验的 DNS 结果都会被拒绝。

```json
{
  "schemaVersion": "1.0.0",
  "items": [
    {
      "package": { "name": "@example/dsh-plugin" },
      "latestVersion": "1.2.3",
      "summary": "What the plugin adds",
      "publisher": { "name": "Example" },
      "updatedAt": "2026-08-21T00:00:00Z",
      "repository": { "url": "https://github.com/example/dsh-plugin" },
      "media": {
        "icon": { "url": "https://catalog.example/icons/dsh-plugin.png" }
      }
    }
  ]
}
```

只有上述字段参与发现；安装命令、脚本、路径、Git spec 和权限提示都会被忽略。
`latestVersion` 只是建议值，并且必须是可带预发布段的精确 SemVer；预览和提交都会通过
当前 npm registry 重新解析 `package.name@latestVersion`。

### 受限媒体

图标是可选项，加载失败不会让条目消失。标准目录图标必须与登记 endpoint 同源；经过审查
的适配器可以声明一小组固定域名。Studio 不使用环境代理，把域名钉到已校验的公网地址，
最多跟随两次仍在允许范围内的重定向，只接受 PNG、JPEG 或 WebP；输入最大 2 MiB、
单边最大 4096 像素、总像素不超过 1600 万。解码后重新编码为无元数据的 96 像素 PNG
data URL，远程 URL 不会交给渲染器。

## 两阶段市场安装

1. 预览解析精确 npm manifest，展示兼容范围、生命周期脚本、弃用状态、仓库回链和
   SHA-512 完整性。
2. 只有全部通过才返回绑定当前 Profile、单次使用、两分钟过期的 token。
3. 提交会消费该 token，并重新读取当前目录和精确 npm manifest，重复所有信任检查后才
   启动包管理命令。
4. Studio 串行执行 Profile 变更，先保存控制文件 before-image；成功后记录精确来源、
   版本和完整性回执，中断或失败则恢复原状态。

因此预览成功不是永久授权。来源切换、Profile 变化、过期、重放、目录下架、仓库身份漂移
或 registry 内容漂移都会停止提交，要求重新检查。

## Desktop 公共服务协议——Protocol 3

由当前回环 Harness 来源提供的页面可以探测冻结的 `window.dshStudio`；普通浏览器标签页
不会得到它。当前能力如下：

| 服务        | 支持的操作                                        |
| ----------- | ------------------------------------------------- |
| 根服务      | `hello`、`notify`、原生 `pick`、`badge`、`onLink` |
| `profiles`  | `list`、`select`                                  |
| `plugins`   | 精确版本 `install`、`remove`                      |
| `workspace` | 原生准入 `validate`、目录拖放 `onDrop`            |

```js
const desktop = window.dshStudio
if (!desktop || desktop.protocol !== 3) return

const roster = await desktop.profiles.list()
const selection = await desktop.profiles.select('web')
// selection.restartRequired 为 true；Studio 不会静默终止正在运行的 Harness。

const chosen = await desktop.pick({ mode: 'directory' })
if (chosen.path) {
  const admission = await desktop.workspace.validate(chosen.path)
  if (!admission.allowed) throw new Error(admission.reason)
}

const stopDrop = desktop.workspace.onDrop((path) => {
  // 托管 Harness 客户端会用这个信号创建并打开真实 Workspace。
  console.log(path)
})

await desktop.plugins.install({
  name: '@example/dsh-plugin',
  version: '1.2.3',
  displayName: 'Example plugin',
})
await desktop.plugins.remove('@example/dsh-plugin')
stopDrop()
```

Profile 选择只持久化下次启动目标，不会擅自终止现有会话；调用方必须向用户说明并由用户
明确触发重启。第三方插件通常应使用上游 Harness Workspace 服务；`workspace.onDrop`
是合格托管客户端使用的窄原生信号，不是任意文件系统授权。

桥接层只接受本 Studio 窗口的后代 frame，且来源必须与当前受监管回环 Harness 完全一致。
它不开放原始 Tauri IPC、Shell 执行、任意 pnpm 参数或任意文件系统权限。除用户自己控制
的原生选择器外，调用都有固定超时；Harness 重启后会建立新的来源和信任边界。

## 上游兼容边界

Studio 不维护上游源码 fork，也不重新实现 Harness。托管运行时固定到经过实际执行验证的
上游版本，并携带一个很小的 Studio 集成 bundle。安装时只对锁定浏览器客户端中明确的
目录选择 seam 做确定性转换，让原生目录选择和拖放进入上游 Workspace 服务；运行时合同
同时检查上游依赖图和转换后的 seam。未来上游如果移动该位置，Studio 会进入**修复**，
而不是静默修改未知代码。
