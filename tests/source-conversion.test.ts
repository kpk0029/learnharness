/**
 * source-conversion (import front door, owner 2026-11-02): binary sources
 * convert to text BEFORE the pipeline. Classification (detectSourceKind),
 * the vision rule (pageNeedsVision), and convertSource over generated PDFs
 * (tests/fixtures/make-pdf.ts) and a 1px PNG, with faux transcriber
 * engines and a fake headless renderer — no real model, no real render
 * except where a test says so.
 *
 * Note: the committed tests/fixtures/sample-3page.pdf has very short pages
 * (28–57 chars), so under the 200-char vision rule every one of its pages
 * goes to vision; the "text-only, no model call" case uses a generated
 * text-rich PDF instead.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import {
	convertSource,
	detectSourceKind,
	pageNeedsVision,
	SourceRejectedError,
	TRANSCRIBER_INSTRUCTIONS,
	VISION_FIGURE_TEXT_CHARS,
	VISION_MIN_TEXT_CHARS,
} from "../src/agent/subagents/source-conversion.ts";
import { MAX_SOURCE_BYTES } from "../src/core/source-import.ts";
import { bodyText, makePdf } from "./fixtures/make-pdf.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

const PNG_1PX = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

interface SeenCall { system: string; text: string; images: { mimeType: string; data: string }[] }

/** A faux transcriber: every call answers `reply(n)` and records what the
 *  model saw (system prompt, user text, image parts). */
function fauxTranscriber(reply: (n: number) => string = (n) => `FAUX TRANSCRIPTION ${n}`) {
	const faux = createFauxCore({});
	const seen: SeenCall[] = [];
	const step: FauxResponseStep = (context) => {
		const user = context.messages.find((m) => m.role === "user") as { content: unknown } | undefined;
		const parts = Array.isArray(user?.content) ? (user!.content as { type: string; text?: string; data?: string; mimeType?: string }[]) : [];
		seen.push({
			system: context.messages
				.filter((m) => m.role === "system")
				.map((m) => { const c = (m as { content: unknown }).content; return typeof c === "string" ? c : (c as { text: string }[]).map((t) => t.text).join(""); })
				.join(""),
			text: parts.filter((p) => p.type === "text").map((p) => p.text).join(""),
			images: parts.filter((p) => p.type === "image").map((p) => ({ mimeType: p.mimeType!, data: p.data! })),
		});
		return fauxAssistantMessage(reply(seen.length));
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, seen };
}

function fakeHeadless(): HeadlessApi & { requested: number[][]; paths: string[] } {
	const requested: number[][] = [];
	const paths: string[] = [];
	return {
		requested,
		paths,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unused"); },
		renderSvg: async () => { throw new Error("unused"); },
		renderPdfPages: async (pdfPath, pages, opts) => {
			paths.push(pdfPath);
			assert.deepEqual(opts, { dpi: 150, maxEdgePx: 2000 });
			requested.push([...pages]);
			return pages.map((page) => ({ page, png: PNG_1PX }));
		},
	};
}

const noop = () => {};

describe("detectSourceKind", () => {
	const pdf = makePdf([bodyText("x")]);
	const cases: [string, Uint8Array, string][] = [
		["notes.pdf", pdf, "pdf"],
		["renamed.txt", pdf, "pdf"],
		["photo.png", PNG_1PX, "png"],
		["scan.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "jpeg"],
		["notes.md", new TextEncoder().encode("# Notes\nplain text"), "text"],
		["notes.unknownext", new TextEncoder().encode("anything textual"), "text"],
	];
	for (const [name, bytes, kind] of cases) it(`${name} → ${kind}`, () => {
		assert.equal(detectSourceKind(name, bytes), kind);
	});

	it("leading junk before %PDF- within 1024 bytes still reads as pdf", () => {
		const bytes = Buffer.concat([Buffer.alloc(100, 0x20), pdf]);
		assert.equal(detectSourceKind("x.pdf", bytes), "pdf");
	});

	const rejects = (name: string, bytes: Uint8Array, reason: SourceRejectedError["reason"], message: RegExp) => {
		assert.throws(() => detectSourceKind(name, bytes), (err) => {
			assert.ok(err instanceof SourceRejectedError);
			assert.equal(err.reason, reason);
			assert.match(err.message, message);
			return true;
		});
	};

	it("a binary extension without its magic is invalid, named by the extension", () => {
		const text = new TextEncoder().encode("just text");
		rejects("fake.pdf", text, "invalid", /not a valid PDF/);
		rejects("fake.PNG", text, "invalid", /not a valid PNG/);
		rejects("fake.jpg", text, "invalid", /not a valid JPEG/);
		rejects("fake.jpeg", text, "invalid", /not a valid JPEG/);
	});

	it("a NUL byte in the first 8 KB is unsupported", () => {
		rejects("blob.bin", new Uint8Array([0x41, 0x00, 0x42]), "unsupported", /Unsupported file type/);
		const late = new Uint8Array(9000).fill(0x41);
		late[8500] = 0;
		assert.equal(detectSourceKind("late.txt", late), "text", "a NUL past 8 KB is not sniffed");
	});

	it("over MAX_SOURCE_BYTES is too large, before any other check", () => {
		rejects("big.md", new Uint8Array(MAX_SOURCE_BYTES + 1), "too_large", /too large/);
	});
});

describe("pageNeedsVision (D4)", () => {
	const page = (text_length: number, image_count = 0) => ({ page: 1, text_length, image_count, math_density: 0 });
	it("text under 200 chars → vision; 200 keeps the text layer", () => {
		assert.equal(VISION_MIN_TEXT_CHARS, 200);
		assert.equal(pageNeedsVision(page(199)), true);
		assert.equal(pageNeedsVision(page(200)), false);
		assert.equal(pageNeedsVision(page(0)), true, "blank pages are not skipped");
	});
	it("a page with an image and text under 600 → vision; 600 keeps the text layer", () => {
		assert.equal(VISION_FIGURE_TEXT_CHARS, 600);
		assert.equal(pageNeedsVision(page(599, 1)), true);
		assert.equal(pageNeedsVision(page(600, 1)), false);
		assert.equal(pageNeedsVision(page(599, 0)), false, "no image: the 200 rule alone");
	});
	it("math density never sends a page", () => {
		assert.equal(pageNeedsVision({ page: 1, text_length: 1000, image_count: 0, math_density: 0.9 }), false);
	});
});

describe("convertSource", () => {
	let tmpRoot: string;
	before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-conv-test-")); });
	after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
	const tmpEmpty = () => assert.deepEqual(fs.readdirSync(tmpRoot), [], "temp dir removed");

	it("a text-rich PDF keeps its text layer: no render, no model call", async () => {
		const { engine, seen } = fauxTranscriber();
		const headless = fakeHeadless();
		const phases: string[] = [];
		const bytes = makePdf([bodyText("Calculus"), bodyText("Physics"), bodyText("Chemistry")]);
		const out = await convertSource({ filePath: "text.pdf", bytes, kind: "pdf", engine, headless, tmpRoot, onPhase: (p) => phases.push(p), onStep: noop });
		assert.equal(seen.length, 0);
		assert.deepEqual(headless.requested, []);
		assert.deepEqual(out.transcribedPages, []);
		assert.equal(out.pages, 3);
		assert.deepEqual(phases, ["reading"]);
		assert.match(out.text, /Calculus line 1/);
		assert.ok(out.text.indexOf("Calculus") < out.text.indexOf("Physics") && out.text.indexOf("Physics") < out.text.indexOf("Chemistry"));
		assert.match(out.text, /Calculus line 1[^\n]*\n\s*Calculus line 2/, "line breaks kept");
		assert.ok(!/Page \d/.test(out.text), "no page headers");
		tmpEmpty();
	});

	it("the committed short-page fixture sends every page to vision (each < 200 chars)", async () => {
		const { engine, seen } = fauxTranscriber();
		const headless = fakeHeadless();
		const out = await convertSource({ filePath: "sample.pdf", bytes: fs.readFileSync(FIXTURE), kind: "pdf", engine, headless, tmpRoot, onPhase: noop, onStep: noop });
		assert.deepEqual(headless.requested, [[1, 2, 3]]);
		assert.equal(seen.length, 3);
		assert.deepEqual(out.transcribedPages, [1, 2, 3]);
		tmpEmpty();
	});

	it("mixed PDF: only the blank page renders and its transcription lands in position 2", async () => {
		const { engine, seen } = fauxTranscriber(() => "FAUX PAGE TWO");
		const headless = fakeHeadless();
		const phases: string[] = [];
		const steps: string[] = [];
		const bytes = makePdf([bodyText("Alpha"), null, bodyText("Omega")]);
		const out = await convertSource({
			filePath: "mixed.pdf", bytes, kind: "pdf", engine, headless, tmpRoot,
			onPhase: (p) => phases.push(p), onStep: (usage, model) => steps.push(`${model}:${usage.output > 0}`),
		});
		assert.deepEqual(headless.requested, [[2]]);
		assert.equal(path.basename(headless.paths[0]!), "source.pdf", "fixed temp name, never the user's");
		assert.equal(path.dirname(path.dirname(headless.paths[0]!)), tmpRoot);
		assert.deepEqual(out.transcribedPages, [2]);
		assert.deepEqual(phases, ["reading", "transcribing"]);
		const [a, b, c] = out.text.split("\n\n");
		assert.match(a!, /Alpha line 1/);
		assert.equal(b, "FAUX PAGE TWO");
		assert.match(c!, /Omega line 1/);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.system, TRANSCRIBER_INSTRUCTIONS);
		assert.equal(seen[0]!.text, 'Transcribe page 2 of 3 of "mixed.pdf".');
		assert.equal(seen[0]!.images[0]!.mimeType, "image/png");
		assert.equal(seen[0]!.images[0]!.data, PNG_1PX.toString("base64"));
		assert.equal(steps.length, 1, "one billed step reported");
		assert.match(steps[0]!, /^faux:/, "provider-qualified model stamp");
		tmpEmpty();
	});

	it("renders fallback pages in batches of 6 and passes the gate per page", async () => {
		const { engine, seen } = fauxTranscriber((n) => `T${n}`);
		const headless = fakeHeadless();
		let gated = 0;
		const bytes = makePdf(Array.from({ length: 8 }, () => null));
		const out = await convertSource({
			filePath: "blank.pdf", bytes, kind: "pdf", engine, headless, tmpRoot, onPhase: noop, onStep: noop,
			gate: async (fn) => { gated++; return fn(); },
		});
		assert.deepEqual(headless.requested, [[1, 2, 3, 4, 5, 6], [7, 8]]);
		assert.equal(seen.length, 8);
		assert.equal(gated, 8);
		assert.deepEqual(out.transcribedPages, [1, 2, 3, 4, 5, 6, 7, 8]);
		tmpEmpty();
	});

	it("over 100 pages is refused before any page is read or a model is called", async () => {
		const { engine, seen } = fauxTranscriber();
		const headless = fakeHeadless();
		const phases: string[] = [];
		const bytes = makePdf(Array.from({ length: 101 }, () => null));
		await assert.rejects(
			convertSource({ filePath: "long.pdf", bytes, kind: "pdf", engine, headless, tmpRoot, onPhase: (p) => phases.push(p), onStep: noop }),
			(err) => err instanceof SourceRejectedError && err.reason === "too_many_pages" && err.message === "PDF has 101 pages; the limit is 100.",
		);
		assert.deepEqual(phases, [], "never reached the reading phase");
		assert.equal(seen.length, 0);
		assert.deepEqual(headless.requested, []);
		tmpEmpty();
	});

	it("garbage PDF bytes are unreadable", async () => {
		const { engine } = fauxTranscriber();
		const bytes = Buffer.from("%PDF-1.4\nthis is not really a pdf at all\n");
		await assert.rejects(
			convertSource({ filePath: "bad.pdf", bytes, kind: "pdf", engine, headless: fakeHeadless(), tmpRoot, onPhase: noop, onStep: noop }),
			(err) => err instanceof SourceRejectedError && err.reason === "unreadable" && err.message === "This PDF could not be read.",
		);
		tmpEmpty();
	});

	it("a PNG goes to one transcription with the image part", async () => {
		const { engine, seen } = fauxTranscriber(() => "  # A photographed page  \n");
		const phases: string[] = [];
		const out = await convertSource({ filePath: "photo.png", bytes: PNG_1PX, kind: "png", engine, tmpRoot, onPhase: (p) => phases.push(p), onStep: noop });
		assert.equal(out.text, "# A photographed page", "trimmed");
		assert.deepEqual(out.transcribedPages, [1]);
		assert.equal(out.pages, undefined);
		assert.deepEqual(phases, ["transcribing"]);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.text, 'Transcribe the image "photo.png".');
		assert.equal(seen[0]!.images.length, 1);
		assert.equal(seen[0]!.images[0]!.mimeType, "image/png");
		tmpEmpty();
	});

	it("one page failing fails the whole file, naming the page", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => { throw new Error("synthetic vision outage"); }]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const bytes = makePdf([bodyText("Alpha"), null]);
		await assert.rejects(
			convertSource({ filePath: "f.pdf", bytes, kind: "pdf", engine, headless: fakeHeadless(), tmpRoot, onPhase: noop, onStep: noop }),
			/^Error: Page 2 could not be transcribed: /,
		);
		tmpEmpty();
	});

	it("an abort during transcription rejects with an AbortError and cleans the temp dir", async () => {
		const faux = createFauxCore({});
		const ctrl = new AbortController();
		faux.setResponses([(_context, options) => new Promise((resolve) => {
			const sig = options?.signal;
			const done = () => resolve(fauxAssistantMessage("late"));
			if (sig?.aborted) return done();
			sig?.addEventListener("abort", done, { once: true });
			ctrl.abort();
		})]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const bytes = makePdf([null]);
		await assert.rejects(
			convertSource({ filePath: "a.pdf", bytes, kind: "pdf", engine, headless: fakeHeadless(), tmpRoot, signal: ctrl.signal, onPhase: noop, onStep: noop }),
			(err) => (err as Error).name === "AbortError",
		);
		tmpEmpty();
	});
});
