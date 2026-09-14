import type { RawCue } from '$lib/types';
import { sanitizeText } from './sanitize';

/**
 * One timestamp for both formats. SRT separates milliseconds with a comma and
 * VTT with a dot, and VTT additionally allows the hours component to be
 * omitted (`mm:ss.mmm`) — the arrow patterns below accept all three shapes, so
 * only the arithmetic here has to know the difference.
 */
const TIMESTAMP = '\\d{1,2}:\\d{2}(?::\\d{2})?[.,]\\d{3}';

const SRT_CUE_RE = new RegExp(
	`(\\d+)\\s*\\n(${TIMESTAMP})\\s*-->\\s*(${TIMESTAMP})\\s*\\n([\\s\\S]*?)(?=\\n\\n|\\n*$)`,
	'g'
);

const VTT_ARROW_RE = new RegExp(`^(${TIMESTAMP})\\s*-->\\s*(${TIMESTAMP})`);

const WEBVTT_HEADER = /^WEBVTT/i;

function parseTimestamp(ts: string): number {
	const parts = ts.replace(',', '.').split(':');
	if (parts.length === 2) {
		const [m, s] = parts;
		return parseInt(m, 10) * 60 + parseFloat(s);
	}
	const [h, m, s] = parts;
	return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

export function parseSRT(raw: string): RawCue[] {
	const cues: RawCue[] = [];
	const matches = raw.matchAll(SRT_CUE_RE);

	for (const match of matches) {
		const index = parseInt(match[1], 10);
		const start = parseTimestamp(match[2]);
		const end = parseTimestamp(match[3]);
		const text = sanitizeText(match[4]);
		if (Number.isNaN(start) || Number.isNaN(end)) {
			console.warn(`Malformed cue ${index}: invalid timestamp`);
			continue;
		}
		cues.push({ index, start, end, text });
	}

	return cues;
}

function parseVTTBody(body: string): RawCue[] {
	const cues: RawCue[] = [];
	const blocks = body.split(/\n\n+/);
	let cueIndex = 0;

	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;

		const lines = trimmed.split('\n');
		let startIdx = 0;

		if (/^\d+$/.test(lines[0].trim())) {
			startIdx = 1;
		}

		const arrowLine = lines[startIdx];
		if (!arrowLine || !arrowLine.includes('-->')) continue;

		const arrowMatch = arrowLine.match(VTT_ARROW_RE);

		if (!arrowMatch) {
			cueIndex++;
			continue;
		}

		const start = parseTimestamp(arrowMatch[1]);
		const end = parseTimestamp(arrowMatch[2]);

		if (Number.isNaN(start) || Number.isNaN(end)) {
			console.warn(`Malformed VTT cue: invalid timestamp`);
			cueIndex++;
			continue;
		}

		const textLines = lines.slice(startIdx + 1);
		const text = sanitizeText(textLines.join('\n'));

		cues.push({ index: cueIndex, start, end, text });
		cueIndex++;
	}

	return cues;
}

export function parseVTT(raw: string): RawCue[] {
	const headerEnd = raw.indexOf('\n\n');
	if (headerEnd === -1) {
		return parseVTTBody(raw);
	}
	const body = raw.slice(headerEnd + 2);
	return parseVTTBody(body);
}

export function parseCues(raw: string): RawCue[] {
	// Subtitle tools on Windows write \r\n; the SRT regex and VTT splits both
	// need \n\n to separate cues, and a CRLF file contains none — it parsed
	// as one cue holding the whole file. A BOM likewise breaks the WEBVTT
	// sniff. Normalize once, here, so both parsers see a canonical form.
	const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
	if (WEBVTT_HEADER.test(normalized.trimStart())) {
		return parseVTT(normalized);
	}
	return parseSRT(normalized);
}
