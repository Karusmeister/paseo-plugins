import type { z } from "zod";
import type { PaseoApi } from "../server/paseo-types";
import { CLAUDE_LOCKDOWN_OPTIONS, type InsightRunnerPlan, type InsightRunnerRegistry, type PaseoStructuredRunOptions, type runPaseoStructured } from "../server/insight-runner";
import type { InsightRunner, InsightRunners } from "../shared/insights";

/**
 * Test double for the analysis helper, replacing the fake Grok CLI the tests used before the Grok runner was removed.
 * `run` gets what the helper would (prompt, schema, system prompt, signal) and returns the model's text; the real
 * runPaseoStructured's agent creation, permission denial and archiving are covered in insight-runner.test.ts.
 */
export type FakeRun = (options: { prompt: string; signal: AbortSignal; schema?: z.ZodType; systemPrompt?: string; model?: string; effort?: string; jobId: string; title?: string }) => Promise<string>;

/** What `auto` and the built-in choice resolve to: Claude Code, locked down. */
export const FAKE_CLAUDE_PLAN: InsightRunnerPlan = {
  info: { kind: "provider", label: "Claude Code · claude · Opus 5.5 · high", provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "high", modeId: "plan", sessionAgentId: null },
  model: "claude-opus-5-5", effort: "high", access: "read", featureValues: {},
  providerOptions: structuredClone(CLAUDE_LOCKDOWN_OPTIONS) as unknown as Record<string, unknown>, claudeLockdown: true,
};

/** A host whose Agents can be read back (suggestions look up the parent Agent before starting a helper). */
export const fakePaseo = {
  agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/repo", workspaceId: "workspace", title: "Agent", archivedAt: null }, project: null }) }) },
} as unknown as PaseoApi;

/** `auto` and provider runners resolve to `plan`; a profile resolves as that profile (its id as the label), like the real registry. */
export function fakePlan(runner: InsightRunner, plan: InsightRunnerPlan = FAKE_CLAUDE_PLAN): InsightRunnerPlan {
  const copy = structuredClone(plan);
  if (runner.kind === "profile") copy.info = { ...copy.info, kind: "profile", label: runner.profileId };
  return copy;
}

export function fakeClaude(run: FakeRun = async () => "", { plan = FAKE_CLAUDE_PLAN, resolve }: { plan?: InsightRunnerPlan; resolve?: (runner: InsightRunner) => Promise<InsightRunnerPlan> } = {}) {
  const calls: Array<Parameters<FakeRun>[0]> = [];
  let sessions = 0;
  const runPaseo = (async <T>(options: PaseoStructuredRunOptions<T>) => {
    const { signal } = options;
    if (signal.aborted) throw new Error("canceled");
    const runner = { ...options.plan.info, sessionAgentId: `helper-${++sessions}` };
    await options.onSession?.(runner);
    const call = { prompt: options.prompt, signal, schema: options.schema, systemPrompt: options.systemPrompt, model: options.plan.model, effort: options.plan.effort ?? undefined, jobId: options.jobId, title: options.title };
    calls.push(call);
    const text = await new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      run(call).then(resolve, reject);
    });
    const value = options.parse(text);
    const usage = (value as { usage?: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null }).usage ?? null;
    return { value, usage, runner };
  }) as typeof runPaseoStructured;
  const runners: InsightRunners = {
    auto: { runner: { kind: "auto" }, label: "Choose automatically", detail: null, providerLabel: plan.info.label, modelLabel: null, thinkingLabel: null, available: true, reason: null, access: "read", modeId: "plan" },
    builtin: { runner: { kind: "provider", provider: "claude", model: null, thinkingOptionId: null }, label: "Claude Code", detail: null, providerLabel: "Claude Code", modelLabel: "Opus 5.5", thinkingLabel: "high", available: true, reason: null, access: "read", modeId: "plan" },
    profiles: [], providers: [],
  };
  const registry = (_paseo: PaseoApi) => ({
    resolve: resolve ?? (async (runner: InsightRunner) => fakePlan(runner, plan)),
    runners: async () => structuredClone(runners),
    models: async (provider: string) => ({ provider, models: [] }),
  }) as unknown as InsightRunnerRegistry;
  return { runPaseo, registry, calls };
}
