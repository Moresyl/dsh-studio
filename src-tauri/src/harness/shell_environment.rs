//! Recover the useful part of a packaged Unix login-shell environment.
//!
//! GUI applications on macOS and Linux are commonly launched without the PATH
//! and tool roots configured in interactive shell files. We ask the user's
//! supported login shell once, bound its output and deadline, then merge only a
//! small allowlist. Credentials and DSH-specific variables never become ambient
//! input to the supervised Harness.

use std::collections::BTreeMap;
#[cfg(all(unix, not(debug_assertions)))]
use std::path::Path;
#[cfg(all(unix, not(debug_assertions)))]
use std::time::Duration;

#[cfg(all(unix, not(debug_assertions)))]
use tokio::io::AsyncReadExt;

#[cfg(all(unix, not(debug_assertions)))]
const MAX_CAPTURE: u64 = 1 << 20;
#[cfg(all(unix, not(debug_assertions)))]
const DEADLINE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Resolution {
    pub updates: BTreeMap<String, String>,
    pub source: &'static str,
    pub fallback_reason: Option<&'static str>,
}

pub async fn resolve() -> Resolution {
    resolve_platform().await
}

#[cfg(any(windows, debug_assertions))]
async fn resolve_platform() -> Resolution {
    Resolution {
        source: "process",
        fallback_reason: Some(if cfg!(windows) {
            "windows"
        } else {
            "development"
        }),
        ..Resolution::default()
    }
}

#[cfg(all(unix, not(debug_assertions)))]
async fn resolve_platform() -> Resolution {
    let Some(shell) = std::env::var_os("SHELL") else {
        return fallback("missing-shell");
    };
    let shell = Path::new(&shell);
    if !shell.is_absolute() || !shell.is_file() {
        return fallback("missing-shell");
    }
    let Some(name) = shell.file_name().and_then(|name| name.to_str()) else {
        return fallback("unsupported-shell");
    };
    let args: &[&str] = match name {
        "bash" | "zsh" => &["-ilc"],
        "fish" => &["--login", "--interactive", "--command"],
        _ => return fallback("unsupported-shell"),
    };
    let marker = format!(
        "dsh-studio-env-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let end = format!("{marker}-end");
    let script = format!(
        "/usr/bin/printf '%s\\0' '{marker}'; /usr/bin/env -0; /usr/bin/printf '%s\\0' '{end}'"
    );
    let mut command = tokio::process::Command::new(shell);
    command
        .args(args)
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return fallback("capture-failed"),
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return fallback("capture-failed");
    };
    let captured = tokio::time::timeout(DEADLINE, async move {
        let mut body = Vec::new();
        let mut bounded = stdout.take(MAX_CAPTURE + 1);
        bounded.read_to_end(&mut body).await?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, body))
    })
    .await;
    let Ok(Ok((status, body))) = captured else {
        return fallback("capture-failed");
    };
    if !status.success() || body.len() as u64 > MAX_CAPTURE {
        return fallback("capture-failed");
    }
    let Ok(captured) = parse(&body, &marker, &end) else {
        return fallback("capture-failed");
    };
    let inherited: BTreeMap<String, String> = std::env::vars().collect();
    let updates = select(&captured, &inherited);
    if !updates.contains_key("PATH") {
        return fallback("missing-path");
    }
    Resolution {
        updates,
        source: "login-shell",
        fallback_reason: None,
    }
}

#[cfg(all(unix, not(debug_assertions)))]
fn fallback(reason: &'static str) -> Resolution {
    Resolution {
        source: "process",
        fallback_reason: Some(reason),
        ..Resolution::default()
    }
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn parse(
    body: &[u8],
    marker: &str,
    end: &str,
) -> std::result::Result<BTreeMap<String, String>, ()> {
    let text = String::from_utf8(body.to_vec()).map_err(|_| ())?;
    let start_marker = format!("{marker}\0");
    let end_marker = format!("{end}\0");
    let start = text.find(&start_marker).ok_or(())? + start_marker.len();
    let finish = text[start..].find(&end_marker).ok_or(())? + start;
    let mut environment = BTreeMap::new();
    for record in text[start..finish]
        .split('\0')
        .filter(|record| !record.is_empty())
    {
        let (name, value) = record.split_once('=').ok_or(())?;
        if name.is_empty() {
            return Err(());
        }
        environment.insert(name.to_string(), value.to_string());
    }
    Ok(environment)
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn select(
    captured: &BTreeMap<String, String>,
    inherited: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    captured
        .iter()
        .filter(|(name, value)| {
            !value.is_empty()
                && allowed(name)
                && (*name == "PATH" || !inherited.contains_key(*name))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn allowed(name: &str) -> bool {
    if name.starts_with("DSH_") || sensitive(name) {
        return false;
    }
    name == "PATH"
        || name.starts_with("LC_")
        || matches!(
            name,
            "ANDROID_HOME"
                | "ANDROID_SDK_ROOT"
                | "ASDF_DATA_DIR"
                | "ASDF_DIR"
                | "BUN_INSTALL"
                | "CARGO_HOME"
                | "CONDA_DEFAULT_ENV"
                | "CONDA_PREFIX"
                | "DENO_INSTALL"
                | "DOTNET_ROOT"
                | "FLUTTER_ROOT"
                | "GEM_HOME"
                | "GEM_PATH"
                | "GOBIN"
                | "GOMODCACHE"
                | "GOPATH"
                | "GOROOT"
                | "HOMEBREW_PREFIX"
                | "JAVA_HOME"
                | "LANG"
                | "LANGUAGE"
                | "NVM_BIN"
                | "NVM_DIR"
                | "PNPM_HOME"
                | "PYENV_ROOT"
                | "RBENV_ROOT"
                | "RUSTUP_HOME"
                | "SDKMAN_DIR"
                | "SDKROOT"
                | "TZ"
                | "VIRTUAL_ENV"
                | "VOLTA_HOME"
        )
}

#[cfg(any(test, all(unix, not(debug_assertions))))]
fn sensitive(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "AUTH",
        "CREDENTIAL",
        "COOKIE",
        "PRIVATE_KEY",
        "API_KEY",
    ]
    .iter()
    .any(|word| name.contains(word))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{parse, select};

    #[test]
    fn parses_only_the_marked_nul_delimited_environment() {
        let body = b"shell noise\ndsh-start\0PATH=/tools\0JAVA_HOME=/java\0dsh-end\0more noise";
        let parsed = parse(body, "dsh-start", "dsh-end").unwrap();
        assert_eq!(parsed["PATH"], "/tools");
        assert_eq!(parsed["JAVA_HOME"], "/java");
    }

    #[test]
    fn selects_useful_exports_without_credentials_or_explicit_overrides() {
        let captured = BTreeMap::from([
            ("PATH".into(), "/login/bin".into()),
            ("JAVA_HOME".into(), "/login/java".into()),
            ("GITHUB_TOKEN".into(), "secret".into()),
            ("DSH_HOME".into(), "/wrong".into()),
            ("UNRELATED".into(), "value".into()),
        ]);
        let inherited = BTreeMap::from([("JAVA_HOME".into(), "/explicit/java".into())]);
        let selected = select(&captured, &inherited);
        assert_eq!(
            selected,
            BTreeMap::from([("PATH".into(), "/login/bin".into())])
        );
    }
}
