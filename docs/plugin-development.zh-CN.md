# 插件与目录开发

[English](plugin-development.md)

## 插件包

插件必须是合法 npm 包，发布一个 Harness 能识别的 Profile patch，并在 `peerDependencies` 中声明兼容的 `@deepseek-ai/dsh` 范围。Studio 安装前会把版本解析成精确 spec，拒绝不兼容或畸形范围。安装脚本由 npm/Harness 规则管理，目录本身无权要求执行命令或放宽构建权限。

测试至少覆盖：空 Profile、重复安装、卸载/启停、Harness peer 边界、安装中断后的恢复，以及 Windows 路径。不要把密钥写入包、日志或目录元数据。

## 标准目录 Schema 1.0.0

自定义目录是无凭据的 HTTPS JSON endpoint，只允许 443 端口。响应最大 2 MiB，最多 10,000 项；跨源跳转、内网/回环/特殊地址和 Unicode 控制字符会被拒绝。

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
      "repository": { "url": "https://github.com/example/dsh-plugin" }
    }
  ]
}
```

除上面字段外的安装命令、脚本、文件路径、git spec 和权限提示都会被忽略。点击安装后，Studio 只使用 `package.name@latestVersion`，再向当前 npm registry 做预检。

## Desktop 公共服务协议

由当前回环 Harness 源提供的页面可以探测 `window.dshStudio`。Protocol 2 除通知、原生文件选择、角标和深链外，还提供两个冻结的公共服务：

```js
const roster = await window.dshStudio.profiles.list()
const selection = await window.dshStudio.profiles.select('web')
// selection.restartRequired 为 true；Studio 不会静默终止正在运行的 Harness。

await window.dshStudio.plugins.install({
  name: '@example/dsh-plugin',
  version: '1.2.3',
  displayName: 'Example plugin',
})
await window.dshStudio.plugins.remove('@example/dsh-plugin')
```

插件安装必须给出精确且不可变的版本。Studio 会重新从 npm 解析，检查 Harness 兼容范围和 registry 完整性；非 npm 项还必须仍存在于当前目录。随后 Profile 改动与市场安装凭据在同一个可恢复事务里提交，并发包操作会被拒绝。Profile 选择只持久化下次使用的 Profile，不会擅自终止现有会话；调用方必须向用户说明并由用户明确触发重启。

桥接层只接受本 Studio 窗口下、来源与当前受监管回环 Harness 完全一致的 frame。它不开放原始 Tauri IPC、Shell 执行、任意 pnpm 参数或任意文件系统权限。
