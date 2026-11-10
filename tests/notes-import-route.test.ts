import assert from "node:assert/strict";
import { after, it } from "node:test";
import { POST } from "../app/api/graph/import/route.ts";
import { extraction } from "../src/server/index.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import { createExtractionPipeline, NotesImportError } from "../src/agent/subagents/extraction.ts";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { stores } from "../src/server/stores.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphNode, GraphChain, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";
import type { ModelRole } from "../config.ts";
import { MAX_SOURCE_BYTES } from "../src/core/source-import.ts";
import { bodyText, makePdf } from "./fixtures/make-pdf.ts";

// The route hands raw bytes to extraction.importSource (owner, 2026-11-02):
// the pipeline classifies and converts.
const original = extraction.importSource;
after(() => { extraction.importSource = original; });
function request(names: string[]) {
	return requestFiles(names.map((name) => new File(["identical text"], name)));
}
function requestFiles(files: File[]) {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

/** In-memory ledgers for the real-pipeline cases. */
function memoryGraph() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }, readCheckpoints: () => [...checkpoints],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	return { nodes, sources, graphStore };
}

/** Faux engines per role; counts model calls and engine resolutions. */
function fauxRoles(roles: readonly ModelRole[] = ["extractor", "auditor", "transcriber"]) {
	const calls: Record<string, number> = { extractor: 0, auditor: 0, transcriber: 0 };
	let resolutions = 0;
	const engineFor = (role: ModelRole) => {
		resolutions++;
		if (!roles.includes(role)) return undefined;
		const faux = createFauxCore({});
		faux.setResponses([() => {
			calls[role] = (calls[role] ?? 0) + 1;
			if (role === "transcriber") return fauxAssistantMessage("A transcribed page about synthetic imports.");
			return fauxAssistantMessage([fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor" ? {
				propositions: [{ id: "p1", name: "Synthetic import", statement: "Explicit notes imports process the whole file.", aliases: [] }], chains: [],
			} : { links: [] })], { stopReason: "toolUse" });
		}]);
		return { model: faux.getModel(), streamFn: faux.streamSimple };
	};
	return { calls, engineFor, resolutions: () => resolutions };
}

it("route keeps three-worker batching, request positions and mixed per-file outcomes/config details", async () => {
	let active = 0;
	let peak = 0;
	const seen: { filePath: string; text: string; isBytes: boolean }[] = [];
	extraction.importSource = async ({ filePath, bytes }) => {
		seen.push({ filePath, text: new TextDecoder().decode(bytes), isBytes: bytes instanceof Uint8Array });
		active++; peak = Math.max(peak, active);
		try {
			await new Promise((resolve) => setTimeout(resolve, filePath === "slow.md" ? 25 : 1));
			if (filePath === "models.md") throw new ModelsNotConfiguredError(["cheap"]);
			if (filePath === "key.md") throw new ProviderKeyMissingError("openai", ["cheap"]);
			if (["failed", "partial", "aborted", "busy"].includes(filePath)) throw new NotesImportError(filePath as NotesImportError["outcome"], { nodes: 2, chains: 1 }, `synthetic ${filePath}`);
			if (filePath === "unknown.md") throw new Error("synthetic unknown error");
			return { nodes: 0, chains: 0 };
		} finally { active--; }
	};
	const names = ["slow.md", "same.md", "same.md", "failed", "partial", "aborted", "busy", "models.md", "key.md", "unknown.md"];
	const response = await POST(request(names));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(peak, 3);
	assert.equal(seen.length, names.length);
	assert.ok(seen.every((s) => s.isBytes && s.text === "identical text"), "raw bytes reach importSource");
	assert.notEqual(results[0].requestIndex, 0, "out-of-order completion remains supported");
	assert.equal(results.length, names.length);
	for (const [requestIndex, filePath] of names.entries()) {
		const result = results.find((r: { requestIndex: number }) => r.requestIndex === requestIndex);
		assert.equal(result.filePath, filePath);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			assert.equal(result.outcome, filePath);
			assert.equal(result.ok, false);
			assert.deepEqual(result.stats, { nodes: 2, chains: 1 });
		} else if (["slow.md", "same.md"].includes(filePath)) {
			assert.equal(result.outcome, "completed"); assert.equal(result.ok, true);
		} else { assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); }
	}
	assert.deepEqual(results.find((r: { filePath: string }) => r.filePath === "models.md").missing, ["cheap"]);
	const key = results.find((r: { filePath: string }) => r.filePath === "key.md");
	assert.equal(key.code, "provider_key_missing"); assert.equal(key.provider, "openai"); assert.deepEqual(key.slots, ["cheap"]);
});

it("real route plus in-memory ledgers and faux stages reprocess identical imports for all four filename cases", async () => {
	const { nodes, sources, graphStore } = memoryGraph();
	const roles = fauxRoles();
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore, engineFor: roles.engineFor });
	extraction.importSource = pipeline.importSource;
	const names = ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"];
	for (let pass = 0; pass < 2; pass++) {
		const response = await POST(request(names));
		const { results } = await response.json();
		assert.equal(results.length, 4);
		assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"));
	}
	assert.equal(roles.calls.extractor, 8, "repeat identical imports execute real faux extractor calls");
	assert.equal(roles.calls.transcriber, 0);
	assert.equal(nodes.length, 8);
	assert.equal(sources.size, 4);
	assert.ok([...sources.values()].every((source) => source.extractions?.length === 2 && source.contentFp === undefined));
});

it("real route: a text-layer PDF needs no transcriber; a PNG takes exactly one", async () => {
	// (The committed sample-3page.pdf has pages under the 200-char vision
	// threshold — every page would transcribe — so a text-rich PDF is built.)
	const { sources, graphStore } = memoryGraph();
	const roles = fauxRoles();
	extraction.importSource = createExtractionPipeline({ chatStore: stores.chatStore, graphStore, engineFor: roles.engineFor }).importSource;
	const pdf = makePdf([bodyText("Calculus"), bodyText("Physics"), bodyText("Chemistry")]);
	const response = await POST(requestFiles([new File([new Uint8Array(pdf)], "text.pdf"), new File([new Uint8Array(PNG_1PX)], "photo.png")]));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, 2);
	assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"), JSON.stringify(results));
	assert.equal(roles.calls.transcriber, 1, "only the PNG went to vision");
	assert.equal(roles.calls.extractor, 2);
	const png = [...sources.values()].find((s) => s.filePath === "photo.png")!;
	assert.equal(png.extractions?.length, 2, "transcription + extraction records");
	const pdfSource = [...sources.values()].find((s) => s.filePath === "text.pdf")!;
	assert.equal(pdfSource.extractions?.length, 1, "no transcription record when nothing was billed");
});

it("real route: per-file refusals ride failed rows (size cap, page cap, missing vision model)", async () => {
	const { graphStore } = memoryGraph();
	const roles = fauxRoles();
	extraction.importSource = createExtractionPipeline({ chatStore: stores.chatStore, graphStore, engineFor: roles.engineFor }).importSource;
	const response = await POST(requestFiles([
		new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], "huge.md"),
		new File([new Uint8Array(makePdf(Array.from({ length: 101 }, () => null)))], "long.pdf"),
	]));
	const { results } = await response.json();
	const byName = (name: string) => results.find((r: { filePath: string }) => r.filePath === name);
	assert.equal(byName("huge.md").outcome, "failed");
	assert.equal(byName("huge.md").error, "File is too large (over 25 MB).");
	assert.equal(byName("long.pdf").outcome, "failed");
	assert.equal(byName("long.pdf").error, "PDF has 101 pages; the limit is 100.");
	assert.deepEqual(roles.calls, { extractor: 0, auditor: 0, transcriber: 0 });

	// The size cap is checked before any engine is even resolved.
	const sizeOnly = fauxRoles();
	extraction.importSource = createExtractionPipeline({ chatStore: stores.chatStore, graphStore, engineFor: sizeOnly.engineFor }).importSource;
	await POST(requestFiles([new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], "huge.png")]));
	assert.equal(sizeOnly.resolutions(), 0, "no engine resolution for an oversized file");

	const noVision = fauxRoles(["extractor", "auditor"]);
	extraction.importSource = createExtractionPipeline({ chatStore: stores.chatStore, graphStore, engineFor: noVision.engineFor }).importSource;
	const refused = await (await POST(requestFiles([new File([new Uint8Array(PNG_1PX)], "photo.png")]))).json();
	assert.equal(refused.results[0].code, "models_not_configured");
	assert.deepEqual(refused.results[0].missing, ["vision"]);
	assert.deepEqual(noVision.calls, { extractor: 0, auditor: 0, transcriber: 0 });
});

it("route returns 413 when the declared body is over the request cap", async () => {
	const form = new FormData();
	form.append("files", new File(["x"], "a.md"));
	let called = false;
	extraction.importSource = async () => { called = true; return { nodes: 0, chains: 0 }; };
	const response = await POST(new Request("http://localhost/api/graph/import", {
		method: "POST", body: form, headers: { "content-length": String(100 * 1024 * 1024 + 1) },
	}));
	assert.equal(response.status, 413);
	assert.deepEqual(await response.json(), { results: [], error: "request too large (over 100 MB)" });
	assert.equal(called, false);
});

it("route returns 400 for a malformed multipart body", async () => {
	const response = await POST(new Request("http://localhost/api/graph/import", {
		method: "POST", body: "definitely not multipart", headers: { "content-type": "multipart/form-data; boundary=nothing-here" },
	}));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "unreadable upload" });
});

it("route returns 400 without files", async () => {
	const response = await POST(request([]));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "no files" });
});
