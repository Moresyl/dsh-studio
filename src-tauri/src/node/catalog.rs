//! Work out which official Node release to download, and from where.
//!
//! Nothing here is a hard-coded version number. The release to install is read
//! from the published index every time, so the shell keeps installing a
//! supported Node long after this file was last edited — and so a build that
//! does not exist for someone's architecture is never attempted, because the
//! index says which builds a release actually has.

use node_runtime::Version;
use reqwest::Client;
use serde::Deserialize;

use super::http;
use crate::error::{Error, Result};

/// Mirrors of the same download tree, tried in order.
///
/// The second one matters more than a fallback usually does: `nodejs.org` is
/// slow to unreachable from mainland China, which is a large share of the people
/// this shell is for, and npmmirror is the tree everyone there already uses for
/// exactly this. It serves byte-identical files, which is what makes the
/// checksum check below meaningful across both.
const MIRRORS: [&str; 2] = [
    "https://nodejs.org/dist",
    "https://cdn.npmmirror.com/binaries/node",
];

/// One release, resolved down to a single file and the hash it must have.
#[derive(Debug)]
pub struct Release {
    /// As Node spells it, leading `v` included. This is the directory name in
    /// the download tree and the one the release is unpacked into.
    pub version: String,
    /// Archive file name, which is also its key in `SHASUMS256.txt`.
    pub archive: String,
    pub url: String,
    /// Expected SHA-256, lower-case hex, as published by the mirror that
    /// answered.
    pub sha256: String,
}

/// One entry of `index.json`. Only the three fields that decide anything.
#[derive(Deserialize)]
struct Entry {
    version: String,
    /// Which builds this release has, as tokens like `win-x64-zip`.
    files: Vec<String>,
    lts: Lts,
}

/// `index.json` writes `false` for a current release and the code name for an
/// LTS one, in the same field.
#[derive(Deserialize)]
#[serde(untagged)]
enum Lts {
    /// The line's code name, `Krypton` and so on.
    Named(String),
    /// Written as `false` on every release that is not on an LTS line.
    No(bool),
}

impl Lts {
    fn is_lts(&self) -> bool {
        match self {
            Lts::Named(name) => !name.is_empty(),
            // Read rather than assumed: this is the field the index uses to say
            // so, and taking the shape of the value for the answer would ignore
            // what the value actually was.
            Lts::No(flag) => *flag,
        }
    }
}

/// How this platform's build is named, in the two places that disagree.
struct Platform {
    /// The token `index.json` lists the build under.
    token: &'static str,
    /// The `{os}-{arch}` fragment of the archive's own file name. Not the same
    /// string as the token: the index says `osx` where the file says `darwin`.
    slug: &'static str,
    extension: &'static str,
}

fn platform() -> Option<Platform> {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// Split from [`platform`] so the whole table can be checked against the names
/// Node actually publishes, not just this machine's row of it.
fn platform_for(os: &str, arch: &str) -> Option<Platform> {
    let platform = match (os, arch) {
        ("windows", "x86_64") => Platform {
            token: "win-x64-zip",
            slug: "win-x64",
            extension: "zip",
        },
        ("windows", "aarch64") => Platform {
            token: "win-arm64-zip",
            slug: "win-arm64",
            extension: "zip",
        },
        ("macos", "x86_64") => Platform {
            token: "osx-x64-tar",
            slug: "darwin-x64",
            extension: "tar.gz",
        },
        ("macos", "aarch64") => Platform {
            token: "osx-arm64-tar",
            slug: "darwin-arm64",
            extension: "tar.gz",
        },
        ("linux", "x86_64") => Platform {
            token: "linux-x64",
            slug: "linux-x64",
            extension: "tar.gz",
        },
        ("linux", "aarch64") => Platform {
            token: "linux-arm64",
            slug: "linux-arm64",
            extension: "tar.gz",
        },
        // Node publishes builds for a handful of other architectures and stops
        // publishing them again; whether one exists is answered by the index, not
        // by this list. What this list is for is the mapping above, which cannot
        // be derived — so an architecture missing from it is a genuine "install
        // Node yourself", not a gap worth guessing at.
        _ => return None,
    };
    Some(platform)
}

/// The newest long-term-support release with a build for this machine.
///
/// LTS rather than current: this is the runtime someone else's agent harness
/// will run on for months without being asked about, and an LTS line is the one
/// that gets security patches without changing behaviour underneath it.
pub async fn newest_lts(client: &Client) -> Result<Release> {
    let platform = platform().ok_or(Error::NodePlatformUnsupported)?;
    let mut refusals: Vec<String> = Vec::new();

    for mirror in MIRRORS {
        match from_mirror(client, mirror, &platform).await {
            Ok(release) => return Ok(release),
            Err(failure) => refusals.push(format!("{mirror} — {failure}")),
        }
    }

    Err(Error::Network(format!(
        "no Node.js download mirror could be reached ({})",
        refusals.join("; ")
    )))
}

async fn from_mirror(client: &Client, mirror: &str, platform: &Platform) -> Result<Release> {
    let index = http::text(client, &format!("{mirror}/index.json")).await?;
    let entries: Vec<Entry> = serde_json::from_str(&index)
        .map_err(|cause| Error::Network(format!("the release index made no sense: {cause}")))?;

    // Highest version rather than first entry: the index happens to be ordered
    // newest-first, and a scan that depends on that would break silently the day
    // it is not.
    let (version, archive) = entries
        .iter()
        .filter(|entry| entry.lts.is_lts())
        .filter(|entry| entry.files.iter().any(|file| file == platform.token))
        .filter_map(|entry| Version::parse(&entry.version).map(|parsed| (parsed, entry)))
        .filter(|(parsed, _)| *parsed >= node_runtime::MINIMUM_SUPPORTED)
        .max_by_key(|(parsed, _)| *parsed)
        .map(|(_, entry)| {
            let archive = format!(
                "node-{}-{}.{}",
                entry.version, platform.slug, platform.extension
            );
            (entry.version.clone(), archive)
        })
        .ok_or_else(|| {
            Error::Network(format!(
                "{mirror} lists no supported Node.js release built for this machine"
            ))
        })?;

    let published = http::text(client, &format!("{mirror}/{version}/SHASUMS256.txt")).await?;
    let sha256 = checksum(&published, &archive)
        .ok_or_else(|| Error::Network(format!("{mirror} publishes no checksum for {archive}")))?;

    Ok(Release {
        url: format!("{mirror}/{version}/{archive}"),
        version,
        archive,
        sha256,
    })
}

/// Find one file's hash in a `sha256sum`-format document.
///
/// Split on whitespace rather than the two spaces the format specifies, and
/// tolerate the `*` a binary-mode line puts in front of the name: both are
/// spellings the same tool produces, and a checksum check that fails on
/// formatting would be worse than useless — it would look like tampering.
fn checksum(document: &str, archive: &str) -> Option<String> {
    document.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let hash = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');

        let plausible = hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
        (name == archive && plausible).then(|| hash.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::{checksum, platform_for, Entry};

    /// The real `SHASUMS256.txt` of v24.19.0, every line this app could want,
    /// copied verbatim — the point of the naming test is that these spellings
    /// were not invented here.
    const PUBLISHED: &str = "\
8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d  node-v24.19.0-darwin-arm64.tar.gz
d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316  node-v24.19.0-darwin-x64.tar.gz
d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f  node-v24.19.0-linux-arm64.tar.gz
f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4  node-v24.19.0-linux-x64.tar.gz
8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f  node-v24.19.0-win-arm64.zip
57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73  node-v24.19.0-win-x64.zip
";

    #[test]
    fn picks_out_one_archive_and_not_a_similar_one() {
        assert_eq!(
            checksum(PUBLISHED, "node-v24.19.0-win-x64.zip").as_deref(),
            Some("57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73")
        );
        // `darwin-arm64` and `darwin-x64` sit on adjacent lines and differ by
        // four characters. Reading the neighbour would report an integrity
        // failure on a download that was perfectly fine.
        assert_eq!(
            checksum(PUBLISHED, "node-v24.19.0-darwin-x64.tar.gz").as_deref(),
            Some("d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316")
        );
        // And a name that is merely a prefix of a published one is not a match.
        assert_eq!(checksum(PUBLISHED, "node-v24.19.0-win-x64"), None);
    }

    #[test]
    fn reads_a_binary_mode_line_too() {
        let binary = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73 *node-v24.19.0-win-x64.zip";
        assert!(checksum(binary, "node-v24.19.0-win-x64.zip").is_some());
    }

    #[test]
    fn refuses_a_line_whose_first_field_is_not_a_hash() {
        // A mirror serving an HTML error page under the checksum URL is the real
        // case. Taking its first two words as a hash would turn that into an
        // integrity failure on the archive, which points at the wrong thing.
        let html = "<html><head><title>404 Not Found</title>\nnode-v24.19.0-win-x64.zip";
        assert_eq!(checksum(html, "node-v24.19.0-win-x64.zip"), None);
    }

    #[test]
    fn reads_both_spellings_of_the_lts_field() {
        let entries: Vec<Entry> = serde_json::from_str(
            r#"[
                { "version": "v25.1.0", "files": ["win-x64-zip"], "lts": false },
                { "version": "v24.19.0", "files": ["win-x64-zip"], "lts": "Krypton" }
            ]"#,
        )
        .expect("the shape index.json actually has");

        assert!(!entries[0].lts.is_lts(), "a current release is not LTS");
        assert!(entries[1].lts.is_lts());
    }

    #[test]
    fn names_every_archive_the_way_the_published_checksums_do() {
        // The index token and the file name disagree on macOS — `osx-arm64-tar`
        // against `darwin-arm64.tar.gz` — so the mapping cannot be derived and
        // the only honest check is against a real published list. A wrong row
        // here is a 404 on a platform nobody developing this is sitting at.
        for (os, arch) in [
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
        ] {
            let platform = platform_for(os, arch).expect("a supported target");
            let archive = format!("node-v24.19.0-{}.{}", platform.slug, platform.extension);

            assert!(
                checksum(PUBLISHED, &archive).is_some(),
                "{os}/{arch} asks for {archive}, which Node does not publish"
            );
        }
    }

    #[test]
    fn has_nothing_to_offer_a_target_node_does_not_build_for() {
        // Better than guessing a name: the row is absent, so the UI says to
        // install Node by hand instead of downloading a 404.
        assert!(platform_for("linux", "arm").is_none(), "32-bit ARM");
        assert!(platform_for("freebsd", "x86_64").is_none());
    }
}
