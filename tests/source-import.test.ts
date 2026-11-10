/**
 * The binary front door's shared contract (PDFs + images through
 * "Import notes…", owner, 2026-11-02): accept list, kind-by-extension,
 * the exact error wording client and server share, the best-effort PDF
 * page hint, and the Next proxy body limit pinned against the request cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_IMPORT_REQUEST_BYTES,
	MAX_PDF_PAGES,
	MAX_SOURCE_BYTES,
	NOTES_IMPORT_ACCEPT,
	NOTES_IMPORT_HINT,
	notValidMessage,
	pdfPageCountHint,
	selectionTooLargeMessage,
	sourceKindFromName,
	sourceTooLargeMessage,
	tooManyPagesMessage,
	unsupportedTypeMessage,
} from "../src/core/source-import.ts";
import nextConfig from "../next.config.ts";

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("source-import contract (owner, 2026-11-02)", () => {
	it("limits and picker strings", () => {
		assert.equal(MAX_SOURCE_BYTES, 25 * 1024 * 1024);
		assert.equal(MAX_PDF_PAGES, 100);
		assert.equal(MAX_IMPORT_REQUEST_BYTES, 100 * 1024 * 1024);
		assert.equal(NOTES_IMPORT_ACCEPT, ".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg");
		assert.equal(NOTES_IMPORT_HINT, "Import notes, PDFs, or images into the graph");
	});

	it("sourceKindFromName: extension only, case-insensitive", () => {
		for (const [name, kind] of [
			["notes.md", "text"], ["notes.markdown", "text"], ["notes.txt", "text"], ["NOTES.MD", "text"],
			["paper.pdf", "pdf"], ["Paper.PDF", "pdf"],
			["shot.png", "png"], ["SHOT.PNG", "png"],
			["photo.jpg", "jpeg"], ["photo.jpeg", "jpeg"], ["PHOTO.JPG", "jpeg"],
			["README", null], ["archive.zip", null], ["page.html", null], ["doc.docx", null], ["pdf", null], ["notes.md.bak", null],
		] as const) assert.equal(sourceKindFromName(name), kind, name);
	});

	it("message wording", () => {
		assert.equal(sourceTooLargeMessage(), "File is too large (over 25 MB).");
		assert.equal(unsupportedTypeMessage(), "Unsupported file type. Import notes (.md, .txt), PDFs, or images (.png, .jpg).");
		assert.equal(tooManyPagesMessage(101), "PDF has 101 pages; the limit is 100.");
		assert.equal(notValidMessage("pdf"), "This file is not a valid PDF.");
		assert.equal(notValidMessage("png"), "This file is not a valid PNG.");
		assert.equal(notValidMessage("jpeg"), "This file is not a valid JPEG.");
		assert.equal(selectionTooLargeMessage(), "Selection is too large to import at once (over 100 MB). Import fewer files at a time.");
	});

	it("pdfPageCountHint: plain Pages node", () => {
		assert.equal(pdfPageCountHint(bytes("%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n")), 3);
	});

	it("pdfPageCountHint: no Pages dictionary → null", () => {
		assert.equal(pdfPageCountHint(bytes("%PDF-1.4\n<< /Type /Page /Count 9 >>\n<< /Type /Catalog >>")), null);
		assert.equal(pdfPageCountHint(bytes("")), null);
	});

	it("pdfPageCountHint: nested Pages nodes → the largest Count (the root)", () => {
		const pdf = [
			"%PDF-1.7",
			"2 0 obj << /Type /Pages /Parent 1 0 R /Kids [4 0 R 5 0 R] /Count 2 >> endobj",
			"1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 /Resources << /Font << /F1 9 0 R >> >> >> endobj",
			"3 0 obj << /Type /Pages /Parent 1 0 R /Kids [6 0 R 7 0 R 8 0 R] /Count 3 >> endobj",
			"6 0 obj << /Type /Page /Parent 3 0 R /Count 999 >> endobj",
		].join("\n");
		assert.equal(pdfPageCountHint(bytes(pdf)), 5);
	});

	it("next.config proxyClientMaxBodySize ≥ the whole-request cap", () => {
		const raw = nextConfig.experimental?.proxyClientMaxBodySize;
		const parse = (v: unknown): number => {
			if (typeof v === "number") return v;
			const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(String(v));
			assert.ok(m, `unparseable proxyClientMaxBodySize ${String(v)}`);
			return Number(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2]!.toLowerCase() as "b"];
		};
		assert.ok(parse(raw) >= MAX_IMPORT_REQUEST_BYTES, `proxy limit ${String(raw)} < ${MAX_IMPORT_REQUEST_BYTES}`);
	});
});
