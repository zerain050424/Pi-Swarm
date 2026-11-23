/**
 * herdr.ts — herdr CLI 的薄封装（Swarm 扩展用）。
 *
 * 设计约束（来自 herdr skill 与 Design.md §8）：
 * - 所有 ID 从 JSON 响应里读，不猜。
 * - exit 1 = server 错误，exit 2 = 语法错误，统一归一为 HerdrError。
 * - wait/prompt 的超时由 herdr 自己的 --timeout 管，不在 exec 层再兜底。
 * - exec 可注入：单元测试用 fake exec，不发真实进程。
 */

// ───────────────────────────── 类型 ─────────────────────────────

export type HerdrExec = (
	file: string,
	args: string[],
	opts?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export class HerdrError extends Error {
	/** server：herdr 报告的运行期错误；syntax：命令用法错误 */
	kind: "server" | "syntax";
	/** stderr JSON 里的 error 字段（如 pane_not_found），可能为空 */
	code?: string;
	/** 原始 stderr，供上层展示 */
	rawStderr?: string;

	constructor(kind: "server" | "syntax", message: string, opts?: { code?: string; rawStderr?: string }) {
		super(message);
		this.name = "HerdrError";
		this.kind = kind;
		this.code = opts?.code;
		this.rawStderr = opts?.rawStderr;
	}
}

/** herdr 响应的统一包装：JSON 时给 result，纯文本时给 text。 */
export interface HerdrResult {
	id?: string;
	result?: Record<string, any>;
	text?: string;
}

export interface PaneInfo {
	pane_id: string;
	tab_id?: string;
	workspace_id?: string;
	agent?: string;
	agent_status?: string;
	cwd?: string;
	[key: string]: any;
}

// ───────────────────────────── 默认 exec ─────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const defaultExec: HerdrExec = async (file, args, opts) => {
	try {
		const { stdout, stderr } = await execFileP(file, args, {
			maxBuffer: 16 * 1024 * 1024,
			signal: opts?.signal,
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: typeof err.stdout === "string" ? err.stdout : "",
			stderr: typeof err.stderr === "string" ? err.stderr : String(err?.message ?? err),
			exitCode: typeof err.code === "number" ? err.code : 1,
		};
	}
};

// ───────────────────────────── 封装层 ─────────────────────────────

function parseResponse(stdout: string): HerdrResult {
	const trimmed = stdout.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object") {
			return { id: parsed.id, result: parsed.result ?? parsed };
		}
		return { text: trimmed };
	} catch {
		return { text: trimmed };
	}
}

export interface HerdrClientOptions {
	bin?: string;
	exec?: HerdrExec;
}

export interface PaneSplitOptions {
	current?: boolean;
	paneId?: string;
	direction: "right" | "down";
	cwd?: string;
	env?: Record<string, string>;
	/** 默认 true：后台 worker 不抢用户焦点 */
	noFocus?: boolean;
	ratio?: number;
}

export function createHerdr(opts: HerdrClientOptions = {}) {
	const bin = opts.bin ?? "herdr";
	const exec = opts.exec ?? defaultExec;

	async function run(
		args: string[],
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<HerdrResult> {
		const { stdout, stderr, exitCode } = await exec(bin, args, opts);
		if (exitCode !== 0) {
			// herdr 的错误 JSON 大多数版本在 stderr，但部分版本发到 stdout：两边都试
			let kind: "server" | "syntax" = exitCode === 2 ? "syntax" : "server";
			let message = "";
			let code: string | undefined;
			for (const raw of [stderr, stdout]) {
				const t = raw.trim();
				if (!t || message) continue;
				try {
					const j = JSON.parse(t);
					const e = j?.error;
					if (typeof e === "string") code = e;
					else if (e && typeof e === "object") {
						code = e.code;
						message = e.message ?? "";
					}
					if (!message && typeof j?.message === "string") message = j.message;
				} catch {
					/* 不是 JSON，下一个 */
				}
			}
			if (!message) message = (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
			throw new HerdrError(kind, message || `herdr exited with code ${exitCode}`, {
				code,
				rawStderr: stderr,
			});
		}
		return parseResponse(stdout);
	}

	return {
		/** 开旁栏 pane。返回新 pane 信息（含 pane_id）。 */
		async paneSplit(o: PaneSplitOptions): Promise<PaneInfo> {
			const args = ["pane", "split"];
			if (o.current) args.push("--current");
			if (o.paneId) args.push("--pane", o.paneId);
			args.push("--direction", o.direction);
			if (o.cwd) args.push("--cwd", o.cwd);
			for (const [k, v] of Object.entries(o.env ?? {})) args.push("--env", `${k}=${v}`);
			if (o.ratio !== undefined) args.push("--ratio", String(o.ratio));
			if (o.noFocus !== false) args.push("--no-focus");
			const r = await run(args);
			return r.result?.pane ?? r.result ?? {};
		},

		/** 在 pane 的 shell 里跑普通命令（如 export、git status）。 */
		async paneRun(paneId: string, command: string): Promise<HerdrResult> {
			return run(["pane", "run", paneId, command]);
		},

		async paneClose(paneId: string): Promise<HerdrResult> {
			return run(["pane", "close", paneId]);
		},

		async paneList(workspaceId?: string): Promise<HerdrResult> {
			const args = ["pane", "list"];
			if (workspaceId) args.push("--workspace", workspaceId);
			return run(args);
		},

		/** 在干净 shell pane 里启动 agent。args 透传给 agent 二进制（-- 之后）。 */
		async agentStart(
			name: string,
			kind: string,
			paneId: string,
			agentArgs: string[] = [],
			startTimeoutMs = 30_000,
		): Promise<HerdrResult> {
			const args = [
				"agent", "start", name, "--kind", kind, "--pane", paneId,
				"--timeout", String(startTimeoutMs),
			];
			if (agentArgs.length > 0) args.push("--", ...agentArgs);
			const r = await run(args);
			return r.result?.agent ?? r;
		},

		/** 等待 agent 到达指定状态。timeout 由 herdr --timeout 承担。 */
		async agentWait(
			target: string,
			o: { until?: "idle" | "working" | "blocked" | "done" | "unknown"; timeoutMs?: number; signal?: AbortSignal } = {},
		): Promise<HerdrResult> {
			const args = ["agent", "wait", target];
			if (o.until) args.push("--until", o.until);
			if (o.timeoutMs) args.push("--timeout", String(o.timeoutMs));
			const r = await run(args, { signal: o.signal });
			return r.result?.agent ?? r;
		},

		/** 发提示。wait=true 时等首个 settled 状态；超时/stalled 后上层不得盲目重发。 */
		async agentPrompt(
			target: string,
			text: string,
			o: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
		): Promise<HerdrResult> {
			const args = ["agent", "prompt", target, text];
			if (o.wait) args.push("--wait");
			if (o.timeoutMs) args.push("--timeout", String(o.timeoutMs));
			return run(args, { signal: o.signal });
		},

		/** 在 pane 输出里等某个字样出现（如 spawn env 的 ready marker）。 */
		async paneWaitOutput(
			paneId: string,
			o: { match?: string; regex?: string; timeoutMs?: number; signal?: AbortSignal } = {},
		): Promise<HerdrResult> {
			const args = ["pane", "wait-output", paneId];
			if (o.match) args.push("--match", o.match);
			if (o.regex) args.push("--regex", o.regex);
			if (o.timeoutMs) args.push("--timeout", String(o.timeoutMs));
			return run(args, { signal: o.signal });
		},

		async agentGet(target: string): Promise<HerdrResult> {
			return run(["agent", "get", target]);
		},

		async agentList(): Promise<HerdrResult> {
			return run(["agent", "list"]);
		},

		async agentRead(
			target: string,
			o: { source?: "visible" | "recent" | "recent-unwrapped" | "detection"; lines?: number } = {},
		): Promise<HerdrResult> {
			const args = ["agent", "read", target];
			args.push("--source", o.source ?? "recent-unwrapped");
			if (o.lines) args.push("--lines", String(o.lines));
			return run(args);
		},

		async agentSendKeys(target: string, ...keys: string[]): Promise<HerdrResult> {
			return run(["agent", "send-keys", target, ...keys]);
		},

		/** 建 git worktree。返回 result（含 workspace / tab / root_pane 等，具体看 herdr 版本）。 */
		async worktreeCreate(o: {
			cwd?: string;
			workspaceId?: string;
			branch?: string;
			path?: string;
			label?: string;
			noFocus?: boolean;
		}): Promise<HerdrResult> {
			const args = ["worktree", "create"];
			if (o.workspaceId) args.push("--workspace", o.workspaceId);
			if (o.cwd && !o.workspaceId) args.push("--cwd", o.cwd);
			if (o.branch) args.push("--branch", o.branch);
			if (o.path) args.push("--path", o.path);
			if (o.label) args.push("--label", o.label);
			if (o.noFocus !== false) args.push("--no-focus");
			const r = await run(args);
			return r.result ?? r;
		},

		async worktreeRemove(workspaceId: string, force = false): Promise<HerdrResult> {
			const args = ["worktree", "remove", "--workspace", workspaceId];
			if (force) args.push("--force");
			return run(args);
		},

		/** 创建独立 tab（默认 --no-focus，不抢用户焦点）。返回 tabId 与初始 rootPaneId。 */
		async tabCreate(o: {
			workspaceId?: string;
			cwd?: string;
			label?: string;
			env?: Record<string, string>;
			noFocus?: boolean;
		} = {}): Promise<{ tabId?: string; rootPaneId?: string; raw: unknown }> {
			const args = ["tab", "create"];
			if (o.workspaceId) args.push("--workspace", o.workspaceId);
			if (o.cwd) args.push("--cwd", o.cwd);
			if (o.label) args.push("--label", o.label);
			for (const [k, v] of Object.entries(o.env ?? {})) args.push("--env", `${k}=${v}`);
			if (o.noFocus !== false) args.push("--no-focus");
			const r = await run(args);
			const res = r.result ?? {};
			const tab = res.tab ?? res;
			const tabId: string | undefined = tab?.tab_id ?? res.tab_id;
			const rootPaneId: string | undefined =
				res.pane?.pane_id ?? res.root_pane_id ?? tab?.root_pane_id ?? tab?.active_pane_id;
			return { tabId, rootPaneId, raw: res };
		},

		async tabGet(tabId: string): Promise<HerdrResult> {
			return run(["tab", "get", tabId]);
		},

		async tabFocus(tabId: string): Promise<HerdrResult> {
			return run(["tab", "focus", tabId]);
		},

		async tabClose(tabId: string): Promise<HerdrResult> {
			return run(["tab", "close", tabId]);
		},
	};
}

export type Herdr = ReturnType<typeof createHerdr>;
