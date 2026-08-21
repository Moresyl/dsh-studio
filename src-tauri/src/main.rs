// Release builds must not open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Packaged-artifact verification needs a path that proves the installed
    // executable can be loaded without opening a window or touching user data.
    if std::env::args_os().any(|argument| argument == "--smoke-test") {
        return;
    }
    dsh_studio_lib::run();
}
