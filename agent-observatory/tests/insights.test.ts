import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { SessionTrajectory } from "../shared/trajectory";
import type { InsightJob, InsightReport } from "../shared/insights";
import { assessTrajectory, buildAnalysisPrompt, buildAnalysisRequest, isUsefulInsightReport, parseInsightText, redactSecrets } from "../server/insight-analysis";
import { InsightManager, type InsightManagerOptions } from "../server/insights";
import { fakeClaude, FAKE_CLAUDE_PLAN, type FakeRun } from "./fake-claude";
import { ANALYSIS_SYSTEM_PROMPT } from "../server/analysis-prompt";

const paseo = {} as PaseoApi;
function trajectory(turns = 3, tools = 3, length = 12): SessionTrajectory {
  return { agent: { id: "agent-a", title: "Investigate", provider: "codex", model: "m", cwd: "/repo", workspaceId: "w", archivedAt: null, status: "idle", attentionReason: "finished" },
    project: { id: "p", name: "Project", rootPath: "/repo" }, capturedAt: "2026-09-16T12:00:00Z",
    rows: Array.from({ length }, (_, index) => ({ ref: `ref-${index}`, epoch: "e", seqStart: index, seqEnd: index, at: "2026-09-16T12:00:00Z", turnId: null,
      kind: index < turns ? "user_message" : index < turns + tools ? "tool_call" : "assistant_message", text: "Sample evidence", toolName: null, toolStatus: null })),
    coverage: { complete: true, hasOlder: false, hasNewer: false, gap: false, truncated: false, reason: null, projectedItems: length, characters: length * 15, pages: 1, firstAt: null, lastAt: null, epoch: "e" },
    counts: { userTurns: turns, assistantMessages: length - turns - tools, tools, toolFailures: 0, errors: 0, observedTurnIds: 0 },
    completionEvidence: { kind: "attention_finished", at: null } };
}
function report(evidence = ["ref-3"]): InsightReport { return { summary: "执行过程清晰", health: "watch", confidence: "high",
  findings: [{ id: "one", severity: "low", category: "efficiency", title: "减少重复读取", detail: "重复读取相同输出", evidence, recommendation: "复用结果" }], strengths: ["已有验证"], nextActions: ["检查结果"], limitations: [] }; }
const output = () => JSON.stringify({ structured_output: report(), usage: { input_tokens: 30, output_tokens: 20 }, total_cost_usd: 0.002 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture({ run = async () => output(), ...options }: InsightManagerOptions & { run?: FakeRun } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-insight-test-"));
  const { runPaseo, registry } = fakeClaude(run);
  const manager = new InsightManager({ directory, fetch: async () => trajectory(), runPaseo, registry, ...options });
  return { directory, manager, async close() { await manager.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function waitFor(manager: InsightManager, id: string, status: InsightJob["status"]) {
  for (let index = 0; index < 200; index++) { const job = (await manager.state()).jobs.find(job => job.id === id); if (job?.status === status) return job; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`Analysis did not reach ${status}`);
}
test("manual and automatic analysis enforce multiple turns and tools", () => {
  assert.equal(assessTrajectory(trajectory(1, 3), "manual").eligible, false);
  assert.equal(assessTrajectory(trajectory(2, 1), "manual").eligible, false);
  assert.equal(assessTrajectory(trajectory(2, 2), "manual").eligible, true);
  assert.equal(assessTrajectory(trajectory(2, 3), "auto").eligible, false);
  assert.equal(assessTrajectory(trajectory(3, 2), "auto").eligible, false);
  assert.equal(assessTrajectory(trajectory(3, 3, 8), "auto").eligible, false);
  const failure = trajectory(3, 3, 8); failure.counts.toolFailures = 1;
  assert.equal(assessTrajectory(failure, "auto").eligible, true);
  failure.agent.status = "running"; assert.equal(assessTrajectory(failure, "auto").eligible, false);
});
test("unknown evidence is removed and reduces confidence even beside valid evidence", () => {
  const parsed = parseInsightText(JSON.stringify(report(["ref-3", "invented", "ref-3"])), new Set(["ref-3"]));
  assert.deepEqual(parsed.report.findings[0].evidence, ["ref-3"]); assert.equal(parsed.report.confidence, "low");
  const unsupported = parseInsightText(JSON.stringify({ ...report(["invented"]), health: "blocked" }), new Set());
  assert.equal(unsupported.report.findings.length, 0); assert.equal(unsupported.report.health, "watch");
});
test("JSON report parser handles CLI envelope and rejects malformed schemas", () => {
  assert.equal(parseInsightText(output(), new Set(["ref-3"])).usage?.outputTokens, 20);
  assert.equal(parseInsightText(JSON.stringify({ text: `\`\`\`json\n${JSON.stringify(report())}\n\`\`\`` }), new Set(["ref-3"])).report.summary, "执行过程清晰");
  assert.throws(() => parseInsightText("not JSON", new Set()), /JSON/);
  assert.throws(() => parseInsightText('{"summary":"incomplete"}', new Set()), /字段/);
});
test("prompt redaction covers JSON fields, credentials, metadata and URL passwords", () => {
  const secrets = ["ghp_" + "a".repeat(28), "xai-" + "b".repeat(28), "private-password-value", "metadata-secret-value", "url-password-value"];
  const input = trajectory();
  input.rows[0].text = JSON.stringify({ api_key: secrets[0], password: secrets[2], token: secrets[1], remote: `https://user:${secrets[4]}@example.test` });
  input.agent.title = `password=${secrets[3]}`;
  const prompt = buildAnalysisPrompt(input);
  for (const secret of secrets) assert.equal(prompt.includes(secret), false, secret);
  assert.match(prompt, /待分析的历史数据/); assert.match(redactSecrets('"authorization": "Bearer 1234567890abcdef"'), /redacted/);
});
test("manager deduplicates repeated requests while queued or running", async () => {
  const gate = deferred<string>(); let calls = 0;
  const f = await fixture({ run: async () => { calls++; return gate.promise; } });
  try {
    const first = await f.manager.start(paseo, "agent-a"); await waitFor(f.manager, first.id, "analyzing");
    const second = await f.manager.start(paseo, "agent-a"); assert.equal(first.id, second.id);
    gate.resolve(output()); await waitFor(f.manager, first.id, "completed"); assert.equal(calls, 1);
  } finally { gate.resolve(output()); await f.close(); }
});
test("cancellation during collection prevents model invocation", async () => {
  const gate = deferred<SessionTrajectory>(); let calls = 0;
  const f = await fixture({ fetch: async () => gate.promise, run: async () => { calls++; return output(); } });
  try {
    const job = await f.manager.start(paseo, "agent-a"); await waitFor(f.manager, job.id, "collecting");
    await f.manager.cancel(job.id); gate.resolve(trajectory()); await f.manager.close();
    assert.equal(calls, 0); assert.equal((await f.manager.state()).jobs[0].status, "canceled");
  } finally { gate.resolve(trajectory()); await f.close(); }
});
test("late model response cannot publish a canceled report", async () => {
  const gate = deferred<string>(); const f = await fixture({ run: async () => gate.promise });
  try {
    const job = await f.manager.start(paseo, "agent-a"); await waitFor(f.manager, job.id, "analyzing");
    await f.manager.cancel(job.id); gate.resolve(output()); await f.manager.close();
    const state = await f.manager.state(); assert.equal(state.jobs[0].status, "canceled"); assert.equal(state.jobs[0].report, null);
  } finally { gate.resolve(output()); await f.close(); }
});
test("disabling automation cancels queued automatic jobs but preserves manual work", async () => {
  const gate = deferred<string>(); let calls = 0;
  const f = await fixture({ run: async () => { calls++; return gate.promise; } });
  try {
    await f.manager.configure(true);
    const first = await f.manager.start(paseo, "manual"); await waitFor(f.manager, first.id, "analyzing");
    const queued = await f.manager.start(paseo, "automatic", "auto"); assert.equal(queued.status, "queued");
    await f.manager.configure(false); assert.equal((await f.manager.state()).jobs.find(job => job.id === queued.id)?.status, "canceled");
    gate.resolve(output()); await waitFor(f.manager, first.id, "completed"); assert.equal(calls, 1);
    await assert.rejects(f.manager.start(paseo, "another", "auto"), /关闭/);
  } finally { gate.resolve(output()); await f.close(); }
});
test("reload converts persisted unfinished jobs to canceled without resuming them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-insight-reload-"));
  const at = "2026-09-16T12:00:00Z";
  const job: InsightJob = { id: "old", agentId: "a", agentTitle: "A", projectName: "P", createdAt: at, updatedAt: at,
    status: "analyzing", trigger: "auto", stage: "pending", eligibility: null, coverage: null, report: null, model: "grok-4.6", effort: "xhigh", usage: null, error: null };
  await writeFile(join(directory, "insights.json"), JSON.stringify({ version: 1, settings: { autoEnabled: true, minTurns: 3, minTools: 3, cooldownHours: 6 }, jobs: [job], fingerprints: {} }));
  let called = false; const manager = new InsightManager({ directory, ...fakeClaude(async () => { called = true; return output(); }) });
  try { const state = await manager.state(); assert.equal(state.settings.autoEnabled, false); assert.equal(state.jobs[0].status, "canceled"); assert.equal(called, false); }
  finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
test("saved reports exclude input trajectory and private user question", async () => {
  const privateMarker = "private-trajectory-never-persist-123";
  const input = trajectory(); input.rows[0].text = privateMarker;
  const f = await fixture({ fetch: async () => input });
  try { const job = await f.manager.start(paseo, "a", "manual", privateMarker); await waitFor(f.manager, job.id, "completed"); await f.manager.close();
    const files = [join(f.directory, "insight-index.json"), join(f.directory, "insight-settings.json"), ...(await readdir(join(f.directory, "insight-reports"))).filter(name => name.endsWith(".json")).map(name => join(f.directory, "insight-reports", name))];
    for (const path of files) assert.equal((await readFile(path, "utf8")).includes(privateMarker), false);
  } finally { await f.close(); }
});
test("analyses run as a locked-down Claude Code helper with the read-only analysis prompt", async () => {
  const seen: Array<Parameters<FakeRun>[0]> = [];
  const f = await fixture({ run: async call => { seen.push(call); return output(); } });
  try {
    const job = await f.manager.start(paseo, "a"); const completed = await waitFor(f.manager, job.id, "completed");
    assert.equal(seen.length, 1); assert.equal(seen[0].systemPrompt, ANALYSIS_SYSTEM_PROMPT); assert.equal(seen[0].model, FAKE_CLAUDE_PLAN.model);
    assert.deepEqual([completed.runner?.provider, completed.runner?.modeId, completed.runner?.kind], ["claude", "plan", "provider"]);
    assert.match(completed.runner?.sessionAgentId ?? "", /^helper-/); assert.equal(completed.model, FAKE_CLAUDE_PLAN.model);
  } finally { await f.close(); }
});
test("fresh installation does not read trajectories or call the model until automation is enabled", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, calls = 0;
  const f = await fixture({ fetch: async () => { reads++; return trajectory(); }, run: async () => { calls++; return output(); } });
  try {
    assert.equal((await f.manager.state()).settings.autoEnabled, false);
    f.manager.turnStarted("eligible"); f.manager.turnEnded("eligible");
    await f.manager.scheduleAuto(paseo, "eligible", 3, 3);
    context.mock.timers.tick(180000); await nextTick();
    await assert.rejects(f.manager.start(paseo, "eligible", "auto"), /关闭/);
    assert.equal((await f.manager.list()).nextScheduledAt, null);
    assert.equal((await f.manager.state()).jobs.length, 0);
    assert.equal(reads, 0); assert.equal(calls, 0);
    await f.manager.configure(true);
    await f.manager.scheduleAuto(paseo, "eligible", 3, 3);
    context.mock.timers.tick(90000);
    for (let index = 0; index < 100; index++) { await nextTick(); if ((await f.manager.state()).jobs.some(job => job.status === "completed")) break; }
    assert.equal((await f.manager.state()).jobs[0]?.status, "completed");
    assert.equal(reads, 1); assert.equal(calls, 1);
  } finally { await f.close(); context.mock.timers.reset(); }
});
test("reload preserves an explicitly enabled automation setting", async () => {
  const f = await fixture(); let restored: InsightManager | undefined;
  try {
    await f.manager.configure(true); await f.manager.close();
    restored = new InsightManager({ directory: f.directory, ...fakeClaude() });
    assert.equal((await restored.state()).settings.autoEnabled, true);
  } finally { await restored?.close(); await f.close(); }
});
test("automatic analysis waits 90 seconds after an eligible end and follow-up cancels it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; const f = await fixture({ run: async () => { calls++; return output(); } });
  try {
    await f.manager.configure(true);
    assert.equal((await f.manager.state()).settings.autoEnabled, true);
    await f.manager.scheduleAuto(paseo, "short", 2, 3);
    context.mock.timers.tick(90000); await nextTick(); assert.equal((await f.manager.state()).jobs.length, 0);
    await f.manager.scheduleAuto(paseo, "eligible", 3, 3);
    context.mock.timers.tick(89999); await nextTick(); assert.equal((await f.manager.state()).jobs.length, 0);
    f.manager.turnStarted("eligible"); context.mock.timers.tick(1); await nextTick(); assert.equal((await f.manager.state()).jobs.length, 0);
    await f.manager.scheduleAuto(paseo, "settled", 3, 3);
    context.mock.timers.tick(90000);
    for (let index = 0; index < 100; index++) { await nextTick(); if ((await f.manager.state()).jobs.some(job => job.status === "completed")) break; }
    assert.equal(calls, 1); assert.equal((await f.manager.state()).jobs[0].trigger, "auto");
  } finally { await f.close(); context.mock.timers.reset(); }
});
test("automatic repeats respect six-hour cooldown and unchanged evidence fingerprint", async () => {
  let now = Date.parse("2026-09-16T12:00:00Z"); let calls = 0; let input = trajectory();
  const f = await fixture({ now: () => now, fetch: async () => input, run: async () => { calls++; return output(); } });
  try {
    await f.manager.configure(true);
    const first = await f.manager.start(paseo, "a"); await waitFor(f.manager, first.id, "completed");
    input = trajectory(); input.rows[0].text = "new evidence";
    now += 3600000; const cooled = await f.manager.start(paseo, "a", "auto"); await waitFor(f.manager, cooled.id, "skipped");
    input = trajectory(); now += 6 * 3600000;
    const unchanged = await f.manager.start(paseo, "a", "auto"); await waitFor(f.manager, unchanged.id, "skipped");
    assert.equal(calls, 1);
  } finally { await f.close(); }
});
const emptyReport = () => ({ summary: "轨迹正文被截断，先读取完整待分析数据再出报告。", health: "watch", confidence: "low", findings: [], strengths: [], nextActions: [], limitations: ["内容容量"] });
test("empty or deferred analysis is rejected instead of accepted as completed", () => {
  assert.throws(() => parseInsightText(JSON.stringify(emptyReport()), new Set()), /实际分析/);
  assert.equal(isUsefulInsightReport({ ...report(), findings: [], strengths: [], nextActions: ["先读取完整轨迹再分析"] }), false);
  assert.equal(isUsefulInsightReport({ ...report(), findings: [], nextActions: [] }), true);
});
test("model evidence is bounded and distributed across many turns with exact refs", () => {
  const input = trajectory(50, 800, 1000);
  for (const row of input.rows) row.text = "beginning " + "embedded code content\n".repeat(3000) + " terminal result";
  input.rows[650].toolStatus = "failed";
  const normal = buildAnalysisRequest(input);
  const compact = buildAnalysisRequest(input, undefined, { compact: true });
  assert.ok(normal.prompt.length <= 120000); assert.ok(compact.prompt.length <= 70000);
  assert.ok(normal.evidence.length <= 180); assert.ok(compact.evidence.length <= 90);
  assert.ok(normal.references.has("ref-0")); assert.ok(normal.references.has("ref-999")); assert.ok(normal.references.has("ref-650"));
  assert.ok(normal.evidence.filter(row => row.kind === "user_message").length >= 2);
  assert.ok(normal.evidence.every(row => input.rows.some(source => source.ref === row.ref)));
  const data = JSON.parse(normal.prompt.split("<trajectory_data>")[1].split("</trajectory_data>")[0]);
  assert.equal(data.analysisWindow.sourceRows, 1000); assert.equal(data.analysisWindow.sampled, true);
  assert.match(normal.prompt, /现在就分析/); assert.match(compact.prompt, /上一次报告/);
});
test("an empty or malformed report fails the analysis and keeps no report", async () => {
  for (const text of [JSON.stringify(emptyReport()), "{invalid"]) {
    let calls = 0; const f = await fixture({ run: async () => { calls++; return text; } });
    try { const job = await f.manager.start(paseo, "a"); const result = await waitFor(f.manager, job.id, "failed"); assert.equal(calls, 1); assert.equal(result.report, null); assert.ok(result.error); }
    finally { await f.close(); }
  }
});
test("load reclassifies old completed empty reports as failed while retaining inspection data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-empty-report-"));
  const at = "2026-09-16T12:00:00Z";
  const old = { id: "old-empty", agentId: "a", agentTitle: "A", projectName: "P", createdAt: at, updatedAt: at,
    status: "completed", trigger: "manual", stage: "completed", eligibility: null, coverage: null, report: emptyReport(), model: "grok-4.6", effort: "xhigh", usage: null, error: null };
  await writeFile(join(directory, "insights.json"), JSON.stringify({ version: 1, settings: { autoEnabled: true, minTurns: 3, minTools: 3, cooldownHours: 6 }, jobs: [old], fingerprints: {} }));
  const manager = new InsightManager({ directory, ...fakeClaude() });
  try { const state = await manager.state(); assert.equal(state.jobs[0].status, "failed"); assert.match(state.jobs[0].error ?? "", /旧报告/); assert.equal(state.jobs[0].report?.summary, old.report.summary); }
  finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
test("Paseo 0.13: below the thresholds, the deeper count is asked only while automation is on", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let deeper = 0; const f = await fixture();
  try {
    const counted = async (minTurns: number, minTools: number) => { deeper++; assert.deepEqual([minTurns, minTools], [3, 3]); return { users: 4, tools: 5 }; };
    await f.manager.scheduleAuto(paseo, "window", 1, 1, undefined, counted);
    assert.equal(deeper, 0, "automation off: nothing read");
    await f.manager.configure(true);
    await f.manager.scheduleAuto(paseo, "enough", 3, 3, undefined, counted);
    assert.equal(deeper, 0, "the window already meets the thresholds");
    await f.manager.scheduleAuto(paseo, "window", 1, 1, undefined, counted);
    assert.equal(deeper, 1);
    assert.ok((await f.manager.list()).nextScheduledAt !== null, "the deeper count schedules the analysis");
  } finally { await f.close(); context.mock.timers.reset(); }
});
