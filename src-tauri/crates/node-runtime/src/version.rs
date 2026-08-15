//! Node version numbers.
//!
//! Node reports `v24.0.0` and ships prereleases as `v25.0.0-nightly...`. Only the
//! three release numbers decide whether a runtime is usable, so the tail is
//! parsed off and discarded rather than modelled.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A `major.minor.patch` triple, ordered the way Node orders releases.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Parse the output of `node --version`, with or without the leading `v`.
    ///
    /// Returns `None` for anything that is not a release triple, which is the
    /// correct answer for shims that print a banner instead of a version.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        // Drop any prerelease/build tail: `25.0.0-nightly2026` -> `25.0.0`.
        let core = text
            .split(['-', '+'])
            .next()
            .filter(|core| !core.is_empty())?;

        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        if parts.next().is_some() {
            return None;
        }

        Some(Self {
            major,
            minor,
            patch,
        })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl fmt::Debug for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "v{self}")
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn parses_plain_and_prefixed_releases() {
        assert_eq!(Version::parse("v24.0.0"), Some(Version::new(24, 0, 0)));
        assert_eq!(Version::parse("22.14.3\n"), Some(Version::new(22, 14, 3)));
    }

    #[test]
    fn drops_prerelease_and_build_tails() {
        assert_eq!(
            Version::parse("v25.0.0-nightly20260101"),
            Some(Version::new(25, 0, 0))
        );
        assert_eq!(
            Version::parse("v20.1.0+build7"),
            Some(Version::new(20, 1, 0))
        );
    }

    #[test]
    fn fills_in_omitted_components() {
        assert_eq!(Version::parse("v24"), Some(Version::new(24, 0, 0)));
        assert_eq!(Version::parse("v24.6"), Some(Version::new(24, 6, 0)));
    }

    #[test]
    fn rejects_non_versions() {
        assert_eq!(Version::parse(""), None);
        assert_eq!(Version::parse("v"), None);
        assert_eq!(Version::parse("not a version"), None);
        assert_eq!(Version::parse("1.2.3.4"), None);
    }

    #[test]
    fn orders_by_release_precedence() {
        assert!(Version::new(24, 0, 0) > Version::new(23, 99, 99));
        assert!(Version::new(22, 14, 3) > Version::new(22, 14, 2));
    }
}
