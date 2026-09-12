# DSH Studio 文档

DSH Studio 是 DeepSeek Harness 的原生桌面承载层。按下面的入口可以快速
完成安装、排查问题或开发插件。

## 选择你的路径

### 我要使用 Studio

- [使用指南](user-guide.zh-CN.md)——安装运行时、创建 Profile、打开终端并安全更新。

### 我遇到了问题

- [故障排查](troubleshooting.zh-CN.md)——启动、插件安装、网络、工作区和恢复检查。
- [支持与验证矩阵](support-matrix.zh-CN.md)——各平台已验证范围及仍需真实设备验证的部分。

### 我要扩展 Studio

- [插件开发](plugin-development.zh-CN.md)——开发并验证兼容插件。
- [插件互操作合同](plugin-interoperability.zh-CN.md)——Host Protocol 1 与安全边界。
- [架构](architecture.zh-CN.md)——进程所有权、运行时隔离和恢复设计。
- [路线图](ROADMAP.zh-CN.md)——已交付能力和可独立验证的差距。

## 五分钟完成首次运行

1. 从[最新版本](https://github.com/Moresyl/dsh-studio/releases/latest)下载对应操作系统的安装包。
2. 打开“环境”，让 Studio 安装或验证托管 Node 与 Harness 运行时。
3. 运行时健康检查通过后再启动 Harness、创建 Profile。
4. 如果出现恢复提示，优先使用“修复”，不要直接删除 Profile；修复会尽量保留用户数据。

## 支持信息

反馈问题时请附上软件版本、操作系统、当前 Profile、触发问题的具体操作、
第一行错误信息和脱敏诊断包。不要提交 API Key、会话令牌或私有工作区内容。

[English documentation](index.md)
- [支持与验证矩阵](support-matrix.zh-CN.md)
