/**
 * SOURCE IMPORT — the binary front door's shared contract (PDFs + images
 * through "Import notes…", owner, 2026-11-02).
 *
 * The limits (25 MB per file, 100 pages per PDF, 100 MB per request), the
 * accepted extensions, the picker hint and every user-facing rejection
 * message live here ONCE: the client prechecks (components/notes-import.tsx)
 * and the server's authoritative checks (source conversion + the import
 * route) both import these, so client and server word every error
 * identically. Pure and browser-safe: no node built-ins, no IO.
 */

/** Per-file cap, enforced client-side and server-side. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Per-PDF page cap; the client hint is best-effort, the server is authoritative. */
export const MAX_PDF_PAGES = 100;
/** Whole-request cap for one import POST (413 above it). */
export const MAX_IMPORT_REQUEST_BYTES = 100 * 1024 * 1024;

export const SOURCE_IMPORT_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf", ".png", ".jpg", ".jpeg"] as const;
/** The file picker's accept attribute (both mounts). */
export const NOTES_IMPORT_ACCEPT = SOURCE_IMPORT_EXTENSIONS.join(",");
/** The Import button's hint label (both mounts). */
export const NOTES_IMPORT_HINT = "Import notes, PDFs, or images into the graph";

export type SourceKind = "text" | "pdf" | "png" | "jpeg";

/** Kind by extension only (case-insensitive); null for anything unlisted. */
export function sourceKindFromName(name: string): SourceKind | null {
	const dot = name.lastIndexOf(".");
	if (dot === -1) return null;
	switch (name.slice(dot).toLowerCase()) {
		case ".md": case ".markdown": case ".txt": return "text";
		case ".pdf": return "pdf";
		case ".png": return "png";
		case ".jpg": case ".jpeg": return "jpeg";
		default: return null;
	}
}

export function sourceTooLargeMessage(): string {
	return "File is too large (over 25 MB).";
}
export function unsupportedTypeMessage(): string {
	return "Unsupported file type. Import notes (.md, .txt), PDFs, or images (.png, .jpg).";
}
export function tooManyPagesMessage(pages: number): string {
	return `PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES}.`;
}
export function notValidMessage(kind: "pdf" | "png" | "jpeg"): string {
	return `This file is not a valid ${kind.toUpperCase()}.`;
}
export function selectionTooLargeMessage(): string {
	return "Selection is too large to import at once (over 100 MB). Import fewer files at a time.";
}

/** Best-effort page count: the largest /Count N inside a dictionary that
 * also holds /Type /Pages (the root Pages node carries the total). Null
 * when none is visible (e.g. compressed object streams) — the server's
 * real parse stays authoritative. */
export function pdfPageCountHint(bytes: Uint8Array): number | null {
	let text = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	// Each dictionary's OWN text (nested << >> dictionaries excluded), so a
	// Pages node's /Count is never confused with a child's.
	let best: number | null = null;
	const stack: string[] = [];
	let last = 0;
	for (const match of text.matchAll(/<<|>>/g)) {
		if (stack.length > 0) stack[stack.length - 1] += text.slice(last, match.index);
		last = match.index + 2;
		if (match[0] === "<<") { stack.push(""); continue; }
		const dict = stack.pop();
		if (dict === undefined || !/\/Type\s*\/Pages(?![A-Za-z0-9])/.test(dict)) continue;
		const count = /\/Count\s+(\d+)/.exec(dict);
		if (!count) continue;
		const n = Number(count[1]);
		if (best === null || n > best) best = n;
	}
	return best;
}
