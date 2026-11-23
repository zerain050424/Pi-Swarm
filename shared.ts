/**
 * shared.ts — Swarm 两侧共享：类型、简报模板、roster 读写。
 *
 * 被 index.ts（协调员）与 worker.ts（worker）同时 import，因此：
 * - 不允许在这里 import herdr.ts（herdr 实例属于协调员侧）；
 * - 不允许在模块加载期发起任何进程调用。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ───────────────────────────── 环境变量名 ─────────────────────────────

export const ENV_NAME = "PI_SWARM_NAME";
export const ENV_RUN = "PI_SWARM_RUN";
export const ENV_BOARD = "PI_SWARM_BOARD";
export const ENV_ROLE = "PI_SWARM_ROLE";
export const ENV_ROSTER = "PI_SWARM_ROSTER";

// ───────────────────────────── 类型 ─────────────────────────────

export type RunStatus = "active" | "done" | "aborted";

export interface MemberEntry {
	name: string; // @ 名，如 fix-1
	agentName: string; // herdr agent 名（去 @ 小写）
	role: "worker" | "verifier";
	paneId?: string;
	agentStatus?: string;
	/** verifier 打回轮次计数 */
	round?: number;
	/** hub 已处理到的帖子 seq（防重复唤醒） */
	acked?: number;
	/** worker 的分工字段（阶段 3 由 plan 填充） */
	scope?: string;
	forbidden?: string;
	definitionOfDone?: string;
	branch?: string;
	worktreePath?: string;
	/** worker 专属 worktree 的 herdr workspace（回滚/清理用） */
	workspaceId?: string;
	/** 模型覆盖（plan 里指定；空 = 继承协调员当前模型） */
	model?: string;
}

export interface RunState {
	runId: string;
	dir: string;
	postsDir: string;
	task: string;
	status: RunStatus;
	/** verifier 打回上限，默认 2 */
	maxVerifyRounds?: number;
	/** 专属 Swarm Tab ID（方案 3：独立 Tab 隔离运行） */
	tabId?: string;
	members: Map<string, MemberEntry>; // key = agentName
}

// ───────────────────────────── run 生命周期 ─────────────────────────────

export function newRunId(): string {
	const d = new Date();
	const ts = d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
	return `run-${ts}-${randomBytes(2).toString("hex")}`;
}

export function initRun(cwd: string, task: string): RunState {
	const runId = newRunId();
	const dir = join(cwd, ".pi", "swarm", runId);
	const postsDir = join(dir, "posts");
	mkdirSync(postsDir, { recursive: true });
	const run: RunState = { runId, dir, postsDir, task, status: "active", members: new Map() };
	persistRoster(run);
	return run;
}

export function persistRoster(run: RunState): void {
	const data = {
		runId: run.runId,
		task: run.task,
		status: run.status,
		maxVerifyRounds: run.maxVerifyRounds,
		tabId: run.tabId,
		members: [...run.members.values()],
	};
	writeFileSync(join(run.dir, "roster.json"), JSON.stringify(data, null, 2) + "\n");
}

/** 从磁盘找最新的 run；只接管 active 的，done/aborted 留在磁盘供排查。 */
export function loadRoster(cwd: string): RunState | undefined {
	const base = join(cwd, ".pi", "swarm");
	if (!existsSync(base)) return undefined;
	let best: { dir: string; mtime: number; data: any } | undefined;
	for (const entry of readdirSafe(base)) {
		const rf = join(base, entry, "roster.json");
		if (!existsSync(rf)) continue;
		try {
			const st = statSync(rf).mtimeMs;
			if (!best || st > best.mtime) {
				best = { dir: join(base, entry), mtime: st, data: JSON.parse(readFileSync(rf, "utf8")) };
			}
		} catch {
			/* 忽略坏文件 */
		}
	}
	if (!best) return undefined;
	// 只接管 active 的 run；done/aborted 的留在磁盘供排查，不隐式复活
	if (best.data.status && best.data.status !== "active") return undefined;
	const members = new Map<string, MemberEntry>();
	for (const m of best.data.members ?? []) members.set(m.agentName, m);
	return {
		runId: best.data.runId,
		dir: best.dir,
		postsDir: join(best.dir, "posts"),
		task: best.data.task ?? "",
		status: "active",
		maxVerifyRounds: best.data.maxVerifyRounds,
		tabId: best.data.tabId,
		members,
	};
}

function readdirSafe(base: string): string[] {
	try {
		return readdirSync(base);
	} catch {
		return [];
	}
}

// ───────────────────────────── 简报 ─────────────────────────────

/** Design.md §9 模板。worktree/branch/postsDir 可选：阶段 1 无消息板时留空。 */
export function renderBriefing(m: {
	name: string;
	role: "worker" | "verifier";
	scope?: string;
	forbidden?: string;
	definitionOfDone?: string;
	worktreePath?: string;
	branch?: string;
	postsDir?: string;
}): string {
	const envLines = [
		m.worktreePath
			? `- 你的工作目录是独立 git worktree：${m.worktreePath}，分支 ${m.branch}。`
			: "- 你直接在当前仓库工作。",
		m.postsDir ? `- 消息板目录：${m.postsDir}。一帖一文件，frontmatter 格式由扩展约定。` : "",
		"- 你只在自己被唤起时行动；没有被点名时不要抢活。",
	]
		.filter(Boolean)
		.join("\n");
	const dutyLines = [
		m.scope ? `你的范围：${m.scope}` : "",
		m.forbidden ? `禁区（不得改动）：${m.forbidden}` : "",
		m.definitionOfDone ? `完成标准：${m.definitionOfDone}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const finishFlow = m.postsDir
		? [
			"完工流程（缺一不可）：",
			"1. 把全部改动 git commit 到当前分支；",
			"2. 调用 report_done 提交 commit hash 与变更摘要。",
			"若收到 issue 帖：修复、再次 commit、重发 report_done，并在帖子里 @ 回提问题的人。",
		].join("\n")
		: [
			"完工流程（缺一不可）：",
			"1. 把全部改动 git commit 到当前分支；",
			"2. 在最终回复里给出 commit hash 与一段变更摘要。",
		].join("\n");
	return [
		`你是 swarm 成员 {@${m.name}}，角色 {${m.role}}。`,
		"",
		dutyLines,
		"",
		"环境事实：",
		envLines,
		"",
		finishFlow,
		"",
		"禁止：越出你的范围改代码、伪造他人身份发帖、未经 commit 就宣称完成。",
		(m.role === "verifier")
			? "作为验证员：读代码差异、跑测试、把问题以帖子的形式 @ 回写代码的成员；跑测试产生的临时文件与缓存可以留在工作区，但不得修改业务代码。"
			: "",
	].filter(Boolean).join("\n");
}
