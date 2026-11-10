/**
 * pdf-ops (sources v0) — the pdfjs text layer against a committed fixture
 * (tests/fixtures/sample-3page.pdf: 3 pages, distinct subjects, "force" on
 * page 2 only). The render path (headless Chrome) is covered by the
 * pdf-reader loop tests via the headlessOverride fake.
 *
 * pdfPageTexts (import front door, owner 2026-11-02): the fixture's pages
 * are single text runs with no hasEOL items, so the line-break pin uses a
 * tiny two-line PDF built in memory (tests/fixtures/make-pdf.ts).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makePdf } from "./fixtures/make-pdf.ts";
import { parsePageSpec, pdfExtract, pdfInfo, pdfPageTexts, pdfProbe, pdfSearch } from "../src/agent/subagents/pdf-ops.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");

/** A one-page PDF whose text sits on two separate lines (two Td moves), so
 *  pdfjs marks the first run hasEOL — the shared in-memory builder. */
function multiLinePdf(): Buffer {
	return makePdf(["First line here\nSecond line here"]);
}

describe("pdf-ops — the pdfjs text layer", () => {
	it("pdfInfo triages every page (count, text lengths, image counts, math density)", async () => {
		const info = await pdfInfo(FIXTURE);
		assert.equal(info.page_count, 3);
		assert.equal(info.pages.length, 3);
		assert.equal(info.pages[0]!.page, 1);
		assert.ok(info.pages.every((p) => p.text_length > 0));
		assert.ok(info.mean_text_length > 0);
		// fixture has no images
		assert.ok(info.pages.every((p) => p.image_count === 0));
	});

	it("pdfExtract heads pages and honors the spec", async () => {
		const two = await pdfExtract(FIXTURE, "1-2");
		assert.match(two, /^--- Page 1 ---/);
		assert.match(two, /--- Page 2 ---/);
		assert.ok(!two.includes("--- Page 3 ---"), "page 3 not requested");
		assert.match(two, /Calculus/);
		const picks = await pdfExtract(FIXTURE, "1,3");
		assert.match(picks, /--- Page 1 ---/);
		assert.ok(!picks.includes("--- Page 2 ---"));
		assert.match(picks, /Chemistry/);
	});

	it("pdfSearch finds hits with page/line + context, literal and regex", async () => {
		const lit = await pdfSearch(FIXTURE, "force", { literal: true });
		assert.equal(lit.hits.length, 1);
		assert.equal(lit.hits[0]!.page, 2);
		assert.match(lit.hits[0]!.context, />>> /);
		// regex with case-insensitivity
		const re = await pdfSearch(FIXTURE, "H2O|water");
		assert.equal(re.hits.length, 1);
		assert.equal(re.hits[0]!.page, 3);
		// no-hit silence
		const none = await pdfSearch(FIXTURE, "zymurgy", { literal: true });
		assert.equal(none.hits.length, 0);
		// invalid regex throws the skill's error shape
		await assert.rejects(() => pdfSearch(FIXTURE, "([unclosed"), /Invalid regex/);
	});

	it("pdfProbe accepts the fixture and rejects garbage", async () => {
		await pdfProbe(FIXTURE); // resolves
		const garbage = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");
		await assert.rejects(() => pdfProbe(garbage));
	});

	it("pdfProbe resolves with the page count", async () => {
		assert.deepEqual(await pdfProbe(FIXTURE), { page_count: 3 });
	});

	it("pdfPageTexts reads every page with pdfInfo's exact per-page fields", async () => {
		const [texts, info] = await Promise.all([pdfPageTexts(FIXTURE), pdfInfo(FIXTURE)]);
		assert.equal(texts.page_count, 3);
		assert.equal(texts.pages.length, 3);
		assert.deepEqual(
			texts.pages.map(({ page, text_length, image_count, math_density }) => ({ page, text_length, image_count, math_density })),
			info.pages,
		);
	});

	it("pdfPageTexts page text carries the same words pdfExtract returns", async () => {
		const texts = await pdfPageTexts(FIXTURE);
		const words = (s: string) => s.split(/\s+/).filter(Boolean);
		for (const p of texts.pages) {
			const extracted = (await pdfExtract(FIXTURE, String(p.page))).replace(/^--- Page \d+ ---\n/, "");
			assert.deepEqual(words(p.text), words(extracted), `page ${p.page} words`);
		}
	});

	it("pdfPageTexts keeps line breaks (hasEOL → newline)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-ops-"));
		try {
			const file = path.join(dir, "two-lines.pdf");
			fs.writeFileSync(file, multiLinePdf());
			const { page_count, pages } = await pdfPageTexts(file);
			assert.equal(page_count, 1);
			assert.ok(pages[0]!.text.includes("\n"), `line break kept: ${JSON.stringify(pages[0]!.text)}`);
			assert.match(pages[0]!.text, /First line here\s*\n\s*Second line here/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pdfPageTexts rejects an already-aborted signal with an AbortError", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await assert.rejects(
			() => pdfPageTexts(FIXTURE, { signal: ctrl.signal }),
			(err: unknown) => err instanceof Error && err.name === "AbortError",
		);
	});

	it("parsePageSpec: all / ranges / lists / clamping", () => {
		assert.deepEqual(parsePageSpec("all", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1-5", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("1,3,7", 3), [1, 3]);
		assert.deepEqual(parsePageSpec("3", 3), [3]);
		assert.deepEqual(parsePageSpec(" 2 , 1 ", 3), [1, 2]);
	});
});