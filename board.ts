/**
 * board.ts — 消息板纯逻辑（Design.md §6.1）。
 *
 * 存储形态：一帖一文件 `posts/NNNN-<from>-<type>.md`，frontmatter 承载结构化字段，
 * 正文自由文本。跨进程安全靠"每帖写一个新文件"，序号分配靠目录扫描 max+1。
 *
 * 本文件只做纯逻辑（解析/序列化/命名/过滤），IO 在 index.ts / worker.ts 侧。
 */

export type PostType = "done" | "issue" | "note" | "question";

export interface PostMeta {
	seq: number;
	from: string;
	to: string; // @名 或 all
	type: PostType;
	/** verifier 打回轮次，非 verifier 帖为 0 */
	round: number;
	/** 关联的帖子序号或 commit，逗号分隔展开 */
	refs: string[];
}

export interface Post {
	meta: PostMeta;
	body: string;
}

const TYPES: ReadonlySet<string> = new Set(["done", "issue", "note", "question"]);

// ───────────────────────────── frontmatter ─────────────────────────────

/**
 * 解析 frontmatter。容错规则：
 * - 无 frontmatter / 字段非法 → meta 为 null（正文原样保留），调用方按裸文本处理；
 * - round 缺省 0，refs 缺省空数组。
 */
export function parseFrontmatter(text: string): { meta: PostMeta | null; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return { meta: null, body: text };
	const [, raw, body] = m;

	const fields = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
		if (kv) fields.set(kv[1], kv[2].trim());
	}

	const seq = Number(fields.get("seq"));
	const type = fields.get("type") ?? "";
	if (!Number.isInteger(seq) || seq <= 0 || !TYPES.has(type)) {
		return { meta: null, body };
	}

	const meta: PostMeta = {
		seq,
		from: fields.get("from") ?? "",
		to: fields.get("to") ?? "",
		type: type as PostType,
		round: Number.isInteger(Number(fields.get("round"))) ? Number(fields.get("round")) : 0,
		refs: (fields.get("refs") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	};
	if (!meta.from) return { meta: null, body };
	// serializePost 在 frontmatter 后留一个空行、结尾补换行：还原时剥掉，保证往返无损
	const cleanBody = body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
	return { meta, body: cleanBody };
}

export function serializePost(meta: PostMeta, body: string): string {
	const lines = [
		"---",
		`seq: ${meta.seq}`,
		`from: ${meta.from}`,
		`to: ${meta.to}`,
		`type: ${meta.type}`,
		`round: ${meta.round}`,
		`refs: ${meta.refs.join(",")}`,
		"---",
		"",
		body,
	];
	return lines.join("\n").replace(/\n*$/, "\n");
}

// ───────────────────────────── 文件名与序号 ─────────────────────────────

export function postFileName(seq: number, from: string, type: PostType): string {
	return `${String(seq).padStart(4, "0")}-${from}-${type}.md`;
}

const SEQ_RE = /^(\d{4})-/;

/** 从目录条目里推下一个序号：现有最大四位前缀 + 1；无可识别条目从 1 开始。 */
export function nextSeq(entries: string[]): number {
	let max = 0;
	for (const e of entries) {
		const m = SEQ_RE.exec(e);
		if (m) {
			const n = Number(m[1]);
			if (Number.isInteger(n) && n > max) max = n;
		}
	}
	return max + 1;
}

// ───────────────────────────── 过滤 ─────────────────────────────

export interface BoardFilter {
	/** 读者是谁：收件人是读者本人或 all 的帖可见 */
	to?: string;
	from?: string;
	type?: PostType;
}

export function filterPosts(posts: Post[], f: BoardFilter): Post[] {
	return posts.filter((p) => {
		if (f.type && p.meta.type !== f.type) return false;
		if (f.from && p.meta.from !== f.from) return false;
		if (f.to && p.meta.to !== f.to && p.meta.to !== "all") return false;
		return true;
	});
}

// ───────────────────────────── IO（跨进程安全靠"每帖一文件"） ─────────────────────────────

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 一帖一文件落盘。序号取目录 max+1；两进程同时算出同号时靠 `wx` 标志 +
 * 重扫重试兜底（先落盘者赢，后落盘者递增）。返回实际落盘的 seq。
 */
export async function writePost(postsDir: string, meta: PostMeta, body: string): Promise<number> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const seq = nextSeq(readdirSync(postsDir));
		const path = join(postsDir, postFileName(seq, meta.from, meta.type));
		try {
			writeFileSync(path, serializePost({ ...meta, seq }, body), { flag: "wx" });
			return seq;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			// 撞号：重扫目录取更大的序号
		}
	}
	throw new Error("消息板序号连续冲突 5 次，放弃发帖（postsDir 状态异常）");
}

/** 读全板：按文件名（即 seq）排序，坏帖跳过。 */
export function readAllPosts(postsDir: string): Post[] {
	if (!existsSync(postsDir)) return [];
	const posts: Post[] = [];
	for (const f of readdirSync(postsDir).sort()) {
		if (!f.endsWith(".md")) continue;
		try {
			const parsed = parseFrontmatter(readFileSync(join(postsDir, f), "utf8"));
			if (parsed.meta) posts.push({ meta: parsed.meta, body: parsed.body });
		} catch {
			/* 坏帖跳过 */
		}
	}
	return posts;
}
