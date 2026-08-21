# DSH Studio 使用指南

[English](user-guide.md)

## 第一次启动

1. 环境页会寻找 Node.js 22.19 或更高版本；没有时可由应用下载并校验官方运行时。
2. 应用把固定版本的 `@deepseek-ai/dsh` 安装到自己的数据目录，不修改全局 npm。
3. 工作区必须存在。Windows 会检查磁盘类型与文件系统：本地 NTFS/ReFS 可直接使用，网络盘、可移动盘和 FAT/exFAT 会阻止启动。
4. 选择 Profile 后启动。Harness 只监听 `127.0.0.1` 的随机端口。

## 插件

「发现」页可切换 npm、DSH 1024Store 或自定义标准目录。目录只负责发现，安装前仍会从 npm 重新读取精确版本、检查包名和 Harness peer 兼容性。插件变更写入恢复日志；进程中断后，下次启动会恢复变更前状态并给出提示。

## 日志与诊断

「关于」页可以导出诊断报告。报告包含版本、运行时、Profile、恢复状态和日志尾部，并自动遮蔽令牌、授权头、查询密钥和用户目录。持久化日志位于应用数据目录的 `logs` 子目录。

## 更新

应用读取 GitHub Release 的 `latest.json`，只安装通过内置公钥验证的更新。正式发布流水线要求 Windows Authenticode、macOS Developer ID + 公证票据以及 Tauri 更新签名全部存在，否则不会发布。

## 远程访问

远程访问默认关闭。开启后，LAN 网关使用一次性二维码为每台设备签发独立凭据；Harness 本身仍只监听回环地址。可以随时撤销单台设备。

遇到问题请先看[故障排查](troubleshooting.zh-CN.md)，仍无法解决时导出诊断报告后提交 issue。
