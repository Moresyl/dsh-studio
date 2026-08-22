//! The small native menu macOS keeps above every application.
//!
//! Tauri's generated default carries entries that do not describe this shell.
//! Keep the platform's standard editing commands, then make the application
//! menu answer the two lifecycle actions people actually need here.

// Compile the native implementation in tests on every desktop target. This
// catches Tauri menu API drift even when the maintainer is not building on a
// Mac; only macOS exports and executes it in production.
#[cfg(any(target_os = "macos", test))]
mod native {
    use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Emitter, Runtime};

    const CHECK_UPDATE: &str = "application-check-update";
    const RESTART: &str = "application-restart";
    const CHECK_UPDATE_EVENT: &str = "application://check-update";

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
        let pick = crate::locale::pick;
        let about = PredefinedMenuItem::about(
            app,
            Some(pick("About DSH Studio", "关于 DSH Studio")),
            None,
        )?;
        let check = MenuItem::with_id(
            app,
            CHECK_UPDATE,
            pick("Check for Updates…", "检查更新…"),
            true,
            None::<&str>,
        )?;
        let restart = MenuItem::with_id(
            app,
            RESTART,
            pick("Restart DSH Studio", "重新启动 DSH Studio"),
            true,
            None::<&str>,
        )?;
        let first_separator = PredefinedMenuItem::separator(app)?;
        let second_separator = PredefinedMenuItem::separator(app)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        let application = Submenu::with_items(
            app,
            "DSH Studio",
            true,
            &[
                &about,
                &check,
                &restart,
                &first_separator,
                &hide,
                &hide_others,
                &show_all,
                &second_separator,
                &quit,
            ],
        )?;

        let undo = PredefinedMenuItem::undo(app, None)?;
        let redo = PredefinedMenuItem::redo(app, None)?;
        let edit_separator = PredefinedMenuItem::separator(app)?;
        let cut = PredefinedMenuItem::cut(app, None)?;
        let copy = PredefinedMenuItem::copy(app, None)?;
        let paste = PredefinedMenuItem::paste(app, None)?;
        let select_all = PredefinedMenuItem::select_all(app, None)?;
        let edit = Submenu::with_items(
            app,
            pick("Edit", "编辑"),
            true,
            &[
                &undo,
                &redo,
                &edit_separator,
                &cut,
                &copy,
                &paste,
                &select_all,
            ],
        )?;

        let minimize = PredefinedMenuItem::minimize(app, None)?;
        let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
        let window =
            Submenu::with_items(app, pick("Window", "窗口"), true, &[&minimize, &fullscreen])?;

        app.set_menu(Menu::with_items(app, &[&application, &edit, &window])?)?;
        app.on_menu_event(on_menu);
        Ok(())
    }

    fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
        match event.id().as_ref() {
            CHECK_UPDATE => {
                if let Some(window) = crate::window::front(app) {
                    crate::window::reveal(&window);
                }
                let _ = app.emit(CHECK_UPDATE_EVENT, ());
            }
            RESTART => app.restart(),
            _ => {}
        }
    }
}

#[cfg(target_os = "macos")]
pub use native::build;

#[cfg(not(target_os = "macos"))]
pub fn build<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
#[test]
fn native_menu_contract_compiles_on_every_desktop_target() {
    let _: fn(&tauri::AppHandle<tauri::Wry>) -> tauri::Result<()> = native::build::<tauri::Wry>;
}
