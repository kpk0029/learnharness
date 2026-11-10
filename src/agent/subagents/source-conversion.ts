import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { pdfPageTexts, pdfProbe, type PdfPageInfo } from "./pdf-ops.ts";
import { getHeadless, normalizeImageForVision, type HeadlessApi } from "./headless.ts";
import {
	MAX_PDF_PAGES,
	MAX_SOURCE_BYTES,
	notValidMessage,
	sourceKindFromName,
	sourceTooLargeMessage,
	tooManyPagesMessage,
	unsupportedTypeMessage,
	type SourceKind,
} from "../../core/source-import.ts";

/**
 * SOURCE CONVERSION — the binary import front door's first step (owner,
 * 2026-11-02): binary sources convert to text BEFORE the pipeline; the
 * extractor stays format-blind. A PDF or image picked through "Import
 * notes…" becomes Markdown-ish text here, and that text then enters the
 * SAME notes pipeline (chunk → extract → audit → merge) a .md file does.
 *
 *   detectSourceKind  size cap → magic bytes → extension mismatch → NUL
 *                     sniff → text (R5: lenient about unlisted extensions —
 *                     "anything textual" imports as text)
 *   convertSource     PDF: pdfjs text layer per page (line breaks kept);
 *                     pages whose text layer is too thin (pageNeedsVision)
 *                     are rendered and transcribed by the vision slot's
 *                     "transcriber" role, replacing that page's text.
 *                     Image: normalised, then one transcription.
 *
 * Originals are never kept (D6): a PDF lives as a temp file only while it
 * converts ("source.pdf" in an lh-import- dir — never the user's file name),
 * removed in finally. One page failing to transcribe fails the whole file
 * (D8) with an error naming the page. This module never imports
 * extraction.ts (extraction imports it).
 */

export type SourceRejection = "too_large" | "unsupported" | "invalid" | "too_many_pages" | "encrypted" | "unreadable";

/** A source refused before any model call — message already user-worded
 *  (the core builders, so client and server say the same thing). */
export class SourceRejectedError extends Error {
	constructor(
		public readonly reason: SourceRejection,
		message: string,
	) {
		super(message);
		this.name = "SourceRejectedError";
	}
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
	if (bytes.length < at + magic.length) return false;
	for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
	return true;
}

/** "%PDF-" within the first 1024 bytes (the PDF spec tolerates leading junk). */
function hasPdfMagic(bytes: Uint8Array): boolean {
	const end = Math.min(bytes.length, 1024) - PDF_MAGIC.length;
	for (let i = 0; i <= end; i++) if (startsWith(bytes, PDF_MAGIC, i)) return true;
	return false;
}

/** Classify one uploaded file. Order: size cap → magic bytes (content wins
 *  over the name) → a binary extension without its magic is invalid → a NUL
 *  in the first 8 KB is unsupported binary → otherwise text (R5). Throws
 *  SourceRejectedError for every refusal. */
export function detectSourceKind(filePath: string, bytes: Uint8Array): SourceKind {
	if (bytes.length > MAX_SOURCE_BYTES) throw new SourceRejectedError("too_large", sourceTooLargeMessage());
	if (hasPdfMagic(bytes)) return "pdf";
	if (startsWith(bytes, PNG_MAGIC)) return "png";
	if (startsWith(bytes, JPEG_MAGIC)) return "jpeg";
	const byName = sourceKindFromName(path.basename(filePath));
	if (byName === "pdf" || byName === "png" || byName === "jpeg") {
		throw new SourceRejectedError("invalid", notValidMessage(byName));
	}
	const sniff = bytes.subarray(0, 8192);
	if (sniff.includes(0)) throw new SourceRejectedError("unsupported", unsupportedTypeMessage());
	return "text";
}

// ─── the vision rule (D4) ───────────────────────────────────────────────────

/** Below this, a page's text layer is effectively absent. */
export const VISION_MIN_TEXT_CHARS = 200;
/** Below this, a page that also paints an image is figure/slide-like. */
export const VISION_FIGURE_TEXT_CHARS = 600;

/** Does this page go to the vision slot instead of keeping its text layer?
 *
 *  A body page of prose carries roughly 1500–3500 characters of text; under
 *  200 means a blank page, a scan with no text layer, or a header/footer-only
 *  layer — the content (if any) is pixels. The second clause catches
 *  figure and slide pages: a painted image with under 600 characters is
 *  mostly picture, and the caption alone would lose it.
 *
 *  Blank pages (text < 200, image_count === 0) are deliberately NOT
 *  skipped: image_count counts paintImageXObject ops only, and misses
 *  inline images, image masks and vector art — a "blank" page by that
 *  count can still hold a diagram. The transcriber outputs nothing for a
 *  truly blank page, so the cost is one cheap call.
 *
 *  Math-dense pages are deliberately NOT sent (math_density is ignored):
 *  their text layer is present and the extractor reads it; transcribing
 *  every formula-heavy page would multiply vision spend for marginal gain. */
export function pageNeedsVision(p: PdfPageInfo): boolean {
	return p.text_length < VISION_MIN_TEXT_CHARS || (p.image_count > 0 && p.text_length < VISION_FIGURE_TEXT_CHARS);
}

// ─── the transcriber ────────────────────────────────────────────────────────

/** The transcriber's system prompt (R6, owner-approved intent). */
export const TRANSCRIBER_INSTRUCTIONS = [
	"You transcribe ONE page image — a PDF page, or a photo or scan of a page — into faithful Markdown.",
	"",
	"- Keep ALL readable text, word for word, in reading order.",
	"- Reproduce headings and lists as Markdown headings and lists; reproduce tables as Markdown tables.",
	"- Write all mathematics in LaTeX exactly as shown: $…$ inline, $$…$$ for display equations.",
	"- Describe each diagram, figure, or chart briefly in brackets as [Figure: …], including its labels and the relationships it shows.",
	"- Write handwriting you cannot read as [illegible].",
	"- Do not summarise, interpret, correct, or translate anything, and add no preamble or commentary.",
	"- If the page is blank, output nothing.",
	"",
	"Output only the transcription.",
].join("\n");

/** One vision call: an image in, its Markdown transcription out. Tool-less,
 *  one turn, on the "transcriber" role (vision slot). Usage reports through
 *  onStep with the provider-qualified model stamp, like every stage. */
export async function transcribeImage(
	engine: PiEngine,
	image: { data: Buffer; mimeType: string },
	where: { filePath: string; page?: number; pageCount?: number },
	opts: { signal?: AbortSignal; onStep: (usage: Usage, model: string) => void },
): Promise<string> {
	const text = where.page !== undefined
		? `Transcribe page ${where.page} of ${where.pageCount} of "${where.filePath}".`
		: `Transcribe the image "${where.filePath}".`;
	const messages: AgentMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text },
				{ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
			],
			timestamp: Date.now(),
		},
	];
	const result = await runSubagent([], {
		role: "transcriber",
		engine,
		systemPrompt: TRANSCRIBER_INSTRUCTIONS,
		messages,
		maxTurns: 1,
		abortSignal: opts.signal,
		// Provider-qualified stamp — the same as submit-agent's.
		onAssistantMessage: (message) => opts.onStep(message.usage, `${message.provider}:${message.model}`),
	});
	return result.text.trim();
}

// ─── conversion ─────────────────────────────────────────────────────────────

/** Pages rendered per renderPdfPages call (bounds PNG memory). */
const RENDER_BATCH = 6;

export interface ConvertSourceInput {
	filePath: string;
	bytes: Uint8Array;
	kind: "pdf" | "png" | "jpeg";
	engine: PiEngine;
	/** Test seam: replaces the default headless API (getHeadless()). */
	headless?: HeadlessApi;
	/** Test seam: where the temp dir is made (default os.tmpdir()). */
	tmpRoot?: string;
	signal?: AbortSignal;
	onPhase: (phase: "reading" | "transcribing") => void;
	onStep: (usage: Usage, model: string) => void;
	/** Concurrency gate around each transcription (the shared background-LLM
	 *  slot in production); identity when absent. */
	gate?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface ConvertedSource {
	text: string;
	/** The PDF's page count (absent for images). */
	pages?: number;
	/** Pages that went through the vision slot; [1] for an image (the image
	 *  is its one page). */
	transcribedPages: number[];
}

function isAbort(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Convert one binary source to text (see the header). */
export async function convertSource(input: ConvertSourceInput): Promise<ConvertedSource> {
	const gate = input.gate ?? (<T>(fn: () => Promise<T>) => fn());
	const { signal } = input;
	signal?.throwIfAborted();

	if (input.kind !== "pdf") {
		const image = await normalizeImageForVision(input.bytes, input.kind);
		input.onPhase("transcribing");
		const text = await gate(() =>
			transcribeImage(input.engine, image, { filePath: input.filePath }, { signal, onStep: input.onStep }),
		);
		return { text, transcribedPages: [1] };
	}

	const dir = await fs.mkdtemp(path.join(input.tmpRoot ?? os.tmpdir(), "lh-import-"));
	try {
		const pdfPath = path.join(dir, "source.pdf");
		await fs.writeFile(pdfPath, input.bytes);
		let pageCount: number;
		try {
			pageCount = (await pdfProbe(pdfPath)).page_count;
		} catch (err) {
			if ((err as { name?: unknown } | null)?.name === "PasswordException") {
				throw new SourceRejectedError("encrypted", "This PDF is password-protected.");
			}
			throw new SourceRejectedError("unreadable", "This PDF could not be read.");
		}
		if (pageCount > MAX_PDF_PAGES) throw new SourceRejectedError("too_many_pages", tooManyPagesMessage(pageCount));

		input.onPhase("reading");
		const { pages } = await pdfPageTexts(pdfPath, { signal });
		const texts = new Map(pages.map((p) => [p.page, p.text]));
		const fallback = pages.filter(pageNeedsVision).map((p) => p.page);

		if (fallback.length > 0) {
			input.onPhase("transcribing");
			const headless = input.headless ?? getHeadless();
			for (let i = 0; i < fallback.length; i += RENDER_BATCH) {
				signal?.throwIfAborted();
				const batch = fallback.slice(i, i + RENDER_BATCH);
				let rendered: Awaited<ReturnType<HeadlessApi["renderPdfPages"]>>;
				try {
					rendered = await headless.renderPdfPages(pdfPath, batch, { dpi: 150, maxEdgePx: 2000 });
				} catch (err) {
					if (isAbort(err)) throw err;
					const span = batch.length === 1 ? `Page ${batch[0]}` : `Pages ${batch[0]}–${batch[batch.length - 1]}`;
					throw new Error(`${span} could not be rendered: ${errorMessage(err)}`, { cause: err });
				}
				const byPage = new Map(rendered.map((r) => [r.page, r.png]));
				// The batch's transcriptions run concurrently under the gate;
				// every one settles before the first failure (page order) is
				// raised, so no call outlives the conversion.
				const settled = await Promise.allSettled(
					batch.map(async (page) => {
						const png = byPage.get(page);
						if (!png) throw new Error("the page did not render");
						return gate(() =>
							transcribeImage(
								input.engine,
								{ data: png, mimeType: "image/png" },
								{ filePath: input.filePath, page, pageCount },
								{ signal, onStep: input.onStep },
							),
						);
					}),
				);
				const abort = settled.find((s): s is PromiseRejectedResult => s.status === "rejected" && isAbort(s.reason));
				if (abort) throw abort.reason;
				for (const [j, s] of settled.entries()) {
					const page = batch[j]!;
					if (s.status === "rejected") {
						throw new Error(`Page ${page} could not be transcribed: ${errorMessage(s.reason)}`, { cause: s.reason });
					}
					texts.set(page, s.value);
				}
			}
		}

		// Page order; vision pages replaced their text layer; no page headers.
		const text = pages.map((p) => texts.get(p.page) ?? "").join("\n\n");
		return { text, pages: pageCount, transcribedPages: fallback };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
