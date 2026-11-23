# Swarm — pi 上的多智能体团队插件（设计稿）

> 基于 Herdr 终端多路复用器，在 pi 里实现类似 Google Antigravity `/swarm` 的多 Agent 协作能力。
> 状态：设计阶段，未开始编码。
> 修订：v2 — 编码前评审定稿。新增唤醒路由、跨进程写板、verifier 可见性、熔断、止损等约定。

## 1. 要解决什么问题

单个 Agent 干大活有两个瓶颈：上下文容易爆、多模块的活只能串行。Swarm 的思路是把一个任务交给一支各有分工的 Agent 小队并行干，每个成员在隔离环境里工作，通过一个共享消息板留痕协作，再由专门的验证员挑错。

我们不做 Antigravity 的复刻，而是借 Herdr 的现有能力（pane 管理、agent 生命周期、worktree）实现同构的最小可用版本。

## 2. 已确认的设计决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| Worker 类型 | 全部用 pi 实例（herdr `--kind pi`） | 共享一套扩展机制，工具链一致，最省事 |
| 代码隔离 | 每个 worker 一个 git worktree（`herdr worktree`） | 改动互不冲突，对齐 Antigravity 做法 |
| 启动把关 | 拆完任务先弹确认框，用户点头才拉人 | 省配额，防误开 |
| 消息板存储 | **按帖落盘**：`posts/0001-<author>-<type>.md`，一帖一文件 | 跨进程追加写没有原子性保证，锁文件又要管残留和重试；一帖一文件让写冲突根本不存在 |
| 唤醒机制 | **协调员中枢路由**，轮询挂在已有事件上 | 文件写入不能唤醒独立进程；详见 §5.4 |
| 熔断 | verifier 打回默认上限 2 轮（`maxVerifyRounds`） | 防打回死循环烧光配额 |
| 并发上限 | 单次 run 默认最多 4 个 worker（可配置） | 终端 pane 超过 4 个会挤到不可用，且配额消耗失控 |
| 看板 UI | 第一期用 `ctx.ui` 状态小组件，全屏 overlay 后置 | 先跑通再打磨 |

## 3. 环境前提与启动前检查

- pi 里已安装并加载本扩展（目录即 `~/.pi/agent/extensions/swarm/`）。
- 当前 pi 会话运行在 Herdr 内（`HERDR_ENV=1`），`herdr` 0.9.5 在 PATH 中。
- herdr 已验证的能力：`pane split` / `agent start --kind pi` / `agent prompt --wait` / `agent wait --until idle` / `agent list` / `agent read` / `worktree` 命令组。

不满足环境时，`/swarm` 命令直接提示原因并退出，不做降级尝试。

**启动前检查（在确认框之前执行，结果一并呈给用户）：**

1. `git status --porcelain` 非空 → 确认框中显式警告：worktree 基于 HEAD 创建，未提交的改动 worker 看不到，建议先提交或 stash。
2. 当前分支 HEAD 存在性检查；无 git 仓库 → 直接拒绝。
3. `.pi/swarm/` 下存在未收尾的 run → 询问用户是接管还是先 `abort` 旧 run。

## 4. 总体架构

```
┌─ pi 主会话（协调员 = Hub）────────────────┐
│  /swarm <task>                            │
│  ├─ 规划：模型输出结构化分工清单           │
│  ├─ 检查：脏仓 / 环境预检（§3）            │
│  ├─ 确认：ctx.ui 确认框，用户把关          │
│  ├─ 执行：herdr worktree + pane split     │
│  │        + agent start --kind pi ×N      │
│  ├─ 路由：读板 → 发现 @ → 唤醒对应成员     │
│  ├─ 收线：agent wait / agent list 轮询     │
│  └─ 监控：agent_end 事件里查全员状态       │
└──────────────┬───────────────────────────┘
               │ 消息板：.pi/swarm/<run-id>/posts/（一帖一文件）
       ┌───────┼────────┬─────────────┐
   @worker-1  @worker-2  @verifier   @monitor(简化版，无独立进程)
   pi 进程     pi 进程    pi 进程(受限写)
   worktree-1  worktree-2 只读主仓+各worktree
   branch-1    branch-2   (跑测试用)
```

三层分工：

1. **协调员侧扩展**（本目录 `index.ts`）：注册 `/swarm` 命令与一组模型可调用工具，负责规划、拉人、**唤醒路由**、收线、监控。协调员就是用户当前的 pi 会话，不另起进程，是整个 swarm 唯一的调度中枢。
2. **worker 侧扩展**（`worker.ts`）：轻量扩展，通过 `pi --extension <绝对路径>` 由 herdr 启动时挂载，只注册 `board_post` / `board_read` / `report_done` 三个工具。worker 不需要知道上级是谁，它的一切来自任务简报；它**只响应被唤醒时的提示，不主动监听任何东西**。
3. **消息板**：`.pi/swarm/<run-id>/posts/` 目录，一帖一个编号文件。帖内用 `@名字` 提及，按编号顺序保留全部对话——对应 Antigravity「不私聊、全留痕」的原则。

## 5. 一次 /swarm 的完整流程

### 5.1 规划与确认

1. 用户输入 `/swarm <task>`。扩展先执行 §3 的启动前检查。
2. 扩展让当前模型调用 `swarm_plan` 工具，产出结构化分工清单，每个成员包含：
   - `name`：消息板 @ 名（如 `@fix-1`）；转写成 herdr agent 名时去 `@` 并小写（herdr 要求 `[a-z][a-z0-9_-]{0,31}`）；
   - `scope`：负责范围（文件/目录/模块）；`forbidden`：不许碰什么；`definitionOfDone`：完成标准；
   - `role`：`worker` | `verifier`；
   - `model`（可选）：透传给 pi 的模型覆盖，验证员与需要深推理的角色用强模型，机械活可用便宜快模型；
   - 并行 worker 数超过上限 4 时，规划阶段就要求模型分批，第一批完成后再拉第二批。
3. 分工清单渲染到确认框（连同预检警告与「本 run 预计 N 个 pi 会话」的配额提示），用户可改，点头后生成 run-id，建 `.pi/swarm/<run-id>/` 目录。

### 5.2 拉人

对每个成员依次执行：

- `herdr worktree create` 开独立工作区，分支命名 `<run-id>-<成员名>`；**roster.json 记录每个成员的 `worktreePath` 和 `branch`，该信息随任务简报发给 verifier**；
- `herdr pane split --current --direction <按几何规则> --cwd <worktree路径> --no-focus` 开旁栏；
- `herdr agent start <agent名> --kind pi --pane <pane-id> -- --extension /abs/path/worker.ts --name <@名> --board <posts目录> --role <role> ...`；
- worker 身份名即消息板上的 @ 名（经转写），roster.json 保留双向映射。

**Spawn 失败回滚策略：任何一个成员拉起失败（pane split 报错、agent 超时等），立即全量回滚——关闭本次 run 已创建的所有 pane 与 worktree，删除 run 目录，向用户报告失败点。不做带残缺队伍的继续运行**，因为那需要现场重新规划，行为不可预期。用户调整分工后重试即可。

### 5.3 交付物约定（worker → verifier 的可见性）

这是跨进程协作的关键约定：**worker 在调用 `report_done` 之前，必须把全部改动 commit 到自己 worktree 的分支上**。`report_done` 的必填参数包含 `commit`（commit hash）与 `summary`；未提交时 worker 扩展直接拒绝 `report_done` 并提示先 commit。

verifier 不只待在主仓：它的简报里带有全队 `worktreePath + branch` 清单，逐个 `git diff <branch>` 看改动、进对应 worktree 跑测试。verifier 的简报固定包含一条指令：跑测试产生的临时文件/缓存可以留在 worktree 里，但**不得修改业务代码**。

### 5.4 唤醒路由（Hub-and-Spoke）

写消息板不会唤醒任何独立进程，所以**所有跨成员的唤醒都由协调员完成**，worker 永远处于「被动等待被 prompt」的状态：

1. 协调员在两类时机检查板上新帖：`agent wait` 返回之后；`agent_end` 事件触发之后。不使用 `fs.watch` 常驻监听——pi 扩展生命周期禁止在工厂里起 watcher/定时器，且轮询挂在已有事件上不新增任何常驻资源。
2. 解析新帖（格式见 §6.1）中的 `@提及`，对照 roster：目标成员处于 `idle` 且该帖未处理过 → 协调员调用 `herdr agent prompt <agent名> "你在消息板上有新提及（帖 #N），请调用 board_read 查看并处理"`。
3. 目标成员不在（已收线）或该帖是发给协调员自己的 → 由协调员模型自行消化。
4. 帖子处理状态记录在 roster.json（每帖的 `acked` 标记），防止重复唤醒。

这个模式下 worker 依然不需要知道上级是谁——它只看到「被 prompt 了一次」，完全符合「不私聊、全留痕」。

### 5.5 协作、验证与熔断

- worker 干完 commit 后发 `type: done` 帖；verifier 读 diff、跑测试、把问题以 `@worker名:` 格式发 `type: issue` 帖；被 @ 的 worker 被协调员唤醒、修复、再次 commit 并发 `type: done`。
- **熔断**：同一对（verifier, worker）的打回-修复轮次记录在 roster.json，超过 `maxVerifyRounds`（默认 2）后，协调员不再转发唤醒，把全部争议帖汇总呈给用户拍板。
- 全员收线后协调员读板汇总，把各分支的 diff 摘要与测试结果呈给用户。

### 5.6 监控与止损

- 卡死监控：不设独立 monitor 进程。扩展在 `agent_end` 等事件中调 `herdr agent list`——若全员 idle/done 但板上无新完成帖且任务未收线，向协调员注入一条提醒，由模型决定催人还是收线。
- **`/swarm abort`**：一键结束当前 run——向所有存活 worker 发 ctrl+c / 结束 prompt，关闭本次 run 创建的 pane 与 worktree，**保留 `.pi/swarm/<run-id>/` 现场与板子**供排查，roster 标记 `aborted`。规划出错、worker 跑偏时用它止损。
- `/swarm cleanup`（第 4 阶段）：对已收线 run 的 worktree 与 pane 做显式清理，合并动作仍不在本期范围内。

## 6. 消息板与工具

### 6.1 帖子格式（机器可读约定）

一帖一文件：`posts/NNNN-<agent名>-<type>.md`，`NNNN` 为四位自增序号（扩展发帖时扫描目录取 max+1，序号即全局顺序，无需时间戳排序）。

文件内容固定为 frontmatter + 正文：

```markdown
---
seq: 0007
from: fix-1
to: verifier        # 或 @all / 协调员专用值 hub
type: issue         # done | issue | note | question
round: 2            # verifier 打回轮次，其他帖可为 0
refs: fix-1         # 关联的提交或帖子序号，逗号分隔
---
正文自由文本。@fix-2 你那边的人口参数也改一下。
```

`from`/`to`/`type` 全部结构化，`board_read` 按 @ 过滤、卡死监控判断「是否有新 done 帖」、熔断计数，都只依赖 frontmatter 的正则级解析，不碰自由正文。

### 6.2 工具职责划分

**协调员侧**（`index.ts`，namespace `swarm`）：

| 工具 | 作用 | 底层 |
|---|---|---|
| `swarm_plan` | 提交结构化分工清单（模型填参数，含 role/model/scope） | 纯数据校验 |
| `swarm_spawn` | 按分工拉起一个 worker（含失败全量回滚） | worktree + pane split + agent start |
| `swarm_post` | 以 hub 身份发帖（同 §6.1 格式） | 文件写入 |
| `swarm_read` | 读板（frontmatter 过滤 + 正文） | 目录扫描 |
| `swarm_status` | 全员状态 + 打回轮次 + 未 ack 帖数 | `herdr agent list` + roster |
| `swarm_wait` | 等指定成员到 idle | `herdr agent wait --until idle` |
| `swarm_read_output` | 读某 worker 的最近终端输出 | `herdr agent read --source recent-unwrapped` |

**worker 侧**（`worker.ts`，不设 namespace，就三个）：

| 工具 | 语义 |
|---|---|
| `board_post` | 发帖（from 自动取自身 @ 名，禁止伪造他人身份） |
| `board_read` | 读板（verifier 角色同样可用） |
| `report_done` | **语义上就是「发一条 `type: done` 的帖 + 把 roster 里自己状态置 done」的组合动作**，参数强制要求 commit hash。模型不需要纠结该调哪个——完成时只调它 |

### 6.3 权限边界（"只读"的准确含义）

verifier 的"只读"指：**禁用代码修改类工具（edit/write 类）+ 简报里明令不改业务代码**；shell 不禁——跑测试、编译、`git diff` 都要经过它，测试产生的临时文件与缓存也在允许范围内。一刀切禁 shell 会让 verifier 摆设化。

## 7. 文件布局

```
~/.pi/agent/extensions/swarm/
├── Design.md        本文件
├── index.ts         主扩展入口（协调员侧）
├── worker.ts        worker 侧扩展（被 herdr 启动的 pi 以 --extension 挂载）
├── board.ts         消息板读写（一帖一文件、序号分配、frontmatter 解析；两侧共用）
└── herdr.ts         herdr CLI 的薄封装（JSON 解析、错误归一）
```

运行期产物：

```
.pi/swarm/<run-id>/
├── posts/           消息板：NNNN-<agent>-<type>.md，一帖一文件
├── plan.json        已确认的分工清单（含 model / maxVerifyRounds）
└── roster.json      成员映射：@名 ↔ agent名 ↔ pane id ↔ worktreePath ↔ branch
                     + 每成员状态 + 打回轮次计数 + 帖 ack 标记 + run 状态（active/done/aborted）
```

## 8. 关键实现约束（来自 pi 与 herdr 文档，编码时必须遵守）

- 扩展工厂内**不得**启动任何 herdr 进程、socket、watcher、定时器；herdr 调用与板检查只发生在命令 handler、工具 execute、以及 `agent_end` 等事件回调里。
- herdr 的 ID（pane id、agent 名）一律从 JSON 响应里读，禁止按布局顺序或示例猜。
- `agent start` 的 pane 必须是「处于交互提示符的可用 shell pane」，故 spawn 前要先 split 出干净的 pane；split 用 `--no-focus`，不抢用户焦点。**worker 数超过 4 时不硬挤 pane——按规划分批，或经用户同意后开新 tab**。
- `agent prompt` 返回成功只代表投递成功，不代表 agent 已开跑；等待语义用 `--wait`。超时或 stalled 后**不得**盲目重发同一条 prompt，唤醒路由的重复唤醒防护靠 roster 的 ack 标记兜底。
- 工具结果里大输出要截断并告诉模型去哪读全文（`swarm_read_output` 尤其如此）。
- **跨进程写板不做任何内存级队列假设**：`withFileMutationQueue()` 只防单进程内重入；跨进程安全由「一帖一文件」的结构保证（每帖写一个新文件，天然无冲突），序号分配用目录扫描取 max+1，极小概率撞号时以先落盘者为准、后落盘者递增重试。
- `session_shutdown` 里做幂等清理：不强杀 worker 进程（用户可能还想看），只解绑本会话的轮询与 UI 状态。

## 9. Worker 任务简报模板（附录）

每次 spawn 时由协调员按此模板实例化，随 `agent start` 参数或首条 prompt 注入。模板固化以下要素，压缩模型自由发挥空间：

```
你是 swarm 成员 {@name}，角色 {role}。

本次任务：{task 全文}
你的范围：{scope}
禁区（不得改动）：{forbidden}
完成标准：{definitionOfDone}

环境事实：
- 你的工作目录是一个独立 git worktree：{worktreePath}，分支 {branch}。
- 消息板目录：{postsDir}。一帖一文件，frontmatter 格式见扩展内约定。
- 你只在自己被唤起时行动；没有被点名时不要抢活。

完工流程（缺一不可）：
1. 把全部改动 git commit 到当前分支；
2. 调用 report_done，提交 commit hash 与一段变更摘要。
若收到 issue 帖：修复、再次 commit、重发 report_done，并在帖子里 @ 回提问题的人。
禁止：跨出 scope 改代码、伪造他人身份发帖、在没有 commit 的情况下 report_done。
```

## 10. 分阶段实施计划（每步独立可验证）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| 1. 最小闭环 | `/swarm` 拉起 1 个 worker、发任务、等 idle、commit 约定 + report_done 取回产出 | 手动跑一个「在某文件里加注释并 commit」任务，产出与 commit hash 正确回到主会话 |
| 2. 消息板 + worker 扩展 | 一帖一文件的 board.ts；worker 侧三工具；hub 轮询唤醒 | 两个 pi 通过板互相 @ 并完成一轮 issue→fix→done 往返，无重复唤醒、无覆盖 |
| 3. 完整功能 | 规划工具 + 确认框 + 预检 + worktree + 多 worker 并行 + 熔断 + abort | 3 个 worker 并行改 3 个模块，verifier 打回 1 次后修复收敛；中途 abort 现场完整 |
| 4. 打磨 | 模型路由、状态小组件、`/swarm cleanup`、全屏看板 overlay（Alt+S 只读）、`swarm_close` 收线工具 | **已交付（2026-11-23）**：per-member 模型透传（须全限定名）、widget 随 agent_end 刷新、cleanup 幂等回收、只读看板快照；详见 e2e-phase4.md |

编码采用 proof-first：每个阶段先把验收标准写成测试，再动实现。

## 11. 已知风险与取舍

- **配额消耗大**：每个 worker 都是独立 pi 会话。确认框显式列出「本 run 预计 N 个会话」；模型路由（§5.1 第 2 步）给机械活指便宜模型。
- **herdr 检测误判**：`idle`/`done` 不保证 agent 真的不再动（比如后台子任务还在跑）。收线逻辑结合板上 done 帖双重确认，不能只信状态。
- **worktree 生命周期**：worker 收线后 worktree 保留到用户确认合并或 `/swarm cleanup`；`abort` 保留现场不删 run 目录，但按用户选择回收 pane/worktree。
- **合并冲突**：worktree 隔离了过程冲突，但最终合并到主分支仍可能冲突。第一期不自动合并——协调员只汇总各分支 diff，把「合并」作为独立一步交给用户。
- **唤醒路由的单点性**：Hub-and-Spoke 让协调员成为唯一调度点，协调员会话崩溃则 swarm 失联。缓解：roster.json 与板子全部落盘，新会话可通过 `/swarm resume`（第 4 阶段，非承诺）接管旧 run。
- **CLI 版本漂移**：herdr 命令语法以本机安装的 0.9.5 为准，`herdr.ts` 封装层集中处理，版本变化只改一处。
