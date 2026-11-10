import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NotesImportErrors, parseNotesImportResults, postNotesImport, useNotesImport, type NotesImportResult } from "../components/notes-import.tsx";

// Real hook/React state, isolated DOM and wholly stubbed import transport.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let current: ReturnType<typeof useNotesImport>;
let starts = 0;
let finishes = 0;
async function mount() {
	starts = 0;
	finishes = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	function Harness() {
		current = useNotesImport({ onStart: () => { starts++; }, onFinish: () => { finishes++; } });
		return <NotesImportErrors errors={current.errors} />;
	}
	await act(async () => { root!.render(<Harness />); });
}
async function submit(selected: File[] | null = [...files]) {
	await act(async () => { current.onImportFiles(selected as unknown as FileList | null); });
}
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
	host = undefined;
	globalThis.fetch = originalFetch;
});
const files = [new File(["one"], "same.md"), new File(["two"], "same.md")];
const completed = (requestIndex = 0): NotesImportResult => ({ requestIndex, filePath: "same.md", ok: true, outcome: "completed", stats: { nodes: 0, chains: 0 } });

it("maps out-of-order responses by index, not duplicate basenames", () => {
	const results = [completed(1), { ...completed(0), stats: { nodes: 7 } }];
	assert.deepEqual(parseNotesImportResults({ results }, files), results);
});
for (const [name, results] of [
	["missing index", [{ ...completed(), requestIndex: undefined }, completed(1)]],
	["duplicate index", [completed(), completed()]],
	["missing row", [completed()]],
	["out-of-range index", [completed(), completed(2)]],
	["wrong filename", [{ ...completed(), filePath: "different.md" }, completed(1)]],
	["missing stats", [{ ...completed(), stats: undefined }, completed(1)]],
	["unknown outcome", [{ ...completed(), outcome: "unchanged" }, completed(1)]],
	["conflicting ok", [{ ...completed(), ok: false }, completed(1)]],
	["invalid stats", [{ ...completed(), stats: { nodes: "bad" } }, completed(1)]],
	["invalid details", [{ ...completed(), slots: [42] }, completed(1)]],
	["invalid provider", [{ ...completed(), provider: 42 }, completed(1)]],
	["invalid code", [{ ...completed(), code: 42 }, completed(1)]],
	["invalid missing", [{ ...completed(), missing: [42] }, completed(1)]],
	["invalid error", [{ ...completed(), error: 42 }, completed(1)]],
	["missing failure error", [{ ...completed(), ok: false, outcome: "failed" }, completed(1)]],
] as const) it(`malformed response (${name}) is rejected for retry`, () => {
	assert.throws(() => parseNotesImportResults({ results }, files), /Please retry/);
});

it("POST sends only captured files, and retains config/provider details", async () => {
	const refused: NotesImportResult = { requestIndex: 0, filePath: files[1]!.name, ok: false, outcome: "failed", code: "provider_key_missing", provider: "openai", slots: ["cheap"], error: "No key is set" };
	globalThis.fetch = async (url, init) => {
		assert.equal(url, "/api/graph/import"); assert.equal(init?.method, "POST");
		const sent = (init?.body as FormData).getAll("files") as File[];
		assert.equal(sent.length, 1); assert.equal(await sent[0]!.text(), "two");
		return Response.json({ results: [refused] });
	};
	assert.deepEqual(await postNotesImport([files[1]!]), [refused]);
});
for (const kind of ["network", "non-JSON", "non-2xx", "malformed"] as const) it(`${kind} response rejects rather than false success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: [] });
	};
	await assert.rejects(postNotesImport([files[0]!]));
});

for (const outcome of ["completed", "failed", "partial", "aborted", "busy"] as const) it(`${outcome} leaves only escaped raw failure text, without results or controls`, async () => {
	const file = new File(["notes"], "<script>notes.md");
	const result: NotesImportResult = { ...completed(), filePath: file.name, outcome, ok: outcome === "completed", error: "<img>synthetic failure", code: "provider_key_missing", provider: "openai", missing: ["OPENAI_API_KEY"], slots: ["cheap", "strong"] };
	globalThis.fetch = async () => Response.json({ results: [result] });
	await mount();
	await submit([file]);
	assert.equal(current.importing, false);
	assert.equal(starts, 1);
	assert.equal(finishes, 1);
	const html = host!.innerHTML;
	assert.doesNotMatch(html, /<button|<section|<ul|border|bg-card|rounded|shadow|Retry|Dismiss|Import complete|new propositions|Saved changes|Import stopped|already being imported/);
	assert.deepEqual(Object.keys(current).sort(), ["errors", "importing", "onImportFiles"], "no retained rows, Files, retry or dismiss API");
	if (outcome === "completed") {
		assert.equal(html, "");
		assert.deepEqual(current.errors, []);
	} else {
		assert.deepEqual(current.errors, [`${file.name}: ${result.error}\nprovider_key_missing — openai — OPENAI_API_KEY — cheap, strong`]);
		assert.match(html, /&lt;script&gt;notes.md: &lt;img&gt;synthetic failure/);
		assert.match(html, /provider_key_missing — openai — OPENAI_API_KEY — cheap, strong/);
		assert.match(html, /role="alert"/);
		assert.match(html, /text-xs text-red-400/);
		assert.match(html, /whitespace-pre-wrap break-words/);
		assert.doesNotMatch(html, /<script>|<img>/);
	}
});

for (const details of [
	{ code: "models_not_configured", missing: ["cheap", "strong", "vision"] },
	{ code: "provider_key_missing", provider: "openai", slots: ["cheap"] },
	{ code: "provider_key_missing" },
	{},
]) it(`keeps existing configuration detail strings (${JSON.stringify(details)})`, async () => {
	globalThis.fetch = async () => Response.json({ results: [{ requestIndex: 0, filePath: "same.md", ok: false, outcome: "failed", error: "Existing raw error", ...details }] });
	await mount();
	await submit([files[0]!]);
	const suffix = details.code === "models_not_configured" ? "\nmodels_not_configured — cheap, strong, vision" : details.provider ? "\nprovider_key_missing — openai — cheap" : details.code ? "\nprovider_key_missing" : "";
	assert.deepEqual(current.errors, [`same.md: Existing raw error${suffix}`]);
});

it("empty error text renders nothing; multiple errors are plain independent alerts", () => {
	assert.equal(renderToStaticMarkup(<NotesImportErrors errors={[]} />), "");
	const html = renderToStaticMarkup(<NotesImportErrors errors={["one.md: failure", "two.md: failure"]} />);
	assert.equal((html.match(/role="alert"/g) ?? []).length, 2);
	assert.doesNotMatch(html, /<section|<button|border|bg-/);
});

it("mixed out-of-order results show only failed files in selection order, including duplicate basenames", async () => {
	const selected = [new File(["success"], "success.md"), ...files];
	const results: NotesImportResult[] = [
		{ requestIndex: 2, filePath: "same.md", ok: false, outcome: "partial", error: "second duplicate" },
		{ ...completed(), filePath: "success.md" },
		{ requestIndex: 1, filePath: "same.md", ok: false, outcome: "failed", error: "first duplicate" },
	];
	globalThis.fetch = async () => Response.json({ results });
	await mount();
	await submit(selected);
	assert.deepEqual(current.errors, ["same.md: first duplicate", "same.md: second duplicate"]);
	assert.doesNotMatch(host!.innerHTML, /success.md|completed|propositions/);
});

for (const kind of ["network", "non-JSON", "non-2xx", "malformed", "duplicate index"] as const) it(`${kind} hook failure is visible for every selected file, never success`, async () => {
	globalThis.fetch = async () => {
		if (kind === "network") throw new Error("synthetic offline");
		if (kind === "non-JSON") return new Response("not JSON");
		if (kind === "non-2xx") return Response.json({ error: "synthetic refused" }, { status: 503 });
		return Response.json({ results: kind === "duplicate index" ? [completed(), completed()] : [] });
	};
	await mount();
	await submit();
	const message = kind === "network" ? "synthetic offline" : kind === "non-2xx" ? "Import request failed (HTTP 503): synthetic refused. Please retry the file." : "Invalid import response. Please retry the file.";
	assert.deepEqual(current.errors, files.map((file) => `${file.name}: ${message}`));
	assert.equal(host!.querySelectorAll('[role="alert"]').length, 2);
	assert.equal(finishes, 1);
	assert.equal(current.importing, false);
});

it("actual attempts clear errors immediately, guard synchronous reentry, preserve callbacks and allow same-file reimport", async () => {
	let requests = 0;
	let resolve!: (response: Response) => void;
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	await submit();
	assert.equal(current.errors.length, 2);
	await submit(null);
	await submit([]);
	assert.equal(current.errors.length, 2, "cancel/empty selection is not an attempt");
	assert.equal(requests, 1);
	globalThis.fetch = async () => { requests++; return new Promise<Response>((done) => { resolve = done; }); };
	await act(async () => {
		const staleHandler = current.onImportFiles;
		staleHandler(files as unknown as FileList);
		staleHandler(files as unknown as FileList);
	});
	assert.equal(requests, 2, "ref guard rejects even same-tick reentry before React rerenders");
	assert.equal(current.importing, true);
	assert.deepEqual(current.errors, []);
	assert.equal(host!.innerHTML, "");
	assert.equal(starts, 2);
	assert.equal(finishes, 1, "finish waits for the POST");
	await submit();
	assert.equal(requests, 2, "pending attempts do not submit");
	await act(async () => { resolve(Response.json({ results: [completed(1), completed()] })); });
	assert.equal(current.importing, false);
	assert.deepEqual(current.errors, []);
	assert.equal(finishes, 2);
	globalThis.fetch = async () => { requests++; return Response.json({ results: [completed(), completed(1)] }); };
	await submit();
	assert.equal(requests, 3, "same File objects can be submitted again after settlement");
	assert.equal(starts, 3);
	assert.equal(finishes, 3);
	assert.equal(host!.innerHTML, "");
});

// Binary sources (PDFs + images, owner, 2026-11-02): client prechecks reject
// doomed files before upload, in the shared server wording; only accepted
// files are posted and server rows map back to the ORIGINAL selection order.
const sized = (name: string, size: number) => {
	const file = new File(["x"], name);
	Object.defineProperty(file, "size", { value: size }); // no real allocation
	return file;
};
const fakePdf = (count: number) => new File([`%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [] /Count ${count} >>\nendobj\n%%EOF`], "big.pdf");
const UNSUPPORTED = "Unsupported file type. Import notes (.md, .txt), PDFs, or images (.png, .jpg).";
const TOO_LARGE = "File is too large (over 25 MB).";
const SELECTION = "Selection is too large to import at once (over 100 MB). Import fewer files at a time.";

it("precheckSourceFile: extension, per-file size, PDF page hint", async () => {
	const { precheckSourceFile } = await import("../components/notes-import.tsx");
	assert.equal(await precheckSourceFile(new File(["x"], "page.html")), UNSUPPORTED);
	assert.equal(await precheckSourceFile(new File(["x"], "README")), UNSUPPORTED);
	assert.equal(await precheckSourceFile(sized("huge.png", 25 * 1024 * 1024 + 1)), TOO_LARGE);
	assert.equal(await precheckSourceFile(sized("edge.jpg", 25 * 1024 * 1024)), null);
	assert.equal(await precheckSourceFile(fakePdf(101)), "PDF has 101 pages; the limit is 100.");
	assert.equal(await precheckSourceFile(fakePdf(100)), null);
	assert.equal(await precheckSourceFile(new File(["%PDF-1.4 no page tree visible"], "opaque.pdf")), null, "no hint → the server decides");
	assert.equal(await precheckSourceFile(new File(["notes"], "NOTES.MD")), null);
});

it("rejected files are never posted; FormData holds only accepted files; rows map back to selection order", async () => {
	const selected = [
		new File(["bad"], "page.html"), // 0: unsupported
		new File(["ok"], "ok.md"), // 1: accepted → request 0, succeeds
		sized("huge.png", 26 * 1024 * 1024), // 2: too large
		new File(["fails"], "fails.txt"), // 3: accepted → request 1, server failure
		fakePdf(101), // 4: too many pages
		new File(["%PDF"], "late.pdf"), // 5: accepted → request 2, server failure
	];
	let posted: string[] = [];
	let requests = 0;
	globalThis.fetch = async (_url, init) => {
		requests++;
		posted = ((init?.body as FormData).getAll("files") as File[]).map((f) => f.name);
		return Response.json({ results: [
			{ requestIndex: 2, filePath: "late.pdf", ok: false, outcome: "failed", error: "This file is not a valid PDF." },
			{ requestIndex: 0, filePath: "ok.md", ok: true, outcome: "completed", stats: { nodes: 1 } },
			{ requestIndex: 1, filePath: "fails.txt", ok: false, outcome: "failed", error: "No key is set", code: "provider_key_missing", provider: "openai", slots: ["cheap"] },
		] });
	};
	await mount();
	await submit(selected);
	assert.equal(requests, 1);
	assert.deepEqual(posted, ["ok.md", "fails.txt", "late.pdf"]);
	assert.deepEqual(current.errors, [
		`page.html: ${UNSUPPORTED}`,
		`huge.png: ${TOO_LARGE}`,
		"fails.txt: No key is set\nprovider_key_missing — openai — cheap",
		"big.pdf: PDF has 101 pages; the limit is 100.",
		"late.pdf: This file is not a valid PDF.",
	]);
	assert.equal(starts, 1);
	assert.equal(finishes, 1);
});

it("everything rejected: no fetch, but onStart/onFinish still fire and errors show", async () => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	await submit([new File(["x"], "a.docx"), sized("b.md", 30 * 1024 * 1024), fakePdf(500)]);
	assert.equal(requests, 0);
	assert.deepEqual(current.errors, [`a.docx: ${UNSUPPORTED}`, `b.md: ${TOO_LARGE}`, "big.pdf: PDF has 500 pages; the limit is 100."]);
	assert.equal(starts, 1);
	assert.equal(finishes, 1);
	assert.equal(current.importing, false);
	assert.equal(host!.querySelectorAll('[role="alert"]').length, 3);
});

it("accepted total over 100 MB: every accepted file gets the selection message, nothing is posted", async () => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return Response.json({ results: [] }); };
	await mount();
	const big = [0, 1, 2, 3, 4].map((i) => sized(`part${i}.pdf`, 21 * 1024 * 1024));
	for (const file of big) Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
	await submit([new File(["x"], "skip.zip"), ...big]);
	assert.equal(requests, 0);
	assert.deepEqual(current.errors, [`skip.zip: ${UNSUPPORTED}`, ...big.map((f) => `${f.name}: ${SELECTION}`)]);
	assert.equal(finishes, 1);
});

it("transport failure applies to accepted files only, keeping precheck errors in selection order", async () => {
	globalThis.fetch = async () => { throw new Error("synthetic offline"); };
	await mount();
	await submit([new File(["a"], "a.md"), new File(["x"], "b.exe"), new File(["c"], "c.txt")]);
	assert.deepEqual(current.errors, ["a.md: synthetic offline", `b.exe: ${UNSUPPORTED}`, "c.txt: synthetic offline"]);
});
