# 架构与信任边界

[English](architecture.md)

DSH Studio 是 Harness 的宿主，不是其 fork。React WebView 只通过列入 Tauri invoke handler 的命令访问 Rust；Harness 运行在受进程树保护的子进程中，只监听回环地址。Rust supervisor 解析就绪输出、探测健康状态、退避重启，并在退出时由 Windows Job Object 或 Unix 进程组回收整棵子进程树。

供应链分成三条边界：Node 从官方发布索引解析并以官方 SHA-256 验证；Harness 固定到已验证的精确 npm 版本并通过 staging/backup 事务替换；插件目录不能提供命令，只能给出精确 npm 包和版本，实际安装仍经过 npm manifest 与 peer 兼容预检。

远程网关不改变 Harness 的监听地址。配对码一次有效且两分钟过期，兑换后每台设备持有独立、可撤销的随机凭据。诊断和持久化日志在写出前统一脱敏；日志按单文件、时间和目录总量三重限额。诊断 ZIP 只从真实普通文件读取，并受文件数、单项和总字节上限约束；原生转储作为可能包含内存的二进制证据单独提示用户检查。

发布边界由 CI 强制：Tag 必须等于配置版本、双语详细说明必须存在、全平台资产矩阵完整、更新签名存在、Windows/macOS 平台签名验证通过，最后才生成覆盖全部资产的 SHA-256 清单。
