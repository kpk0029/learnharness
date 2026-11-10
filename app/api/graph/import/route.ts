/**
 * POST /api/graph/import — the format-agnostic front door's transport
 * (vision §1, 2026-09-13): raw personal-notes files in, one extraction run
 * per file through the SAME pipeline the sessions use. Multipart form data
 * (field "files", any text format — the extractor is format-agnostic); the
 * pipeline mints a deterministic source id per file path, persists the
 * source record (the file's provenance + the run's usage), and runs
 * extractor → auditor → merger over the raw text.
 *
 * Small concurrency cap: the model calls are the slow part, and a burst of
 * 25 simultaneous runs would trip provider rate limits — a 3-wide worker
 * pool keeps the run registry (the dock's status chips) and the ledgers
 * healthy. The dock's chips + graph refetch track progress live through
 * /api/graph/status, as with session runs.
 *
 * BYTES IN (owner, 2026-11-02): PDFs and images ride the same door. The
 * route reads each file's raw bytes and hands them to
 * extraction.importSource — the pipeline classifies (text / PDF / PNG /
 * JPEG, size and page caps) and converts binary sources to text before
 * extracting; every validation failure comes back as an ordinary failed
 * row (no new error codes). Request-level guards: a declared body over
 * MAX_IMPORT_REQUEST_BYTES is refused 413 before parsing, and a body that
 * does not parse as multipart is a 400.
 */
import { extraction, NotesImportError } from "@/src/server";
import {
	MAX_IMPORT_REQUEST_BYTES,
	ModelsNotConfiguredError,
	PROVIDER_KEY_MISSING_CODE,
	ProviderKeyMissingError,
	type EmissionStats,
} from "@/src/core";

export const dynamic = "force-dynamic";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
}

export async function POST(request: Request) {
	if (Number(request.headers.get("content-length")) > MAX_IMPORT_REQUEST_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "request too large (over 100 MB)" }, { status: 413 });
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json({ results: [] as ImportResult[], error: "unreadable upload" }, { status: 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	const results: ImportResult[] = [];
	const queue = files.map((file, requestIndex) => ({ file, requestIndex }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex } = next;
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const stats = await extraction.importSource({ filePath: file.name, bytes });
				results.push({ filePath: file.name, requestIndex, outcome: "completed", ok: true, stats });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({
						filePath: file.name,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: "models_not_configured",
						missing: err.envelope.missing,
					});
					continue;
				}
				if (err instanceof ProviderKeyMissingError) {
					results.push({
						filePath: file.name,
						ok: false,
						requestIndex, outcome: "failed",
						error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE,
						provider: err.envelope.provider,
						slots: err.envelope.slots,
					});
					continue;
				}
				results.push({
					filePath: file.name, requestIndex, ok: false,
					outcome: err instanceof NotesImportError ? err.outcome : "failed",
					...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}