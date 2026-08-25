//! File reads whose memory cost is fixed before parsing untrusted control data.

use std::fs::File;
use std::io::{Error, ErrorKind, Read as _};
use std::path::Path;

pub const CONTROL_BYTES: usize = 2 * 1024 * 1024;

pub fn read(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut body = Vec::new();
    file.take(maximum.saturating_add(1) as u64)
        .read_to_end(&mut body)?;
    if body.len() > maximum {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!("file exceeds the {maximum} byte safety limit"),
        ));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn reads_the_limit_and_refuses_the_next_byte() {
        let path = std::env::temp_dir().join(format!(
            "dsh-studio-bounded-file-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, b"12345").expect("fixture");
        assert_eq!(read(&path, 5).expect("at limit"), b"12345");
        assert_eq!(
            read(&path, 4).expect_err("over limit").kind(),
            ErrorKind::InvalidData
        );
        std::fs::remove_file(path).expect("cleanup");
    }
}
