import { App } from "obsidian";
import { STOP_WORDS } from "./stopwords";

// ── Types ────────────────────────────────────────────────────────────────────

interface TagProfile {
	documentCount: number;
	wordCounts: Map<string, number>;
	totalWordCount: number;
	// Precomputed after scan
	vector: Map<string, number>;
	vectorNorm: number;
}

export interface TagSuggestion {
	tag: string;
	score: number;
}

export interface ModelStats {
	totalDocuments: number;
	taggedDocuments: number;
	uniqueTags: number;
	uniqueWords: number;
}

// ── Model ────────────────────────────────────────────────────────────────────

export class TagModel {
	private tagProfiles = new Map<string, TagProfile>();
	private cooccurrence = new Map<string, Map<string, number>>();
	private globalDocFreq = new Map<string, number>();
	private totalDocuments = 0;
	private taggedDocuments = 0;
	private _ready = false;

	get isReady(): boolean {
		return this._ready;
	}

	getStats(): ModelStats {
		return {
			totalDocuments: this.totalDocuments,
			taggedDocuments: this.taggedDocuments,
			uniqueTags: this.tagProfiles.size,
			uniqueWords: this.globalDocFreq.size,
		};
	}

	getKnownTags(): string[] {
		return Array.from(this.tagProfiles.keys()).sort();
	}

	// ── Vault scan ───────────────────────────────────────────────────────

	async scan(
		app: App,
		onProgress?: (pct: number) => void
	): Promise<ModelStats> {
		this.clear();

		const files = app.vault.getMarkdownFiles();
		const BATCH = 100;

		for (let i = 0; i < files.length; i += BATCH) {
			const end = Math.min(i + BATCH, files.length);
			for (let j = i; j < end; j++) {
				const content = await app.vault.cachedRead(files[j]);
				this.processFile(content);
			}
			onProgress?.(end / files.length);
			// Yield to UI thread between batches
			if (end < files.length) {
				await new Promise<void>((r) => setTimeout(r, 0));
			}
		}

		this.finalizeVectors();
		this._ready = true;
		return this.getStats();
	}

	// ── Suggestion ───────────────────────────────────────────────────────

	suggest(
		content: string,
		existingTags: Set<string>,
		maxResults = 5,
		minScore = 0.01
	): TagSuggestion[] {
		if (!this._ready || this.taggedDocuments === 0) return [];

		const words = this.tokenize(content);
		if (words.length < 3) return [];

		// Build document TF-IDF vector
		const wordCounts = new Map<string, number>();
		for (const w of words) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);

		const docVector = new Map<string, number>();
		let docNorm = 0;

		for (const [word, count] of wordCounts) {
			const df = this.globalDocFreq.get(word);
			if (!df) continue; // word not in corpus
			const tf = count / words.length;
			const idf = Math.log(1 + this.taggedDocuments / df);
			const weight = tf * idf;
			docVector.set(word, weight);
			docNorm += weight * weight;
		}
		docNorm = Math.sqrt(docNorm);
		if (docNorm === 0) return [];

		const results: TagSuggestion[] = [];

		for (const [tag, profile] of this.tagProfiles) {
			if (existingTags.has(tag)) continue;
			if (profile.documentCount < 2) continue;
			if (profile.vectorNorm === 0) continue;

			// Cosine similarity with precomputed tag vector
			let dot = 0;
			for (const [word, docW] of docVector) {
				const tagW = profile.vector.get(word);
				if (tagW) dot += docW * tagW;
			}

			let score = dot / (docNorm * profile.vectorNorm);

			// Co-occurrence boost: if existing tags in the note frequently
			// appear alongside this candidate tag, boost the score
			for (const existingTag of existingTags) {
				const coMap = this.cooccurrence.get(existingTag);
				if (!coMap) continue;
				const coCount = coMap.get(tag);
				if (!coCount) continue;
				const existingProfile = this.tagProfiles.get(existingTag);
				if (!existingProfile) continue;
				const coRate = coCount / existingProfile.documentCount;
				score *= 1 + coRate;
			}

			if (score >= minScore) {
				results.push({ tag, score });
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, maxResults);
	}

	// ── Tag & word extraction (public for reuse in main.ts) ──────────────

	extractTags(content: string): Set<string> {
		const tags = new Set<string>();

		// Inline tags: #tag-name or #nested/tag
		const inlineRegex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/\-]*)/g;
		let m;
		while ((m = inlineRegex.exec(content)) !== null) {
			tags.add(m[1]);
		}

		// Frontmatter tags
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (fmMatch) {
			const fm = fmMatch[1];
			// Inline array: tags: [a, b]
			const arr = fm.match(/^tags:\s*\[([^\]]*)\]/m);
			if (arr) {
				arr[1].split(",").forEach((t) => {
					const v = t
						.trim()
						.replace(/^["']|["']$/g, "")
						.replace(/^#/, "");
					if (v) tags.add(v);
				});
			}
			// YAML list: tags:\n  - a\n  - b
			const list = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)*)/m);
			if (list) {
				list[1].match(/^\s*-\s*(.+)$/gm)?.forEach((item) => {
					const v = item
						.replace(/^\s*-\s*/, "")
						.trim()
						.replace(/^["']|["']$/g, "")
						.replace(/^#/, "");
					if (v) tags.add(v);
				});
			}
		}

		return tags;
	}

	tokenize(content: string): string[] {
		let body = content.replace(/^---\n[\s\S]*?\n---\n?/, ""); // frontmatter
		body = body.replace(/```[\s\S]*?```/g, ""); // code blocks
		body = body.replace(/`[^`]*`/g, ""); // inline code
		body = body.replace(/!\[.*?\]\(.*?\)/g, ""); // images
		body = body.replace(/\[([^\]]*)\]\(.*?\)/g, "$1"); // links
		body = body.replace(/\[\[([^\]|]*?)(?:\|.*?)?\]\]/g, "$1"); // wiki links
		body = body.replace(/#[a-zA-Z][a-zA-Z0-9_/\-]*/g, ""); // tags
		body = body.replace(/#{1,6}\s/g, ""); // heading markers
		body = body.replace(/[*_~`]+/g, ""); // emphasis

		return body
			.toLowerCase()
			.split(/[^a-zäöüßàáâãèéêëìíîïòóôõùúûüñç0-9]+/)
			.filter(
				(w) =>
					w.length >= 3 &&
					!STOP_WORDS.has(w) &&
					!/^\d+$/.test(w)
			);
	}

	// ── Private ──────────────────────────────────────────────────────────

	private clear() {
		this.tagProfiles.clear();
		this.cooccurrence.clear();
		this.globalDocFreq.clear();
		this.totalDocuments = 0;
		this.taggedDocuments = 0;
		this._ready = false;
	}

	private processFile(content: string) {
		this.totalDocuments++;
		const tags = this.extractTags(content);
		if (tags.size === 0) return; // only learn from tagged documents
		this.taggedDocuments++;

		const words = this.tokenize(content);
		const uniqueWords = new Set(words);

		// Global document frequency (for IDF)
		for (const w of uniqueWords) {
			this.globalDocFreq.set(
				w,
				(this.globalDocFreq.get(w) || 0) + 1
			);
		}

		// Per-tag word frequencies
		for (const tag of tags) {
			let profile = this.tagProfiles.get(tag);
			if (!profile) {
				profile = {
					documentCount: 0,
					wordCounts: new Map(),
					totalWordCount: 0,
					vector: new Map(),
					vectorNorm: 0,
				};
				this.tagProfiles.set(tag, profile);
			}
			profile.documentCount++;
			profile.totalWordCount += words.length;
			for (const w of words) {
				profile.wordCounts.set(
					w,
					(profile.wordCounts.get(w) || 0) + 1
				);
			}
		}

		// Tag co-occurrence matrix
		const tagArr = Array.from(tags);
		for (let i = 0; i < tagArr.length; i++) {
			for (let j = 0; j < tagArr.length; j++) {
				if (i === j) continue;
				let map = this.cooccurrence.get(tagArr[i]);
				if (!map) {
					map = new Map();
					this.cooccurrence.set(tagArr[i], map);
				}
				map.set(
					tagArr[j],
					(map.get(tagArr[j]) || 0) + 1
				);
			}
		}
	}

	private finalizeVectors() {
		// Precompute TF-IDF vectors for each tag
		for (const [, profile] of this.tagProfiles) {
			profile.vector.clear();
			let norm = 0;
			for (const [word, count] of profile.wordCounts) {
				const tf = count / profile.totalWordCount;
				const df = this.globalDocFreq.get(word) || 1;
				const idf = Math.log(1 + this.taggedDocuments / df);
				const weight = tf * idf;
				profile.vector.set(word, weight);
				norm += weight * weight;
			}
			profile.vectorNorm = Math.sqrt(norm);
		}
	}
}
