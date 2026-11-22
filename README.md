# Tasks

English | [简体中文](README.zh-CN.md)

A local Markdown to-do app for macOS 26. Each `.md` file is a list, and a folder is a task vault. There is no private database.

Built with Tauri 2 / Rust, React / TypeScript and CodeMirror 6. The window uses the system WKWebView. File watching, notifications, menus and PDF printing use macOS APIs. It is not a SwiftUI / TextKit project and does not need the full Xcode.

The app's interface is in Chinese only. UI labels below appear in parentheses.

## Running

You need Node.js 22.12+, stable Rust and the Xcode Command Line Tools for development.

```sh
npm ci
npm run tauri -- dev
```

`npm run dev` starts only the frontend server. In a plain browser there is no file system access, notifications or other native features.

To build the app for the host architecture:

```sh
npm run tauri -- build --bundles app
open src-tauri/target/release/bundle/macos/Tasks.app
```

You can drag `Tasks.app` into `/Applications`. The app is for personal use on your own Mac: it has no Developer ID signing, notarization, auto-update or App Sandbox. The window uses the system sidebar vibrancy material and an overlay title bar. That requires Tauri's `macos-private-api`, so the app can't go on the App Store.

## Usage

1. On first launch, choose a task folder. The app reads the `.md` files in it recursively. Hidden directories and `attachments/` are left out of the task index. Subdirectories that can't be read, files that aren't UTF-8, and links pointing outside the task folder are skipped, and you get one notice about them.
2. Press `⌘N` to create a list and type Markdown. Edits save automatically about one second after you stop typing. Pending edits are also saved before the app quits (`⌘Q`, Quit from the Dock, logout or shutdown). Files with CRLF line endings are written back with CRLF.
3. The sidebar has Today (今天), Upcoming (即将到期, the next seven days), Done (已完成), Tags and the file tree. Right-click a file or folder to rename it or move it to the Trash. Right-click empty space to create a folder.
4. In the aggregate views, you can check off tasks or click a field badge to change the due date, reminder, priority or recurrence. Changes are written back to the source file.
5. The search box scans the text of every list. Click a result to jump to that line.

Today shows open tasks that are due today or overdue. It also shows open tasks with no due date whose reminder is today or has passed. Tasks are sorted by due date, then by priority. Tags can be nested, as in `#work` and `#work/project`. `- [-]` marks a task as cancelled: cancelled tasks don't appear in Today, Upcoming or reminders, and checking one again makes it open. A `- [ ]` inside a code block is not a task.

### Markdown format

Fields use the Obsidian Tasks syntax. Reminders are written `⏰ YYYY-MM-DD HH:mm` in the local time zone.

```markdown
# Work

- [ ] Sort out the notes #work ⏫ 📅 2026-10-05 ⏰ 2026-10-05 09:00
- [ ] Weekly report #work 🔁 every week 📅 2026-10-09
- [ ] Release
    - [ ] Check the copy
    - [ ] Update screenshots

## Done

- [x] Handled ✅ 2026-10-03
```

Completing a parent task also checks its subtasks. About three seconds after a top-level task is completed, it moves with its subtasks to a `## Done` section at the bottom of the file. You can uncheck it during that delay.

When you complete a recurring task, the next instance appears in its place. All of its dates (due, reminder, scheduled, start) move by the same interval, and `when done` rules count from the day of completion. The old instance is archived as usual. Supported rules are days, weeks, months, years, every N days, specific weekdays and a day of the month. A task with a recurrence rule the app can't parse can't be completed: the app shows a notice and marks the badge as invalid.

Obsidian block references (`^id`) at the end of a line and the 🆔 ⛔ 🏁 ❌ fields are kept unchanged.

The aggregate views and the field popover find a task by its line number and the text of that line. If the file changed in the meantime and the line no longer matches, the action is cancelled and you're asked to retry, so a different task is never edited by mistake.

### Editing and completion

- The line with the cursor shows Markdown source, and every other line shows a live preview. A table shows its source when the cursor moves into it.
- Supported elements: headings, bold and italic, inline code, code blocks, checkboxes, field badges, links, images, tables, blockquotes and horizontal rules.
- Type `@` to open completion in English or Chinese, for example `@tomorrow`, `@remind tomorrow 9am`, `@every monday`, `@high priority` or `@明天`. Use the arrow keys to choose, Enter to accept and Escape to cancel.
- Dropping or pasting an image copies it into the vault's `attachments/` folder and inserts a relative path. The original image isn't moved. Clicking a link to a local file opens it in its default app. This works only for files inside the vault, and executables, `.app` bundles and similar files are refused. `#heading` links jump to that heading.
- Light and dark appearance follow the system. The colour of a checkbox ring shows the task's priority: red for high, yellow for medium, blue-grey for low.
- The search box works with input methods such as Chinese pinyin. Your input is kept while you compose, and results update after you pick a candidate. During composition, Escape goes to the input method; otherwise it clears the search.

### External changes and conflicts

The app watches the vault with FSEvents and rereads only the files that changed. Events that can't be matched to individual files, such as renaming or moving a folder, trigger a full reload.

If the editor has no unsaved edits, outside changes load automatically. If it does have edits, autosave pauses and the app asks whether to keep your version or the one on disk. It never merges the two by itself. Every write is checked against the file on disk on the Rust side. If someone else changed the file in the meantime, the app treats it as a conflict instead of overwriting it.

If a save fails, a bar appears at the top of the main area with Retry (重试), Save a Copy (另存副本…) and Discard Local Changes (放弃本地修改). Saves write a temporary file and then rename it over the original. Extended attributes, ACLs and the creation date are kept, but hard links are broken.

Deleted lists go to the system Trash. There is no built-in sync, backup or version history, so back up your task folder yourself.

### Reminders

Reminders are registered ahead of time with `UNUserNotificationCenter`. The system delivers registered reminders, so the app doesn't need to keep running. The system keeps only 64 pending reminders per app, so the app registers the 64 soonest. The next reminder of a recurring task is registered after you complete the current instance and the new one is created. Reminders are synced once more before the app quits, with a wait of up to 2 seconds.

You need to allow notifications the first time. If you said no, turn them on in System Settings → Notifications → Tasks and restart the app. If the system refuses notifications, the app reports a scheduling error instead of treating the reminders as registered.

Notification permissions and Focus modes affect whether and how reminders appear.

### Export

To export, use the export button at the top right of the current list or the File menu. You pick where to save in a system dialog.

- **PDF**: laid out by the system's WebKit on A4 pages with automatic page breaks. If the export fails, any existing file at that location is left as it was.
- **HTML**: local images are embedded, remote image URLs are kept, and relative links are rewritten for the new location. If some images can't be read, their original links are kept and you get a notice.
- **Markdown**: relative links in the copy are rewritten for the new location. Images stay in the original vault and aren't copied.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘N` | New list |
| `⌘⇧N` | New folder |
| `⌘F` | Search all lists |
| `⌘↩` | Mark the current task done or not done |
| `⌘1` / `⌘2` | Today / Upcoming |
| `⌘3` / `⌘4` / `⌘5` | Tags / Done / Lists |
| `⌘⇧E` | Export the current list as PDF |
| `⌘Z` / `⌘⇧Z` | Undo / redo in the editor |

Closing the window hides it; click the Dock icon to bring it back. `⌘Q`, Quit from the Dock and logout all save before quitting. If saving fails, the app stays open and tells you.

## Security

The frontend can reach files only through Rust commands, and every path must be inside the current vault, with symlinks checked. Images are served through a custom `vaultfile://` protocol from whichever vault is open when they're requested. Exports can only be written to the path you chose in the dialog. A strict CSP is in place.

## Verification

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

All 301 TypeScript tests and 17 Rust tests currently pass.

- Core tests cover Markdown parsing and field edits, CRLF, code blocks, cancelled tasks, block references, completing parents and subtasks together, moving recurrence dates, archiving completed tasks, date completion, aggregate queries and search.
- App-layer tests cover line-ending conversion, link classification, rewriting links on export and merging on reload.
- Rust tests cover path checks, detecting write conflicts, skipping directories, non-UTF-8 files, watcher events, the reminder limit, the attachment allowlist and keeping the creation date.

Native app smoke test (2026-11-22):

- Files and folders added from outside showed up right away.
- Quitting with `⌘Q` or via AppleScript within a second of typing saved the content and exited normally.
- Checking a task in a CRLF file kept the line endings and archived the task correctly.
- Shortcuts such as `⌘2` worked.

During local testing the system returned `Notifications are not allowed for this application`, so **notification delivery hasn't been tested yet**. The quit flow on logout hasn't been tested either. The production build shows a harmless warning that a JavaScript chunk is larger than 500 kB.

## Code layout

- `src/core/`: parsing, task edits, dates and queries, independent of the UI.
- `src/editor/`: CodeMirror live preview, images, badges and completion.
- `src/app/`: vault index, editing sessions, conflict handling, views and export conversion.
- `src-tauri/src/`: file system and path checks (`vault.rs`, `tracker.rs`), FSEvents (`watcher.rs`), system notifications, the native menu and quit handling (`menu.rs`, `quit.rs`), export (`export.rs`, `pdf.rs`) and the `vaultfile://` protocol.
