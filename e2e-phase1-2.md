# E2E 剧本 — 阶段 1 & 2（已执行通过）

> 执行环境：herdr 0.9.5，协调员与 worker 均为 pi。本剧本记录的命令序列可直接复跑。

## 准备

```bash
rm -rf /tmp/swarm-e2e && mkdir -p /tmp/swarm-e2e && cd /tmp/swarm-e2e
git init -q && echo "# e2e repo" > README.md && git add -A && git commit -qm init
# 在 herdr 里为协调员开 pane 并启动（或直接在目标 pane 手动跑 pi）
herdr pane split --current --direction down --cwd /tmp/swarm-e2e --no-focus
herdr agent start coord-e2e --kind pi --pane <pane-id> --timeout 60000
```

注意（实测经验）：

- `agent start` 返回 `interactive_ready` 后 pi 仍在初始化，**过早投递 prompt 会丢键**。对协调员先发一条无关 prompt（如"回复 OK"）确认管道通，再发 `/swarm`。
- 斜杠命令不会产生 `working` 状态：用 `agent prompt` 时**不要**加 `--wait`（会误报 `agent_prompt_stalled`）；且 `--timeout` 必须与 `--wait` 成对。

## 阶段 1：最小闭环

```bash
herdr agent prompt coord-e2e "/swarm 在 README.md 末尾追加一行注释 // swarm-e2e-test，然后 commit"
# 等约 1 分钟后验证：
cd /tmp/swarm-e2e && git log --oneline -3        # 期望：worker 的 commit
tail -3 README.md                                # 期望：注释已追加
```

验收（2026-11-23 实测通过）：

- [x] worker 在右侧 pane 独立 pi 会话开工，无 pty 投递竞态（简报+任务由 worker.ts 自唤醒）
- [x] README.md 出现 `// swarm-e2e-test`，新增 commit `1a5bfbd`
- [x] 协调员会话内模型自动用 swarm_wait / swarm_read_output 收线并汇报 commit hash

## 阶段 2：消息板闭环

验收要点（同一轮 E2E 覆盖）：

- [x] worker 干完后 `report_done`：工作区脏/commit 不符会被拒绝（单元测试覆盖）
- [x] 完成帖 `0001-fix-1-done.md`（type: done, to: hub）落盘，含 commit 摘要
- [x] 协调员 `agent_end` 轮询读到 hub 新帖 → `sendUserMessage(nextTurn)` 唤醒自己 → `swarm_read` 读板汇总
- [x] 发帖序号自增、撞号由 `wx` 标志 + 重扫重试兜底（单元测试覆盖）

## 已修掉的实测竞态（编码时新增的回归红线）

1. **pane split → agent start 竞态**：split 返回后 shell 未就绪，`agent_pane_busy`。spawn 已内置瞬态重试（≤10 次 × 600ms）。
2. **agent 参数编码限制**：长简报（换行/花括号）被 herdr 拒绝（`agent arguments cannot be encoded safely`）。简报一律走 roster 文件 + worker.ts 自读，不走启动参数或首条 prompt。
3. **pi 启动期全屏提示**（如 tools/ 迁移警告 "Press any key"）：spawn 后补发一个无害按键（space）过关。
4. **wait 语义**：agent 收线后状态是 `done` 不是 `idle`，`--until idle` 会死等到超时。`swarm_wait` 使用 herdr 默认 settled 集（idle/done/blocked）。
5. **abort 传播**：`swarm_wait`/`agentPrompt` 已接 pi 的 AbortSignal，打断会话时立刻杀掉挂着的 herdr 子进程。
6. **残骸 run 接管**：spawn 失败时 run 状态落盘为 `aborted`，`loadRoster` 只接管 `active`。
