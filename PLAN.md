# PLAN — Swarm 插件实现（v1：阶段 1~3）

## Context

Design.md（v2）已定稿：在 pi 里借 Herdr 实现多智能体团队协作（协调员 + N 个 pi worker + verifier + 消息板）。用户已确认三项决策（全 pi worker / git worktree 隔离 / 先确认再开）并评审过全部架构缺口。本计划把 Design.md 落成代码，proof-first，按阶段推进，每阶段先写测试。

规划摸底已确认的可行性事实：

- `pi -e <path>` 可挂载指定扩展，配 `--no-extensions` 可让 worker 不加载全量用户扩展（explicit `-e` 仍然生效）。
- pi 的位置参数即开场 prompt → worker 简报直接作为 `agent start -- --no-extensions -e worker.ts <briefing>` 的位置参数注入。
- `herdr worktree create` 支持 `--branch` / `--path` / `--cwd`，满足 §5.2 拉人流程。
- Node 24 原生 type-stripping → 纯逻辑模块（board/herdr 封装）用 `node:test` 直接测 .ts，零依赖。
- worker 身份注入用环境变量：coordinator 先 `herdr pane run <pane> "export PI_SWARM_NAME=fix-1 PI_SWARM_RUN=<run-id>"`，再 `agent start`，shell 环境会被 pi 进程继承，worker.ts 在 session_start 读 env 自报身份。

## Approach

按 Design.md §10 的三阶段实现，每阶段独立可验证后再进下一阶段：

1. **阶段 1（最小闭环）**：`index.ts` 注册 `/swarm` 命令（本阶段为固定简报的直通版，不走规划）+ `swarm_spawn`/`swarm_wait` 工具；`herdr.ts` 封装层。拉 1 个 worker、等 idle、取回产出与 commit hash。
2. **阶段 2（消息板）**：`board.ts`（一帖一文件、frontmatter、序号分配）+ `worker.ts`（board_post/board_read/report_done）+ hub 轮询唤醒（挂 `agent_end` 与 `agent wait` 返回）。
3. **阶段 3（完整功能）**：`swarm_plan` 结构化分工 + `ctx.ui` 确认框 + 预检（脏仓/旧 run）+ worktree 隔离 + 多 worker 并行 + 熔断（maxVerifyRounds）+ `/swarm abort`。

阶段 4（模型路由/状态小组件/cleanup/overlay）不在本计划内，另行规划。

## Files to modify/create

全部在 `~/.pi/agent/extensions/swarm/`：

- `Design.md` — 已存在，不改动（实现依据）。
- `herdr.ts` — CLI 薄封装：execFile 包装、JSON 解析、错误归一；pane split / agent start / agent wait / agent prompt / agent list / agent read / worktree create。
- `board.ts` — 消息板纯逻辑：frontmatter 解析与序列化、seq 分配（目录扫描 max+1 + 撞号重试）、按 @/type 过滤。**纯函数、无 IO 副作用的剥出来便于测试**。
- `worker.ts` — worker 侧扩展入口：session_start 读 `PI_SWARM_NAME`/`PI_SWARM_RUN` 自报身份；注册 board_post / board_read / report_done；report_done 强制 commit hash（校验 `git rev-parse HEAD`）。
- `index.ts` — 协调员侧入口：`/swarm`、`/swarm abort` 命令；swarm_plan / swarm_spawn / swarm_post / swarm_read / swarm_status / swarm_wait / swarm_read_output 工具（namespace `swarm`）；`agent_end` 挂轮询唤醒。
- `swarm.test.ts` — board.ts 与解析/校验逻辑的单元测试。
- `e2e-phase1.md` / `e2e-phase2.md` — 手动 E2E 剧本（见 Verification）。

运行期产物目录（代码创建，不入库）：`.pi/swarm/<run-id>/{posts/,plan.json,roster.json}`。

## Reuse

- `~/.pi/agent/extensions/ds-search.ts` — 本机现成的扩展写法参照：`registerTool`（TypeBox schema + execute）、`registerCommand`、常量/错误处理组织方式、输出截断预算模式（MAX_OUTPUT_CHARS）。
- `herdr` skill 文档（`~/.agents/skills/herdr/SKILL.md`）已确认的命令语义与红线（ID 从 JSON 响应读、`--no-focus`、prompt 超时不重发）直接作为 herdr.ts 的行为规范。
- pi 内置 `withFileMutationQueue()` — 防单进程内重入，board 写入仍要用。

## Steps

### 阶段 1：最小闭环

- [x] 1.1 `herdr.ts`：execFile 封装（`herdr <args>` → JSON parse，exit 1=server 错误 / 2=语法错误归一为 HerdrError）；实现 `paneSplit`、`agentStart`、`agentWait`、`agentPrompt`、`agentList`、`agentRead`、`worktreeCreate`。
- [x] 1.2 `index.ts`：`/swarm <task>` 命令 v0——环境检查（HERDR_ENV、herdr 可用）后，固定分工（单 worker `@fix-1`，简报 = 用户 task），执行 spawn。
- [x] 1.3 spawn 实现：pane split（按几何规则）→ `pane run export PI_SWARM_*` → `agent start --kind pi -- --no-extensions -e <abs worker.ts 路径占位，本阶段用 --append-system-prompt 注入简报>` → 确认 agent 上线。
- [x] 1.4 `swarm_wait` 工具：`agent wait --until idle` + 超时；`swarm_read_output` 截断读取。
- [x] 1.5 单测：herdr.ts 的参数拼装与错误归一（mock execFile）。

### 阶段 2：消息板 + worker 扩展

- [x] 2.1 `board.ts` 纯逻辑：frontmatter 解析/序列化（seq/from/to/type/round/refs）、seq 分配、过滤；先写 `swarm.test.ts`（含撞号重试、非法 frontmatter 容错），再实现。
- [x] 2.2 `worker.ts`：身份自报（env 缺失则拒绝激活）、三工具注册、report_done 的 commit 校验。
- [x] 2.3 spawn 链路切换为正式版：简报按 Design.md §9 模板实例化为开场 prompt；worker 带三工具上岗。
- [x] 2.4 hub 侧 `swarm_post`/`swarm_read` + `agent_end` 轮询唤醒（roster ack 标记防重复）。
- [x] 2.5 E2E：手动两 pi 往返（见 Verification）。

### 阶段 3：完整功能

- [x] 3.1 `swarm_plan` 工具：分工清单 TypeBox schema（name/scope/forbidden/definitionOfDone/role/model/maxVerifyRounds，worker 数上限 4 校验）。
- [ ] 3.2 确认框：预检结果 + 分工清单 + 配额提示，经 `ctx.ui` 确认；确认后建 run 目录、写 plan.json/roster.json。
- [x] 3.3 worktree 隔离 spawn：每成员 `worktree create --branch <run-id>-<名>`，roster 记录映射；失败全量回滚（逆序关 pane、worktree remove、删 run 目录）。
- [x] 3.4 verifier：role=verifier 时简报含全队 worktree/branch 清单 + 测试许可边界声明。
- [x] 3.5 熔断：round 计数 > maxVerifyRounds 停止唤醒、汇总呈报。
- [x] 3.6 `/swarm abort`：停活 worker、回收 pane/worktree、保留 run 目录、roster 置 aborted。
- [x] 3.7 单测补齐：plan schema 校验、熔断计数、回滚序。

## Verification

**单测**：`node --test swarm.test.ts`（Node 24 原生跑 TS）。纯逻辑全覆盖：frontmatter 往返、seq 分配与撞号、过滤、plan 校验、熔断计数、herdr 参数拼装。

**E2E（herdr 真实环境，手动按剧本执行）**：

- 阶段 1：在测试仓库跑 `/swarm 在 README 加一行注释并 commit` → worker pane 可见开工 → idle 后主会话取回 commit hash，`git log` 确认。
- 阶段 2：worker A 发 issue 帖 @verifier → hub 唤醒 verifier → verifier 回帖 → 往返两轮无重复唤醒；故意并发发帖验证无覆盖、序号连续。
- 阶段 3：3 worker 并行改 3 个模块 → verifier 打回 1 次后收敛 → 汇总正确；中途 `/swarm abort` → 现场保留、pane/worktree 回收；脏仓预检警告可见。

**回归红线**（每次阶段收尾跑一遍）：用户焦点始终留在协调员 pane；扩展加载期无任何 herdr 进程启动；prompt 超时后无重发。

## 风险与对策（实现期）

- `agent start -- <args>` 传给 pi 的参数若被 herdr 侧校验拦截 → 降级为 `--append-system-prompt` + 首 条 `agent prompt` 注入简报（已在 1.3 预留降级路径）。
- worker 简报超长（模板 + task）→ 简报主体走 `-e worker.ts` 的 session_start 注入，开场 prompt 只放 task 与 run-id。
