/**
 * Swarm 扩展单元测试。
 *
 * 覆盖范围（按 PLAN.md）：
 *   1.5  herdr.ts 参数拼装与错误归一（注入 fake exec，不发真实进程）
 *   2.1  board.ts frontmatter 解析/序列化、seq 分配与撞号、过滤
 *   3.x  plan/roster 校验、熔断计数、唤醒目标选择
 *
 * 运行：node --test <本文件>（Node 24 原生 type-stripping，零依赖）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ────────────────────────── 1.5 herdr.ts ──────────────────────────

import {
	HerdrError,
	type HerdrExec,
	type HerdrResult,
	createHerdr,
} from "./herdr.ts";

/** 记录调用并返回脚本化响应的 fake exec。 */
function fakeExec(
	script: Array<{ stdout?: string; stderr?: string; exitCode?: number }>,
) {
	const calls: Array<{ file: string; args: string[]; timeoutMs?: number }> = [];
	const exec: HerdrExec = async (file, args, opts) => {
		const i = calls.length;
		calls.push({ file, args, timeoutMs: opts?.timeoutMs });
		const s = script[Math.min(i, script.length - 1)] ?? {};
		return { stdout: s.stdout ?? "{}", stderr: s.stderr ?? "", exitCode: s.exitCode ?? 0 };
	};
	return { calls, exec };
}

const ok = (result: unknown): string => JSON.stringify({ id: "cli:test", result });

describe("herdr.ts — 参数拼装", () => {
	it("paneSplit：current + 方向 + cwd + no-focus + env", async () => {
		const { calls, exec } = fakeExec([
			{ stdout: ok({ pane: { pane_id: "w1:p2", tab_id: "w1:t1" } }) },
		]);
		const h = createHerdr({ exec });
		const pane = await h.paneSplit({
			current: true,
			direction: "right",
			cwd: "/repo",
			env: { PI_SWARM_NAME: "fix-1", PI_SWARM_RUN: "r1" },
		});
		assert.equal(pane.pane_id, "w1:p2");
		assert.equal(calls[0].file, "herdr");
		assert.deepEqual(calls[0].args, [
			"pane", "split", "--current",
			"--direction", "right",
			"--cwd", "/repo",
			"--env", "PI_SWARM_NAME=fix-1",
			"--env", "PI_SWARM_RUN=r1",
			"--no-focus",
		]);
	});

	it("agentStart：kind pi + 透传 args（-- 之后）", async () => {
		const { calls, exec } = fakeExec([{ stdout: ok({ agent: { name: "fix-1" } }) }]);
		const h = createHerdr({ exec });
		await h.agentStart("fix-1", "pi", "w1:p2", ["--no-extensions", "-e", "/x/worker.ts"]);
		assert.deepEqual(calls[0].args, [
			"agent", "start", "fix-1", "--kind", "pi", "--pane", "w1:p2",
			"--timeout", "30000",
			"--", "--no-extensions", "-e", "/x/worker.ts",
		]);
	});

	it("agentWait：until idle + timeout 透传给 herdr 而非 exec", async () => {
		const { calls, exec } = fakeExec([
			{ stdout: ok({ agent: { name: "fix-1", agent_status: "idle" } }) },
		]);
		const h = createHerdr({ exec });
		const r = await h.agentWait("fix-1", { until: "idle", timeoutMs: 120000 });
		assert.equal(r.agent_status, "idle");
		assert.deepEqual(calls[0].args, [
			"agent", "wait", "fix-1", "--until", "idle", "--timeout", "120000",
		]);
		assert.equal(calls[0].timeoutMs, undefined, "超时由 herdr 自管，不设 exec 层兜底超时");
	});

	it("agentPrompt：--wait + timeout", async () => {
		const { calls, exec } = fakeExec([{ stdout: ok({}) }]);
		const h = createHerdr({ exec });
		await h.agentPrompt("fix-1", "你有新提及", { wait: true, timeoutMs: 60000 });
		assert.deepEqual(calls[0].args, [
			"agent", "prompt", "fix-1", "你有新提及", "--wait", "--timeout", "60000",
		]);
	});

	it("agentList / agentRead / worktreeCreate 拼装", async () => {
		const { calls, exec } = fakeExec([{ stdout: ok({ agents: [] }) }, { stdout: ok({}) }, { stdout: ok({ workspace: { workspace_id: "w9" }, path: "/wt" }) }]);
		const h = createHerdr({ exec });
		await h.agentList();
		await h.agentRead("fix-1", { lines: 120 });
		const wt = await h.worktreeCreate({ cwd: "/repo", branch: "swarm-r1-fix-1" });
		assert.deepEqual(calls[0].args, ["agent", "list"]);
		assert.deepEqual(calls[1].args, [
			"agent", "read", "fix-1", "--source", "recent-unwrapped", "--lines", "120",
		]);
		assert.deepEqual(calls[2].args, [
			"worktree", "create", "--cwd", "/repo", "--branch", "swarm-r1-fix-1", "--no-focus",
		]);
		assert.equal(wt.workspace.workspace_id, "w9");
	});
});

const { initRun, persistRoster, loadRoster } = await import("./shared.ts");
const fsp = await import("node:fs/promises");
const os = await import("node:os");
const pathMod = await import("node:path");

describe("index.ts — run 状态与恢复", () => {
	it("persistRoster 写入 status；loadRoster 只接管 active 的 run", async () => {
		const tmp = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "swarm-test-"));
		const run = initRun(tmp, "任务A");
		assert.equal(run.status, "active");
		run.status = "aborted";
		persistRoster(run);
		assert.equal(loadRoster(tmp), undefined, "非 active 的 run 不被接管");

		await new Promise((r) => setTimeout(r, 20)); // 避开同毫秒创建两个 run 的 mtime 平手
		const run2 = initRun(tmp, "任务B");
		run2.members.set("fix-1", { name: "fix-1", agentName: "fix-1", role: "worker", paneId: "w1:p9" });
		persistRoster(run2);
		const loaded = loadRoster(tmp);
		assert.ok(loaded, "active run 被接管");
		assert.equal(loaded!.runId, run2.runId);
		assert.equal(loaded!.members.get("fix-1")?.paneId, "w1:p9");
		await fsp.rm(tmp, { recursive: true, force: true });
	});
});

describe("index.ts — spawnMember 竞态重试", () => {
	it("agent start 撞 agent_pane_busy 时重试，第二次成功", async () => {
		const calls: string[][] = [];
		let startCalls = 0;
		const h = {
			paneSplit: async (_o: any) => ({ pane_id: "w1:p2" }),
			agentStart: async (..._a: any[]) => {
				startCalls++;
				if (startCalls === 1) {
					throw new HerdrError("server", "agent target pane is not an available shell", { code: "agent_pane_busy" });
				}
				return {};
			},
			paneClose: async () => ({}),
			agentPrompt: async () => ({}),
			agentWait: async () => ({ agent_status: "idle" }),
		} as any;
		const run = {
			runId: "r1", dir: "/tmp", postsDir: "/tmp/posts", task: "t", members: new Map(),
		} as any;
		const member = { name: "fix-1", agentName: "fix-1", role: "worker" } as any;
		const { spawnMember } = await import("./index.ts");
		// 把重试间隔压到 0，测试不真等待
		const origSleep = (globalThis as any).__swarmSleep;
		(globalThis as any).__swarmSleep = async () => {};
		try {
			const res = await spawnMember(h, member, run, "/repo", { workerExtensionPath: "/x/worker.ts" });
			assert.equal(res.member.paneId, "w1:p2");
			assert.equal(startCalls, 2, "撞到 busy 后重试了一次");
			assert.equal(run.members.get("fix-1")?.paneId, "w1:p2");
		} finally {
			(globalThis as any).__swarmSleep = origSleep;
		}
	});

	it("非瞬态错误不重试，直接回滚并抛出", async () => {
		let closeCalls = 0;
		const h = {
			paneSplit: async () => ({ pane_id: "w1:p2" }),
			agentStart: async () => {
				throw new HerdrError("server", "quota exceeded", { code: "quota_exceeded" });
			},
			paneClose: async () => { closeCalls++; return {}; },
			agentPrompt: async () => ({}),
			agentWait: async () => ({ agent_status: "idle" }),
		} as any;
		const run = { runId: "r1", dir: "/tmp", postsDir: "/tmp/posts", task: "t", members: new Map() } as any;
		const member = { name: "fix-1", agentName: "fix-1", role: "worker" } as any;
		const { spawnMember } = await import("./index.ts");
		(globalThis as any).__swarmSleep = async () => {};
		try {
			await assert.rejects(() => spawnMember(h, member, run, "/repo", { workerExtensionPath: "/x/worker.ts" }), /quota exceeded/);
			assert.equal(closeCalls, 1, "pane 已回收");
		} finally {
			(globalThis as any).__swarmSleep = undefined;
		}
	});
});

describe("herdr.ts — 错误归一", () => {
	it("exit 1 → server 错误，携带 stderr 里的 JSON message", async () => {
		const { exec } = fakeExec([{
			stderr: JSON.stringify({ error: "pane_not_found", message: "no such pane: w1:pX" }),
			exitCode: 1,
		}]);
		const h = createHerdr({ exec });
		await assert.rejects(
			() => h.agentGet("fix-1"),
			(err: unknown) => {
				assert.ok(err instanceof HerdrError);
				assert.equal((err as HerdrError).kind, "server");
				assert.match((err as HerdrError).message, /no such pane/);
				assert.equal((err as HerdrError).code, "pane_not_found");
				return true;
			},
		);
	});

	it("exit 2 → syntax 错误", async () => {
		const { exec } = fakeExec([{ stderr: "bad usage", exitCode: 2 }]);
		const h = createHerdr({ exec });
		await assert.rejects(() => h.agentList(), (err: unknown) => {
			assert.ok(err instanceof HerdrError);
			assert.equal((err as HerdrError).kind, "syntax");
			return true;
		});
	});

	it("错误 JSON 出现在 stdout 时也能解析出 message 与 code", async () => {
		const { exec } = fakeExec([{
			stdout: JSON.stringify({ error: "agent_pane_busy", message: "agent target pane w3:p0 is not an available shell" }),
			exitCode: 1,
		}]);
		const h = createHerdr({ exec });
		await assert.rejects(() => h.agentStart("fix-1", "pi", "w3:p0"), (err: unknown) => {
			assert.ok(err instanceof HerdrError);
			assert.equal((err as HerdrError).kind, "server");
			assert.equal((err as HerdrError).code, "agent_pane_busy");
			assert.match((err as HerdrError).message, /not an available shell/);
			return true;
		});
	});

	it("非 JSON stdout → 原样包成 text 结果而不是崩溃", async () => {
		const { exec } = fakeExec([{ stdout: "plain text output" }]);
		const h = createHerdr({ exec });
		const r: HerdrResult = await h.agentList();
		assert.equal(r.text, "plain text output");
		assert.deepEqual(r.json, undefined);
	});
});

// ────────────────────────── 2.1 board.ts ──────────────────────────

import {
	filterPosts,
	type PostMeta,
	nextSeq,
	parseFrontmatter,
	postFileName,
	serializePost,
} from "./board.ts";

describe("board.ts — frontmatter 解析/序列化", () => {
	it("serialize → parse 往返无损", () => {
		const meta: PostMeta = {
			seq: 7,
			from: "fix-1",
			to: "verifier",
			type: "issue",
			round: 2,
			refs: ["0003"],
		};
		const body = "@fix-2 你那边的人口参数也改一下。";
		const text = serializePost(meta, body);
		const parsed = parseFrontmatter(text);
		assert.ok(parsed.meta);
		assert.deepEqual(parsed.meta, meta);
		assert.equal(parsed.body, body);
	});

	it("非法 frontmatter → meta 为 null，正文原样保留", () => {
		const text = "---\nseq: 不是数字\n---\n正文";
		const parsed = parseFrontmatter(text);
		assert.equal(parsed.meta, null);
		assert.equal(parsed.body, "正文");
	});

	it("缺省字段容错：round 缺省 0，refs 缺省空", () => {
		const parsed = parseFrontmatter("---\nseq: 1\nfrom: hub\nto: all\ntype: note\n---\nhi");
		assert.ok(parsed.meta);
		assert.equal(parsed.meta!.round, 0);
		assert.deepEqual(parsed.meta!.refs, []);
	});

	it("无 frontmatter 的裸文本 → meta null", () => {
		const parsed = parseFrontmatter("就是一段话");
		assert.equal(parsed.meta, null);
		assert.equal(parsed.body, "就是一段话");
	});
});

describe("board.ts — 文件名与序号", () => {
	it("postFileName：四位序号 + agent 名 + 类型", () => {
		assert.equal(postFileName(7, "fix-1", "done"), "0007-fix-1-done.md");
	});

	it("nextSeq：取目录现有最大序号 +1；空目录从 1 开始", () => {
		assert.equal(nextSeq([]), 1);
		assert.equal(
			nextSeq(["0001-hub-note.md", "0007-fix-1-done.md", "roster.json"]),
			8,
		);
		assert.equal(nextSeq(["随便.txt"]), 1, "无序号文件不影响");
	});

	it("nextSeq：序号不连续时仍取最大", () => {
		assert.equal(nextSeq(["0002-a-done.md", "0010-b-issue.md"]), 11);
	});
});

describe("board.ts — 过滤", () => {
	const mk = (seq: number, from: string, to: string, type: PostMeta["type"]): { meta: PostMeta; body: string } => ({
		meta: { seq, from, to, type, round: 0, refs: [] },
		body: `post ${seq}`,
	});

	it("按 to/from/type 过滤", () => {
		const posts = [
			mk(1, "hub", "all", "note"),
			mk(2, "fix-1", "verifier", "done"),
			mk(3, "verifier", "fix-1", "issue"),
		];
		assert.deepEqual(filterPosts(posts, { to: "verifier" }).map((p) => p.meta.seq), [1, 2]);
		assert.deepEqual(filterPosts(posts, { to: "fix-1" }).map((p) => p.meta.seq), [1, 3]);
		assert.deepEqual(filterPosts(posts, { type: "done" }).map((p) => p.meta.seq), [2]);
		assert.deepEqual(filterPosts(posts, { from: "hub" }).map((p) => p.meta.seq), [1]);
		// to: all 匹配任何人
		const hubOnly = filterPosts(posts, { to: "hub" }).map((p) => p.meta.seq);
		assert.deepEqual(hubOnly, [1], "发往 all 的帖对任何读者可见");
	});
});

// ────────────────────────── 2.2 worker.ts ──────────────────────────

import { writePost } from "./board.ts";
import { checkDeliverable } from "./worker.ts";

describe("worker.ts — writePost 落盘", () => {
	it("序号自增、文件名正确、frontmatter 可读回", async () => {
		const fsp = await import("node:fs/promises");
		const os = await import("node:os");
		const pathMod = await import("node:path");
		const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "swarm-wp-"));
		const seq1 = await writePost(dir, { seq: 0, from: "hub", to: "all", type: "note", round: 0, refs: [] }, "第一帖");
		assert.equal(seq1, 1);
		const seq2 = await writePost(dir, { seq: 0, from: "fix-1", to: "verifier", type: "done", round: 0, refs: ["0001"] }, "完成");
		assert.equal(seq2, 2);
		const files = (await fsp.readdir(dir)).sort();
		assert.deepEqual(files, ["0001-hub-note.md", "0002-fix-1-done.md"]);
		const raw = await fsp.readFile(pathMod.join(dir, files[1]), "utf8");
		const parsed = parseFrontmatter(raw);
		assert.equal(parsed.meta!.type, "done");
		await fsp.rm(dir, { recursive: true, force: true });
	});
});

describe("worker.ts — report_done 的交付物校验", () => {
	it("未提交的改动 → 拒绝并提示先 commit", () => {
		const r = checkDeliverable({ head: "abc1234", dirty: 2, provided: "abc1234" });
		assert.match(r ?? "", /commit/);
	});
	it("provided 与 HEAD 不一致 → 拒绝", () => {
		const r = checkDeliverable({ head: "abc1234", dirty: 0, provided: "dead999" });
		assert.match(r ?? "", /HEAD/);
	});
	it("dirty=0 且 hash 匹配（缩写可）→ 通过", () => {
		assert.equal(checkDeliverable({ head: "abc1234def", dirty: 0, provided: "abc1234" }), null);
		assert.equal(checkDeliverable({ head: "abc1234def", dirty: 0, provided: "abc1234def" }), null);
	});
});

// ────────────────────────── 2.4 唤醒路由 ──────────────────────────

import { planWakes } from "./index.ts";

const mkPost = (seq: number, from: string, to: string, type: PostMeta["type"], round = 0) => ({
	meta: { seq, from, to, type, round, refs: [] },
	body: `p${seq}`,
});
const mkMember = (name: string, agentStatus: string, acked = 0) => ({
	name, agentName: name, role: "worker" as const, agentStatus, acked,
});

describe("index.ts — planWakes 唤醒路由", () => {
	it("发往 idle 成员的新帖 → 唤醒并推进 acked", () => {
		const posts = [mkPost(3, "verifier", "fix-1", "issue", 1), mkPost(1, "hub", "all", "note")];
		const members = new Map([["fix-1", mkMember("fix-1", "idle", 2)]]);
		const plan = planWakes(posts, members, "active", 0);
		assert.deepEqual(plan.wakes, [{ member: "fix-1", seq: 3 }]);
	});

	it("成员不在/忙/已 ack → 不唤醒", () => {
		const posts = [
			mkPost(4, "verifier", "fix-1", "issue", 1),
			mkPost(5, "verifier", "fix-2", "issue", 1),
			mkPost(6, "verifier", "fix-3", "issue", 1),
		];
		const members = new Map([
			["fix-1", mkMember("fix-1", "working", 3)],   // 在忙
			["fix-3", mkMember("fix-3", "idle", 6)],      // 已 ack 过
			// fix-2 不在 roster（已收线移除）
		]);
		const plan = planWakes(posts, members, "active", 0);
		assert.deepEqual(plan.wakes, []);
	});

	it("发往 hub 的帖 → 触发协调员通知（新于 lastHubSeq 才通知）", () => {
		const posts = [mkPost(7, "fix-1", "hub", "done")];
		const members = new Map([["fix-1", mkMember("fix-1", "idle", 7)]]);
		const plan = planWakes(posts, members, "active", 5);
		assert.equal(plan.hubNotify, true);
		assert.equal(plan.maxSeq, 7);
		const plan2 = planWakes(posts, members, "active", 7);
		assert.equal(plan2.hubNotify, false, "已通知过的不重复触发");
	});

	it("run 非 active → 不产生任何动作", () => {
		const posts = [mkPost(9, "x", "fix-1", "issue"), mkPost(10, "x", "hub", "done")];
		const members = new Map([["fix-1", mkMember("fix-1", "idle", 0)]]);
		const plan = planWakes(posts, members, "aborted", 0);
		assert.deepEqual(plan.wakes, []);
		assert.equal(plan.hubNotify, false);
	});
});

// ────────────────────────── 3.x 阶段三 ──────────────────────────

import { buildExportEnv } from "./index.ts";

describe("3.x — planWakes 熔断", () => {
	it("issue 帖 round 超上限 → 不唤醒 worker，改为通知 hub", () => {
		const posts = [mkPost(11, "verifier", "fix-1", "issue", 3)];
		const members = new Map([["fix-1", mkMember("fix-1", "idle", 10)]]);
		const plan = planWakes(posts, members, "active", 10, 2);
		assert.deepEqual(plan.wakes, []);
		assert.equal(plan.hubNotify, true);
		assert.deepEqual(plan.circuit, { to: "fix-1", round: 3 });
	});

	it("round 未超限 → 正常唤醒；不带 round 的帖不受熔断影响", () => {
		const posts = [mkPost(12, "verifier", "fix-1", "issue", 2), mkPost(13, "hub", "fix-1", "note")];
		const members = new Map([["fix-1", mkMember("fix-1", "idle", 10)]]);
		const plan = planWakes(posts, members, "active", 10, 2);
		assert.deepEqual(plan.wakes, [{ member: "fix-1", seq: 12 }, { member: "fix-1", seq: 13 }]);
		assert.equal(plan.circuit, undefined);
	});
});

describe("3.x — buildExportEnv", () => {
	it("单引号包裹，值内单引号转义", () => {
		const line = buildExportEnv({ A: "x", B: "it's", C: "/tmp/a b" });
		assert.equal(line, "export A='x' B='it'\\''s' C='/tmp/a b'");
	});
});

describe("3.x — spawnTeam 全量回滚", () => {
	it("第二个成员失败 → 逆序回收两个成员的 pane 与 worktree，run 置 aborted", async () => {
		const { spawnTeam } = await import("./index.ts");
		const events: string[] = [];
		let startCount = 0;
		const h = {
			paneSplit: async () => { events.push("split"); return { pane_id: `p${events.length}` }; },
			agentStart: async () => {
				startCount++;
				if (startCount === 2) throw new HerdrError("server", "quota exceeded", { code: "quota_exceeded" });
				return {};
			},
			agentSendKeys: async () => {},
			agentWait: async () => ({ agent_status: "idle" }),
			agentPrompt: async () => ({}),
			paneClose: async (id: string) => { events.push(`close:${id}`); return {}; },
		} as any;
		const gitRun = async (_cwd: string, args: string[]) => {
			if (args[0] === "worktree") events.push(args[1] === "add" ? "wt-create" : "wt-remove");
			return "";
		};
		const fspT = await import("node:fs/promises");
		const osT = await import("node:os");
		const pathT = await import("node:path");
		const tmpDir = await fspT.mkdtemp(pathT.join(osT.tmpdir(), "swarm-team-"));
		const run = initRun(tmpDir, "task");
		const members: any[] = [
			{ name: "fix-1", agentName: "fix-1", role: "worker" },
			{ name: "fix-2", agentName: "fix-2", role: "worker" },
		];
		await assert.rejects(
			() => spawnTeam(h, run, members, "/repo", { workerExtensionPath: "/x/worker.ts", gitRun }),
			/quota exceeded/,
		);
		assert.equal(run.status, "aborted");
		assert.equal(events.filter((e) => e === "wt-create").length, 2, "两个 worker 各建一个 worktree");
		assert.equal(events.filter((e) => e === "wt-remove").length, 2, "两个 worktree 都被回收");
		assert.equal(events.filter((e) => e.startsWith("close:")).length, 2, "两个 pane 都被回收");
		const firstWtRemove = events.findIndex((e) => e.startsWith("wt-remove"));
		assert.ok(firstWtRemove > events.lastIndexOf("wt-create"), "worktree 回收发生在全部创建之后");
		await fspT.rm(tmpDir, { recursive: true, force: true });
	});
});

import { precheckRepo } from "./index.ts";

describe("3.x — precheckRepo", () => {
	it("git 仓库：isGit=true，dirty 数正确", async () => {
		const fsp = await import("node:fs/promises");
		const os = await import("node:os");
		const pathMod = await import("node:path");
		const { execFileSync } = await import("node:child_process");
		const { writeFileSync } = await import("node:fs");
		const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "swarm-git-"));
		const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		g(["init", "-q"]);
		g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
		writeFileSync(pathMod.join(dir, "a.txt"), "hi");
		const clean = precheckRepo(dir);
		assert.equal(clean.isGit, true);
		assert.ok(clean.dirty >= 1, "未提交的 a.txt 计入 dirty");
		g(["add", "-A"]);
		g(["commit", "-qm", "init"]);
		const now = precheckRepo(dir);
		assert.equal(now.dirty, 0);
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("非 git 目录：isGit=false", () => {
		const r = precheckRepo("/tmp");
		assert.equal(r.isGit, false);
	});
});

// ────────────────────────── P4 — 模型路由 ──────────────────────────

describe("P4 — 模型路由", () => {
	it("spawnMember：member.model 优先于 opts.model", async () => {
		const { spawnMember } = await import("./index.ts");
		const seen: string[] = [];
		const h = {
			paneSplit: async () => ({ pane_id: "w1:p2" }),
			agentStart: async (_n: string, _k: string, _p: string, agentArgs: string[]) => {
				const i = agentArgs.indexOf("--model");
				seen.push(i >= 0 ? agentArgs[i + 1] : "(none)");
				return {};
			},
			agentSendKeys: async () => {},
			agentWait: async () => ({}),
			agentPrompt: async () => ({}),
		} as any;
		const fspT = await import("node:fs/promises");
		const osT = await import("node:os");
		const pathT = await import("node:path");
		const tmp = await fspT.mkdtemp(pathT.join(osT.tmpdir(), "swarm-model-"));
		const run = initRun(tmp, "t");
		const m: any = { name: "fix-1", agentName: "fix-1", role: "worker", model: "cheap/fast" };
		await spawnMember(h, m, run, "/repo", { workerExtensionPath: "/x/worker.ts", model: "strong/model" });
		assert.deepEqual(seen, ["cheap/fast"], "成员自己的 model 优先");
		const m2: any = { name: "fix-2", agentName: "fix-2", role: "worker" };
		await spawnMember(h, m2, run, "/repo", { workerExtensionPath: "/x/worker.ts", model: "strong/model" });
		assert.deepEqual(seen, ["cheap/fast", "strong/model"], "未填则吃 opts.model");
		const m3: any = { name: "fix-3", agentName: "fix-3", role: "worker" };
		await spawnMember(h, m3, run, "/repo", { workerExtensionPath: "/x/worker.ts" });
		assert.deepEqual(seen, ["cheap/fast", "strong/model", "(none)"], "都没有则不传 --model（继承协调员模型）");
		await fspT.rm(tmp, { recursive: true, force: true });
	});

	it("spawnTeam：worktree 路径下每成员各用各的 model", async () => {
		const { spawnTeam } = await import("./index.ts");
		const modelsSeen: Record<string, string> = {};
		let n = 0;
		const h = {
			paneSplit: async () => ({ pane_id: `p${++n}` }),
			agentStart: async (name: string, _k: string, _p: string, agentArgs: string[]) => {
				const i = agentArgs.indexOf("--model");
				modelsSeen[name] = i >= 0 ? agentArgs[i + 1] : "(none)";
				return {};
			},
			agentSendKeys: async () => {},
			agentWait: async () => ({}),
			agentPrompt: async () => ({}),
			paneClose: async () => ({}),
		} as any;
		const gitRun = async () => "";
		const fspT = await import("node:fs/promises");
		const osT = await import("node:os");
		const pathT = await import("node:path");
		const tmp = await fspT.mkdtemp(pathT.join(osT.tmpdir(), "swarm-model-team-"));
		const run = initRun(tmp, "t");
		const members: any[] = [
			{ name: "fix-1", agentName: "fix-1", role: "worker", model: "cheap/fast" },
			{ name: "verify-1", agentName: "verify-1", role: "verifier", model: "strong/model" },
		];
		await spawnTeam(h, run, members, "/repo", { workerExtensionPath: "/x/worker.ts", gitRun });
		assert.equal(modelsSeen["fix-1"], "cheap/fast");
		assert.equal(modelsSeen["verify-1"], "strong/model");
		// verifier 不建 worktree（gitRun 只被 worker 触发）
		assert.ok(run.members.get("verify-1") && !run.members.get("verify-1")!.worktreePath);
		await fspT.rm(tmp, { recursive: true, force: true });
	});
});

// ────────────────────────── P4 — 渲染 ──────────────────────────

import { renderWidget, renderBoard } from "./index.ts";

describe("P4 — renderWidget", () => {
	it("单行：runId + 成员状态缩写 + 最新帖号", () => {
		const run: any = {
			runId: "run-x", task: "t", status: "active", dir: "/d", postsDir: "/d/posts",
			members: new Map([
				["fix-1", { name: "fix-1", agentName: "fix-1", role: "worker", agentStatus: "working" }],
				["verifier", { name: "verifier", agentName: "verifier", role: "verifier", agentStatus: "idle", round: 2 }],
			]),
		};
		const lines = renderWidget(run, 7);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /run-x/);
		assert.match(lines[0], /@fix-1.*忙/);
		assert.match(lines[0], /@verifier.*待.*r2/);
		assert.match(lines[0], /#7/);
	});

	it("超长时截断到 160 字符", () => {
		const run: any = {
			runId: "run-x", task: "t", status: "active", dir: "/d", postsDir: "/d/posts",
			members: new Map(Array.from({ length: 8 }, (_, i) => [
				`member-${i}`, { name: `member-${i}`, agentName: `member-${i}`, role: "worker", agentStatus: "working" },
			])),
		};
		const line = renderWidget(run, 1)[0];
		assert.ok(line.length <= 160 + 3, `实际 ${line.length}`);
	});
});

describe("P4 — renderBoard", () => {
	it("含标题、名册（状态/round/worktree）与帖子流", () => {
		const run: any = {
			runId: "run-y", task: "写两个模块", status: "active", dir: "/d", postsDir: "/d/posts",
			maxVerifyRounds: 2,
			members: new Map([
				["fix-1", { name: "fix-1", agentName: "fix-1", role: "worker", agentStatus: "done", worktreePath: "/wt/a", branch: "br-a", model: "cheap/fast" }],
				["verifier", { name: "verifier", agentName: "verifier", role: "verifier", agentStatus: "idle", round: 1 }],
			]),
		};
		const lines = renderBoard(run, [
			{ meta: { seq: 1, from: "hub", to: "all", type: "note", round: 0, refs: [] }, body: "分工总帖" },
			{ meta: { seq: 2, from: "fix-1", to: "hub", type: "done", round: 0, refs: [] }, body: "完成了" },
		]);
		const text = lines.join("\n");
		assert.match(text, /run-y/);
		assert.match(text, /@fix-1/);
		assert.match(text, /\/wt\/a/);
		assert.match(text, /cheap\/fast/);
		assert.match(text, /#1 \[note\] hub → all/);
		assert.match(text, /分工总帖/);
		assert.match(text, /#2 \[done\] fix-1 → hub/);
		assert.match(text, /q|esc/);
	});

	it("空板子也能渲染", () => {
		const run: any = {
			runId: "run-z", task: "t", status: "active", dir: "/d", postsDir: "/d/posts",
			members: new Map(),
		};
		const lines = renderBoard(run, []);
		assert.ok(lines.length >= 2, "标题 + 名册/提示");
	});
});

// ────────────────────────── P4 — cleanup ──────────────────────────

import { collectCleanupTargets, runCleanup } from "./index.ts";

describe("P4 — collectCleanupTargets", () => {
	it("只收 done/aborted 的 run；指定 runId 则只要那个", async () => {
		const fsp = await import("node:fs/promises");
		const os = await import("node:os");
		const pathMod = await import("node:path");
		const tmp = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "swarm-cln-"));
		const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
		const mk = (id: string, status: string, members: any[]) => {
			const dir = pathMod.join(tmp, ".pi", "swarm", id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(pathMod.join(dir, "roster.json"), JSON.stringify({ runId: id, status, members }));
			return dir;
		};
		mk("run-a", "done", [{ name: "w1", agentName: "w1", role: "worker", paneId: "w9:p1", worktreePath: "/wt/a", branch: "br-a" }]);
		mk("run-b", "aborted", [{ name: "w2", agentName: "w2", role: "worker", worktreePath: "/wt/b", branch: "br-b" }]);
		mk("run-c", "active", [{ name: "w3", agentName: "w3", role: "worker", paneId: "w9:p3" }]);

		const all = collectCleanupTargets(tmp);
		assert.deepEqual(all.map((t) => t.runId).sort(), ["run-a", "run-b"], "active 的 run 不进 cleanup");
		const t1 = all.find((t) => t.runId === "run-a")!;
		assert.deepEqual(t1.paneIds, ["w9:p1"]);
		assert.deepEqual(t1.worktrees, [{ path: "/wt/a", branch: "br-a" }]);

		const only = collectCleanupTargets(tmp, "run-b");
		assert.deepEqual(only.map((t) => t.runId), ["run-b"]);
		// 指定 active run → 空（要先 abort）
		assert.deepEqual(collectCleanupTargets(tmp, "run-c"), []);
		await fsp.rm(tmp, { recursive: true, force: true });
	});
});

describe("P4 — runCleanup", () => {
	it("关 pane → 删 worktree → 删分支；pane/worktree 不存在时吞错（幂等）", async () => {
		const events: string[] = [];
		const h = {
			paneClose: async (id: string) => {
				events.push(`close:${id}`);
				if (id === "gone") throw new HerdrError("server", "not found", { code: "pane_not_found" });
				return {};
			},
		} as any;
		const gitRun = async (_c: string, args: string[]) => {
			if (args[0] === "branch") {
				// 第二次删同分支 → 幂等：吞错
				if (events.filter((e) => e === `branch:${args[2]}`).length > 0) throw new Error("branch 不存在");
			}
			if (args[0] === "worktree") {
				// 第二次删同 worktree → 幂等：吞错
				if (events.filter((e) => e.startsWith("wt:")).length > 0) throw new Error("not a worktree");
			}
			events.push(args[0] === "worktree" ? `wt:${args[3]}` : `branch:${args[2]}`);
			return "";
		};
		const targets: any[] = [
			{ runId: "run-a", dir: "/d/a", paneIds: ["w9:p1"], worktrees: [{ path: "/wt/a", branch: "br-a" }] },
			{ runId: "run-b", dir: "/d/b", paneIds: ["gone"], worktrees: [{ path: "/wt/a", branch: "br-a" }] },
		];
		const acted = await runCleanup(h, "/repo", targets, gitRun);
		// 第一次：close w9:p1, wt /wt/a, branch br-a；第二次：close gone(吞), wt(吞), branch(吞)
		assert.ok(events.includes("close:w9:p1"));
		assert.ok(events.includes("wt:/wt/a"));
		assert.ok(events.includes("branch:br-a"));
		assert.ok(acted.length >= 3);
		// 再跑一遍：全部吞错，不抛
		await runCleanup(h, "/repo", targets, gitRun);
	});
});

// ────────────────────────── models.ts — 结构化模型配置与解析 ──────────────────────────

import * as fspM from "node:fs/promises";
import * as osM from "node:os";
import * as pathM from "node:path";
import {
	globalModelConfigPath,
	loadEffectiveModelConfig,
	loadModelConfigFile,
	mergeModelConfigs,
	parseModelTarget,
	parseSwarmTaskArgs,
	projectModelConfigPath,
	resetConfigTarget,
	resolveMemberModel,
	saveModelConfigFile,
	setConfigTarget,
	validateQualifiedModel,
} from "./models.ts";

describe("models.ts — 格式校验与目标解析", () => {
	it("validateQualifiedModel：接受 provider/model 与多层斜杠；拒绝裸模型名与空白", () => {
		assert.equal(validateQualifiedModel("  opencode-go/glm-5.3-flash  "), "opencode-go/glm-5.3-flash");
		assert.equal(validateQualifiedModel("openrouter/anthropic/claude-3.5-sonnet"), "openrouter/anthropic/claude-3.5-sonnet");
		assert.throws(() => validateQualifiedModel("glm-5"), /provider\/model/);
		assert.throws(() => validateQualifiedModel("/glm-5"), /provider\/model/);
		assert.throws(() => validateQualifiedModel("opencode-go/"), /provider\/model/);
		assert.throws(() => validateQualifiedModel("opencode-go/glm 5"), /provider\/model/);
		assert.throws(() => validateQualifiedModel("openrouter//claude"), /不能为空/);
	});

	it("parseModelTarget：支持 default / role / member:<name> / 成员名", () => {
		assert.deepEqual(parseModelTarget("default"), { kind: "default" });
		assert.deepEqual(parseModelTarget("worker"), { kind: "role", role: "worker" });
		assert.deepEqual(parseModelTarget("verifier"), { kind: "role", role: "verifier" });
		assert.deepEqual(parseModelTarget("member:fix-1"), { kind: "member", name: "fix-1" });
		assert.deepEqual(parseModelTarget("fix-1"), { kind: "member", name: "fix-1" });
		assert.throws(() => parseModelTarget("INVALID_NAME"), /无效目标/);
	});
});

describe("models.ts — 双层配置读写、合并与 set/reset", () => {
	it("全局 + 项目配置合并：项目按字段覆盖全局", async () => {
		const homeDir = await fspM.mkdtemp(pathM.join(osM.tmpdir(), "swarm-home-"));
		const cwd = await fspM.mkdtemp(pathM.join(osM.tmpdir(), "swarm-cwd-"));

		saveModelConfigFile(globalModelConfigPath(homeDir), {
			default: "global/default",
			roles: { worker: "global/worker", verifier: "global/verifier" },
			members: { "fix-1": "global/fix-1", "fix-2": "global/fix-2" },
		});
		saveModelConfigFile(projectModelConfigPath(cwd), {
			roles: { worker: "project/worker" },
			members: { "fix-1": "project/fix-1" },
		});

		const { effective } = loadEffectiveModelConfig(cwd, homeDir);
		assert.deepEqual(effective, {
			default: "global/default",
			roles: { worker: "project/worker", verifier: "global/verifier" },
			members: { "fix-1": "project/fix-1", "fix-2": "global/fix-2" },
		});
	});

	it("setConfigTarget / resetConfigTarget：正确增删并清理空对象", () => {
		let cfg = setConfigTarget({}, { kind: "role", role: "worker" }, "p/w");
		cfg = setConfigTarget(cfg, { kind: "member", name: "fix-1" }, "p/m");
		assert.deepEqual(cfg, { roles: { worker: "p/w" }, members: { "fix-1": "p/m" } });

		const r1 = resetConfigTarget(cfg, { kind: "member", name: "fix-1" });
		assert.equal(r1.removed, true);
		assert.deepEqual(r1.config, { roles: { worker: "p/w" } });

		const r2 = resetConfigTarget(r1.config, { kind: "role", role: "verifier" });
		assert.equal(r2.removed, false);
	});

	it("loadModelConfigFile：缺失返回空对象，损坏 JSON 抛明确错误", async () => {
		const dir = await fspM.mkdtemp(pathM.join(osM.tmpdir(), "swarm-badcfg-"));
		assert.deepEqual(loadModelConfigFile(pathM.join(dir, "missing.json")), {});
		const bad = pathM.join(dir, "bad.json");
		await fspM.writeFile(bad, "{bad json");
		assert.throws(() => loadModelConfigFile(bad), /解析失败/);
	});

	it("mergeModelConfigs：空配置合并返回空对象", () => {
		assert.deepEqual(mergeModelConfigs({}, {}), {});
	});
});

describe("models.ts — 5 级优先级与命令行解析", () => {
	it("resolveMemberModel：interactive > cli > config.members > config.roles > config.default > plan.model > undefined", () => {
		const config = {
			default: "cfg/default",
			roles: { worker: "cfg/worker", verifier: "cfg/verifier" },
			members: { "fix-1": "cfg/fix-1" },
		};
		const cliOverrides = { worker: "cli/worker", verifier: "cli/verifier" };

		// 1. interactive 最高
		assert.equal(
			resolveMemberModel({ name: "fix-1", role: "worker", model: "plan/m" }, { interactiveOverride: "ui/m", cliOverrides, config }),
			"ui/m",
		);
		// 1b. interactive 显式清除 ("") → 直接继承协调员，不回退到下级
		assert.equal(
			resolveMemberModel({ name: "fix-1", role: "worker", model: "plan/m" }, { interactiveOverride: "", cliOverrides, config }),
			undefined,
		);
		// 2. cli 优先于 config
		assert.equal(
			resolveMemberModel({ name: "fix-1", role: "worker", model: "plan/m" }, { cliOverrides, config }),
			"cli/worker",
		);
		// 3a. config.members > config.roles
		assert.equal(
			resolveMemberModel({ name: "fix-1", role: "worker", model: "plan/m" }, { config }),
			"cfg/fix-1",
		);
		// 3b. config.roles > config.default > plan.model
		assert.equal(
			resolveMemberModel({ name: "fix-2", role: "worker", model: "plan/m" }, { config }),
			"cfg/worker",
		);
		// 3c. config.default > plan.model
		assert.equal(
			resolveMemberModel({ name: "fix-2", role: "worker", model: "plan/m" }, { config: { default: "cfg/default" } }),
			"cfg/default",
		);
		// 4. plan.model 兜底
		assert.equal(
			resolveMemberModel({ name: "fix-2", role: "worker", model: "plan/m" }, {}),
			"plan/m",
		);
		// 5. 都没有 → undefined
		assert.equal(
			resolveMemberModel({ name: "fix-2", role: "worker" }, {}),
			undefined,
		);
	});

	it("parseSwarmTaskArgs：提取 --worker-model 与 --verifier-model 并校验格式", () => {
		const r1 = parseSwarmTaskArgs("--worker-model=p/w --verifier-model p/v 修复所有单测");
		assert.deepEqual(r1, {
			task: "修复所有单测",
			cliOverrides: { worker: "p/w", verifier: "p/v" },
		});

		const r2 = parseSwarmTaskArgs("重构模块 --worker-model p/w2");
		assert.deepEqual(r2, {
			task: "重构模块",
			cliOverrides: { worker: "p/w2" },
		});

		assert.throws(() => parseSwarmTaskArgs("--worker-model=bare-model 修复"), /provider\/model/);
		assert.throws(() => parseSwarmTaskArgs("--verifier-model"), /缺少模型参数/);
	});
});

// ────────────────────────── UI 改造 — Tab + 2×2 网格 + 实时监控面板 ──────────────────────────

import { planGridSplits, renderMonitor } from "./index.ts";

describe("herdr.ts — tabCreate / tabFocus / tabClose", () => {
	it("tabCreate / tabFocus / tabClose 参数拼装", async () => {
		const { calls, exec } = fakeExec([
			{ stdout: ok({ tab: { tab_id: "t1", root_pane_id: "p1" } }) },
			{ stdout: ok({}) },
			{ stdout: ok({}) },
		]);
		const h = createHerdr({ exec });
		const res = await h.tabCreate({ cwd: "/repo", label: "swarm-r1", env: { A: "1" }, noFocus: true });
		assert.equal(res.tabId, "t1");
		assert.equal(res.rootPaneId, "p1");
		assert.deepEqual(calls[0].args, ["tab", "create", "--cwd", "/repo", "--label", "swarm-r1", "--env", "A=1", "--no-focus"]);

		await h.tabFocus("t1");
		assert.deepEqual(calls[1].args, ["tab", "focus", "t1"]);

		await h.tabClose("t1");
		assert.deepEqual(calls[2].args, ["tab", "close", "t1"]);
	});
});

describe("index.ts — planGridSplits 2×2 网格切分", () => {
	it("按成员序号生成正确的锚点 pane 与方向", () => {
		assert.deepEqual(planGridSplits(["p1"]), { anchorPaneId: "p1", direction: "right" });
		assert.deepEqual(planGridSplits(["p1", "p2"]), { anchorPaneId: "p1", direction: "down" });
		assert.deepEqual(planGridSplits(["p1", "p2", "p3"]), { anchorPaneId: "p2", direction: "down" });
		assert.deepEqual(planGridSplits(["p1", "p2", "p3", "p4"]), { anchorPaneId: "p4", direction: "down" });
	});
});

describe("index.ts — renderMonitor 实时监控面板", () => {
	it("output 模式高亮选中成员并展示实时输出与相关帖子；board 模式展示帖子流", () => {
		const run: any = {
			runId: "run-mon",
			task: "测试实时监控",
			status: "active",
			tabId: "t9",
			members: new Map([
				["fix-1", { name: "fix-1", agentName: "fix-1", role: "worker", agentStatus: "working", model: "p/w" }],
				["verify-1", { name: "verify-1", agentName: "verify-1", role: "verifier", agentStatus: "idle", round: 1 }],
			]),
		};
		const posts: any[] = [
			{ meta: { seq: 1, from: "fix-1", to: "hub", type: "done", round: 0, refs: [] }, body: "已提交" },
		];
		const outputs = new Map([["fix-1", "line1\nrunning tests..."]]);

		const outLines = renderMonitor(run, posts, {
			selectedIdx: 0,
			viewMode: "output",
			outputs,
			lastRefreshed: "21:20:00",
			width: 120,
		}).join("\n");
		assert.match(outLines, /Tab t9/);
		assert.match(outLines, /▶ \[1\] @fix-1\(worker\) working/);
		assert.match(outLines, /running tests\.\.\./);
		assert.match(outLines, /#1 \[done\] fix-1→hub: 已提交/);
		assert.match(outLines, /f 跳到 Swarm Tab/);

		const boardLines = renderMonitor(run, posts, {
			selectedIdx: 1,
			viewMode: "board",
			outputs,
			width: 120,
		}).join("\n");
		assert.match(boardLines, /▶ \[2\] @verify-1\(verifier\) idle/);
		assert.match(boardLines, /消息板全量帖子 \(1\)/);
		assert.match(boardLines, /已提交/);
	});
});

describe("index.ts — cleanup 回收 tabId", () => {
	it("runCleanup 在关 pane 后幂等调用 tabClose", async () => {
		const closedTabs: string[] = [];
		const h: any = {
			paneClose: async () => ({}),
			tabClose: async (id: string) => {
				closedTabs.push(id);
				return {};
			},
		};
		const acted = await runCleanup(
			h,
			"/repo",
			[{ runId: "run-t", dir: "/d/t", status: "done", tabId: "tab-42", paneIds: ["p1"], worktrees: [] }],
			async () => "",
		);
		assert.deepEqual(closedTabs, ["tab-42"]);
		assert.ok(acted.some((a) => a.includes("tab tab-42 已关")));
	});
});
