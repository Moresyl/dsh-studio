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
