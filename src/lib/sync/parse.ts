import type { RawCue } from '$lib/types';
import { sanitizeText } from './sanitize';

const SRT_CUE_RE =
	/(\d+)\s*\n(\d{1,2}:\d{2}:\d{2}[,.]\d{3}|\d{1,2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3}|\d{1,2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\n|\n*$)/g;

const WEBVTT_HEADER = /^WEBVTT/i;

function parseTimestampSRT(ts: string): number {
	ts = ts.replace(',', '.');
	const parts = ts.split(':');
	if (parts.length === 2) {
		const [m, s] = parts;
		return parseInt(m, 10) * 60 + parseFloat(s);
	}
	const [h, m, s] = parts;
	return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

function parseTimestampVTT(ts: string): number {
	ts = ts.replace(',', '.');
	const parts = ts.split(':');
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
		const start = parseTimestampSRT(match[2]);
		const end = parseTimestampSRT(match[3]);
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

		const arrowMatch = arrowLine.match(
			/^(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})/
		);

		if (!arrowMatch) {
			cueIndex++;
			continue;
		}

		const start = parseTimestampVTT(arrowMatch[1]);
		const end = parseTimestampVTT(arrowMatch[2]);

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
