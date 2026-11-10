/**
 * makePdf — minimal valid PDFs built in memory for tests (import front
 * door, owner 2026-11-02). One Helvetica font shared by every page; each
 * page is either text (each "\n"-separated line its own Td move, so pdfjs
 * marks line ends hasEOL) or null for a blank page. Hand-built with a
 * correct xref table. Not a test file — imported by tests.
 */

function escapePdfString(s: string): string {
	return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

export function makePdf(pages: ReadonlyArray<string | null>): Buffer {
	const objects: string[] = [];
	// 1 = catalog, 2 = pages, 3 = font; then page/content pairs.
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	for (const [i, text] of pages.entries()) {
		const contentId = 5 + i * 2;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
		);
		const stream = text === null
			? ""
			: `BT /F1 10 Tf 72 740 Td ${text.split("\n").map((line, j) => `${j === 0 ? "" : "0 -14 Td "}(${escapePdfString(line)}) Tj`).join(" ")} ET`;
		objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
	}
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const xref = Buffer.byteLength(body, "latin1");
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

/** A line of body text long enough that `lines` of it clear the vision
 *  threshold (≥ 200 chars) comfortably. */
export function bodyText(subject: string, lines = 6): string {
	return Array.from({ length: lines }, (_, i) => `${subject} line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join("\n");
}
