// Release builds must not open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_studio_lib::run();
}
