/**
 * worker.ts — Swarm worker 侧扩展（pi）。
 *
 * 由协调员经 herdr 拉起：`pi --no-extensions --no-session -e <abs worker.ts>`，
 * 身份与 run 信息全部来自环境变量（pane split --env 注入），简报+任务从 roster.json
 * 自读，session_start 里 sendMessage 自唤醒开工——不依赖任何往 pty 敲键的投递。
 *
 * 工具：board_post / board_read / report_done（Design.md §6.2）。
 * 非 swarm 环境（无 PI_SWARM_NAME）时全部静默，不注册任何东西。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	parseFrontmatter,
	filterPosts,
	readAllPosts,
	writePost,
} from "./board.ts";
import {
	ENV_BOARD,
	ENV_NAME,
	ENV_ROLE,
	ENV_ROSTER,
	ENV_RUN,
	loadRoster,
	renderBriefing,
} from "./shared.ts";

// ───────────────────────────── 交付物校验 ─────────────────────────────

/**
 * report_done 的硬约定（Design.md §5.3）：
 * - 工作区必须干净（全部改动已 commit）；
 * - provided commit 必须与当前 HEAD 一致（允许缩写前缀）。
 * 返回错误文案；null = 通过。
 */
export function checkDeliverable(o: { head: string; dirty: number; provided: string }): string | null {
	if (o.dirty > 0) return `工作区还有 ${o.dirty} 个未提交改动，先 git commit 再 report_done。`;
	if (!o.provided) return "report_done 需要 commit hash（git rev-parse HEAD 的输出）。";
	if (!o.head.toLowerCase().startsWith(o.provided.toLowerCase())) {
		return `commit hash 与 HEAD（${o.head.slice(0, 12)}）不一致，用 git rev-parse HEAD 的实际值。`;
	}
	return null;
}

function gitState(cwd: string): { head: string; dirty: number } {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
	const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
	const dirty = (status.stdout ?? "").split("\n").filter((l) => l.trim()).length;
	return { head: (head.stdout ?? "").trim(), dirty };
}

// ───────────────────────────── 扩展入口 ─────────────────────────────

function toolResult(content: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: content }], details };
}

export default function (pi: ExtensionAPI) {
	// 身份只读一次：session_start 时 env 已由 herdr pane 注入
	const myName = process.env[ENV_NAME];
	const myRole = (process.env[ENV_ROLE] as "worker" | "verifier") ?? "worker";
	const postsDir = process.env[ENV_BOARD];
	const rosterPath = process.env[ENV_ROSTER];
	const isWorker = Boolean(myName && postsDir && rosterPath);

	pi.on("session_start", () => {
		if (!isWorker) return;
		try {
			const run = loadRosterDir(rosterPath!);
			if (!run) throw new Error("roster.json 无法读取");
			const me = run.members.get(myName!) ?? {
				name: myName!,
				agentName: myName!,
				role: myRole,
			};
			let briefing =
				renderBriefing({ ...me, postsDir }) + "\n\n本次任务：\n" + (run.task || "(未提供)") + "\n按上述完工流程执行。";
			if (me.role === "verifier") {
				// 验证员要看得见每个 worker 的 worktree（改动在各分支上，跑测试进对应目录）
				const team = [...run.members.values()].filter((x) => x.role === "worker" && x.worktreePath);
				if (team.length > 0) {
					briefing += "\n\n队伍工作区（diff 与测试都在这些 worktree/分支上）：\n"
						+ team.map((x) => `- @${x.name}：${x.worktreePath}（分支 ${x.branch}）`).join("\n");
				}
			}
			// 自唤醒：pi 内部触发首轮，不经 pty 键入，无投递竞态
			pi.sendMessage(
				{ customType: "swarm_briefing", content: briefing, display: true },
				{ triggerTurn: true },
			);
		} catch (err) {
			// 激活失败必须可见：worker 挂在 pane 里但不知道要干嘛时，协调员会白等
			pi.sendMessage(
				{
					customType: "swarm_briefing",
					content: `Swarm worker 激活失败：${err instanceof Error ? err.message : String(err)}\n`
						+ `请向协调员（hub）报告此错误，不要开工。`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	});

	if (!isWorker) return; // 普通 pi 会话挂到本扩展时是 no-op

	// ── board_post ──
	pi.registerTool({
		name: "board_post",
		label: "Board Post",
		description:
			"往 swarm 消息板发一帖。from 固定为你的名字，不可伪造他人。type: note=普通说明, question=提问, issue=打回问题(仅验证员), done=完工(应改用 report_done)。",
		parameters: Type.Object({
			to: Type.String({ description: "收帖人 @名 或 all" }),
			type: Type.Union(
				[Type.Literal("note"), Type.Literal("question"), Type.Literal("issue")],
				{ description: "帖子类型；done 类型请走 report_done" },
			),
			body: Type.String({ description: "正文" }),
			round: Type.Optional(Type.Number({ description: "打回轮次（仅 issue 帖需要）" })),
			refs: Type.Optional(Type.Array(Type.String(), { description: "关联帖子序号或 commit" })),
		}),
		execute: async (_id, params) => {
			const seq = await writePost(postsDir!, {
				seq: 0,
				from: myName!,
				to: params.to,
				type: params.type,
				round: params.round ?? 0,
				refs: params.refs ?? [],
			}, params.body);
			return toolResult(`已发帖 #${seq}（${myName} → ${params.to}, ${params.type}）。`, { seq });
		},
	});

	// ── board_read ──
	pi.registerTool({
		name: "board_read",
		label: "Board Read",
		description: "读 swarm 消息板。默认返回发给你的帖子（含 all 广播）；可选按 from/type 过滤。",
		parameters: Type.Object({
			from: Type.Optional(Type.String({ description: "只看某人发的帖" })),
			type: Type.Optional(
				Type.Union([
					Type.Literal("done"), Type.Literal("issue"), Type.Literal("note"), Type.Literal("question"),
				]),
			),
			all: Type.Optional(Type.Boolean({ description: "true 时无视过滤返回全部帖子" })),
		}),
		execute: async (_id, params) => {
			const posts = readAllPosts(postsDir!);
			const visible = params.all
				? posts
				: filterPosts(posts, { to: myName!, from: params.from, type: params.type });
			if (visible.length === 0) return toolResult("消息板上没有发给你的新帖。", { count: 0 });
			const text = visible
				.map((p) => `#${p.meta.seq} [${p.meta.type}] ${p.meta.from} → ${p.meta.to}`
					+ (p.meta.round ? ` (round ${p.meta.round})` : "")
					+ `\n${p.body}`)
				.join("\n\n");
			return toolResult(text, { count: visible.length });
		},
	});

	// ── report_done ──
	pi.registerTool({
		name: "report_done",
		label: "Report Done",
		description:
			"宣告完工：自动校验工作区干净 + commit hash 与 HEAD 一致，然后发 type:done 的帖子。必须先 commit。",
		parameters: Type.Object({
			commit: Type.String({ description: "git rev-parse HEAD 的输出（缩写可）" }),
			summary: Type.String({ description: "变更摘要（一两句话）" }),
			refs: Type.Optional(Type.Array(Type.String(), { description: "关联帖子序号" })),
		}),
		execute: async (_id, params, signal, onUpdate, ctx) => {
			const st = gitState(ctx.cwd);
			const problem = checkDeliverable({ head: st.head, dirty: st.dirty, provided: params.commit });
			if (problem) throw new Error(problem);
			const seq = await writePost(postsDir!, {
				seq: 0,
				from: myName!,
				to: "hub",
				type: "done",
				round: 0,
				refs: params.refs ?? [],
			}, params.summary);
			return toolResult(
				`完工帖 #${seq} 已发（commit ${params.commit.slice(0, 12)}）。等待协调员或验证员后续指示。`,
				{ seq, commit: params.commit },
			);
		},
	});
}

/** 从 roster 文件路径直接恢复 run（与 shared.loadRoster 的差异：不扫描目录、不看 status） */
function loadRosterDir(rosterPath: string) {
	if (!existsSync(rosterPath)) return undefined;
	const dir = join(rosterPath, "..");
	const data = JSON.parse(readFileSync(rosterPath, "utf8"));
	const members = new Map<string, any>();
	for (const m of data.members ?? []) members.set(m.agentName ?? m.name, m);
	return {
		runId: data.runId,
		dir,
		postsDir: data.postsDir ?? join(dir, "posts"),
		task: data.task ?? "",
		status: data.status ?? "active",
		members,
	};
}
