//! Read-only review of a worktree registered with the selected repository.
//! No staging, reset, checkout, merge, external diff or text conversion runs here.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{git, git_bounded, parse_worktrees, repository_root, same_path, selected};
use crate::error::{Error, Result};

const MAX_PATCH_BYTES: usize = 256 << 10;
const MAX_PATCH_LINES: usize = 5_000;
const MAX_CHANGED_FILES: usize = 5_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    previous_path: Option<String>,
    index: String,
    worktree: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    text: String,
    too_large: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    path: PathBuf,
    changes: Vec<Change>,
    staged: Patch,
    unstaged: Patch,
}

/// Review only exact worktree roots in Git's registry, not arbitrary filesystem paths.
#[tauri::command]
pub async fn workspace_worktree_review(path: PathBuf) -> Result<Review> {
    review_in(&selected(), &path).await
}

async fn review_in(selected: &Path, candidate: &Path) -> Result<Review> {
    let repository = repository_root(selected).await?;
    let path = registered_path(&repository, candidate).await?;
    let status = git(
        &path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        false,
    )
    .await?;
    let changes = parse_changes(&status)?;
    let staged = patch(&path, true).await?;
    let unstaged = patch(&path, false).await?;
    Ok(Review {
        path,
        changes,
        staged,
        unstaged,
    })
}

async fn registered_path(repository: &Path, candidate: &Path) -> Result<PathBuf> {
    let canonical = candidate
        .canonicalize()
        .map_err(|cause| Error::Workspace(format!("the worktree could not be opened: {cause}")))?;
    let canonical = node_runtime::plain_path(canonical);
    let registry = git(
        repository,
        &["worktree", "list", "--porcelain", "-z"],
        false,
    )
    .await?;
    for record in parse_worktrees(&registry)? {
        let Ok(registered) = record.path.canonicalize() else {
            continue;
        };
        if same_path(&canonical, &node_runtime::plain_path(registered)) {
            return Ok(canonical);
        }
    }
    Err(Error::Workspace(
        "only worktrees registered with the selected repository can be reviewed".into(),
    ))
}

fn parse_changes(output: &str) -> Result<Vec<Change>> {
    if !output.is_empty() && !output.ends_with('\0') {
        return Err(Error::Workspace(
            "Git returned an unterminated change record".into(),
        ));
    }
    let mut fields = output.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(record) = fields.next() {
        let bytes = record.as_bytes();
        let valid = |value: u8| b" MADRCU?!T".contains(&value);
        if bytes.len() < 4 || bytes[2] != b' ' || !valid(bytes[0]) || !valid(bytes[1]) {
            return Err(Error::Workspace(
                "Git returned a malformed change record".into(),
            ));
        }
        let previous_path = if matches!(bytes[0], b'R' | b'C') || matches!(bytes[1], b'R' | b'C') {
            Some(
                fields
                    .next()
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| {
                        Error::Workspace("Git returned a rename without its original path".into())
                    })?
                    .to_owned(),
            )
        } else {
            None
        };
        changes.push(Change {
            path: record[3..].to_owned(),
            previous_path,
            index: (bytes[0] as char).to_string(),
            worktree: (bytes[1] as char).to_string(),
        });
        if changes.len() > MAX_CHANGED_FILES {
            return Err(Error::Workspace(format!("more than {MAX_CHANGED_FILES} changed files; review this repository with Git directly")));
        }
    }
    Ok(changes)
}

async fn patch(path: &Path, staged: bool) -> Result<Patch> {
    let mut arguments = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        "--ignore-submodules=none",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
    ];
    if staged {
        arguments.push("--cached");
    }
    arguments.push("--");
    let text = git_bounded(path, &arguments, false, MAX_PATCH_BYTES).await?;
    let text =
        text.filter(|text| text.lines().take(MAX_PATCH_LINES + 1).count() <= MAX_PATCH_LINES);
    Ok(Patch {
        too_large: text.is_none(),
        text: text.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_framing_preserves_spaces_unicode_newlines_and_rename_direction() {
        let changes = parse_changes(" M src/中文 file\nname.ts\0R  new name.ts\0old name.ts\0?? new folder/\0UU conflict.ts\0").unwrap();
        assert_eq!(changes.len(), 4);
        assert_eq!(changes[0].path, "src/中文 file\nname.ts");
        assert_eq!(changes[0].worktree, "M");
        assert_eq!(changes[1].previous_path.as_deref(), Some("old name.ts"));
        assert_eq!(changes[1].path, "new name.ts");
        assert_eq!(changes[2].index, "?");
        assert_eq!(changes[3].index, "U");
        assert!(parse_changes("").unwrap().is_empty());
    }

    #[test]
    fn malformed_and_excessive_status_records_fail_closed() {
        for invalid in [
            " M missing terminator",
            "R  new\0",
            "R  new\0\0",
            "bad\0",
            "ZZ file\0",
            " M \0",
        ] {
            assert!(parse_changes(invalid).is_err(), "{invalid:?}");
        }
        assert!(parse_changes(&"?? file\0".repeat(MAX_CHANGED_FILES + 1)).is_err());
    }

    struct Repository(PathBuf);

    impl Repository {
        async fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "dsh-studio-review-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            let repo = Self(path);
            repo.run(&["init", "-b", "main"]).await;
            repo.run(&["config", "user.name", "Review fixture"]).await;
            repo.run(&["config", "user.email", "review@example.invalid"])
                .await;
            repo.run(&["config", "core.autocrlf", "false"]).await;
            repo.run(&[
                "config",
                "core.hooksPath",
                repo.0.join("disabled-hooks").to_str().unwrap(),
            ])
            .await;
            std::fs::write(repo.0.join("tracked.txt"), "base\n").unwrap();
            repo.run(&["add", "tracked.txt"]).await;
            repo.run(&["-c", "commit.gpgsign=false", "commit", "-m", "fixture"])
                .await;
            repo
        }

        async fn run(&self, arguments: &[&str]) -> String {
            git(&self.0, arguments, true).await.unwrap()
        }
    }

    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn review_distinguishes_index_worktree_and_untracked_without_mutation() {
        let repo = Repository::new().await;
        std::fs::write(repo.0.join("tracked.txt"), "staged\n").unwrap();
        repo.run(&["add", "tracked.txt"]).await;
        std::fs::write(repo.0.join("tracked.txt"), "unstaged\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "new\n").unwrap();
        let before = repo.run(&["status", "--porcelain=v1", "-z"]).await;
        let review = review_in(&repo.0, &repo.0).await.unwrap();
        assert_eq!(review.changes.len(), 2);
        assert!(review.staged.text.contains("+staged"));
        assert!(review.unstaged.text.contains("+unstaged"));
        assert!(!review.unstaged.text.contains("new.txt"));
        assert_eq!(before, repo.run(&["status", "--porcelain=v1", "-z"]).await);
        let worktrees = super::super::worktrees_in(&repo.0).await.unwrap();
        assert!(worktrees[0].dirty);
        assert!(
            worktrees[0].primary,
            "the selected worktree must be identified"
        );
        #[cfg(unix)]
        {
            let alias = repo.0.join("same-repository");
            std::os::unix::fs::symlink(&repo.0, &alias).unwrap();
            let aliased = super::super::worktrees_in(&alias).await.unwrap();
            assert!(
                aliased[0].primary,
                "filesystem aliases identify the same root"
            );
            std::fs::remove_file(alias).unwrap();
        }
        repo.run(&["restore", "--staged", "tracked.txt"]).await;
        repo.run(&["restore", "tracked.txt"]).await;
        assert!(
            super::super::worktrees_in(&repo.0).await.unwrap()[0].dirty,
            "untracked files must not appear clean"
        );
    }

    #[tokio::test]
    async fn review_rejects_other_repositories_and_accepts_registered_linked_worktree() {
        let repo = Repository::new().await;
        let unrelated = Repository::new().await;
        assert!(review_in(&repo.0, &unrelated.0).await.is_err());
        let linked = repo.0.join("linked");
        repo.run(&[
            "worktree",
            "add",
            "-b",
            "agent/test",
            linked.to_str().unwrap(),
        ])
        .await;
        assert!(review_in(&repo.0, &linked).await.is_ok());
        std::fs::create_dir(linked.join("nested")).unwrap();
        assert!(review_in(&repo.0, &linked.join("nested")).await.is_err());
    }

    #[tokio::test]
    async fn oversized_diff_is_explicit_and_external_converters_are_not_run() {
        let repo = Repository::new().await;
        repo.run(&["config", "core.fsmonitor", "this-program-must-never-run"])
            .await;
        repo.run(&["config", "diff.external", "this-program-must-never-run"])
            .await;
        repo.run(&[
            "config",
            "diff.unsafe.textconv",
            "this-program-must-never-run",
        ])
        .await;
        std::fs::write(repo.0.join(".gitattributes"), "*.txt diff=unsafe\n").unwrap();
        std::fs::write(repo.0.join("tracked.txt"), "safe\n").unwrap();
        assert!(review_in(&repo.0, &repo.0)
            .await
            .unwrap()
            .unstaged
            .text
            .contains("+safe"));
        std::fs::write(repo.0.join("tracked.txt"), "a".repeat(MAX_PATCH_BYTES + 1)).unwrap();
        let review = review_in(&repo.0, &repo.0).await.unwrap();
        assert!(review.unstaged.too_large);
        assert!(review.unstaged.text.is_empty());
        assert!(!review.changes.is_empty());
        std::fs::write(
            repo.0.join("tracked.txt"),
            "a\n".repeat(MAX_PATCH_LINES + 1),
        )
        .unwrap();
        assert!(
            review_in(&repo.0, &repo.0)
                .await
                .unwrap()
                .unstaged
                .too_large
        );
    }

    #[tokio::test]
    async fn staged_rename_and_binary_change_have_honest_review_results() {
        let repo = Repository::new().await;
        repo.run(&["mv", "tracked.txt", "renamed file.txt"]).await;
        let renamed = review_in(&repo.0, &repo.0).await.unwrap();
        assert_eq!(
            renamed.changes[0].previous_path.as_deref(),
            Some("tracked.txt")
        );
        assert_eq!(renamed.changes[0].path, "renamed file.txt");
        assert_eq!(renamed.changes[0].index, "R");
        assert!(renamed.staged.text.contains("rename to renamed file.txt"));
        std::fs::write(repo.0.join("renamed file.txt"), b"binary\0content").unwrap();
        let binary = review_in(&repo.0, &repo.0).await.unwrap();
        assert!(binary.unstaged.text.contains("Binary files"));
        assert!(!binary.unstaged.too_large);
    }
}
