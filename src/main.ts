import {
	Plugin,
	PluginSettingTab,
	Setting,
	App,
	Editor,
	MarkdownView,
	Notice,
	Modal,
	TFile,
} from "obsidian";
import { TagModel, TagSuggestion } from "./model";

// ── Types ────────────────────────────────────────────────────────────────────

interface AutoTaggerSettings {
	debounceMs: number;
	tagLocation: "first-line" | "frontmatter" | "inline-end";
	minScore: number;
	maxSuggestions: number;
	autoSuggest: boolean;
}

const DEFAULT_SETTINGS: AutoTaggerSettings = {
	debounceMs: 2000,
	tagLocation: "first-line",
	minScore: 0.01,
	maxSuggestions: 5,
	autoSuggest: true,
};

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class AutoTaggerPlugin extends Plugin {
	settings: AutoTaggerSettings;
	model: TagModel;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private suggestedForFile = new Map<string, Set<string>>();
	private activeNotice: Notice | null = null;
	private pendingSuggestions: TagSuggestion[] = [];
	private pendingIdx = 0;

	async onload() {
		await this.loadSettings();
		this.model = new TagModel();
		this.addSettingTab(new AutoTaggerSettingTab(this.app, this));

		// Scan vault once layout is ready
		this.app.workspace.onLayoutReady(async () => {
			const notice = new Notice("Auto Tagger: Scanning vault...", 0);
			try {
				const stats = await this.model.scan(this.app);
				notice.hide();
				new Notice(
					`Auto Tagger: ${stats.uniqueTags} tags learned from ${stats.taggedDocuments} notes`
				);
			} catch (e) {
				notice.hide();
				console.error("Auto Tagger scan error:", e);
				new Notice("Auto Tagger: Scan failed. See console.");
			}
		});

		// Real-time editor change detection
		this.registerEvent(
			this.app.workspace.on("editor-change", (editor) => {
				if (this.settings.autoSuggest) this.scheduleCheck(editor);
			})
		);

		// On file open: reset tracking and run tag check
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.pendingSuggestions = [];
				this.pendingIdx = 0;
				this.activeNotice?.hide();
				this.activeNotice = null;

				// Run tag check on the newly opened note
				if (!leaf) return;
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) return;
				const editor = view.editor;
				const file = view.file;
				if (!editor || !file) return;

				// Small delay to let the editor settle
				setTimeout(() => {
					this.suggestedForFile.delete(file.path);
					this.checkAndSuggest(editor);
				}, 500);
			})
		);

		// Commands
		this.addCommand({
			id: "suggest-tags",
			name: "Suggest tags for current note",
			editorCallback: (editor, view) => {
				if (!view.file) return;
				this.suggestedForFile.delete(view.file.path);
				this.showAllSuggestions(editor, view.file);
			},
		});

		this.addCommand({
			id: "rescan-vault",
			name: "Rescan vault for tag patterns",
			callback: async () => {
				const notice = new Notice("Rescanning vault...", 0);
				const stats = await this.model.scan(this.app);
				notice.hide();
				this.suggestedForFile.clear();
				new Notice(
					`Done: ${stats.uniqueTags} tags from ${stats.taggedDocuments} notes`
				);
			},
		});
	}

	onunload() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.activeNotice?.hide();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	clearCache() {
		this.suggestedForFile.clear();
	}

	// ── Real-time suggestion flow ────────────────────────────────────────

	private scheduleCheck(editor: Editor) {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.checkAndSuggest(editor);
		}, this.settings.debounceMs);
	}

	private checkAndSuggest(editor: Editor) {
		if (!this.model.isReady) return;

		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		const content = editor.getValue();
		const existingTags = this.model.extractTags(content);

		if (!this.suggestedForFile.has(file.path)) {
			this.suggestedForFile.set(file.path, new Set());
		}
		const seen = this.suggestedForFile.get(file.path)!;

		const suggestions = this.model
			.suggest(
				content,
				existingTags,
				this.settings.maxSuggestions,
				this.settings.minScore
			)
			.filter((s) => !seen.has(s.tag));

		if (suggestions.length === 0) return;

		for (const s of suggestions) seen.add(s.tag);

		this.pendingSuggestions = suggestions;
		this.pendingIdx = 0;
		this.showNextSuggestion(editor, file);
	}

	private showNextSuggestion(editor: Editor, file: TFile) {
		if (this.pendingIdx >= this.pendingSuggestions.length) return;

		this.activeNotice?.hide();

		const suggestion = this.pendingSuggestions[this.pendingIdx];
		const remaining =
			this.pendingSuggestions.length - this.pendingIdx;

		const frag = document.createDocumentFragment();
		const box = frag.createEl("div", { cls: "auto-tagger-notice" });

		const msg = box.createEl("div", {
			cls: "auto-tagger-notice-message",
		});
		msg.appendText("Suggest: ");
		msg.createEl("code", { text: `#${suggestion.tag}` });
		if (remaining > 1) {
			msg.createEl("span", {
				text: ` (+${remaining - 1} more)`,
				cls: "auto-tagger-muted",
			});
		}

		const btns = box.createEl("div", {
			cls: "auto-tagger-notice-buttons",
		});

		btns.createEl("button", { text: "Add", cls: "mod-cta" }).addEventListener(
			"click",
			async () => {
				notice.hide();
				this.activeNotice = null;
				await this.addTag(editor, file, suggestion.tag);
				this.pendingIdx++;
				this.showNextSuggestion(editor, file);
			}
		);

		btns.createEl("button", { text: "Skip" }).addEventListener(
			"click",
			() => {
				notice.hide();
				this.activeNotice = null;
				this.pendingIdx++;
				this.showNextSuggestion(editor, file);
			}
		);

		if (remaining > 1) {
			btns.createEl("button", { text: "Show all" }).addEventListener(
				"click",
				() => {
					notice.hide();
					this.activeNotice = null;
					this.showAllSuggestions(editor, file);
				}
			);
		}

		const notice = new Notice(frag, 0);
		this.activeNotice = notice;
	}

	// ── Modal with all suggestions ───────────────────────────────────────

	private showAllSuggestions(editor: Editor, file: TFile) {
		const content = editor.getValue();
		const existingTags = this.model.extractTags(content);
		const suggestions = this.model.suggest(
			content,
			existingTags,
			this.settings.maxSuggestions * 2,
			this.settings.minScore
		);

		if (suggestions.length === 0) {
			new Notice("No tag suggestions for this note.");
			return;
		}

		new TagSuggestionModal(
			this.app,
			suggestions,
			async (selected) => {
				for (const tag of selected) {
					await this.addTag(editor, file, tag);
				}
				if (selected.length > 0) {
					new Notice(`Added ${selected.length} tag(s)`);
				}
			}
		).open();
	}

	// ── Tag insertion ────────────────────────────────────────────────────

	private async addTag(editor: Editor, file: TFile, tag: string) {
		if (this.settings.tagLocation === "frontmatter") {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (!fm.tags) fm.tags = [];
				if (!Array.isArray(fm.tags)) fm.tags = [fm.tags];
				if (!fm.tags.includes(tag)) fm.tags.push(tag);
			});
		} else if (this.settings.tagLocation === "first-line") {
			// Find the first content line (skip frontmatter if present)
			const content = editor.getValue();
			let firstLine = 0;
			const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
			if (fmMatch) {
				firstLine = fmMatch[0].split("\n").length - 1;
				// Skip empty lines after frontmatter
				while (
					firstLine < editor.lineCount() &&
					editor.getLine(firstLine).trim() === ""
				) {
					firstLine++;
				}
			}

			const lineText = editor.getLine(firstLine);
			// Check if first line already has tags — append to it
			if (/^#[a-zA-Z]/.test(lineText.trim())) {
				editor.replaceRange(` #${tag}`, {
					line: firstLine,
					ch: lineText.length,
				});
			} else {
				// Insert a new tag line before the first content line
				editor.replaceRange(`#${tag}\n`, {
					line: firstLine,
					ch: 0,
				});
			}
		} else {
			// inline-end: append to current line
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			editor.replaceRange(` #${tag}`, {
				line: cursor.line,
				ch: line.length,
			});
		}
	}
}

// ── Tag Suggestion Modal ─────────────────────────────────────────────────────

class TagSuggestionModal extends Modal {
	private suggestions: TagSuggestion[];
	private onAccept: (tags: string[]) => void;
	private selected: Set<string>;

	constructor(
		app: App,
		suggestions: TagSuggestion[],
		onAccept: (tags: string[]) => void
	) {
		super(app);
		this.suggestions = suggestions;
		this.onAccept = onAccept;
		// Pre-select top 3
		this.selected = new Set(
			suggestions.filter((_, i) => i < 3).map((s) => s.tag)
		);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("auto-tagger-modal");

		contentEl.createEl("h3", { text: "Suggested Tags" });
		contentEl.createEl("p", {
			text: "Based on your note's content and vault-wide tagging patterns:",
			cls: "setting-item-description",
		});

		const maxScore = this.suggestions[0]?.score || 1;

		for (const s of this.suggestions) {
			const row = contentEl.createEl("div", {
				cls: "auto-tagger-suggestion-row",
			});

			const cb = row.createEl("input") as HTMLInputElement;
			cb.type = "checkbox";
			cb.checked = this.selected.has(s.tag);
			cb.addEventListener("change", () => {
				if (cb.checked) this.selected.add(s.tag);
				else this.selected.delete(s.tag);
			});

			row.createEl("code", {
				text: `#${s.tag}`,
				cls: "auto-tagger-tag",
			});

			const barWrap = row.createEl("div", {
				cls: "auto-tagger-bar-container",
			});
			const bar = barWrap.createEl("div", {
				cls: "auto-tagger-bar",
			});
			bar.style.width = `${Math.round((s.score / maxScore) * 100)}%`;
		}

		const btns = contentEl.createEl("div", {
			cls: "auto-tagger-modal-buttons",
		});

		btns.createEl("button", {
			text: "Add selected",
			cls: "mod-cta",
		}).addEventListener("click", () => {
			this.close();
			this.onAccept(Array.from(this.selected));
		});

		btns.createEl("button", { text: "Dismiss" }).addEventListener(
			"click",
			() => this.close()
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Settings Tab ─────────────────────────────────────────────────────────────

class AutoTaggerSettingTab extends PluginSettingTab {
	plugin: AutoTaggerPlugin;

	constructor(app: App, plugin: AutoTaggerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Auto Tagger" });

		// Model stats
		if (this.plugin.model.isReady) {
			const stats = this.plugin.model.getStats();
			containerEl.createEl("p", {
				text: `${stats.uniqueTags} tags learned from ${stats.taggedDocuments} tagged notes (${stats.totalDocuments} total). ${stats.uniqueWords} unique words indexed.`,
				cls: "setting-item-description",
			});
		}

		new Setting(containerEl)
			.setName("Auto-suggest while editing")
			.setDesc("Suggest tags in real-time as you type")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoSuggest)
					.onChange(async (v) => {
						this.plugin.settings.autoSuggest = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Check delay (ms)")
			.setDesc(
				"Wait time after typing before checking (higher = less intrusive)"
			)
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(
						String(this.plugin.settings.debounceMs)
					)
					.onChange(async (value) => {
						const n = parseInt(value);
						if (!isNaN(n) && n >= 500) {
							this.plugin.settings.debounceMs = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Tag placement")
			.setDesc("Where to insert accepted tags")
			.addDropdown((dd) =>
				dd
					.addOption(
						"first-line",
						"First line (inline tags)"
					)
					.addOption(
						"frontmatter",
						"Frontmatter (YAML tags)"
					)
					.addOption("inline-end", "End of current line")
					.setValue(this.plugin.settings.tagLocation)
					.onChange(async (v) => {
						this.plugin.settings.tagLocation =
							v as AutoTaggerSettings["tagLocation"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max suggestions")
			.setDesc("Maximum tags to suggest at once")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.maxSuggestions)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxSuggestions = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Minimum confidence")
			.setDesc(
				"Lower = more suggestions, higher = only strong matches"
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.005, 0.1, 0.005)
					.setValue(this.plugin.settings.minScore)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.minScore = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Rescan vault")
			.setDesc("Re-learn tag patterns from all notes")
			.addButton((btn) =>
				btn.setButtonText("Rescan now").onClick(async () => {
					const notice = new Notice("Rescanning...", 0);
					const stats = await this.plugin.model.scan(
						this.app
					);
					notice.hide();
					this.plugin.clearCache();
					new Notice(
						`Done: ${stats.uniqueTags} tags from ${stats.taggedDocuments} notes`
					);
					this.display();
				})
			);
	}
}
