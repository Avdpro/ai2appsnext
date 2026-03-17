import {
	callProviderText,
	getProviderForPurpose,
	resolveModelByTier,
} from "./AIProviderClient.mjs";

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function normActionType(v) {
	return asText(v).toLowerCase();
}

function toArray(v) {
	if (Array.isArray(v)) return v;
	if (v == null || v === "") return [];
	return [v];
}

function parseCsvSet(raw) {
	const out = new Set();
	for (const part of String(raw || "").split(",")) {
		const v = normActionType(part);
		if (v) out.add(v);
	}
	return out;
}

function parseBool(raw, fallback = false) {
	const s = asText(raw).toLowerCase();
	if (!s) return fallback;
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	return fallback;
}

function normalizeMode(raw) {
	const m = asText(raw).toLowerCase();
	if (m === "off" || m === "warn" || m === "enforce") return m;
	return "warn";
}

function normalizeRiskLevel(raw, fallback = "medium") {
	const s = asText(raw).toLowerCase();
	if (["critical", "high", "medium", "low", "info"].includes(s)) return s;
	return fallback;
}

function riskWeight(level) {
	const l = normalizeRiskLevel(level, "low");
	if (l === "critical") return 4;
	if (l === "high") return 3;
	if (l === "medium") return 2;
	if (l === "low") return 1;
	return 0;
}

function flattenStrings(root, path = "$", out = []) {
	if (typeof root === "string") {
		out.push({ path, value: root });
		return out;
	}
	if (Array.isArray(root)) {
		for (let i = 0; i < root.length; i++) flattenStrings(root[i], `${path}[${i}]`, out);
		return out;
	}
	if (root && typeof root === "object") {
		for (const [k, v] of Object.entries(root)) flattenStrings(v, `${path}.${k}`, out);
	}
	return out;
}

function getTemplateArgRefs(text) {
	const refs = [];
	const re = /\$\{args\.([a-zA-Z0-9_]+)\}/g;
	let m;
	while ((m = re.exec(String(text || "")))) refs.push(String(m[1] || "").toLowerCase());
	return refs;
}

function hasJsBlockTemplate(text) {
	return /\$\{\{[\s\S]*\}\}/.test(String(text || ""));
}

function tryParseJSON(text) {
	const s = asText(text);
	if (!s) return null;
	try { return JSON.parse(s); } catch (_) {}
	const obj = s.match(/\{[\s\S]*\}/);
	if (obj) {
		try { return JSON.parse(obj[0]); } catch (_) {}
	}
	return null;
}

function normalizeArgSensitivityKeys(raw) {
	const base = new Set([
		"password", "passwd", "pwd",
		"token", "access_token", "refresh_token",
		"secret", "api_key", "apikey", "authorization",
		"cookie", "session", "credential", "credentials",
		"idcard", "phone", "email",
	]);
	for (const k of toArray(raw)) {
		const nk = asText(k).toLowerCase();
		if (nk) base.add(nk);
	}
	return base;
}

function isHttpLikeUrl(text) {
	return /^https?:\/\//i.test(asText(text));
}

function isDangerousSchemeUrl(text) {
	const s = asText(text).toLowerCase();
	return s.startsWith("javascript:") || s.startsWith("data:") || s.startsWith("file:");
}

function extractUrlCandidate(action, args = {}) {
	const urlRaw = action?.url;
	if (typeof urlRaw !== "string") return "";
	const s = urlRaw.trim();
	const full = s.match(/^\$\{args\.([a-zA-Z0-9_]+)\}$/);
	if (full) {
		const v = args?.[full[1]];
		return typeof v === "string" ? v.trim() : "";
	}
	return s;
}

function scanRunJsRisk(code) {
	const text = asText(code);
	if (!text) return { hits: [], hasSource: false, hasSink: false };
	const ruleDefs = [
		{ code: "eval", re: /\beval\s*\(/i, message: "contains eval(...)", riskLevel: "high" },
		{ code: "new_function", re: /\bnew\s+Function\s*\(/i, message: "contains new Function(...)", riskLevel: "high" },
		{ code: "source_cookie", re: /\bdocument\.cookie\b/i, message: "reads/writes document.cookie", source: true, riskLevel: "medium" },
		{ code: "source_local_storage", re: /\blocalStorage\b/i, message: "uses localStorage", source: true, riskLevel: "medium" },
		{ code: "source_session_storage", re: /\bsessionStorage\b/i, message: "uses sessionStorage", source: true, riskLevel: "medium" },
		{ code: "source_indexeddb", re: /\bindexedDB\b/i, message: "uses indexedDB", source: true, riskLevel: "medium" },
		{ code: "source_clipboard", re: /\bnavigator\.clipboard\b/i, message: "uses clipboard API", source: true, riskLevel: "medium" },
		{ code: "sink_fetch", re: /\bfetch\s*\(/i, message: "contains fetch(...)", sink: true, riskLevel: "medium" },
		{ code: "sink_xhr", re: /\bXMLHttpRequest\b/i, message: "contains XMLHttpRequest", sink: true, riskLevel: "medium" },
		{ code: "sink_beacon", re: /\bsendBeacon\s*\(/i, message: "contains sendBeacon(...)", sink: true, riskLevel: "medium" },
		{ code: "sink_websocket", re: /\bnew\s+WebSocket\s*\(/i, message: "opens WebSocket", sink: true, riskLevel: "medium" },
	];
	const hits = [];
	let hasSource = false;
	let hasSink = false;
	for (const r of ruleDefs) {
		if (!r.re.test(text)) continue;
		hits.push(r);
		if (r.source) hasSource = true;
		if (r.sink) hasSink = true;
	}
	return { hits, hasSource, hasSink };
}

function buildPolicy({ mode, allowActions, denyActions, sensitiveArgKeys, ai } = {}) {
	const allow = new Set((Array.isArray(allowActions) ? allowActions : []).map(normActionType).filter(Boolean));
	const deny = new Set((Array.isArray(denyActions) ? denyActions : []).map(normActionType).filter(Boolean));
	const aiObj = (ai && typeof ai === "object") ? ai : {};
	return {
		mode: normalizeMode(mode),
		allowActions: allow,
		denyActions: deny,
		sensitiveArgKeys: normalizeArgSensitivityKeys(sensitiveArgKeys),
		ai: {
			enabled: !!aiObj.enabled,
			includeRunJsWithCode: !!aiObj.includeRunJsWithCode,
			provider: asText(aiObj.provider),
			model: asText(aiObj.model),
			tier: asText(aiObj.tier || "balanced") || "balanced",
			timeoutMs: Number(aiObj.timeoutMs || 45000),
		},
	};
}

function addFinding(findings, item) {
	findings.push({
		source: asText(item.source || "rule"),
		category: asText(item.category || "execution"),
		riskLevel: normalizeRiskLevel(item.riskLevel || "medium"),
		confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.75))),
		stepId: asText(item.stepId || "(unknown)"),
		actionType: asText(item.actionType || ""),
		path: asText(item.path || ""),
		title: asText(item.title || item.code || "audit finding"),
		evidence: asText(item.evidence || item.message || ""),
		recommendation: asText(item.recommendation || ""),
		uncertainty: asText(item.uncertainty || ""),
		code: asText(item.code || ""),
	});
}

function computeOverview(findings, mode) {
	const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	let maxLevel = "info";
	for (const f of findings) {
		const lv = normalizeRiskLevel(f.riskLevel, "low");
		counts[lv] = (counts[lv] || 0) + 1;
		if (riskWeight(lv) > riskWeight(maxLevel)) maxLevel = lv;
	}
	const summary = findings.length
		? `findings=${findings.length}, critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, mode=${mode}`
		: `no findings, mode=${mode}`;
	return { maxRiskLevel: maxLevel, counts, summary };
}

async function auditRunJsWithAI({ stepId, action, policy, logger = null }) {
	const query = asText(action?.query);
	const code = asText(action?.code);
	const scope = asText(action?.scope || "page");
	const queryOnly = !!query && !code;
	if (!policy.ai.enabled) return { ok: false, reason: "ai disabled" };
	if (!queryOnly && !policy.ai.includeRunJsWithCode) return { ok: false, reason: "ai skipped for run_js with code" };

	const provider = policy.ai.provider || getProviderForPurpose("audit");
	const model = policy.ai.model
		|| resolveModelByTier({ provider, purpose: "audit", tier: policy.ai.tier || "balanced", fallback: false })
		|| resolveModelByTier({ provider, purpose: "run_ai", tier: policy.ai.tier || "balanced", fallback: false });

	const system = [
		"You are a security auditor for browser automation flows.",
		"Analyze a run_js action for malicious execution and privacy exposure risk.",
		"Because web page context may be missing, explicitly state uncertainty.",
		"Return strict JSON only.",
		"Schema:",
		`{
  "riskLevel":"critical|high|medium|low|info",
  "confidence":0..1,
  "uncertainty":"string",
  "reason":"string",
  "risks":[{"title":"string","riskLevel":"critical|high|medium|low|info","evidence":"string","recommendation":"string"}]
}`,
	].join("\n");
	const user = JSON.stringify({
		stepId,
		actionType: "run_js",
		scope,
		query,
		code: code || null,
		queryOnly,
	}, null, 2);

	const ret = await callProviderText({
		provider,
		model,
		purpose: "audit",
		forceJson: true,
		temperature: 0,
		timeoutMs: Number(policy.ai.timeoutMs || 45000),
		logger,
		input: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	});
	if (!ret?.ok) return { ok: false, reason: ret?.reason || "ai audit failed", provider, model };

	const obj = tryParseJSON(ret.raw);
	if (!obj || typeof obj !== "object") {
		return { ok: false, reason: "ai audit invalid json", provider: ret.provider || provider, model: ret.model || model };
	}
	const risks = Array.isArray(obj.risks) ? obj.risks : [];
	const mapped = risks.map((r) => ({
		source: "ai",
		category: "execution",
		riskLevel: normalizeRiskLevel(r?.riskLevel || obj.riskLevel || "medium"),
		confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.6))),
		stepId,
		actionType: "run_js",
		path: queryOnly ? "$.action.query" : "$.action.code",
		title: asText(r?.title || "AI risk finding"),
		evidence: asText(r?.evidence || obj.reason || ""),
		recommendation: asText(r?.recommendation || ""),
		uncertainty: asText(obj.uncertainty || ""),
		code: "ai_run_js_risk",
	}));
	if (!mapped.length) {
		mapped.push({
			source: "ai",
			category: "uncertainty",
			riskLevel: normalizeRiskLevel(obj.riskLevel || "low"),
			confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5))),
			stepId,
			actionType: "run_js",
			path: queryOnly ? "$.action.query" : "$.action.code",
			title: "AI run_js assessment",
			evidence: asText(obj.reason || "AI provided no explicit risks"),
			recommendation: "",
			uncertainty: asText(obj.uncertainty || ""),
			code: "ai_run_js_assessment",
		});
	}
	return {
		ok: true,
		provider: ret.provider || provider,
		model: ret.model || model,
		findings: mapped,
	};
}

async function auditFlow({ flow, args = {}, policy = {}, logger = null }) {
	const p = buildPolicy(policy);
	if (p.mode === "off") {
		return {
			ok: true,
			mode: "off",
			blocked: false,
			wouldBlock: false,
			summary: "audit disabled",
			overview: { maxRiskLevel: "info", counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
			findings: [],
			ai: { enabled: false, calls: 0, failures: 0 },
		};
	}

	const findings = [];
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	const hasAllowList = p.allowActions.size > 0;
	const highRiskActions = new Set(["run_js", "invoke", "invokemany", "uploadfile", "download", "dialog"]);

	let aiCalls = 0;
	let aiFailures = 0;
	const aiRuns = [];

	for (const step of steps) {
		const stepId = asText(step?.id) || "(unknown)";
		const action = (step && typeof step.action === "object" && step.action) ? step.action : {};
		const type = normActionType(action.type);
		if (!type) {
			addFinding(findings, {
				source: "rule",
				riskLevel: "high",
				code: "missing_action_type",
				stepId,
				title: "Missing action type",
				message: "step.action.type is missing",
				recommendation: "Define step.action.type explicitly.",
			});
			continue;
		}

		if (p.denyActions.has(type)) {
			addFinding(findings, {
				source: "rule",
				riskLevel: "high",
				code: "denylist_action",
				stepId,
				actionType: type,
				title: "Denied action",
				message: `action "${type}" is denied by policy`,
			});
		}
		if (hasAllowList && !p.allowActions.has(type)) {
			addFinding(findings, {
				source: "rule",
				riskLevel: "high",
				code: "not_in_allowlist",
				stepId,
				actionType: type,
				title: "Action not in allowlist",
				message: `action "${type}" is not in allowActions`,
			});
		}
		if (highRiskActions.has(type)) {
			addFinding(findings, {
				source: "rule",
				riskLevel: "medium",
				code: "high_risk_action",
				stepId,
				actionType: type,
				title: "High-risk action category",
				message: `action "${type}" should be reviewed`,
			});
		}

		if (type === "goto") {
			const url = extractUrlCandidate(action, args);
			if (url && isDangerousSchemeUrl(url)) {
				addFinding(findings, {
					source: "rule",
					riskLevel: "high",
					code: "dangerous_url_scheme",
					stepId,
					actionType: type,
					path: "$.action.url",
					title: "Dangerous URL scheme",
					message: `goto uses dangerous URL scheme: ${url.slice(0, 120)}`,
				});
			}
		}

		if (type === "run_js") {
			const risk = scanRunJsRisk(action.code);
			for (const hit of risk.hits) {
				addFinding(findings, {
					source: "rule",
					category: hit.source ? "privacy" : (hit.sink ? "network" : "execution"),
					riskLevel: hit.riskLevel,
					code: `run_js_${hit.code}`,
					stepId,
					actionType: type,
					path: "$.action.code",
					title: "run_js sensitive pattern",
					message: `run_js ${hit.message}`,
				});
			}
			if (risk.hasSource && risk.hasSink) {
				addFinding(findings, {
					source: "rule",
					category: "privacy",
					riskLevel: "high",
					code: "run_js_privacy_exfil_possible",
					stepId,
					actionType: type,
					path: "$.action.code",
					title: "Possible privacy exfiltration",
					message: "run_js contains both privacy sources and network sinks",
					recommendation: "Limit collected fields and remove outbound network in run_js.",
				});
			}
			if (normActionType(action.scope) === "agent") {
				addFinding(findings, {
					source: "rule",
					category: "execution",
					riskLevel: "high",
					code: "run_js_agent_scope",
					stepId,
					actionType: type,
					path: "$.action.scope",
					title: "Agent-scope execution",
					message: "run_js scope=agent increases host-side execution risk",
					recommendation: "Prefer scope=page unless strictly required.",
				});
			}

			aiCalls += 1;
			const aiRet = await auditRunJsWithAI({ stepId, action, policy: p, logger });
			if (aiRet.ok) {
				aiRuns.push({ stepId, ok: true, provider: aiRet.provider, model: aiRet.model });
				for (const f of aiRet.findings) addFinding(findings, f);
			} else {
				aiFailures += 1;
				aiRuns.push({ stepId, ok: false, reason: aiRet.reason || "ai skipped" });
				addFinding(findings, {
					source: "ai",
					category: "uncertainty",
					riskLevel: "low",
					confidence: 0.3,
					code: "ai_assessment_unavailable",
					stepId,
					actionType: type,
					path: "$.action.query",
					title: "AI assessment unavailable",
					message: aiRet.reason || "AI audit unavailable",
					uncertainty: "Semantic risk for this run_js step may be incomplete without AI output.",
				});
			}
		}

		if (type === "uploadfile") {
			const files = toArray(action.files);
			for (const f of files) {
				const path = asText(f && typeof f === "object" ? f.path : "");
				if (!path) continue;
				if (path.startsWith("/") || /^[A-Za-z]:\\/.test(path)) {
					addFinding(findings, {
						source: "rule",
						category: "privacy",
						riskLevel: "medium",
						code: "upload_absolute_path",
						stepId,
						actionType: type,
						path: "$.action.files[*].path",
						title: "Absolute file upload path",
						message: `uploadFile uses absolute path: ${path.slice(0, 120)}`,
					});
				}
				if (/\/(users|home)\//i.test(path) || /\\Users\\/i.test(path)) {
					addFinding(findings, {
						source: "rule",
						category: "privacy",
						riskLevel: "high",
						code: "upload_user_home_path",
						stepId,
						actionType: type,
						path: "$.action.files[*].path",
						title: "User-home file upload",
						message: "uploadFile targets user-home path, possible privacy leak",
					});
				}
			}
		}

		const allStrings = flattenStrings(action, "$.action");
		for (const s of allStrings) {
			if (hasJsBlockTemplate(s.value)) {
				const pathLow = s.path.toLowerCase();
				const highPath = pathLow.includes(".code")
					|| pathLow.includes(".url")
					|| pathLow.includes(".prompt")
					|| pathLow.includes(".input")
					|| pathLow.includes(".args");
				addFinding(findings, {
					source: "rule",
					category: "execution",
					riskLevel: highPath ? "high" : "medium",
					code: "js_block_template",
					stepId,
					actionType: type,
					path: s.path,
					title: "Dynamic JS template",
					message: "contains ${{ ... }} dynamic code template",
				});
			}

			const refs = getTemplateArgRefs(s.value);
			for (const ref of refs) {
				if (!p.sensitiveArgKeys.has(ref)) continue;
				const pathLow = s.path.toLowerCase();
				const looksOutbound = pathLow.includes(".url")
					|| pathLow.includes(".prompt")
					|| pathLow.includes(".input")
					|| pathLow.includes(".args")
					|| isHttpLikeUrl(s.value);
				addFinding(findings, {
					source: "rule",
					category: "privacy",
					riskLevel: looksOutbound ? "high" : "medium",
					code: "sensitive_arg_reference",
					stepId,
					actionType: type,
					path: s.path,
					title: "Sensitive arg reference",
					message: `references sensitive arg "${ref}" in action payload`,
					recommendation: "Avoid passing secrets into prompts/URLs/input payloads.",
				});
			}
		}
	}

	const overview = computeOverview(findings, p.mode);
	const wouldBlock = p.mode === "enforce" && (overview.counts.critical > 0 || overview.counts.high > 0);
	return {
		ok: true,
		mode: p.mode,
		blocked: false,
		wouldBlock,
		summary: overview.summary,
		overview,
		findings,
		ai: {
			enabled: p.ai.enabled,
			calls: aiCalls,
			failures: aiFailures,
			runs: aiRuns,
		},
	};
}

function buildAuditPolicyFromRuntime({ cli = {}, env = {}, opts = {} } = {}) {
	const optsAudit = (opts && typeof opts === "object" && opts.audit && typeof opts.audit === "object") ? opts.audit : {};
	const mode = cli.mode || optsAudit.mode || env.FLOW_AUDIT_MODE || "warn";
	const cliAllow = parseCsvSet(cli.allowActions || "");
	const cliDeny = parseCsvSet(cli.denyActions || "");
	const envAllow = parseCsvSet(env.FLOW_AUDIT_ALLOW_ACTIONS || "");
	const envDeny = parseCsvSet(env.FLOW_AUDIT_DENY_ACTIONS || "");
	const optsAllow = new Set((Array.isArray(optsAudit.allowActions) ? optsAudit.allowActions : []).map(normActionType).filter(Boolean));
	const optsDeny = new Set((Array.isArray(optsAudit.denyActions) ? optsAudit.denyActions : []).map(normActionType).filter(Boolean));
	const allow = new Set([...optsAllow, ...envAllow, ...cliAllow]);
	const deny = new Set([...optsDeny, ...envDeny, ...cliDeny]);
	const sensitiveArgKeys = Array.isArray(optsAudit.sensitiveArgKeys) ? optsAudit.sensitiveArgKeys : [];

	const aiEnabled = parseBool(
		(cli.aiEnabled !== undefined && cli.aiEnabled !== null && cli.aiEnabled !== "") ? cli.aiEnabled
			: (optsAudit?.ai?.enabled !== undefined ? optsAudit.ai.enabled : env.FLOW_AUDIT_AI_ENABLED),
		false
	);
	const aiTier = asText(cli.aiTier || optsAudit?.ai?.tier || env.FLOW_AUDIT_AI_TIER || "balanced") || "balanced";
	const aiProvider = asText(cli.aiProvider || optsAudit?.ai?.provider || env.FLOW_AUDIT_AI_PROVIDER || "");
	const aiModel = asText(cli.aiModel || optsAudit?.ai?.model || env.FLOW_AUDIT_AI_MODEL || "");
	const aiTimeoutMsRaw = Number(cli.aiTimeoutMs || optsAudit?.ai?.timeoutMs || env.FLOW_AUDIT_AI_TIMEOUT_MS || 45000);
	const aiIncludeRunJsWithCode = parseBool(
		(cli.aiIncludeRunJsWithCode !== undefined && cli.aiIncludeRunJsWithCode !== null && cli.aiIncludeRunJsWithCode !== "") ? cli.aiIncludeRunJsWithCode
			: (optsAudit?.ai?.includeRunJsWithCode !== undefined ? optsAudit.ai.includeRunJsWithCode : env.FLOW_AUDIT_AI_RUN_JS_WITH_CODE),
		false
	);

	return {
		mode: normalizeMode(mode),
		allowActions: Array.from(allow),
		denyActions: Array.from(deny),
		sensitiveArgKeys,
		ai: {
			enabled: aiEnabled,
			tier: aiTier,
			provider: aiProvider,
			model: aiModel,
			timeoutMs: Number.isFinite(aiTimeoutMsRaw) ? Math.max(5000, aiTimeoutMsRaw) : 45000,
			includeRunJsWithCode: aiIncludeRunJsWithCode,
		},
	};
}

export {
	auditFlow,
	buildAuditPolicyFromRuntime,
};
