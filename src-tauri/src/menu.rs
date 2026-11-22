//! Native application menu. Custom items emit the `menu` event with their id.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Ids of custom items forwarded to the frontend (must match `MenuId` in src/backend.ts).
const MENU_IDS: &[&str] = &[
    "new-list",
    "new-folder",
    "choose-vault",
    "export-pdf",
    "export-html",
    "export-md",
    "find",
    "toggle-task",
    "view-today",
    "view-upcoming",
    "view-tags",
    "view-done",
    "view-lists",
];

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accelerator)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Tasks")
        .about(Some(AboutMetadata::default()))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-list", "New List", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "new-folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?)
        .separator()
        .item(&item(app, "choose-vault", "Choose Vault…", None)?)
        .separator()
        .item(&item(app, "export-pdf", "Export PDF…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item(app, "export-html", "Export HTML…", None)?)
        .item(&item(app, "export-md", "Export Markdown…", None)?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find", "Find…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let task = SubmenuBuilder::new(app, "Task")
        .item(&item(app, "toggle-task", "Toggle Done", Some("CmdOrCtrl+Enter"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "view-today", "Today", Some("CmdOrCtrl+1"))?)
        .item(&item(app, "view-upcoming", "Upcoming", Some("CmdOrCtrl+2"))?)
        .item(&item(app, "view-tags", "Tags", Some("CmdOrCtrl+3"))?)
        .item(&item(app, "view-done", "Done", Some("CmdOrCtrl+4"))?)
        .item(&item(app, "view-lists", "Lists", Some("CmdOrCtrl+5"))?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &task, &view, &window])
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if MENU_IDS.contains(&id) {
        if let Err(e) = app.emit("menu", id) {
            eprintln!("tasks: cannot emit menu event {id}: {e}");
        }
    }
}
