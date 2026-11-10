/**
 * Tests for src/core/cost-summary.ts — the graph cost pill's pure fold.
 * Same laws as the money channel everywhere: dollars INFERRED at read
 * time (core/prices.ts), unpriced models excluded-but-counted (render
 * "—", never a silent zero), tokens always sum.
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	graphCostSummary as foldGraphCostSummary,
	type CostSummaryInput,
	type GraphCostSummary,
} from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage } from "../src/core/contracts.ts";
import { callCost } from "../src/server/pricing.ts";
const graphCostSummary = (input: CostSummaryInput) => foldGraphCostSummary(input, callCost);

/** A model with full published pricing (from the generated registry). */
const PRICED = "openrouter:z-ai/glm-5.3-flash";
assert.notEqual(callCost({ inputTokens: 1, outputTokens: 1 }, PRICED), null);

const step = (input: number, output: number): CallUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: 0,
	cacheWriteTokens: undefined,
	reasoningTokens: 0,
});

const extractionRun = (
	startedAt: number,
	extractorModel: string,
	auditorModel: string,
	stats?: ExtractionRunUsage["stats"],
): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 10_000,
	stages: {
		extractor: { model: extractorModel, steps: [step(1000, 200)] },
		auditor: { model: auditorModel, steps: [step(2000, 100)] },
	},
	...(stats ? { stats } : {}),
});

const transcriptionRun = (startedAt: number, model: string, steps: CallUsage[] = [step(3000, 400)]): ExtractionRunUsage => ({
	startedAt,
	at: new Date(startedAt).toISOString(),
	durationMs: 5_000,
	stages: { transcriber: { model, steps } },
});

describe("graphCostSummary (the cost pill's fold)", () => {
	test("folds both channels: stage totals, tokens, newest-first runs", () => {
		// (The cluster-naming channel died with the extraction-UX close-out,
		// 2026-09-24 — two channels: chat + notes front doors.)
		const input: CostSummaryInput = {
			chats: [{ title: "Testing session", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/modal.md", extractions: [extractionRun(200, PRICED, PRICED)] }],
		};
		const s = graphCostSummary(input);
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		assert.equal(s.stages.extraction.dollars, extStep * 2);
		assert.equal(s.stages.audit.dollars, audStep * 2);
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.extraction.tokens.inputTokens, 2000);
		assert.equal(s.stages.audit.tokens.outputTokens, 200);
		assert.equal(s.totalDollars, extStep * 2 + audStep * 2);
		// Both runs, newest first, titles joined per front door — every
		// run is kind "extraction" now.
		assert.deepEqual(
			s.runs.map((r) => r.title),
			["/vault/modal.md", "Testing session"],
		);
		assert.deepEqual(s.runs.map((r) => r.kind), ["extraction", "extraction"]);
		assert.equal(s.unpricedRuns, 0);
	});

	test("unpriced models: excluded dollars, counted honestly, run null only when BOTH stages unpriced", () => {
		const s: GraphCostSummary = graphCostSummary({
			chats: [{ title: "partial", extractions: [extractionRun(100, PRICED, "unknown-model")] }],
			sources: [{ filePath: "/vault/x.md", extractions: [extractionRun(200, "unknown-model", "unknown-model")] }],
		});
		assert.equal(s.stages.audit.unpricedRuns, 2);
		assert.equal(s.stages.audit.dollars, 0); // never a silent zero: unpricedRuns says it
		assert.equal(s.stages.extraction.unpricedRuns, 1);
		// The partial run still prices its extractor side; the fully
		// unpriced run renders "—". Newest first: 200 (both unpriced), 100.
		assert.equal(s.runs[0]!.dollars, null);
		assert.notEqual(s.runs[1]!.dollars, null);
		assert.equal(s.unpricedRuns, 1); // run-level: only the both-stages run
	});

	test("recent runs cap: newest survive", () => {
		const extractions = [1, 2, 3, 4].map((n) => extractionRun(n * 100, PRICED, PRICED));
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions }],
			sources: [],
			recentCap: 2,
		});
		assert.equal(s.runs.length, 2);
		assert.deepEqual(s.runs.map((r) => r.startedAt), [400, 300]);
		// stage totals still count EVERY run, cap is presentational.
		assert.equal(s.stages.extraction.runs, 4);
	});

	test("failed runs carry no merged stats; empty input folds to zero", () => {
		const s = graphCostSummary({
			chats: [{ title: "failed", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [],
		});
		assert.equal(s.runs[0]!.merged, undefined);
		const empty = graphCostSummary({ chats: [], sources: [] });
		assert.equal(empty.totalDollars, 0);
		assert.equal(empty.runs.length, 0);
		assert.equal(empty.stages.extraction.tokens.inputTokens, undefined);
	});

	test("no transcription records: stages.transcription is absent", () => {
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions: [extractionRun(100, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/x.md", extractions: [extractionRun(200, PRICED, PRICED)] }],
		});
		assert.equal("transcription" in s.stages, false);
		assert.deepEqual(Object.keys(s.stages), ["extraction", "audit"]);
	});

	test("transcription records fold into stages.transcription: dollars, tokens, totals, run kind", () => {
		const s = graphCostSummary({
			chats: [],
			sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(100, PRICED), transcriptionRun(150, PRICED)] }],
		});
		const trStep = callCost(step(3000, 400), PRICED)!;
		assert.ok(s.stages.transcription);
		assert.equal(s.stages.transcription.runs, 2);
		assert.equal(s.stages.transcription.dollars, trStep * 2);
		assert.equal(s.stages.transcription.unpricedRuns, 0);
		assert.equal(s.stages.transcription.tokens.inputTokens, 6000);
		assert.equal(s.stages.transcription.tokens.outputTokens, 800);
		// No phantom extraction/audit stage-runs from a transcription record.
		assert.equal(s.stages.extraction.runs, 0);
		assert.equal(s.stages.audit.runs, 0);
		assert.equal(s.stages.extraction.unpricedRuns, 0);
		assert.equal(s.totalDollars, trStep * 2);
		assert.deepEqual(s.runs.map((r) => r.kind), ["transcription", "transcription"]);
		assert.equal(s.runs[0]!.dollars, trStep);
		assert.equal(s.runs[0]!.tokens.inputTokens, 3000);
		assert.equal(s.runs[0]!.merged, undefined);
		assert.equal(s.unpricedRuns, 0);
	});

	test("unpriced transcription: excluded dollars, counted at stage and run level", () => {
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/a.png", extractions: [transcriptionRun(100, "unknown-model")] }] });
		assert.equal(s.stages.transcription!.unpricedRuns, 1);
		assert.equal(s.stages.transcription!.dollars, 0);
		assert.equal(s.stages.transcription!.tokens.inputTokens, 3000, "tokens always sum");
		assert.equal(s.runs[0]!.dollars, null);
		assert.equal(s.unpricedRuns, 1);
		assert.equal(s.totalDollars, 0);
	});

	test("subscription transcription: plan-billed, neither dollars nor unpriced", () => {
		const s = graphCostSummary({ chats: [], sources: [{ filePath: "/vault/a.png", extractions: [transcriptionRun(100, "chatgpt:fixture")] }] });
		assert.equal(s.stages.transcription!.subscriptionRuns, 1);
		assert.deepEqual(s.stages.transcription!.subscriptionProviders, ["ChatGPT"]);
		assert.equal(s.stages.transcription!.unpricedRuns, 0);
		assert.equal(s.subscriptionRuns, 1);
		assert.deepEqual(s.subscriptionProviders, ["ChatGPT"]);
		assert.equal(s.runs[0]!.subscriptionRuns, 1);
		assert.equal(s.runs[0]!.dollars, null);
		assert.equal(s.unpricedRuns, 0, "a wholly plan-billed transcription run is not unpriced");
	});

	test("a source mixing both record kinds folds each into its own stages", () => {
		const s = graphCostSummary({
			chats: [{ title: "chat", extractions: [extractionRun(50, PRICED, PRICED)] }],
			sources: [{ filePath: "/vault/scan.pdf", extractions: [transcriptionRun(100, PRICED), extractionRun(101, PRICED, "unknown-model", { nodes: 3, chains: 1 })] }],
		});
		const extStep = callCost(step(1000, 200), PRICED)!;
		const audStep = callCost(step(2000, 100), PRICED)!;
		const trStep = callCost(step(3000, 400), PRICED)!;
		assert.equal(s.stages.extraction.runs, 2);
		assert.equal(s.stages.audit.runs, 2);
		assert.equal(s.stages.audit.unpricedRuns, 1);
		assert.equal(s.stages.transcription!.runs, 1);
		assert.equal(s.stages.transcription!.unpricedRuns, 0);
		assert.equal(s.totalDollars, extStep * 2 + audStep + trStep);
		assert.deepEqual(s.runs.map((r) => [r.kind, r.title]), [
			["extraction", "/vault/scan.pdf"],
			["transcription", "/vault/scan.pdf"],
			["extraction", "chat"],
		]);
		assert.deepEqual(s.runs[0]!.merged, { nodes: 3, chains: 1 });
		assert.equal(s.unpricedRuns, 0);
	});
});
