# E2E 剧本 — 阶段 4（已执行通过）

> 执行环境：herdr 0.9.5。前置：协调员 pi 会话跑在 herdr pane 内，目标为 git 仓库。

## 验证项与结果（2026-11-23 实测）

- [x] **确认框带模型**：swarm_plan 的确认框每个成员显示「模型: <provider/model>」。
- [x] **per-member model 透传**：worker 以指定模型启动并正常干活（裸模型名会因多 provider 歧义直接让 pi 退出——plan 工具描述已提示写全限定名；单测覆盖 args 拼装优先级 member.model ?? opts.model ?? 不传）。
- [x] **状态小组件**：agent_end 轮询后渲染 `swarm <runId> | @成员(角色)状态r轮次 | 帖 #N`；swarm_close/abort/leanup 后清除。
- [x] **Alt+S 只读看板**：全屏快照（标题/任务/打回上限/成员名册含 worktree 与模型/消息板回放），q 或 esc 关闭即弃，无实时刷新。
- [x] **swarm_close 收线**：协调员全员 done 并汇总后调用，run 状态落盘 done，widget 清除。
- [x] **/swarm cleanup**：回收 done/aborted run 的 pane、worktree（`git worktree remove --force`）与分支（`git branch -D`）；档案 `.pi/swarm/<id>/` 保留；幂等（重复执行不报错）。

## 复跑命令序列

```bash
rm -rf /tmp/swarm-p4 && mkdir -p /tmp/swarm-p4 && cd /tmp/swarm-p4
git init -q && echo "# p4 repo" > README.md && git add -A && git commit -qm init
# herdr 里 split 出协调员 pane 并 agent start --kind pi
herdr agent prompt coord-p4 "回复 OK 即可" --wait --timeout 60000   # 确认输入管道就绪
herdr agent prompt coord-p4 "/swarm 在 NOTES-A.md 写两行配置说明，同时在 NOTES-B.md 写两行部署步骤，互不相干，完成后各自 commit。两个 worker 的 model 都指定 opencode-go/glm-5.3-flash"
# 确认框出现后：herdr agent send-keys coord-p4 return
# 途中：herdr agent send-keys coord-p4 alt+s 开看板；q 关闭
# 收线后：herdr agent prompt coord-p4 "/swarm cleanup"
cd /tmp/swarm-p4 && git worktree list && git branch   # 期望只剩主仓 master
```

## 实测发现的坑（新增回归认知）

1. **`--model` 必须写全限定名**：多 provider 环境下裸模型名（如 `glm-5.3-flash`）会让 pi 直接退出（"ambiguous across providers"），worker 静默死亡、协调员只能看到 agent not found。已在 swarm_plan 的参数描述里提示；若 coordinator 仍填裸名，worker 退出后 hub 会在收线时发现全员消失。
2. worker 启动后瞬间，协调员立即 `swarm_wait` 可能撞 `agent not found`（herdr 名字注册的瞬态窗口）——重试自然恢复，不盲目重发任务。
