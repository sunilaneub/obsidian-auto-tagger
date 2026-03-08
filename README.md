# Auto Tagger for Obsidian

An Obsidian plugin that automatically suggests tags for your notes based on your vault's existing tagging patterns. No AI required — uses TF-IDF and cosine similarity to learn word-tag associations from your existing notes.

## How it works

1. **Vault scan**: On startup, the plugin scans all your notes and builds a statistical model of which words are associated with which tags
2. **TF-IDF vectors**: Each tag gets a weighted word profile — rare, distinctive words get more weight than common ones
3. **Cosine similarity**: When you open or edit a note, it compares the note's word vector against each tag's profile
4. **Co-occurrence boost**: Tags that frequently appear together in your vault get an additional relevance boost

## Features

- Real-time tag suggestions as you type (debounced)
- Suggestions when opening a note
- Manual trigger via command palette: "Suggest tags for current note"
- Configurable tag placement: first line (inline), frontmatter (YAML), or end of current line
- Adjustable confidence threshold and max suggestions
- Supports both English and German content
- Rescan vault command to update the model after significant changes

## Installation

### From Community Plugins
1. Open Obsidian Settings
2. Go to Community Plugins and disable Safe Mode
3. Search for "Auto Tagger"
4. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder `.obsidian/plugins/auto-tagger/` in your vault
3. Copy the files into that folder
4. Enable the plugin in Settings > Community Plugins

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Auto-suggest while editing | Suggest tags in real-time as you type | On |
| Check delay | Debounce time in ms before checking | 2000 |
| Tag placement | Where to insert tags (first line / frontmatter / end of line) | First line |
| Max suggestions | Maximum tags to suggest at once | 5 |
| Minimum confidence | Threshold for suggestions (lower = more) | 0.01 |

## Tips

- The more consistently you tag your existing notes, the better the suggestions become
- Use the "Rescan vault" button in settings after bulk-tagging notes
- The plugin needs at least 2 documents with a tag to consider it for suggestions
