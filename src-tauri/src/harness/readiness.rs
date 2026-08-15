//! Recognise the line `dsh web` prints when its server starts listening.
//!
//! The harness announces itself on stdout as `dsh web: http://127.0.0.1:52175`.
//! That string decides where the application points its WebView, so it is
//! validated rather than trusted: a supervised child must not be able to steer
//! the shell at an arbitrary origin by printing one.

/// Marker the harness prefixes its announcement with.
const READY_PREFIX: &str = "dsh web: ";

/// Outcome of inspecting one line of harness output.
#[derive(Debug, PartialEq, Eq)]
pub enum Ready {
    /// The line announced a usable loopback origin.
    At(String),
    /// The line announced something this shell refuses to load.
    Rejected(String),
}

/// Extract the loopback origin announced by one line of harness stdout.
///
/// Returns `None` for ordinary log output, which is most lines.
pub fn parse(line: &str) -> Option<Ready> {
    let announced = line.trim_end().strip_prefix(READY_PREFIX)?;
    // The announcement is a bare URL; anything after whitespace is commentary.
    let candidate = announced.split_whitespace().next().unwrap_or_default();

    let Ok(url) = url::Url::parse(candidate) else {
        return Some(Ready::Rejected(format!(
            "harness announced an unparseable URL: {candidate}"
        )));
    };

    let is_loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if url.scheme() != "http" || !is_loopback {
        return Some(Ready::Rejected(format!(
            "harness announced a non-loopback URL: {candidate}"
        )));
    }
    if url.port().is_none() {
        return Some(Ready::Rejected(format!(
            "harness announced a URL without an explicit port: {candidate}"
        )));
    }

    Some(Ready::At(url.origin().ascii_serialization()))
}

#[cfg(test)]
mod tests {
    use super::{parse, Ready};

    #[test]
    fn accepts_the_announcement_dsh_actually_prints() {
        assert_eq!(
            parse("dsh web: http://127.0.0.1:52175"),
            Some(Ready::At("http://127.0.0.1:52175".into()))
        );
    }

    #[test]
    fn tolerates_trailing_whitespace_and_carriage_returns() {
        assert_eq!(
            parse("dsh web: http://localhost:3080/\r\n"),
            Some(Ready::At("http://localhost:3080".into()))
        );
    }

    #[test]
    fn ignores_ordinary_log_output() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("loading plugin dsh-tool-bash"), None);
        assert_eq!(parse("  dsh web: http://127.0.0.1:1"), None);
    }

    #[test]
    fn refuses_to_be_steered_off_the_loopback() {
        assert!(matches!(
            parse("dsh web: http://example.com:80"),
            Some(Ready::Rejected(_))
        ));
        assert!(matches!(
            parse("dsh web: https://127.0.0.1:443"),
            Some(Ready::Rejected(_))
        ));
        assert!(matches!(
            parse("dsh web: file:///etc/passwd"),
            Some(Ready::Rejected(_))
        ));
    }

    #[test]
    fn requires_an_explicit_port() {
        assert!(matches!(
            parse("dsh web: http://127.0.0.1"),
            Some(Ready::Rejected(_))
        ));
    }

    #[test]
    fn rejects_garbage_after_the_marker() {
        assert!(matches!(
            parse("dsh web: not-a-url"),
            Some(Ready::Rejected(_))
        ));
    }
}
