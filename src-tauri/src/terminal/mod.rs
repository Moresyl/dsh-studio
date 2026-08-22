//! A real terminal, inside the window.
//!
//! Not a log view and not a command runner: a pty with a shell in it, so that
//! `dsh` — and git, and npm, and whatever else the work needs — can be run
//! without leaving the application or finding a separate terminal. That means a
//! pseudo-terminal rather than piped stdio, because line editing, colour, Ctrl-C
//! and progress bars are all things a program does only when it believes it is
//! talking to a terminal.
//!
//! Two decisions are worth stating outright.
//!
//! **The pty runs under its own [`ProcessGuard`], not the supervisor's.** Sharing
//! one would tie the two lifetimes together in the wrong direction: stopping the
//! harness would take the user's shells down with it, half-typed commands and all.
//! What matters is the guarantee, and a second guard gives exactly the same one —
//! on Windows a Job Object with `KILL_ON_JOB_CLOSE`, so closing the window is
//! enough to reclaim every process a terminal started, whether or not any code of
//! ours gets to run.
//!
//! **Each session owns three threads, and none of them is async.** `portable-pty`
//! is a blocking API, and wrapping blocking reads in tasks would either occupy a
//! runtime worker for the life of the terminal or lose the ordering that a
//! terminal is made of. Threads are the honest shape: one reading, one writing,
//! one waiting for the child to exit.

pub mod commands;
mod decoder;
mod shell;

use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use proc_guard::ProcessGuard;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::paths;

/// Channel the terminal pane listens on for output.
const OUTPUT_CHANNEL: &str = "terminal://output";

/// Channel that reports a shell having exited, so the tab can say so.
const EXIT_CHANNEL: &str = "terminal://exit";

/// Read buffer size. A pty read returns whatever has arrived, so this is a
/// ceiling rather than a batch size — large enough that a burst of build output
/// arrives in a few events instead of hundreds.
const READ_CHUNK: usize = 32 * 1024;

/// A terminal the frontend can address.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Handle for every other command. Unique for the life of the application.
    pub id: String,
    /// What is running, for the tab: `pwsh`, `bash`, `fish`.
    pub label: String,
    /// Directory the shell started in, which is what the tab's tooltip shows.
    pub cwd: PathBuf,
}

/// Output from one terminal.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id: String,
    /// Already decoded, so the frontend never has to reassemble a character.
    data: String,
}

/// A terminal whose shell has finished.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: String,
    /// `None` when the shell was ended by a signal rather than by exiting.
    code: Option<u32>,
}

/// What a live session needs to be steered from a command.
struct Live {
    /// Kept for `resize` — and because dropping it is what closes the pty.
    master: Box<dyn MasterPty + Send>,
    /// Bytes queued for the shell. Dropping it stops the writer thread.
    input: mpsc::Sender<Vec<u8>>,
    /// Ends the shell without waiting for it.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Repeated back by `list`, so a reopened pane can rebuild its tabs.
    describe: Session,
}

/// Every terminal this window has open.
pub struct Terminals {
    /// Own guard, deliberately. See the module comment.
    guard: ProcessGuard,
    live: Mutex<HashMap<String, Live>>,
    /// Session ids are handed out from here, never reused within a run.
    next: AtomicU64,
}

impl Terminals {
    pub fn new() -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            guard: ProcessGuard::new().map_err(Error::ProcessGuard)?,
            live: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }))
    }

    /// Open a terminal and start reading from it.
    ///
    /// `rows` and `cols` are the size the pane already knows it has. Starting at
    /// the right size matters more than it sounds: a shell asks once, at startup,
    /// and a prompt drawn for 80 columns stays wrong until something redraws it.
    pub fn open(
        self: &Arc<Self>,
        app: &AppHandle,
        rows: u16,
        cols: u16,
        login_environment: &BTreeMap<String, String>,
    ) -> Result<Session> {
        let pty = portable_pty::native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|failure| Error::Terminal(format!("could not open a terminal: {failure}")))?;

        let command = self.command(login_environment);
        let program = command.get_argv().clone();
        let cwd = command
            .get_cwd()
            .map(PathBuf::from)
            .unwrap_or_else(paths::default_workspace_dir);

        let mut child = pair.slave.spawn_command(command).map_err(|failure| {
            Error::Terminal(format!(
                "could not start {}: {failure}",
                shell::label(&program)
            ))
        })?;

        // Before anything else is set up: from here on the shell is the kernel's
        // problem to reclaim, however this process ends. A pid is all the pty layer
        // offers, and on Windows that leaves a gap of microseconds between creation
        // and adoption — `ProcessGuard::adopt` says so in full.
        if let Some(pid) = child.process_id() {
            if let Err(failure) = self.guard.adopt(pid) {
                let _ = child.kill();
                return Err(Error::Terminal(format!(
                    "could not put the terminal under process reclamation: {failure}"
                )));
            }
        }

        let reader = pair.master.try_clone_reader().map_err(|failure| {
            Error::Terminal(format!("could not read the terminal: {failure}"))
        })?;
        let writer = pair.master.take_writer().map_err(|failure| {
            Error::Terminal(format!("could not write to the terminal: {failure}"))
        })?;

        // Split off the ability to signal the shell before the child itself goes
        // to the waiter thread, which will be blocked inside `wait` and unable to
        // lend it back. This split is the whole reason `ChildKiller` is a separate
        // trait.
        let killer = child.clone_killer();
        let (input, queued) = mpsc::channel::<Vec<u8>>();

        let id = format!("t{}", self.next.fetch_add(1, Ordering::Relaxed));
        let describe = Session {
            id: id.clone(),
            label: shell::label(&program),
            cwd,
        };

        // Registered before the threads start, so a shell that exits immediately
        // cannot be forgotten before it was ever remembered.
        self.live.lock().expect("terminals poisoned").insert(
            id.clone(),
            Live {
                master: pair.master,
                input,
                killer,
                describe: describe.clone(),
            },
        );

        // The first bytes belong to the Desktop environment, before the shell
        // can draw its prompt. Emitting through the normal channel also means a
        // frontend that has not adopted this id yet buffers them in order.
        let profile = crate::profiles::selected();
        let tools = if crate::harness::install::runtime_compatible(&paths::harness_dir()) {
            "dsh · pnpm · node"
        } else {
            "node (Repair Environment to enable dsh and pnpm)"
        };
        let _ = app.emit(
            OUTPUT_CHANNEL,
            Output {
                id: id.clone(),
                data: format!(
                    "\r\n\x1b[1;36mDSH Studio {}\x1b[0m\r\nProfile: {}\r\nWorkspace: {}\r\nTools: {}\r\n\r\n",
                    app.package_info().version,
                    profile,
                    describe.cwd.display(),
                    tools
                ),
            },
        );

        spawn_reader(app.clone(), id.clone(), reader);
        spawn_writer(queued, writer);
        spawn_waiter(Arc::clone(self), app.clone(), id, child);

        Ok(describe)
    }

    /// Send keystrokes to a terminal.
    ///
    /// Queued rather than written here: a shell that has stopped reading would
    /// otherwise block the command, and through it whichever runtime worker was
    /// unlucky enough to be running it.
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let live = self.live.lock().expect("terminals poisoned");
        let session = live.get(id).ok_or_else(|| Self::gone(id))?;
        session
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| Self::gone(id))
    }

    /// Tell the shell the pane changed size.
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let live = self.live.lock().expect("terminals poisoned");
        let session = live.get(id).ok_or_else(|| Self::gone(id))?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|failure| Error::Terminal(format!("could not resize the terminal: {failure}")))
    }

    /// End a terminal now.
    ///
    /// The session is not removed here. The shell's death is what removes it, via
    /// the waiter thread, so a terminal that closes because the user asked and one
    /// that closes because someone typed `exit` take exactly the same path — and
    /// the tab hears about both the same way.
    pub fn close(&self, id: &str) -> Result<()> {
        let mut live = self.live.lock().expect("terminals poisoned");
        let session = live.get_mut(id).ok_or_else(|| Self::gone(id))?;
        session
            .killer
            .kill()
            .map_err(|failure| Error::Terminal(format!("could not end the terminal: {failure}")))
    }

    /// Every open terminal, so a pane that remounted can rebuild its tabs.
    pub fn list(&self) -> Vec<Session> {
        self.live
            .lock()
            .expect("terminals poisoned")
            .values()
            .map(|session| session.describe.clone())
            .collect()
    }

    /// Drop a session, having first let go of the lock.
    ///
    /// The order matters: dropping `master` closes the pseudo-console, and on
    /// Windows that blocks until the console host has flushed what it still holds.
    /// Doing it under the lock would stall every other terminal for as long as
    /// that takes.
    fn forget(&self, id: &str) {
        let session = self.live.lock().expect("terminals poisoned").remove(id);
        drop(session);
    }

    fn gone(id: &str) -> Error {
        Error::Terminal(format!("terminal {id} is no longer open"))
    }

    /// The command a new terminal runs, environment and all.
    fn command(&self, login_environment: &BTreeMap<String, String>) -> CommandBuilder {
        // `new_default_prog` is used only to read the environment the pty layer
        // would build: on Windows that is the registry's `PATH` rather than this
        // process's, so a shell installed since launch is found and a `PATH` the
        // user edited an hour ago is in effect.
        let base = CommandBuilder::new_default_prog();
        let inherited = base.get_env("PATH").map(OsString::from);
        let recovered = login_environment.get("PATH").map(String::as_str);

        let argv = shell::argv(recovered.map(OsStr::new).or(inherited.as_deref()));
        let mut command = CommandBuilder::from_argv(argv);

        for (name, value) in login_environment {
            command.env(name, value);
        }
        if let Some(path) = search_path(recovered.map(OsStr::new), inherited.as_deref()) {
            command.env("PATH", path);
        }

        // Same marker the supervised harness gets, so a plugin that behaves
        // differently under the desktop shell behaves the same way in here.
        command.env("DSH_DESKTOP", "1");
        let profile = crate::profiles::selected();
        command.env("DSH_PROFILE", &profile);
        command.env("DSH_PROFILE_DIR", paths::profile_dir(&profile));
        command.env("DSH_HOME", paths::dsh_home());

        // What every terminal emulator declares, and what curses programs read to
        // decide whether they may use colour at all. Not set on Windows: ConPTY
        // already tells programs what they need, and a `TERM` that looks like a
        // Unix one sends the MSYS tools that ship with Git down a different path.
        #[cfg(not(windows))]
        {
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
        }

        command.cwd(paths::default_workspace_dir());
        command
    }
}

/// `PATH` for a terminal: the harness's tools, then everything already there.
///
/// This is the difference between a terminal in this window and any other one on
/// the machine. `dsh` is installed inside application data, which is deliberately
/// not on anybody's `PATH` — so without this, the one command the pane exists to
/// make available would be the one command that does not work.
fn search_path(recovered: Option<&OsStr>, inherited: Option<&OsStr>) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = Vec::new();

    // The runtime the harness itself was started with, so `node` in here is the
    // same `node` the harness is running on rather than whichever came first.
    if let Some(node) = crate::harness::environment().node {
        if let Some(directory) = node.path.parent() {
            directories.push(directory.to_path_buf());
        }
    }

    let bin = paths::harness_dir().join("node_modules").join(".bin");
    if bin.is_dir() {
        directories.push(bin);
    }

    // The pinned pnpm installed for market operations is also the pnpm the
    // Desktop terminal promises. It remains private to child processes and
    // never modifies the user's PATH or shell startup files.
    let tools = paths::tools_dir().join("node_modules").join(".bin");
    if tools.is_dir() {
        directories.push(tools);
    }

    join_search_path(directories, recovered, inherited)
}

fn join_search_path(
    mut prepended: Vec<PathBuf>,
    recovered: Option<&OsStr>,
    inherited: Option<&OsStr>,
) -> Option<OsString> {
    if let Some(base) = recovered.or(inherited) {
        prepended.extend(std::env::split_paths(base));
    }
    if prepended.is_empty() {
        return None;
    }

    // A directory containing `;` on Windows cannot be expressed in a `PATH` at
    // all, and inventing a truncated one would be worse than leaving `PATH` alone.
    std::env::join_paths(prepended).ok()
}

/// Forward everything the shell prints to the pane that is showing it.
fn spawn_reader(app: AppHandle, id: String, mut reader: Box<dyn Read + Send>) {
    std::thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || {
            let mut decoder = decoder::Decoder::new();
            let mut buffer = vec![0u8; READ_CHUNK];

            loop {
                match reader.read(&mut buffer) {
                    // End of file: the pty closed, which happens when the session
                    // is forgotten. Nothing left to do.
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let data = decoder.push(&buffer[..read]);
                        // A read can be entirely the first half of a character.
                        if data.is_empty() {
                            continue;
                        }
                        if app
                            .emit(
                                OUTPUT_CHANNEL,
                                Output {
                                    id: id.clone(),
                                    data,
                                },
                            )
                            .is_err()
                        {
                            // The window is gone, so there is nobody to tell.
                            break;
                        }
                    }
                }
            }
        })
        .expect("spawn a pty reader thread");
}

/// Drain the input queue into the shell, in order.
fn spawn_writer(queued: mpsc::Receiver<Vec<u8>>, mut writer: Box<dyn Write + Send>) {
    std::thread::Builder::new()
        .name("pty-write".into())
        .spawn(move || {
            // Ends when the sender is dropped, which is when the session is
            // forgotten — and dropping the writer then sends EOF to the shell.
            while let Ok(bytes) = queued.recv() {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        })
        .expect("spawn a pty writer thread");
}

/// Wait for the shell to finish, then take the session down with it.
fn spawn_waiter(
    terminals: Arc<Terminals>,
    app: AppHandle,
    id: String,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    std::thread::Builder::new()
        .name(format!("pty-wait-{id}"))
        .spawn(move || {
            let status = child.wait().ok();

            // Forgetting the session closes the pty, which is what ends the reader
            // and writer threads. Without this they would wait on a shell that no
            // longer exists — on Windows the console host holds the pipe open, so
            // no amount of waiting would produce an end of file.
            terminals.forget(&id);

            let _ = app.emit(
                EXIT_CHANNEL,
                Exit {
                    id,
                    code: status.map(|status| status.exit_code()),
                },
            );
        })
        .expect("spawn a pty waiter thread");
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;

    use super::join_search_path;

    #[test]
    fn recovered_login_path_wins_over_the_gui_process_path() {
        let recovered = std::env::join_paths([PathBuf::from("login-bin")]).unwrap();
        let inherited = std::env::join_paths([PathBuf::from("gui-bin")]).unwrap();
        let joined = join_search_path(
            vec![PathBuf::from("studio-bin")],
            Some(&recovered),
            Some(&inherited),
        )
        .expect("a path");

        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            [PathBuf::from("studio-bin"), PathBuf::from("login-bin")]
        );
    }

    #[test]
    fn inherited_path_remains_the_fallback() {
        let inherited = std::env::join_paths([PathBuf::from("gui-bin")]).unwrap();
        let joined = join_search_path(Vec::new(), None, Some(&inherited)).expect("a path");
        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            [PathBuf::from("gui-bin")]
        );
    }

    #[test]
    fn no_input_does_not_invent_a_path() {
        assert_eq!(join_search_path(Vec::new(), None, None), None::<OsString>);
    }
}
