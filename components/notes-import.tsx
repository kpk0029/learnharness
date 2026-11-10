"use client";

/**
 * NOTES IMPORT — the "Import notes…" transport + hook shared by both
 * mounts (graph view, minimal home): one POST of the selected files to
 * /api/graph/import, failures only, as plain `<file>: <message>` alerts.
 *
 * Binary sources (PDFs + images, owner, 2026-11-02): before anything is
 * uploaded every selected file is prechecked here — extension, the 25 MB
 * per-file cap, and a best-effort PDF page count (> 100 pages) — with the
 * wording shared with the server through src/core/source-import.ts. Only
 * accepted files are posted, and only when their total stays under the
 * 100 MB request cap (otherwise each accepted file reports the selection
 * message and nothing is sent). Server rows map back to the ORIGINAL
 * selection order, interleaved with precheck errors. The server's checks
 * stay authoritative; these only spare a doomed upload.
 */

import { useRef, useState } from "react";
import {
	MAX_IMPORT_REQUEST_BYTES,
	MAX_PDF_PAGES,
	MAX_SOURCE_BYTES,
	pdfPageCountHint,
	selectionTooLargeMessage,
	sourceKindFromName,
	sourceTooLargeMessage,
	tooManyPagesMessage,
	unsupportedTypeMessage,
} from "@/src/core";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Please retry the file.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Please retry the file."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}. Please retry the file.`);
	}
	return parseNotesImportResults(body, files);
}

/** Client-side rejection message for one selected file, or null to upload it. */
export async function precheckSourceFile(file: File): Promise<string | null> {
	const kind = sourceKindFromName(file.name);
	if (kind === null) return unsupportedTypeMessage();
	if (file.size > MAX_SOURCE_BYTES) return sourceTooLargeMessage();
	if (kind === "pdf") {
		const pages = pdfPageCountHint(new Uint8Array(await file.arrayBuffer()));
		if (pages !== null && pages > MAX_PDF_PAGES) return tooManyPagesMessage(pages);
	}
	return null;
}

/** Only error text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [errors, setErrors] = useState<string[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (files: File[]) => {
		if (pending.current || files.length === 0) return;
		pending.current = true;
		setImporting(true);
		setErrors([]);
		// Selection-order error rows: precheck rejections + server failures.
		const rows: { index: number; text: string }[] = [];
		let accepted = files.map((file, index) => ({ file, index }));
		try {
			callbacks.onStart?.();
			const checks = await Promise.all(files.map((file) => precheckSourceFile(file)));
			accepted = [];
			checks.forEach((message, index) => {
				if (message === null) accepted.push({ file: files[index]!, index });
				else rows.push({ index, text: `${files[index]!.name}: ${message}` });
			});
			if (accepted.reduce((total, { file }) => total + file.size, 0) > MAX_IMPORT_REQUEST_BYTES) {
				for (const { file, index } of accepted) rows.push({ index, text: `${file.name}: ${selectionTooLargeMessage()}` });
			} else if (accepted.length > 0) {
				const results = await postNotesImport(accepted.map(({ file }) => file));
				for (const r of results) if (!r.ok) rows.push({
					index: accepted[r.requestIndex]!.index,
					text: `${r.filePath}: ${r.error}${r.code ? `\n${r.code}${r.provider ? ` — ${r.provider}` : ""}${r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}${r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}` : ""}`,
				});
			}
			setErrors(rows.sort((a, b) => a.index - b.index).map((row) => row.text));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Transport failures apply to the files actually sent; precheck errors stay.
			for (const { file, index } of accepted) rows.push({ index, text: `${file.name}: ${message}` });
			setErrors(rows.sort((a, b) => a.index - b.index).map((row) => row.text));
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		errors, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
	};
}

export function NotesImportErrors({ errors }: { errors: readonly string[] }) {
	return <>{errors.map((error, i) => (
		<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
	))}</>;
}
