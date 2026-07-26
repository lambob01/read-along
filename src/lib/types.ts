export interface RawCue {
	index: number;
	start: number;
	end: number;
	text: string;
}

export interface Sentence {
	id: number;
	start: number;
	end: number;
	text: string;
	cueIds: number[];
}

export interface Paragraph {
	id: number;
	sentences: Sentence[];
}

export interface CueIndex {
	paragraphs: Paragraph[];
	sentences: Sentence[];
	starts: Float64Array;
	ends: Float64Array;
}

export interface ABSLibrary {
	id: string;
	name: string;
}

export interface ABSItem {
	id: string;
	media: {
		metadata: { title: string; authorName: string };
		coverPath: string;
		audioFiles: { ino: string; metadata: { filename: string } }[];
		chapters: { id: number; start: number; end: number; title: string }[];
	};
}

export interface ABSSession {
	id: string;
	audioTracks: { relPath: string; contentUrl: string }[];
}

export interface MergeOptions {
	gapThreshold?: number;
	showNonSpeech?: boolean;
}
