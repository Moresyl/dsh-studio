<!--
Write in whichever language you actually speak. Both are read here.
用你真正会写的语言就行，中英文都有人看。
-->

## What this changes / 改了什么

<!-- One or two sentences. The diff shows what; this is for why. -->
<!-- 一两句话。改了什么 diff 里看得见，这里写为什么。 -->

Closes #

## Checks / 检查

<!-- CI runs the same set on Linux, Windows and macOS. -->
<!-- CI 会在 Linux、Windows、macOS 上跑同一套。 -->

- [ ] `pnpm lint` — ESLint, zero warnings / 零警告
- [ ] `pnpm exec tsc --noEmit` — strict TypeScript / 严格模式
- [ ] `pnpm test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --workspace`
- [ ] `pnpm format` and `cargo fmt --all` / 已跑过格式化

## If it applies / 如果涉及

- [ ] **Strings:** added to both dictionaries in `src/lib/i18n.ts`. / **文案：** `src/lib/i18n.ts` 里中英两份都加了。
- [ ] **UI:** a screenshot is below. / **界面：** 下面附了截图。
- [ ] **Supervisor or process handling:** says below what happens when the shell is killed outright, not just closed. / **supervisor 或进程处理：** 下面说明了外壳被强杀（而不是正常关闭）时会发生什么。
- [ ] **Suppression:** if the diff contains a `@ts-ignore`, an `as any`, a skipped test or an empty `catch`, the reason is written below rather than left in the code. / **压制：** 如果 diff 里出现了 `@ts-ignore`、`as any`、跳过的测试或空 `catch`，理由写在下面，而不是留在代码里。

## Notes / 补充

<!-- Screenshots, trade-offs you weighed, anything a reviewer would otherwise
     have to reconstruct from the diff. -->
<!-- 截图、你权衡过的取舍、以及任何 reviewer 不看就得从 diff 里自己推出来的东西。 -->
