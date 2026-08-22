// Release builds must not open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::{OsStr, OsString};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Launch,
    SmokeTest,
    ExportDiagnostics,
}

fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    match action(&arguments) {
        Ok(Action::SmokeTest) => {}
        Ok(Action::ExportDiagnostics) => {
            attach_parent_console();
            match dsh_studio_lib::export_diagnostics_cli() {
                Ok(path) => println!("{}", path.display()),
                Err(cause) => {
                    eprintln!("dsh-studio: could not export diagnostics: {cause}");
                    std::process::exit(1);
                }
            }
        }
        Ok(Action::Launch) => dsh_studio_lib::run(),
        Err(cause) => {
            attach_parent_console();
            eprintln!("dsh-studio: {cause}");
            std::process::exit(2);
        }
    }
}

fn action(arguments: &[OsString]) -> Result<Action, &'static str> {
    if arguments.is_empty() {
        return Ok(Action::Launch);
    }
    if arguments.len() == 1 && arguments[0] == OsStr::new("--smoke-test") {
        return Ok(Action::SmokeTest);
    }
    if arguments.len() == 1 && arguments[0] == OsStr::new("--export-diagnostics") {
        return Ok(Action::ExportDiagnostics);
    }
    if arguments.iter().any(|argument| {
        argument == OsStr::new("--smoke-test") || argument == OsStr::new("--export-diagnostics")
    }) {
        return Err("--smoke-test and --export-diagnostics must be used alone");
    }
    Ok(Action::Launch)
}

#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    // Release builds are GUI-subsystem executables. Attach only for an explicit
    // CLI action so PowerShell can show the exported absolute path and errors.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn headless_actions_are_exact_and_do_not_fall_through_to_launch() {
        assert_eq!(action(&arguments(&[])), Ok(Action::Launch));
        assert_eq!(action(&arguments(&["--smoke-test"])), Ok(Action::SmokeTest));
        assert_eq!(
            action(&arguments(&["--export-diagnostics"])),
            Ok(Action::ExportDiagnostics)
        );
        assert!(action(&arguments(&["--export-diagnostics", "extra"])).is_err());
    }

    #[test]
    fn ordinary_desktop_arguments_still_launch_tauri() {
        assert_eq!(
            action(&arguments(&["--dsh-startup-standby"])),
            Ok(Action::Launch)
        );
    }
}
