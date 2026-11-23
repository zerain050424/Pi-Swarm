# PLAN — Swarm 插件阶段 4（打磨：模型路由 / cleanup / 状态小组件 / 只读看板 overlay）

## Context

阶段 1~3 已交付并 E2E 验证。本阶段补齐 Design.md §10 遗留的四项打磨，用户已拍板：

1. **模型路由**：`swarm_plan` 的 `model` 字段在映射 MemberEntry 时被丢弃（index.ts ~668），spawnTeam 的 `opts.model` 只有全局口径。**决策：只靠 plan 字段**——每成员不填 `model` 就继承协调员当前模型（即不传 `--model`），填了就透传 `pi --model`。
2. **`/swarm cleanup`**：**决策：回收资源留档案**——删 worktree 目录（`git worktree remove --force`）、删对应分支、关存活 pane；保留 `.pi/swarm/<run-id>/`（板子+roster）供排查。
3. **状态小组件**：`ctx.ui.setWidget` 常驻一行：`swarm <runId> | @fix-1(worker) working · @verifier idle r1 | 帖 #N`。数据源 roster（agent_end 轮询已在刷新），run 结束/abort 后清除。仅 `ctx.mode === "tui"` 生效。
4. **Alt+S 只读看板 overlay**：`registerShortcut(Key.alt("s"))` + `ctx.ui.custom({ overlay: true })`，展示成员名册 + 帖子流回放（frontmatter 行 + 正文），esc/q 关闭。只读，无写入竞态。

## Files to modify

全部在 `~/.pi/agent/extensions/swarm/`：

- `shared.ts` — `MemberEntry` 加 `model?: string`。
- `index.ts` — ①plan 映射补 `model: m.model`；②spawnTeam/startAgentInPane/spawnMember 改 `member.model ?? opts.model`；③`/swarm cleanup` 命令 + `collectCleanupTargets(run)` 纯函数；④`agent_end` 里 `updateWidget(ctx)`；⑤`registerShortcut` + `openBoardOverlay(ctx)`；⑥swarm_plan 分工帖/确认文案带模型名。
- `worker.ts` — 无改动（简报不含 model，模型在启动参数层）。
- `swarm.test.ts` — 新增：模型透传拼装、cleanup 目标收集、widget 文本渲染（纯函数 `renderWidget(run, boardMaxSeq)`）。
- `e2e-phase4.md` — 验证剧本。
- `Design.md` — §10 表补阶段 4 状态（文档收尾）。

## Reuse

- `spawnMember`/`startAgentInPane` 的 `opts.model → agentArgs.push("--model")` 现成管道（index.ts:139、278），只改取值优先级。
- `agent_end` 轮询已刷新 roster 成员状态（index.ts），widget 刷新直接挂在其尾部。
- `cmdAbort` 的回收逻辑（paneClose + git worktree remove）cleanup 复用同款调用；worktree 路径与分支在 `MemberEntry.worktreePath/branch` 里现成。
- `readAllPosts(board.ts)` 供 overlay/渲染取帖。
- `Key.alt("s")` 来自 `@earendil-works/pi-tui`（preset.ts 示例同款写法）。

## Steps

- [x] 1. **模型路由**：`MemberEntry.model`；plan 映射补 model；spawnTeam/startAgentInPane/spawnMember 取 `member.model ?? opts.model`；确认框/分工帖显示模型。单测：fake herdr 断言 agentStart args 里出现成员各自的 `--model`。
- [x] 2. **渲染纯函数**：`renderWidget(run, maxSeq): string[]`（单行紧凑）+ `renderBoard(run): string[]`（overlay 全屏文本：名册 + 帖子流）。先测后写。
- [x] 3. **`/swarm cleanup`**：参数支持 `cleanup [run-id]`（缺省=最近一个非 active run）。`collectCleanupTargets(cwd, runId?)`：扫 `.pi/swarm/*/roster.json`，对 done/aborted run 收集 {paneId, worktreePath, branch}（roster 里记录的）→ 关 pane → `git worktree remove --force` → `git branch -D`。**不删 run 目录**。已回收过的目标幂等跳过（pane/worktree 不存在时吞错）。单测：fake roster + fake git/herdr 断言调用序与幂等。
- [x] 4. **状态小组件**：`agent_end` 尾部调 `updateWidget(ctx)`（tui 守卫；`ctx.ui.setWidget("swarm", renderWidget(...))`）；无 run / run 结束（status !== active）时 `setWidget("swarm", undefined)` 清除；`session_shutdown` 同样清除。
- [x] 5. **Alt+S overlay**：`registerShortcut` 仅 TUI 模式注册（RPC/print 下 handler 直接 return）；`openBoardOverlay` 用 `ctx.ui.custom` 渲染 `renderBoard` 输出，q/esc 关闭（返回即 dispose）。overlay 内容打开瞬间快照 + 关闭即弃（只读，不做实时刷新——保持零竞态）。
- [x] 6. **E2E**（herdr 实测）：单 worker run → widget 显示状态变化 → 完成收线后 widget 清除 → `/swarm cleanup` 回收 worktree/分支 → Alt+S 看板开关正常 → per-member model 在 `agent start` argv 里可见（fake + 实测各一次）。
- [x] 7. **文档收尾**：Design.md §10 表更新、e2e-phase4.md 剧本、PLAN-PHASE4.md 勾选。

## Verification

- **单测**：`npm test`（TAP，家目录 package.json 已接）。新增覆盖：模型透传 args、renderWidget/renderBoard 文本、cleanup 收集与幂等。
- **E2E**：按 e2e-phase4.md 在 /tmp 测试仓跑一轮 2-worker run（复用阶段 3 流程），人工核对 widget/overlay/cleanup/model argv。
- **回归红线**：扩展工厂内仍零进程启动；焦点不被抢（widget/overlay 不改焦点）；abort/cleanup 幂等；prompt 超时不重发。
