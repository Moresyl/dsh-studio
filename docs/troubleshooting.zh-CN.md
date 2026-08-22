# 故障排查

[English](troubleshooting.md)

## 安装插件出现 404 / No authorization header

如果日志指向 `@deepseek-ai/dsh@0.0.1-rc.1`，并提示 `@deepseek-ai/dsh-code-runtime-worker` 在镜像中不存在，问题来自旧版上游依赖图，不是你的登录状态。当前 Studio 固定使用已验证的 `0.1.0-rc.8` 家族；在环境页点击「修复」即可原子替换旧运行时。若仍报错：

1. 检查 npm registry 是否被设为不完整的镜像；作用域私有包才需要认证，公开包不应依赖 Authorization 头。
2. 切回 `https://registry.npmjs.org/` 后重试。
3. 不要直接删除正在使用的 Profile；先退出 Studio，再导出诊断报告。

## 安装中断

Harness 安装发生在 staging 目录，校验成功后才替换当前运行时。插件操作也保存变更前副本。重启时应用会自动恢复；如果环境页显示恢复失败，点击「修复」并附上诊断报告提交 issue。

## Harness 一直停在「安装中」

Studio 会从官方 npm registry 安装经过验证的运行时，并在控制台显示原生生命周期脚本阶段。连续 120 秒没有任何输出，或安装总时长超过 20 分钟时，任务会被终止并给出错误，不再永久转圈。请根据错误检查网络后重试，或改用完整离线版；窗口无法打开时，可给可执行文件传入 `--export-diagnostics`，并附上生成的 ZIP。

如果 npm 已完成安装但 Contract 2 仍拒绝运行时，请升级到 Studio v0.7.2 或更高版本并点击「修复」。这些版本会把随附 Studio integration 物化为普通目录，不再保留指向临时安装源码的 Windows Junction；如果校验仍失败，错误会列出具体缺失的合同条件。

## 工作区被拒绝

Windows 上请把项目移到本地 NTFS/ReFS 固定磁盘。网络映射盘、U 盘、FAT32 和 exFAT 不能可靠提供包管理器需要的链接、锁和原子替换，因此会在进程启动前被阻止。

## macOS/Windows 阻止安装包

只从正式 Release 或列出的包管理器渠道安装，并核对 `SHA256SUMS.txt`。正式版本必须通过平台签名验证；若系统仍显示未知发布者，请不要绕过提示，先提交 issue 并附上安装包名称与哈希。

## 找不到 Node

环境页可以安装官方 Node 运行时。若公司网络拦截下载，可手动安装满足页面所示最低版本的 Node，再重新检查环境。
