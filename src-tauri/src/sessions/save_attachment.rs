//! Save opaque, content-addressed attachment bytes without executing them.
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

const LIMIT: usize = 20 * 1024 * 1024;

fn decode(id: &str, data: &str) -> Result<Vec<u8>> {
    let invalid = || Error::Session("invalid or oversized attachment download".into());
    if id.len() != 71
        || !id.starts_with("sha256:")
        || !id[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || data.len() > LIMIT.div_ceil(3) * 4
    {
        return Err(invalid());
    }
    let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
    if bytes.len() > LIMIT || format!("sha256:{:x}", Sha256::digest(&bytes)) != id {
        return Err(invalid());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn session_attachment_save(path: String, id: String, data: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let bytes = decode(&id, &data)?;
        crate::atomic::write(std::path::Path::new(&path), bytes).map_err(|_| {
            Error::Session("could not save the attachment at the selected location".into())
        })
    })
    .await
    .map_err(|_| Error::Session("attachment save could not finish".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn validates_empty_binary_and_limit_without_interpreting_content() {
        for bytes in [vec![], vec![0, 255, 1, 128], vec![0; LIMIT]] {
            assert_eq!(
                decode(&identity(&bytes), &STANDARD.encode(&bytes)).unwrap(),
                bytes
            );
        }
        assert!(decode(&identity(&[0]), &"A".repeat(LIMIT.div_ceil(3) * 4 + 1)).is_err());
    }

    #[test]
    fn rejects_wrong_digest_identity_and_encoding() {
        let id = identity(b"abc");
        for (id, data) in [
            (id.as_str(), "!"),
            (id.as_str(), "YWJj\n"),
            (id.as_str(), "YWJk"),
            ("../file", "YWJj"),
            ("", ""),
        ] {
            assert!(decode(id, data).is_err());
        }
    }

    #[tokio::test]
    async fn saves_exact_bytes_and_preserves_existing_file_on_invalid_input() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-attachment-save-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("attachment.bin");
        let target = path.to_string_lossy().into_owned();
        session_attachment_save(target.clone(), identity(b"abc"), "YWJj".into())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert!(
            session_attachment_save(target, identity(b"abc"), "YWJk".into())
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert!(session_attachment_save(
            root.join("missing/file").to_string_lossy().into_owned(),
            identity(b"abc"),
            "YWJj".into()
        )
        .await
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
