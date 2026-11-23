/**
 * index.ts — Swarm 协调员侧扩展（pi）。
 *
 * 阶段 1（最小闭环）：/swarm <task> 拉起 1 个 worker（pi 实例，herdr pane 内），
 * 协调员模型用 swarm_wait / swarm_read_output 收线汇总。
 *
 * 生命周期红线（Design.md §8）：
 * - 工厂内不启动任何 herdr 进程；所有调用发生在命令 handler / 工具 execute 里。
 * - herdr 的 ID 一律从 JSON 响应读。
 * - split 用 --no-focus，不抢用户焦点。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHerdr, HerdrError, type Herdr, type PaneInfo } from "./herdr.ts";
import {
	ENV_BOARD,
	ENV_NAME,
	ENV_ROLE,
	ENV_ROSTER,
	ENV_RUN,
	initRun,
	loadRoster,
	newRunId,
	persistRoster,
	renderBriefing,
	type MemberEntry,
	type RunState,
	type RunStatus,
} from "./shared.ts";
import { readAllPosts, writePost, type Post } from "./board.ts";
import {
	formatModelConfigSummary,
	globalModelConfigPath,
	loadEffectiveModelConfig,
	loadModelConfigFile,
	parseModelTarget,
	parseSwarmTaskArgs,
	projectModelConfigPath,
	resetConfigTarget,
	resolveMemberModel,
	saveModelConfigFile,
	setConfigTarget,
	validateQualifiedModel,
	type ModelOverrides,
	type ModelTarget,
	type SwarmModelConfig,
} from "./models.ts";

// ───────────────────────────── 会话级 run 状态 ─────────────────────────────

/** worker.ts 绝对路径：herdr agent start 透传给 pi -e 用（jiti 下 import.meta.url 可用） */
const WORKER_EXT_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** 会话级唯一 run；多 run 并行是第 4 阶段之后的事 */
let currentRun: RunState | undefined;
/** `/swarm --worker-model=...` 等单次启动覆盖，在 swarm_plan 消费后清空 */
let pendingModelOverrides: ModelOverrides | undefined;

export function getRun(): RunState | undefined {
	return currentRun;
}

// ───────────────────────────── 常量 ─────────────────────────────

const MAX_OUTPUT_CHARS = 6_000;
const WAIT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT_START_TIMEOUT_MS = 30_000;
// ───────────────────────────── 环境检查 ─────────────────────────────

export interface EnvCheck {
	ok: boolean;
	problems: string[];
}

export function checkEnv(): EnvCheck {
	const problems: string[] = [];
	if (process.env.HERDR_ENV !== "1") {
		problems.push("当前 pi 不在 Herdr 内（HERDR_ENV≠1），/swarm 需要 herdr 管理 pane 才能拉 worker。");
	}
	try {
		const v = spawnSync("herdr", ["--version"], { encoding: "utf8", timeout: 5000 });
		if (v.status !== 0 || !/\d+\.\d+/.test(v.stdout.trim())) {
			problems.push("herdr CLI 不可用或版本无法读取。");
		}
	} catch {
		problems.push("herdr CLI 不在 PATH 中。");
	}
	return { ok: problems.length === 0, problems };
}

// ───────────────────────────── 启动前检查 ─────────────────────────────

export interface RepoPrecheck {
	isGit: boolean;
	/** 未提交改动数（git status --porcelain 非空行数） */
	dirty: number;
	/** 环境检查未通过的原因（空 = 通过） */
	problems: string[];
}

/** /swarm 预检：git 仓库与脏工作区。env 检查（HERDR_ENV/herdr CLI）由 checkEnv 负责。 */
export function precheckRepo(cwd: string): RepoPrecheck {
	try {
		const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", timeout: 5000 });
		if (inside.status !== 0 || inside.stdout.trim() !== "true") {
			return { isGit: false, dirty: 0, problems: [] };
		}
		const st = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 5000 });
		const dirty = (st.stdout ?? "").split("\n").filter((l) => l.trim()).length;
		return { isGit: true, dirty, problems: [] };
	} catch {
		return { isGit: false, dirty: 0, problems: ["git 命令不可用"] };
	}
}

// ───────────────────────────── spawn ─────────────────────────────

function sleepMs(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export interface SpawnResult {
	member: MemberEntry;
	pane: PaneInfo;
}

/**
 * 计算第 N 个成员（N = createdPaneIds.length >= 1）在 2×2 网格中的切分锚点与方向：
 * - 第 2 人：从第 1 人向右切（1×2）
 * - 第 3 人：从第 1 人向下切（左列 2 格）
 * - 第 4 人：从第 2 人向下切（右列 2 格 → 2×2 网格）
 * - 第 5 人起：从上一格向下切
 */
export function planGridSplits(createdPaneIds: string[]): { anchorPaneId: string; direction: "right" | "down" } {
	const idx = createdPaneIds.length;
	if (idx <= 1) return { anchorPaneId: createdPaneIds[0], direction: "right" };
	if (idx === 2) return { anchorPaneId: createdPaneIds[0], direction: "down" };
	if (idx === 3) return { anchorPaneId: createdPaneIds[1], direction: "down" };
	return { anchorPaneId: createdPaneIds[idx - 1], direction: "down" };
}

/** 拉起一个 worker：复用或 split pane → 注入身份 env → agent start。失败时回收 pane。 */
export async function spawnMember(
	h: Herdr,
	member: MemberEntry,
	run: RunState,
	cwd: string,
	opts: {
		workerExtensionPath?: string;
		model?: string;
		paneId?: string;
		anchorPaneId?: string;
		direction?: "right" | "down";
	} = {},
): Promise<SpawnResult> {
	const env: Record<string, string> = {
		[ENV_NAME]: member.name,
		[ENV_RUN]: run.runId,
		[ENV_ROLE]: member.role,
		[ENV_BOARD]: run.postsDir,
		[ENV_ROSTER]: join(run.dir, "roster.json"),
	};
	let pane: PaneInfo;
	const ownSplit = !opts.paneId;
	if (opts.paneId) {
		pane = { pane_id: opts.paneId };
		const quotedCwd = `'${cwd.replace(/'/g, "'\\''")}'`;
		await h.paneRun(opts.paneId, `cd ${quotedCwd} && ${buildExportEnv(env)}`);
	} else if (opts.anchorPaneId) {
		pane = await h.paneSplit({ paneId: opts.anchorPaneId, direction: opts.direction ?? "right", cwd, env, noFocus: true });
	} else {
		pane = await h.paneSplit({ current: true, direction: "right", cwd, env });
	}
	const paneId = pane.pane_id;
	member.paneId = paneId;
	try {
		// 启动参数只放短文本：长文本会被 herdr 拒绝（"agent arguments cannot be encoded safely"）。
		// 简报+任务由 worker.ts 在 session_start 里从 roster 自读，sendMessage 自唤醒，不经 pty 键入。
		if (!opts.workerExtensionPath) throw new Error("spawnMember 需要 workerExtensionPath（worker.ts 绝对路径）");
		const agentArgs = ["--no-extensions", "--no-session", "-e", opts.workerExtensionPath];
		const model = member.model ?? opts.model; // 成员自带 model 优先；都没有则继承协调员模型
		if (model) agentArgs.push("--model", model);
		agentArgs.push("-n", `swarm-${member.name}`);
		// split 返回后 shell 提示符可能未就绪，瞬态错误重试（竞态实测：agent_pane_busy）
		const TRANSIENT = new Set(["agent_pane_busy", "agent_not_ready"]);
		for (let attempt = 1; ; attempt++) {
			try {
				await h.agentStart(member.agentName, "pi", paneId, agentArgs, AGENT_START_TIMEOUT_MS);
				break;
			} catch (err) {
				const retryable = err instanceof HerdrError && TRANSIENT.has(err.code ?? "") && attempt < 10;
				if (!retryable) throw err;
				const sleeper = (globalThis as any).__swarmSleep ?? sleepMs;
				await sleeper(600);
			}
		}
		// pi 启动期可能有全屏提示（如 tools/ 迁移警告 "Press any key to continue"）：
		// 补一个无害按键确保过关；没有提示时空格进空编辑器是无害 no-op
		try {
			await h.agentSendKeys(member.agentName, "space");
		} catch {
			/* 发键失败不阻断，后续 wait/prompt 会暴露问题 */
		}
		// start 成功 ≠ 交互就绪：等首个 settled idle 再投递，否则按键会丢（实测竞态）
		try {
			await h.agentWait(member.agentName, { until: "idle", timeoutMs: 30_000 });
		} catch {
			/* 等待超时不阻断后续流程 */
		}
	} catch (err) {
		// spawn 失败 → 回收刚开的 pane（若是独立 split），保持现场干净
		if (ownSplit) {
			try {
				await h.paneClose(paneId);
			} catch {
				/* 回收失败不掩盖原始错误 */
			}
		}
		throw err;
	}
	run.members.set(member.agentName, member);
	persistRoster(run);
	return { member, pane };
}

/** 拼 "export K='v' ..." 单行命令；值用单引号包裹并转义内部单引号。 */
export function buildExportEnv(env: Record<string, string>): string {
	const parts = Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`);
	return `export ${parts.join(" ")}`;
}

export interface SpawnTeamOptions {
	workerExtensionPath: string;
	/** worker 是否用 git worktree 隔离（默认 true；verifier 永远留在主仓 cwd） */
	useWorktree?: boolean;
	/** 是否创建独立 Swarm Tab 并排布 2×2 网格（默认 true） */
	useDedicatedTab?: boolean;
	model?: string;
	/** git 执行器注入点（测试用）；默认 spawn real git */
	gitRun?: GitRunner;
}

export type GitRunner = (
	cwd: string,
	args: string[],
) => Promise<string>;

export const defaultGitRun: GitRunner = async (cwd, args) => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	try {
		const { stdout } = await promisify(execFile)("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
		return stdout;
	} catch (err: any) {
		throw new Error(`git ${args[0]} 失败：${err?.stderr ?? err?.message ?? err}`);
	}
};

/**
 * 按 plan 依次拉起全部成员。
 * 失败策略（Design.md §5.2）：任一成员失败 → 全量回滚（逆序关 pane + git worktree remove），

 * run 置 aborted 落盘，然后抛出。保留 run 目录供排查。
 */
export async function spawnTeam(
	h: Herdr,
	run: RunState,
	members: MemberEntry[],
	cwd: string,
	opts: SpawnTeamOptions,
): Promise<void> {
	const gitRun = opts.gitRun ?? defaultGitRun;
	const created: Array<{ paneId?: string; worktreePath?: string }> = [];
	const createdPaneIds: string[] = [];
	const useTab = opts.useDedicatedTab !== false && typeof (h as any).tabCreate === "function";
	let dedicatedTabId: string | undefined;
	let rootPaneId: string | undefined;

	try {
		if (useTab) {
			const tabRes = await h.tabCreate({ cwd, label: `swarm-${run.runId}`, noFocus: true });
			dedicatedTabId = tabRes.tabId;
			rootPaneId = tabRes.rootPaneId;
			if (dedicatedTabId) {
				run.tabId = dedicatedTabId;
				if (!rootPaneId && typeof (h as any).tabGet === "function") {
					const info = await h.tabGet(dedicatedTabId);
					const t = info?.result?.tab ?? info?.result ?? {};
					rootPaneId = t.root_pane_id ?? t.active_pane_id;
				}
			}
		}

		for (const m of members) {
			let memberCwd = cwd;
			const record: { paneId?: string; worktreePath?: string } = {};
			if (m.role === "worker" && opts.useWorktree !== false) {
				// 原生 git worktree：不依赖 herdr 的 workspace-git 耦合（workspace 根 ≠ 仓库时 herdr 会拒绝）
				const branch = `${run.runId}-${m.agentName}`;
				const wtPath = join(run.dir, "wt-" + m.agentName);
				await gitRun(cwd, ["worktree", "add", wtPath, "-b", branch]);
				m.worktreePath = wtPath;
				m.branch = branch;
				memberCwd = wtPath;
				record.worktreePath = wtPath;
			}
			created.push(record);

			const splitOpts: { paneId?: string; anchorPaneId?: string; direction?: "right" | "down" } = {};
			if (createdPaneIds.length === 0 && rootPaneId) {
				splitOpts.paneId = rootPaneId;
			} else if (createdPaneIds.length > 0 && useTab) {
				Object.assign(splitOpts, planGridSplits(createdPaneIds));
			}

			const res = await spawnMember(h, m, run, memberCwd, { ...opts, ...splitOpts });
			record.paneId = res.pane.pane_id;
			createdPaneIds.push(res.pane.pane_id);
		}
	} catch (err) {
		for (const c of [...created].reverse()) {
			if (c.paneId) {
				try {
					await h.paneClose(c.paneId);
				} catch {
					/* 回收失败不掩盖原始错误 */
				}
			}
			if (c.worktreePath) {
				try {
					await gitRun(cwd, ["worktree", "remove", "--force", c.worktreePath]);
				} catch {
					/* 同上 */
				}
			}
		}
		if (dedicatedTabId && typeof (h as any).tabClose === "function") {
			try {
				await h.tabClose(dedicatedTabId);
			} catch {
				/* 同上 */
			}
		}
		run.status = "aborted";
		persistRoster(run);
		throw err;
	}
	persistRoster(run);
}

/** 在指定 pane 里启动 agent（含瞬态重试 + 启动提示过关 + 等 settled），供 spawnTeam 复用。 */
async function startAgentInPane(
	h: Herdr,
	m: MemberEntry,
	run: RunState,
	paneId: string,
	opts: SpawnTeamOptions,
): Promise<void> {
	const agentArgs = ["--no-extensions", "--no-session", "-e", opts.workerExtensionPath];
	const model = m.model ?? opts.model;
	if (model) agentArgs.push("--model", model);
	agentArgs.push("-n", `swarm-${m.name}`);
	const TRANSIENT = new Set(["agent_pane_busy", "agent_not_ready"]);
	for (let attempt = 1; ; attempt++) {
		try {
			await h.agentStart(m.agentName, "pi", paneId, agentArgs, AGENT_START_TIMEOUT_MS);
			break;
		} catch (err) {
			const retryable = err instanceof HerdrError && TRANSIENT.has(err.code ?? "") && attempt < 10;
			if (!retryable) throw err;
			const sleeper = (globalThis as any).__swarmSleep ?? sleepMs;
			await sleeper(600);
		}
	}
	try {
		await h.agentSendKeys(m.agentName, "space");
	} catch {
		/* 启动提示过关失败不阻断 */
	}
	try {
		await h.agentWait(m.agentName, { timeoutMs: 30_000 });
	} catch {
		/* 等待超时不阻断 */
	}
	run.members.set(m.agentName, m);
}

// ───────────────────────────── 唉醒路由 ─────────────────────────────

export interface WakePlan {
	wakes: Array<{ member: string; seq: number }>;
	hubNotify: boolean;
	maxSeq: number;
	/** 熐断触发：worker @名 + 超限的 round */
	circuit?: { to: string; round: number };
}

/**
 * 纯逻辑：根据板上新帖与成员状态，决定要唉醒谁、要不要通知协调员。
 * 约定（Design.md §5.4）：所有跨成员唉醒都由协调员完成；to=all 广播不主动唉醒
 * （成员被 prompt 时会读板）；每个成员的 acked 推进防重复。
 */
export function planWakes(
	posts: Post[],
	members: Map<string, MemberEntry>,
	runStatus: RunStatus | string,
	lastHubSeq: number,
	maxVerifyRounds = 2,
): WakePlan {
	const plan: WakePlan = { wakes: [], hubNotify: false, maxSeq: lastHubSeq, circuit: undefined };
	if (runStatus !== "active") return plan;
	for (const p of posts) {
		if (p.meta.to === "hub") {
			if (p.meta.seq > lastHubSeq) {
				plan.hubNotify = true;
				plan.maxSeq = Math.max(plan.maxSeq, p.meta.seq);
			}
			continue;
		}
		if (p.meta.to === "all") continue;
		// 熐断：verifier 的 issue 帖 round 超上限时不再自动唉醒 worker，交 hub 拍板
		if (p.meta.type === "issue" && p.meta.round > maxVerifyRounds) {
			plan.circuit = { to: p.meta.to, round: p.meta.round };
			plan.hubNotify = true;
			plan.maxSeq = Math.max(plan.maxSeq, p.meta.seq);
			continue;
		}
		const m = members.get(p.meta.to);
		if (!m) continue; // 已收线/不在 roster
		const acked = m.acked ?? 0;
		if (p.meta.seq <= acked) continue; // 已处理过
		if (m.agentStatus === "idle") {
			plan.wakes.push({ member: m.agentName, seq: p.meta.seq });
			// 只有真正唉醒才推进 acked；忙的成员保持 pending，等它 idle 后再唉
			m.acked = Math.max(acked, p.meta.seq);
		}
		plan.maxSeq = Math.max(plan.maxSeq, p.meta.seq);
		plan.maxSeq = Math.max(plan.maxSeq, p.meta.seq);
	}
	return plan;
}

// ───────────────────────────── 工具辅助 ─────────────────────────────

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `\n…（截断，共 ${s.length} 字符；完整输出在对应 pane 里）`;
}

function requireRun(): RunState {
	if (!currentRun) throw new Error("当前没有进行中的 swarm run。先运行 /swarm <task>。");
	return currentRun;
}

function toolResult(content: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: content }], details };
}

/** agent 结果里提取可读文本（各种 herdr 版本形状兜底） */
function agentResultText(r: any): string {
	if (typeof r?.text === "string") return r.text;
	if (typeof r?.result?.text === "string") return r.result.text;
	if (typeof r?.result?.output === "string") return r.result.output;
	if (typeof r?.result?.agent?.output === "string") return r.result.agent.output;
	return JSON.stringify(r, null, 2);
}

// ───────────────────────────── 扩展入口 ─────────────────────────────

// ───────────────────────────── 渲染（widget / 看板） ─────────────────────────────

const STATUS_SHORT: Record<string, string> = {
	idle: "待", working: "忙", done: "完", blocked: "卡", unknown: "?", "": "?",
};

/** 编辑器上方的一行状态；run 结束后由 updateWidget 清除。 */
export function renderWidget(run: RunState, maxSeq: number): string[] {
	const members = [...run.members.values()]
		.map((m) => {
			const st = STATUS_SHORT[m.agentStatus ?? ""] ?? (m.agentStatus ?? "?");
			return `@${m.name}(${m.role[0]})${st}${m.round ? `r${m.round}` : ""}`;
		})
		.join(" · ");
	let line = `swarm ${run.runId} | ${members || "无成员"} | 帖 #${maxSeq}`;
	if (line.length > 160) line = line.slice(0, 157) + "…";
	return [line];
}

/** Alt+S 只读看板：名册 + 帖子流回放。posts 由调用方传入（打开瞬间快照）。 */
export function renderBoard(run: RunState, posts: Post[]): string[] {
	const lines: string[] = [];
	lines.push(`═══ Swarm 看板 ${run.runId}（${run.status}）═══`);
	lines.push(`任务：${run.task.length > 80 ? run.task.slice(0, 77) + "…" : run.task}`);
	if (run.maxVerifyRounds) lines.push(`打回上限：${run.maxVerifyRounds} 轮`);
	lines.push("");
	lines.push("── 成员 ──");
	if (run.members.size === 0) lines.push("（无成员）");
	for (const m of run.members.values()) {
		const bits = [`@${m.name}（${m.role}）${m.agentStatus ?? "?"}`];
		if (m.round) bits.push(`round ${m.round}`);
		if (m.model) bits.push(`模型 ${m.model}`);
		if (m.worktreePath) bits.push(`wt ${m.worktreePath}（${m.branch}）`);
		lines.push(bits.join(" ｜ "));
	}
	lines.push("");
	lines.push("── 消息板 ──");
	if (posts.length === 0) lines.push("（空）");
	for (const p of posts) {
		lines.push(`#${p.meta.seq} [${p.meta.type}] ${p.meta.from} → ${p.meta.to}` + (p.meta.round ? ` (round ${p.meta.round})` : ""));
		for (const bl of p.body.split("\n")) lines.push(`  ${bl}`);
	}
	lines.push("");
	lines.push("q / esc 关闭");
	return lines;
}

export interface MonitorState {
	selectedIdx: number;
	viewMode: "output" | "board";
	outputs: Map<string, string>;
	lastRefreshed?: string;
	width?: number;
}

/** Alt+S 实时交互监控面板纯渲染函数。 */
export function renderMonitor(run: RunState, posts: Post[], state: MonitorState): string[] {
	const width = Math.max(40, state.width ?? 100);
	const clip = (s: string) => (s.length > width ? s.slice(0, width - 1) + "…" : s);
	const memberList = [...run.members.values()];
	const safeIdx = memberList.length > 0 ? Math.max(0, Math.min(state.selectedIdx, memberList.length - 1)) : 0;
	const selected = memberList[safeIdx];

	const lines: string[] = [];
	const refreshTag = state.lastRefreshed ? ` ｜ 刷新 ${state.lastRefreshed}` : "";
	const tabTag = run.tabId ? ` ｜ Tab ${run.tabId}` : "";
	lines.push(clip(`═══ Swarm 监控 ${run.runId}（${run.status}）${tabTag}${refreshTag} ═══`));
	lines.push(clip(`任务：${run.task}`));
	lines.push("");

	lines.push(clip(`── 成员 (${memberList.length}) ──`));
	if (memberList.length === 0) {
		lines.push("（无成员）");
	} else {
		for (let i = 0; i < memberList.length; i++) {
			const m = memberList[i];
			const marker = i === safeIdx ? "▶" : " ";
			const bits = [
				`${marker} [${i + 1}] @${m.name}(${m.role}) ${m.agentStatus ?? "?"}`,
			];
			if (m.round) bits.push(`r${m.round}`);
			if (m.model) bits.push(m.model);
			lines.push(clip(bits.join(" ｜ ")));
		}
	}
	lines.push("");

	if (state.viewMode === "output") {
		lines.push(clip(`── 实时输出：${selected ? `@${selected.name}` : "无"} ──`));
		const rawOut = selected ? (state.outputs.get(selected.agentName) ?? "（等待采集输出…）") : "（无成员）";
		const outLines = rawOut.split("\n").slice(-16);
		for (const ol of outLines) lines.push(clip(`  ${ol}`));

		lines.push("");
		lines.push("── 相关最新帖 ──");
		const rel = selected
			? posts.filter((p) => p.meta.from === selected.name || p.meta.to === selected.name || p.meta.to === "all").slice(-3)
			: posts.slice(-3);
		if (rel.length === 0) {
			lines.push("  （暂无相关帖子）");
		} else {
			for (const p of rel) {
				const firstLine = p.body.split("\n")[0] ?? "";
				lines.push(clip(`  #${p.meta.seq} [${p.meta.type}] ${p.meta.from}→${p.meta.to}: ${firstLine}`));
			}
		}
	} else {
		lines.push(`── 消息板全量帖子 (${posts.length}) ──`);
		if (posts.length === 0) {
			lines.push("  （空）");
		} else {
			for (const p of posts.slice(-12)) {
				lines.push(clip(`#${p.meta.seq} [${p.meta.type}] ${p.meta.from} → ${p.meta.to}` + (p.meta.round ? ` (round ${p.meta.round})` : "")));
				for (const bl of p.body.split("\n").slice(0, 4)) lines.push(clip(`  ${bl}`));
			}
		}
	}

	lines.push("");
	const focusHint = run.tabId ? " · f 跳到 Swarm Tab" : "";
	lines.push(clip(`↑/↓ 或 1-5 切成员 · Tab 切输出/消息板 · r 刷新${focusHint} · q/Esc 关闭`));
	return lines;
}


// ───────────────────────────── cleanup ─────────────────────────────

export interface CleanupTarget {
	runId: string;
	dir: string;
	status: string;
	tabId?: string;
	paneIds: string[];
	worktrees: Array<{ path: string; branch?: string }>;
}

/**
 * 扫 .pi/swarm/<id>/roster.json，收集可清理的 done/aborted run。
 * 指定 runId 时只看该 run（若它是 active → 空数组，需先 abort）。
 */
export function collectCleanupTargets(cwd: string, runId?: string): CleanupTarget[] {
	const base = join(cwd, ".pi", "swarm");
	if (!existsSync(base)) return [];
	const targets: CleanupTarget[] = [];
	for (const entry of readdirSync(base)) {
		const rf = join(base, entry, "roster.json");
		if (!existsSync(rf)) continue;
		try {
			const data = JSON.parse(readFileSync(rf, "utf8"));
			if (data.status && data.status !== "active") {
				if (runId && data.runId !== runId) continue;
				targets.push({
					runId: data.runId,
					dir: join(base, entry),
					status: data.status,
					tabId: data.tabId,
					paneIds: (data.members ?? []).map((m: any) => m.paneId).filter(Boolean),
					worktrees: (data.members ?? [])
						.filter((m: any) => m.worktreePath)
						.map((m: any) => ({ path: m.worktreePath, branch: m.branch })),
				});
			} else if (runId && data.runId === runId) {
				continue; // active run 不能 cleanup
			}
		} catch {
			/* 坏 roster 跳过 */
		}
	}
	return targets;
}

/**
 * 执行清理：关 pane → git worktree remove --force → git branch -D。
 * 幂等：pane/worktree/branch 已不存在时吞错。不删 run 目录（留档案）。
 */
export async function runCleanup(
	h: Herdr,
	cwd: string,
	targets: CleanupTarget[],
	gitRun: GitRunner = defaultGitRun,
): Promise<string[]> {
	const acted: string[] = [];
	for (const t of targets) {
		for (const paneId of t.paneIds) {
			try {
				await h.paneClose(paneId);
				acted.push(`${t.runId}: pane ${paneId} 已关`);
			} catch {
				/* 已不存在，幂等跳过 */
			}
		}
		if (t.tabId && typeof (h as any).tabClose === "function") {
			try {
				await h.tabClose(t.tabId);
				acted.push(`${t.runId}: tab ${t.tabId} 已关`);
			} catch {
				/* 已不存在，幂等跳过 */
			}
		}
		for (const wt of t.worktrees) {
			try {
				await gitRun(cwd, ["worktree", "remove", "--force", wt.path]);
				acted.push(`${t.runId}: worktree ${wt.path} 已删`);
			} catch {
				/* 已不存在，幂等跳过 */
			}
			if (wt.branch) {
				try {
					await gitRun(cwd, ["branch", "-D", wt.branch]);
					acted.push(`${t.runId}: 分支 ${wt.branch} 已删`);
				} catch {
					/* 已不存在，幂等跳过 */
				}
			}
		}
	}
	return acted;
}


export default function (pi: ExtensionAPI) {
	const herdr: Herdr = createHerdr(); // 只是个对象，工厂阶段不发起任何调用

	// ── /swarm 命令 ──
	pi.registerCommand("swarm", {
		description: "Swarm：拉起 worker 团队并行处理任务（支持 /swarm models 管理模型）",
		getArgumentCompletions: (prefix) => {
			const cmds = [
				{ value: "models", label: "models — 查看或配置各角色默认模型" },
				{ value: "status", label: "status — 查看成员状态" },
				{ value: "abort", label: "abort — 停止当前 run" },
				{ value: "cleanup", label: "cleanup — 清理已结束的 worktree 与分支" },
			];
			const matched = cmds.filter((c) => c.value.startsWith(prefix));
			return matched.length > 0 ? matched : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim();
			if (sub === "status") {
				cmdStatus(ctx);
				return;
			}
			if (sub === "abort") {
				await cmdAbort(ctx);
				return;
			}
			if (sub === "cleanup" || sub.startsWith("cleanup ")) {
				await cmdCleanup(ctx, sub.slice("cleanup".length).trim() || undefined);
				return;
			}
			if (sub === "models" || sub.startsWith("models ")) {
				await cmdModels(ctx, sub.slice("models".length).trim());
				return;
			}
			const env = checkEnv();
			if (!env.ok) {
				ctx.ui.notify(`/swarm 环境检查未通过：\n${env.problems.join("\n")}`, "error");
				return;
			}
			if (currentRun) {
				ctx.ui.notify(
					`已有进行中的 run：${currentRun.runId}。先 /swarm abort 或等它收线。`,
					"warning",
				);
				return;
			}
			let parsed: { task: string; cliOverrides: ModelOverrides };
			try {
				parsed = parseSwarmTaskArgs(sub);
			} catch (err: any) {
				ctx.ui.notify(err?.message ?? String(err), "error");
				return;
			}
			const task = parsed.task;
			if (!task) {
				ctx.ui.notify(
					"用法：/swarm [--worker-model=provider/model] [--verifier-model=provider/model] <task>，或 /swarm models | status | abort | cleanup",
					"info",
				);
				return;
			}

			let modelSummary = "";
			try {
				const { effective } = loadEffectiveModelConfig(ctx.cwd);
				const effectiveWithCli: SwarmModelConfig = {
					...effective,
					roles: {
						...effective.roles,
						...(parsed.cliOverrides.worker ? { worker: parsed.cliOverrides.worker } : {}),
						...(parsed.cliOverrides.verifier ? { verifier: parsed.cliOverrides.verifier } : {}),
					},
				};
				modelSummary = formatModelConfigSummary(effectiveWithCli);
			} catch (err: any) {
				ctx.ui.notify(err?.message ?? String(err), "error");
				return;
			}
			pendingModelOverrides = parsed.cliOverrides;

			// 预检（Design.md §3）：git 仓库、脏工作区、herdr workspace 可用性
			const pre = precheckRepo(ctx.cwd);
			const warnings: string[] = [];
			if (!pre.isGit) warnings.push("当前目录不是 git 仓库：无法做 worktree 隔离，worker 将直接在主仓干活。");
			else if (pre.dirty > 0) warnings.push(`主仓有 ${pre.dirty} 个未提交改动：worktree 基于 HEAD 创建，worker 看不到这些改动。建议先提交或 stash。`);

			// 交给协调员模型规划；分工确认在 swarm_plan 工具内经确认框把关
			pi.sendUserMessage(
				`Swarm 预检完成${warnings.length ? "，注意：\n" + warnings.map((w) => `- ${w}`).join("\n") : "，无告警"}。\n`
				+ `当前生效模型配置：${modelSummary}\n`
				+ `任务：\n<task>\n${task}\n</task>\n`
				+ `现在调用 swarm_plan 提交分工清单：成员 name（小写短横线，如 fix-1）、role（worker/verifier，worker ≤4，可选一个 verifier）、`
				+ `scope/forbidden/definitionOfDone、可选 model（已配置的规则会优先于模型参数生效）。任务必须原样透传给 plan 的 task 参数，不要改写。`,
				{ deliverAs: "nextTurn" },
			);
		},
	});

	/** 止损：停活 worker（关 pane 即杀进程）、回收现场、保留 run 目录供排查。 */
	async function cmdAbort(ctx: ExtensionCommandContext) {
		pendingModelOverrides = undefined;
		let run = currentRun;
		if (!run) run = loadRoster(ctx.cwd); // 会话重启后的孤儿 run 也能接管
		if (!run) {
			ctx.ui.notify("当前没有进行中的 swarm run。", "info");
			return;
		}
		const closed: string[] = [];
		for (const m of run.members.values()) {
			if (m.paneId) {
				try {
					await herdr.paneClose(m.paneId);
					closed.push(m.name);
				} catch {
					/* 单个 pane 失败不阻断其余回收 */
				}
			}
			if (m.worktreePath) {
				try {
					await defaultGitRun(ctx.cwd, ["worktree", "remove", "--force", m.worktreePath]);
					closed.push(`${m.name}(worktree)`);
				} catch {
					/* 同上 */
				}
			}
		}
		if (run.tabId) {
			try {
				await herdr.tabClose(run.tabId);
			} catch {
				/* tab 已关闭不阻断 */
			}
		}
		run.status = "aborted";
		persistRoster(run);
		currentRun = undefined;
		ctx.ui.notify(
			`Swarm ${run.runId} 已中止。已停 ${closed.length} 个 worker：${closed.join(", ") || "无"}。现场保留在 ${run.dir}。`,
			"warning",
		);
	}

	/** 清理 done/aborted run 的 pane/worktree/分支；保留 .pi/swarm/<id>/ 档案。 */
	async function cmdCleanup(ctx: ExtensionCommandContext, runId?: string) {
		const targets = collectCleanupTargets(ctx.cwd, runId);
		if (targets.length === 0) {
			ctx.ui.notify("没有可清理的 run（只处理 done/aborted；active 的先 /swarm abort）。", "info");
			return;
		}
		const acted = await runCleanup(herdr, ctx.cwd, targets);
		ctx.ui.notify(
			`已清理 ${targets.length} 个 run（档案保留在 .pi/swarm/）：\n${acted.join("\n") || "无可回收资源（此前已清过）"}`,
			"info",
		);
	}

	/** 编辑器上方的一行状态；run 结束后由 updateWidget 清除。仅 TUI 模式生效。 */
	function updateWidget(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		try {
			if (!currentRun || currentRun.status !== "active") {
				ctx.ui.setWidget("swarm", undefined);
				return;
			}
			ctx.ui.setWidget("swarm", renderWidget(currentRun, lastHubSeq));
		} catch {
			/* widget 刷新失败不影响主流程 */
		}
	}

	/** Alt+S 交互式实时监控面板：每 2 秒刷新成员状态/输出与消息板，支持切换成员与跳到 Swarm Tab。 */
	async function openBoardOverlay(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		const run = currentRun ?? loadRoster(ctx.cwd);
		if (!run) {
			ctx.ui.notify("当前没有 swarm run。", "info");
			return;
		}
		try {
			await ctx.ui.custom(
				(tui, _theme, _kb, done) => {
					const state: MonitorState = {
						selectedIdx: 0,
						viewMode: "output",
						outputs: new Map(),
					};
					let posts: Post[] = readAllPosts(run.postsDir);
					let refreshing = false;
					let closed = false;
					let timer: ReturnType<typeof setInterval> | undefined;

					const stopTimer = () => {
						closed = true;
						if (timer) {
							clearInterval(timer);
							timer = undefined;
						}
					};

					const refresh = async () => {
						if (refreshing || closed) return;
						refreshing = true;
						try {
							posts = readAllPosts(run.postsDir);
							try {
								const r = await herdr.agentList();
								const agents: any[] = r.result?.agents ?? [];
								for (const a of agents) {
									const m = run.members.get(a.name);
									if (m) m.agentStatus = a.agent_status;
								}
							} catch {
								/* 状态拉取失败不阻断输出预览 */
							}
							const memberList = [...run.members.values()];
							const sel = memberList[Math.max(0, Math.min(state.selectedIdx, memberList.length - 1))];
							if (sel && state.viewMode === "output") {
								try {
									const out = await herdr.agentRead(sel.agentName, { source: "recent-unwrapped", lines: 30 });
									const text = (out.result?.text ?? out.result?.output ?? "").trim();
									if (text) state.outputs.set(sel.agentName, text);
								} catch {
									/* 读取输出失败保留上次内容 */
								}
							}
							const now = new Date();
							state.lastRefreshed = now.toTimeString().slice(0, 8);
						} finally {
							refreshing = false;
							if (!closed) tui.requestRender();
						}
					};

					void refresh();
					timer = setInterval(() => {
						void refresh();
					}, 2000);

					return {
						render: (width: number) => {
							state.width = width;
							return renderMonitor(run, posts, state);
						},
						handleInput: (data: string) => {
							const memberList = [...run.members.values()];
							if (data === "\x1b[A" || data === "k") {
								if (memberList.length > 0) {
									state.selectedIdx = (state.selectedIdx - 1 + memberList.length) % memberList.length;
									void refresh();
									tui.requestRender();
								}
								return;
							}
							if (data === "\x1b[B" || data === "j") {
								if (memberList.length > 0) {
									state.selectedIdx = (state.selectedIdx + 1) % memberList.length;
									void refresh();
									tui.requestRender();
								}
								return;
							}
							if (data >= "1" && data <= "5") {
								const idx = Number(data) - 1;
								if (idx < memberList.length) {
									state.selectedIdx = idx;
									void refresh();
									tui.requestRender();
								}
								return;
							}
							if (data === "\t") {
								state.viewMode = state.viewMode === "output" ? "board" : "output";
								void refresh();
								tui.requestRender();
								return;
							}
							const key = data.toLowerCase();
							if (key === "r") {
								void refresh();
								return;
							}
							if (key === "f" && run.tabId) {
								void herdr.tabFocus(run.tabId).catch(() => {});
								return;
							}
							if (key === "q" || data === "\x1b" || data === "\u0003") {
								stopTimer();
								done(undefined);
							}
						},
						invalidate: () => {},
						dispose: stopTimer,
					};
				},
				{ overlay: true },
			);
		} catch {
			/* overlay 打开失败静默 */
		}
	}

	function cmdStatus(ctx: ExtensionCommandContext) {
		const run = currentRun;
		if (!run) {
			ctx.ui.notify("当前没有进行中的 swarm run。", "info");
			return;
		}
		const lines = [...run.members.values()].map(
			(m) => `@${m.name}（${m.role}）pane=${m.paneId ?? "?"} status=${m.agentStatus ?? "?"}`,
		);
		ctx.ui.notify(`Swarm ${run.runId}\n${lines.join("\n")}`, "info");
	}

	/** 从运行时 modelRegistry 读取可用模型列表（返回 provider/id），不可用时返回空数组。 */
	function getAvailableModelIds(ctx: { modelRegistry?: unknown }): string[] {
		try {
			const reg = ctx.modelRegistry as any;
			const list: any[] = reg?.getAvailable?.() ?? reg?.getAll?.() ?? [];
			const ids = list
				.map((m) => (m?.provider && m?.id ? `${m.provider}/${m.id}` : typeof m === "string" ? m : ""))
				.filter((s) => s.includes("/"));
			return [...new Set(ids)];
		} catch {
			return [];
		}
	}

	/** 交互式选择或输入一个全限定模型名；返回 string 为新模型，"" 表示清除恢复继承，undefined 表示取消。 */
	async function pickModelForTarget(
		ctx: { ui: any; modelRegistry?: unknown },
		title: string,
		currentModel?: string,
	): Promise<string | undefined> {
		const ui = ctx.ui;
		if (!ui?.select && !ui?.input) return undefined;

		const available = getAvailableModelIds(ctx);
		const MANUAL = "手动输入 provider/model...";
		const CLEAR = "清除（恢复继承/上一级）";
		const CANCEL = "取消";

		let options: string[];
		if (ui.select) {
			options = [...available, MANUAL, CLEAR, CANCEL];
			const sel = await ui.select(`${title}${currentModel ? `（当前：${currentModel}）` : "（当前：继承）"}`, options);
			if (!sel || sel === CANCEL) return undefined;
			if (sel === CLEAR) return "";
			if (sel !== MANUAL) return validateQualifiedModel(sel);
		}
		if (!ui.input) return undefined;
		const typed = await ui.input(title, currentModel ?? "provider/model");
		if (typed === undefined || typed === null) return undefined;
		if (typed.trim() === "") return "";
		return validateQualifiedModel(typed);
	}

	function formatTargetLabel(t: ModelTarget): string {
		if (t.kind === "default") return "default";
		if (t.kind === "role") return t.role;
		return `@${t.name}`;
	}

	/** `/swarm models` 管理命令：支持 show/set/reset 快捷子命令与交互式菜单。 */
	async function cmdModels(ctx: ExtensionCommandContext, rawArgs: string) {
		const tokens = rawArgs.trim().match(/\S+/g) ?? [];
		const isGlobalFlag = tokens.includes("--global");
		const positional = tokens.filter((t) => t !== "--global");
		const sub = positional[0];

		const showAll = () => {
			const { global: g, project: p, effective: e } = loadEffectiveModelConfig(ctx.cwd);
			ctx.ui.notify(
				[
					`全局 (${globalModelConfigPath()}): ${formatModelConfigSummary(g)}`,
					`项目 (${projectModelConfigPath(ctx.cwd)}): ${formatModelConfigSummary(p)}`,
					`当前生效: ${formatModelConfigSummary(e)}`,
				].join("\n"),
				"info",
			);
		};

		try {
			if (sub === "show") {
				showAll();
				return;
			}
			if (sub === "set") {
				if (positional.length < 3) {
					ctx.ui.notify("用法：/swarm models set <worker|verifier|default|member-name> <provider/model> [--global]", "info");
					return;
				}
				const target = parseModelTarget(positional[1]);
				const filePath = isGlobalFlag ? globalModelConfigPath() : projectModelConfigPath(ctx.cwd);
				const updated = setConfigTarget(loadModelConfigFile(filePath), target, positional[2]);
				saveModelConfigFile(filePath, updated);
				ctx.ui.notify(
					`已更新${isGlobalFlag ? "全局" : "项目"}模型配置 [${formatTargetLabel(target)}] = ${validateQualifiedModel(positional[2])}`,
					"info",
				);
				return;
			}
			if (sub === "reset") {
				if (positional.length < 2) {
					ctx.ui.notify("用法：/swarm models reset <worker|verifier|default|member-name> [--global]", "info");
					return;
				}
				const target = parseModelTarget(positional[1]);
				const filePath = isGlobalFlag ? globalModelConfigPath() : projectModelConfigPath(ctx.cwd);
				const { config: updated, removed } = resetConfigTarget(loadModelConfigFile(filePath), target);
				saveModelConfigFile(filePath, updated);
				ctx.ui.notify(
					removed
						? `已清除${isGlobalFlag ? "全局" : "项目"}模型配置 [${formatTargetLabel(target)}]。`
						: `${isGlobalFlag ? "全局" : "项目"}配置中未设置 [${formatTargetLabel(target)}]。`,
					"info",
				);
				return;
			}
			if (sub) {
				ctx.ui.notify("用法：/swarm models [show | set <target> <provider/model> [--global] | reset <target> [--global]]", "info");
				return;
			}

			// 交互式菜单
			const ui = ctx.ui as any;
			if (!ctx.hasUI || !ui?.select) {
				showAll();
				return;
			}
			const scopeChoice = await ui.select("Swarm 模型配置", [
				"项目配置 (.pi/swarm/models.json)",
				"全局配置 (~/.pi/agent/swarm-models.json)",
				"查看当前生效配置",
				"取消",
			]);
			if (!scopeChoice || scopeChoice === "取消") return;
			if (scopeChoice === "查看当前生效配置") {
				showAll();
				return;
			}
			const useGlobal = scopeChoice.startsWith("全局配置");
			const filePath = useGlobal ? globalModelConfigPath() : projectModelConfigPath(ctx.cwd);
			const cfg = loadModelConfigFile(filePath);

			const targetChoice = await ui.select(`选择要配置的${useGlobal ? "全局" : "项目"}目标`, [
				`worker (当前: ${cfg.roles?.worker ?? "未设置"})`,
				`verifier (当前: ${cfg.roles?.verifier ?? "未设置"})`,
				`default (当前: ${cfg.default ?? "未设置"})`,
				"指定成员名 (members.<name>)",
				"取消",
			]);
			if (!targetChoice || targetChoice === "取消") return;

			let target: ModelTarget;
			let currentModel: string | undefined;
			if (targetChoice.startsWith("worker")) {
				target = { kind: "role", role: "worker" };
				currentModel = cfg.roles?.worker;
			} else if (targetChoice.startsWith("verifier")) {
				target = { kind: "role", role: "verifier" };
				currentModel = cfg.roles?.verifier;
			} else if (targetChoice.startsWith("default")) {
				target = { kind: "default" };
				currentModel = cfg.default;
			} else {
				const nameInput = await ui.input?.("输入成员名（如 fix-1）", "fix-1");
				if (!nameInput?.trim()) return;
				target = parseModelTarget(nameInput.trim());
				currentModel = target.kind === "member" ? cfg.members?.[target.name] : undefined;
			}

			const chosen = await pickModelForTarget(ctx, `为 [${formatTargetLabel(target)}] 选择模型`, currentModel);
			if (chosen === undefined) return;
			if (chosen === "") {
				const { config: updated } = resetConfigTarget(cfg, target);
				saveModelConfigFile(filePath, updated);
				ctx.ui.notify(`已清除${useGlobal ? "全局" : "项目"}模型配置 [${formatTargetLabel(target)}]。`, "info");
			} else {
				const updated = setConfigTarget(cfg, target, chosen);
				saveModelConfigFile(filePath, updated);
				ctx.ui.notify(`已保存${useGlobal ? "全局" : "项目"}模型配置 [${formatTargetLabel(target)}] = ${chosen}`, "info");
			}
		} catch (err: any) {
			ctx.ui.notify(err?.message ?? String(err), "error");
		}
	}

	// ── 工具：swarm_wait ──
	pi.registerTool({
		name: "swarm_wait",
		label: "Swarm Wait",
		description:
			"等待某个 swarm 成员到达 idle（干完活）。返回其最终状态。注意：超时后不要盲目重发任务，先用 swarm_read_output 观察它在干什么。",
		parameters: Type.Object({
			name: Type.String({ description: "成员名，如 fix-1（不带 @）" }),
			timeoutMs: Type.Optional(
				Type.Number({ description: "最长等待毫秒数，默认 600000" }),
			),
		}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async (_id, params, signal) => {
			const run = requireRun();
			const member = run.members.get(params.name);
			if (!member) throw new Error(`swarm 里没有成员 ${params.name}`);
			const timeoutMs = params.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
			let lastStatus: string | undefined;
			const onAbort = () => {
				/* herdr wait 进程由 exec 层处理；这里仅占位 */
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				// 不指定 until：用 herdr 默认的 settled 集（idle/done/blocked）。
				// 只等 idle 会死等：收线后的 agent 状态是 done（实测）。
				// signal 接入：用户打断时立刻杀掉挂着的 herdr wait 进程。
				const r = await herdr.agentWait(params.name, { timeoutMs, signal });
				member.agentStatus = (r as any).agent_status ?? "idle";
				lastStatus = member.agentStatus;
			} catch (err) {
				if (err instanceof HerdrError) {
					member.agentStatus = "unknown";
					lastStatus = `herdr ${err.kind}: ${err.message}`;
				} else {
					throw err;
				}
			} finally {
				signal?.removeEventListener("abort", onAbort);
				persistRoster(run);
			}
			return toolResult(
				`@${member.name} 状态：${lastStatus}`,
				{ name: member.name, status: lastStatus },
			);
		},
	});

	// ── 工具：swarm_read_output ──
	pi.registerTool({
		name: "swarm_read_output",
		label: "Swarm Read Output",
		description: "读取某个 swarm 成员最近一段终端输出（已按软换行拼接，截断到预算内）。",
		parameters: Type.Object({
			name: Type.String({ description: "成员名，如 fix-1" }),
			lines: Type.Optional(Type.Number({ description: "读取行数，默认 120" })),
		}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async (_id, params) => {
			const run = requireRun();
			const member = run.members.get(params.name);
			if (!member) throw new Error(`swarm 里没有成员 ${params.name}`);
			const r = await herdr.agentRead(params.name, { lines: params.lines ?? 120 });
			return toolResult(truncate(agentResultText(r)), { name: member.name });
		},
	});

	// ── 工具：swarm_post（hub 身份发帖）──
	pi.registerTool({
		name: "swarm_post",
		label: "Swarm Post",
		description:
			"以协调员（hub）身份往 swarm 消息板发帖。分工总帖用 to=all + type=note；打回/指引用 to=成员名。",
		parameters: Type.Object({
			to: Type.String({ description: "收帖人 @名 或 all" }),
			type: Type.Union([
				Type.Literal("note"), Type.Literal("question"), Type.Literal("issue"), Type.Literal("done"),
			]),
			body: Type.String({ description: "正文" }),
			round: Type.Optional(Type.Number()),
			refs: Type.Optional(Type.Array(Type.String())),
		}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async (_id, params) => {
			const run = requireRun();
			const seq = await writePost(run.postsDir, {
				seq: 0, from: "hub", to: params.to, type: params.type,
				round: params.round ?? 0, refs: params.refs ?? [],
			}, params.body);
			return toolResult(`已发帖 #${seq}（hub → ${params.to}, ${params.type}）。`, { seq });
		},
	});

	// ── 工具：swarm_read（读板）──
	pi.registerTool({
		name: "swarm_read",
		label: "Swarm Read",
		description: "读 swarm 消息板全部帖子（按序号排列），用于收线汇总与检查打回轮次。",
		parameters: Type.Object({}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async () => {
			const run = requireRun();
			const posts = readAllPosts(run.postsDir);
			if (posts.length === 0) return toolResult("消息板还是空的。", { count: 0 });
			const text = posts
				.map((p) => `#${p.meta.seq} [${p.meta.type}] ${p.meta.from} → ${p.meta.to}`
					+ (p.meta.round ? ` (round ${p.meta.round})` : "")
					+ `\n${p.body}`)
				.join("\n\n");
			return toolResult(text, { count: posts.length });
		},
	});

	// ── 工具：swarm_plan（规划 + 确认框 + 拉队）──
	pi.registerTool({
		name: "swarm_plan",
		label: "Swarm Plan",
		description:
			"提交 swarm 分工清单。执行：校验 → 确认框给用户把关 → 建 worktree 拉起全部成员 → 发分工总帖。"
			+ "成员 name 用小写短横线（如 fix-1，正则 ^[a-z][a-z0-9_-]{0,31}$）；worker ≤4，可选一个 verifier。"
			+ "用户否决时返回否决原因，调整清单后重新调用。",
		parameters: Type.Object({
			task: Type.String({ description: "本次 swarm 的完整任务原文（原样透传，不要改写）" }),
			maxVerifyRounds: Type.Optional(
				Type.Number({ description: "verifier 打回上限，默认 2" }),
			),
			members: Type.Array(
				Type.Object({
					name: Type.String({ description: "成员名，如 fix-1 / refactor / tests" }),
					role: Type.Union([Type.Literal("worker"), Type.Literal("verifier")]),
					scope: Type.Optional(Type.String({ description: "负责范围（文件/目录/模块）" })),
					forbidden: Type.Optional(Type.String({ description: "禁区（不得改动）" })),
					definitionOfDone: Type.Optional(Type.String({ description: "完成标准" })),
					model: Type.Optional(Type.String({ description: "模型覆盖（可选）。建议写 provider/model 全限定名（如 opencode-go/glm-5.3-flash）：裸模型名在多 provider 环境有歧义，pi 会直接退出" })),
				}),
				{ minItems: 1, maxItems: 5 },
			),
		}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async (_id, params, _signal, _onUpdate, toolCtx) => {
			if (currentRun) throw new Error("已有进行中的 run，先 /swarm abort 或等收线。");

			// ── 校验 ──
			const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
			const problems: string[] = [];
			const names = params.members.map((m) => m.name);
			if (new Set(names).size !== names.length) problems.push("成员名有重复。");
			for (const n of names) if (!NAME_RE.test(n)) problems.push(`成员名 ${n} 不符合 ^[a-z][a-z0-9_-]{0,31}$`);
			const workers = params.members.filter((m) => m.role === "worker");
			if (workers.length > 4) problems.push(`worker 数 ${workers.length} 超过上限 4。`);
			const verifiers = params.members.filter((m) => m.role === "verifier");
			if (verifiers.length > 1) problems.push("verifier 最多 1 个。");
			if (problems.length > 0) throw new Error(`分工清单有误：\n${problems.join("\n")}`);

			// ── 解析模型配置 + 确认框 ──
			const { effective: effectiveConfig } = loadEffectiveModelConfig(toolCtx.cwd);
			const cliOverrides = pendingModelOverrides;
			const interactiveOverrides: Record<string, string | undefined> = {};

			const computeResolvedModels = () =>
				params.members.map((m) =>
					resolveMemberModel(m, {
						interactiveOverride: interactiveOverrides[m.name],
						cliOverrides,
						config: effectiveConfig,
					}),
				);

			const buildLines = (resolvedModels: Array<string | undefined>) =>
				params.members.map((m, idx) => {
					const bits = [`@${m.name}（${m.role}）`];
					if (m.scope) bits.push(`范围: ${m.scope}`);
					if (m.forbidden) bits.push(`禁区: ${m.forbidden}`);
					if (m.definitionOfDone) bits.push(`完成标准: ${m.definitionOfDone}`);
					bits.push(`模型: ${resolvedModels[idx] ?? "继承协调员"}`);
					return `- ${bits.join(" ｜ ")}`;
				});

			const quotaNote = `本 run 将启动 ${params.members.length} 个独立 pi 会话（各自消耗模型配额）。`;
			let resolvedModels = computeResolvedModels();
			let lines = buildLines(resolvedModels);

			if (toolCtx.hasUI) {
				const ui = toolCtx.ui as any;
				if (ui.select) {
					while (true) {
						resolvedModels = computeResolvedModels();
						lines = buildLines(resolvedModels);
						const prompt = `确认 Swarm 分工？\n任务：${params.task.slice(0, 200)}\n\n${lines.join("\n")}\n\n${quotaNote}`;
						const choice = await ui.select(prompt, ["确认启动", "修改成员模型", "取消"]);
						if (!choice || choice === "取消") {
							pendingModelOverrides = undefined;
							return toolResult("用户否决了这份分工。不要自行重试同一方案；调整分工（或换任务拆法）后重新调用 swarm_plan。", { confirmed: false });
						}
						if (choice === "确认启动") break;
						// 修改成员模型
						const memberLabels = params.members.map((m, idx) => `@${m.name} (${m.role}) — ${resolvedModels[idx] ?? "继承协调员"}`);
						const pickedLabel = await ui.select("选择要修改模型的成员", [...memberLabels, "返回"]);
						const pickedIdx = memberLabels.indexOf(pickedLabel);
						if (pickedIdx < 0) continue;
						const targetMember = params.members[pickedIdx];
						try {
							const nextModel = await pickModelForTarget(
								toolCtx as any,
								`为 @${targetMember.name} (${targetMember.role}) 选择模型`,
								resolvedModels[pickedIdx],
							);
							if (nextModel !== undefined) {
								interactiveOverrides[targetMember.name] = nextModel;
							}
						} catch (err: any) {
							toolCtx.ui.notify?.(err?.message ?? String(err), "error");
						}
					}
				} else {
					const ok = await toolCtx.ui.confirm(
						"确认 Swarm 分工？",
						`任务：${params.task.slice(0, 200)}\n\n${lines.join("\n")}\n\n${quotaNote}`,
					);
					if (!ok) {
						pendingModelOverrides = undefined;
						return toolResult("用户否决了这份分工。不要自行重试同一方案；调整分工（或换任务拆法）后重新调用 swarm_plan。", { confirmed: false });
					}
				}
			}

			pendingModelOverrides = undefined;

			// ── 建 run + 拉队 ──
			const run = initRun(toolCtx.cwd, params.task);
			run.maxVerifyRounds = params.maxVerifyRounds ?? 2;
			currentRun = run;
			const members: MemberEntry[] = params.members.map((m, idx) => ({
				name: m.name,
				agentName: m.name,
				role: m.role,
				scope: m.scope,
				forbidden: m.forbidden,
				definitionOfDone: m.definitionOfDone,
				model: resolvedModels[idx],
			}));
			try {
				await spawnTeam(herdr, run, members, toolCtx.cwd, {
					workerExtensionPath: WORKER_EXT_PATH,
				});
			} catch (err) {
				currentRun = undefined;
				throw err;
			}

			// ── 分工总帖 ──
			await writePost(run.postsDir, {
				seq: 0, from: "hub", to: "all", type: "note", round: 0, refs: [],
			},
			`任务：${params.task}\n${lines.join("\n")}\n各自按简报开工；完成即 report_done。`);

			toolCtx.ui.notify?.(`Swarm ${run.runId} 已启动（${members.length} 人）。`, "info");
			pi.sendUserMessage(
				`Swarm run ${run.runId} 已启动（${members.length} 名成员）。分工总帖已发（to=all）。`
				+ `现在盯收线：用 swarm_wait 等成员到 settled，用 swarm_read 检查板子上的 done/issue 帖，`
				+ `有 issue 打回就确认对应成员被唤醒修复；全部 done 后读板汇总 diff 与 commit hash 给用户。`,
				{ deliverAs: "nextTurn" },
			);
			return toolResult(
				`Swarm ${run.runId} 启动：${members.map((m) => `@${m.name}(${m.role})`).join(", ")}`,
				{ runId: run.runId, members: members.map((m) => ({ name: m.name, role: m.role, worktree: m.worktreePath })) },
			);
		},
	});

	// ── 工具：swarm_close（收线）──
	pi.registerTool({
		name: "swarm_close",
		label: "Swarm Close",
		description:
			"收线：全员 done、汇总已呈报后调用。把 run 状态置为 done（状态小组件随之清除），档案保留在 .pi/swarm/，worktree 清理走 /swarm cleanup。",
		parameters: Type.Object({
			summary: Type.Optional(Type.String({ description: "一句话收线纪要（写入档案）" })),
		}),
		namespace: { name: "swarm", description: "Swarm 多智能体协调" },
		execute: async (_id, params) => {
			const run = requireRun();
			run.status = "done";
			persistRoster(run);
			if (params.summary) {
				await writePost(run.postsDir, { seq: 0, from: "hub", to: "all", type: "note", round: 0, refs: [] }, `收线纪要：${params.summary}`);
			}
			if (lastCtx?.mode === "tui") lastCtx.ui.setWidget("swarm", undefined);
			return toolResult(`Swarm ${run.runId} 已收线（done）。worktree 清理：/swarm cleanup。`, { runId: run.runId });
		},
	});

	// ── 生命周期：恢复 + 清理 ──
	pi.on("session_start", () => {
		if (!currentRun) currentRun = loadRoster(process.cwd());
		lastHubSeq = currentRun ? maxSeqOf(readAllPosts(currentRun.postsDir)) : 0;
	});

	pi.on("agent_end", async (ctx) => {
		lastCtx = ctx;
		const run = currentRun;
		if (!run || run.status !== "active") return;
		try {
			// 刷新成员状态缓存
			const r = await herdr.agentList();
			const agents: any[] = r.result?.agents ?? [];
			for (const a of agents) {
				const m = run.members.get(a.name);
				if (m) m.agentStatus = a.agent_status;
			}
			// 读板：决定唤醒谁、要不要叫醒协调员自己
			const plan = planWakes(readAllPosts(run.postsDir), run.members, run.status, lastHubSeq);
			lastHubSeq = plan.maxSeq;
			for (const w of plan.wakes) {
				herdr
					.agentPrompt(w.member, `消息板有新帖 #${w.seq} 发给你，调用 board_read 查看并处理。`)
					.catch(() => {
						/* 唤醒失败留待下次轮询；不盲目重发 */
					});
			}
			if (plan.hubNotify) {
				pi.sendUserMessage(
					`Swarm 消息板有发给你（hub）的新帖（最新 #${plan.maxSeq}）。`
					+ "调用 swarm_read 查看，决定下一步：继续等待、催促、还是收线汇总。",
					{ deliverAs: "nextTurn" },
				);
			}
			persistRoster(run);
		} catch {
			/* 状态刷新失败不打扰主流程 */
		}
		updateWidget(ctx);
	});

	// Alt+S：只读看板（仅 TUI 模式有效；RPC/print 下 handler 直接 return）
	pi.registerShortcut(Key.alt("s"), {
		description: "Swarm 看板（只读）",
		handler: (ctx) => openBoardOverlay(ctx),
	});

	pi.on("session_shutdown", () => {
		// 幂等：不强杀 worker（用户可能还要看 pane），只解绑会话级状态
		currentRun = undefined;
		lastCtx?.ui.setWidget("swarm", undefined);
	});
}

let lastHubSeq = 0;
let lastCtx: ExtensionContext | undefined;

function maxSeqOf(posts: Post[]): number {
	return posts.reduce((m, p) => Math.max(m, p.meta.seq), 0);
}
