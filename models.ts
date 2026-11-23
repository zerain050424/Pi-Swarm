/**
 * models.ts — Swarm 结构化模型配置、校验、合并与优先级解析。
 *
 * 双层配置：
 * - 全局：~/.pi/agent/swarm-models.json
 * - 项目：<cwd>/.pi/swarm/models.json（按字段覆盖全局）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SwarmRole = "worker" | "verifier";

export interface SwarmModelConfig {
	default?: string;
	roles?: {
		worker?: string;
		verifier?: string;
	};
	members?: Record<string, string>;
}

export interface ModelOverrides {
	worker?: string;
	verifier?: string;
}

export type ModelTarget =
	| { kind: "default" }
	| { kind: "role"; role: SwarmRole }
	| { kind: "member"; name: string };

const MEMBER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 全局模型配置文件路径：~/.pi/agent/swarm-models.json */
export function globalModelConfigPath(homeDir: string = homedir()): string {
	return join(homeDir, ".pi", "agent", "swarm-models.json");
}

/** 项目模型配置文件路径：<cwd>/.pi/swarm/models.json */
export function projectModelConfigPath(cwd: string): string {
	return join(cwd, ".pi", "swarm", "models.json");
}

/**
 * 校验模型名必须为 `provider/model` 全限定格式（允许 model 部分含 `/` 如 `openrouter/org/model`）。
 * 拒绝裸模型名、空白字符与空 provider/model 段。
 */
export function validateQualifiedModel(model: string): string {
	const s = model.trim();
	const idx = s.indexOf("/");
	if (!s || idx <= 0 || idx === s.length - 1 || /\s/.test(s)) {
		throw new Error(
			`模型名 "${model}" 格式无效：必须使用 provider/model 全限定名（例如 opencode-go/glm-5.3-flash），裸模型名会导致 pi 退出。`,
		);
	}
	const rest = s.slice(idx + 1);
	if (!rest || rest.startsWith("/") || rest.endsWith("/")) {
		throw new Error(`模型名 "${model}" 格式无效：provider/model 两侧不能为空。`);
	}
	return s;
}

/** 校验并归一化模型配置对象（容错忽略非对象字段）。 */
function normalizeConfig(raw: unknown): SwarmModelConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	const out: SwarmModelConfig = {};
	if (typeof obj.default === "string" && obj.default.trim()) {
		out.default = obj.default.trim();
	}
	if (obj.roles && typeof obj.roles === "object" && !Array.isArray(obj.roles)) {
		const r = obj.roles as Record<string, unknown>;
		const roles: NonNullable<SwarmModelConfig["roles"]> = {};
		if (typeof r.worker === "string" && r.worker.trim()) roles.worker = r.worker.trim();
		if (typeof r.verifier === "string" && r.verifier.trim()) roles.verifier = r.verifier.trim();
		if (roles.worker || roles.verifier) out.roles = roles;
	}
	if (obj.members && typeof obj.members === "object" && !Array.isArray(obj.members)) {
		const members: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj.members as Record<string, unknown>)) {
			if (typeof v === "string" && v.trim()) members[k] = v.trim();
		}
		if (Object.keys(members).length > 0) out.members = members;
	}
	return out;
}

/** 读取单个配置文件；文件不存在时返回空配置，JSON 损坏时抛出可读错误。 */
export function loadModelConfigFile(filePath: string): SwarmModelConfig {
	if (!existsSync(filePath)) return {};
	const raw = readFileSync(filePath, "utf8");
	if (!raw.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: any) {
		throw new Error(`模型配置文件解析失败 (${filePath})：${err?.message ?? err}`);
	}
	return normalizeConfig(parsed);
}

/** 写入单个配置文件（自动建父目录并清理空对象）。 */
export function saveModelConfigFile(filePath: string, config: SwarmModelConfig): void {
	const normalized = normalizeConfig(config);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(normalized, null, 2) + "\n");
}

/** 合并双层配置：项目级按字段覆盖全局级。 */
export function mergeModelConfigs(
	globalCfg: SwarmModelConfig,
	projectCfg: SwarmModelConfig,
): SwarmModelConfig {
	const merged: SwarmModelConfig = {};
	const def = projectCfg.default ?? globalCfg.default;
	if (def) merged.default = def;

	const worker = projectCfg.roles?.worker ?? globalCfg.roles?.worker;
	const verifier = projectCfg.roles?.verifier ?? globalCfg.roles?.verifier;
	if (worker || verifier) {
		merged.roles = {};
		if (worker) merged.roles.worker = worker;
		if (verifier) merged.roles.verifier = verifier;
	}

	const members = { ...globalCfg.members, ...projectCfg.members };
	if (Object.keys(members).length > 0) merged.members = members;
	return merged;
}

/** 读取全局、项目与合并后的生效配置。 */
export function loadEffectiveModelConfig(
	cwd: string,
	homeDir: string = homedir(),
): { global: SwarmModelConfig; project: SwarmModelConfig; effective: SwarmModelConfig } {
	const global = loadModelConfigFile(globalModelConfigPath(homeDir));
	const project = loadModelConfigFile(projectModelConfigPath(cwd));
	return { global, project, effective: mergeModelConfigs(global, project) };
}

/**
 * 解析成员最终模型，严格按 5 级优先级：
 * 1. interactiveOverride（确认阶段手动修改；"" 表示显式清除并继承协调员）
 * 2. cliOverrides[role]（/swarm --worker-model / --verifier-model）
 * 3. config.members[name] > config.roles[role] > config.default（项目已覆盖全局）
 * 4. member.model（协调员 swarm_plan 兜底值）
 * 5. undefined（继承协调员当前模型）
 */
export function resolveMemberModel(
	member: { name: string; role: SwarmRole; model?: string },
	opts: {
		interactiveOverride?: string;
		cliOverrides?: ModelOverrides;
		config?: SwarmModelConfig;
	} = {},
): string | undefined {
	if (opts.interactiveOverride !== undefined) {
		return opts.interactiveOverride === "" ? undefined : opts.interactiveOverride;
	}
	const cli = opts.cliOverrides?.[member.role];
	if (cli) return cli;
	const cfg = opts.config;
	if (cfg?.members?.[member.name]) return cfg.members[member.name];
	if (cfg?.roles?.[member.role]) return cfg.roles[member.role];
	if (cfg?.default) return cfg.default;
	if (member.model) return member.model;
	return undefined;
}

/**
 * 解析 `/swarm` 参数中的 `--worker-model` / `--verifier-model` 覆盖项，
 * 返回剥离 flag 后的纯任务文本与校验后的 cliOverrides。
 */
export function parseSwarmTaskArgs(rawArgs: string): {
	task: string;
	cliOverrides: ModelOverrides;
} {
	const cliOverrides: ModelOverrides = {};
	const tokens = rawArgs.trim().match(/\S+/g) ?? [];
	const kept: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--worker-model" || tok === "--verifier-model") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("--")) {
				throw new Error(`${tok} 缺少模型参数（需要 provider/model）。`);
			}
			const role: SwarmRole = tok === "--worker-model" ? "worker" : "verifier";
			cliOverrides[role] = validateQualifiedModel(next);
			i++;
			continue;
		}
		if (tok.startsWith("--worker-model=")) {
			cliOverrides.worker = validateQualifiedModel(tok.slice("--worker-model=".length));
			continue;
		}
		if (tok.startsWith("--verifier-model=")) {
			cliOverrides.verifier = validateQualifiedModel(tok.slice("--verifier-model=".length));
			continue;
		}
		kept.push(tok);
	}

	return { task: kept.join(" ").trim(), cliOverrides };
}

/** 解析 `/swarm models` 目标参数（worker / verifier / default / member:<name> / <name>）。 */
export function parseModelTarget(raw: string): ModelTarget {
	const s = raw.trim();
	if (s === "default") return { kind: "default" };
	if (s === "worker" || s === "verifier") return { kind: "role", role: s };
	const memberName = s.startsWith("member:") ? s.slice("member:".length).trim() : s;
	if (!MEMBER_NAME_RE.test(memberName)) {
		throw new Error(
			`无效目标 "${raw}"：请使用 worker、verifier、default 或合法成员名（^[a-z][a-z0-9_-]{0,31}$）。`,
		);
	}
	return { kind: "member", name: memberName };
}

/** 更新配置中指定目标的模型（返回新对象，不修改入参）。 */
export function setConfigTarget(
	config: SwarmModelConfig,
	target: ModelTarget,
	model: string,
): SwarmModelConfig {
	const qualified = validateQualifiedModel(model);
	const next: SwarmModelConfig = normalizeConfig(config);
	if (target.kind === "default") {
		next.default = qualified;
	} else if (target.kind === "role") {
		next.roles = { ...next.roles, [target.role]: qualified };
	} else {
		next.members = { ...next.members, [target.name]: qualified };
	}
	return next;
}

/** 清除配置中指定目标的模型。 */
export function resetConfigTarget(
	config: SwarmModelConfig,
	target: ModelTarget,
): { config: SwarmModelConfig; removed: boolean } {
	const next: SwarmModelConfig = normalizeConfig(config);
	let removed = false;
	if (target.kind === "default") {
		if (next.default !== undefined) {
			delete next.default;
			removed = true;
		}
	} else if (target.kind === "role") {
		if (next.roles?.[target.role] !== undefined) {
			delete next.roles[target.role];
			removed = true;
		}
	} else if (next.members?.[target.name] !== undefined) {
		delete next.members[target.name];
		removed = true;
	}
	return { config: normalizeConfig(next), removed };
}

/** 格式化配置摘要供 UI 展示或提示词注入。 */
export function formatModelConfigSummary(cfg: SwarmModelConfig): string {
	const lines: string[] = [];
	if (cfg.roles?.worker) lines.push(`worker: ${cfg.roles.worker}`);
	if (cfg.roles?.verifier) lines.push(`verifier: ${cfg.roles.verifier}`);
	if (cfg.default) lines.push(`default: ${cfg.default}`);
	if (cfg.members) {
		for (const [k, v] of Object.entries(cfg.members)) {
			lines.push(`@${k}: ${v}`);
		}
	}
	return lines.length > 0 ? lines.join(" | ") : "（未配置，默认继承协调员模型）";
}
