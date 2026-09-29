//! Bounded in-memory package access, shared by export validation and import parsing.
//! No part is extracted to disk and no relationship target is fetched.
use std::collections::HashSet;
use std::io::{Cursor, Read};

use super::failure;
use crate::error::Result;

const ARCHIVE_LIMIT: usize = 64 * 1024 * 1024;
const PART_LIMIT: u64 = 64 * 1024 * 1024;
const EXPANDED_LIMIT: u64 = 256 * 1024 * 1024;
const ENTRY_LIMIT: usize = 20_000;

pub(super) struct Package<'a> {
    archive: zip::ZipArchive<Cursor<&'a [u8]>>,
}

fn integer(bytes: &[u8], at: usize, width: usize) -> Result<u64> {
    let data = bytes
        .get(
            at..at
                .checked_add(width)
                .ok_or_else(|| failure("invalid ZIP offset"))?,
        )
        .ok_or_else(|| failure("truncated ZIP metadata"))?;
    Ok(data.iter().enumerate().fold(0, |value, (shift, byte)| {
        value | (u64::from(*byte) << (shift * 8))
    }))
}

/// Check entry count before the ZIP library allocates its central-directory index.
/// Also reject duplicate raw names, which that index otherwise coalesces.
fn directory(bytes: &[u8]) -> Result<(usize, usize)> {
    let end = (bytes.len().saturating_sub(65_557)..bytes.len().saturating_sub(21))
        .rev()
        .find(|at| {
            bytes.get(*at..*at + 4) == Some(b"PK\x05\x06")
                && integer(bytes, *at + 20, 2)
                    .is_ok_and(|length| *at + 22 + length as usize == bytes.len())
        })
        .ok_or_else(|| failure("missing ZIP directory footer"))?;
    if integer(bytes, end + 4, 2)? != 0 || integer(bytes, end + 6, 2)? != 0 {
        return Err(failure("split ZIP packages are unsupported"));
    }
    let mut count = integer(bytes, end + 10, 2)?;
    let mut on_disk = integer(bytes, end + 8, 2)?;
    let mut size = integer(bytes, end + 12, 4)?;
    let mut start = integer(bytes, end + 16, 4)?;
    let mut footer = end;
    if end >= 20 && bytes.get(end - 20..end - 16) == Some(b"PK\x06\x07") {
        let locator = end - 20;
        if integer(bytes, locator + 4, 4)? != 0 || integer(bytes, locator + 16, 4)? != 1 {
            return Err(failure("split ZIP64 packages are unsupported"));
        }
        footer = usize::try_from(integer(bytes, locator + 8, 8)?)
            .map_err(|_| failure("invalid ZIP64 offset"))?;
        if bytes.get(footer..footer.saturating_add(4)) != Some(b"PK\x06\x06")
            || integer(bytes, footer + 4, 8)? < 44
            || (footer as u64)
                .checked_add(12)
                .and_then(|n| n.checked_add(integer(bytes, footer + 4, 8).ok()?))
                != Some(locator as u64)
            || integer(bytes, footer + 16, 4)? != 0
            || integer(bytes, footer + 20, 4)? != 0
        {
            return Err(failure("invalid ZIP64 directory footer"));
        }
        on_disk = integer(bytes, footer + 24, 8)?;
        count = integer(bytes, footer + 32, 8)?;
        size = integer(bytes, footer + 40, 8)?;
        start = integer(bytes, footer + 48, 8)?;
    }
    if count == 0
        || count > ENTRY_LIMIT as u64
        || count != on_disk
        || start.checked_add(size) != Some(footer as u64)
    {
        return Err(failure("invalid or oversized ZIP directory"));
    }
    let start = usize::try_from(start).map_err(|_| failure("invalid ZIP directory offset"))?;
    let mut position = start;
    let mut names = HashSet::new();
    for _ in 0..count {
        if bytes.get(position..position.saturating_add(4)) != Some(b"PK\x01\x02") {
            return Err(failure("invalid ZIP directory entry"));
        }
        let length = integer(bytes, position + 28, 2)? as usize;
        let extra = integer(bytes, position + 30, 2)? as usize;
        let comment = integer(bytes, position + 32, 2)? as usize;
        let name_start = position + 46;
        let next = name_start + length + extra + comment;
        if next > footer
            || !names.insert(
                bytes
                    .get(name_start..name_start + length)
                    .ok_or_else(|| failure("truncated ZIP part name"))?,
            )
        {
            return Err(failure("duplicate or truncated ZIP part"));
        }
        position = next;
    }
    if position != footer {
        return Err(failure("ZIP directory length mismatch"));
    }
    Ok((start, count as usize))
}

impl<'a> Package<'a> {
    pub(super) fn open(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() > ARCHIVE_LIMIT {
            return Err(failure("PPTX compressed size limit exceeded"));
        }
        let (directory_start, count) = directory(bytes)?;
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| failure("invalid PPTX ZIP package"))?;
        if archive.len() != count
            || archive.offset() != 0
            || archive.central_directory_start() != directory_start as u64
        {
            return Err(failure("ambiguous PPTX ZIP directory"));
        }
        let mut names = HashSet::new();
        let mut expanded = 0_u64;
        let mut ranges = Vec::new();
        for index in 0..archive.len() {
            let part = archive
                .by_index_raw(index)
                .map_err(|_| failure("unreadable PPTX part"))?;
            let name = part.name().strip_suffix('/').unwrap_or(part.name());
            if name.is_empty()
                || name.len() > 1024
                || name.contains(['\\', ':'])
                || name.chars().any(char::is_control)
                || name
                    .split('/')
                    .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
                || !names.insert(name.to_ascii_lowercase())
                || part.is_symlink()
                || part.encrypted()
                || part
                    .unix_mode()
                    .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
            {
                return Err(failure("unsafe, duplicate or encrypted PPTX part"));
            }
            if part.size() > PART_LIMIT || (part.is_dir() && part.size() != 0) {
                return Err(failure("PPTX part size limit exceeded"));
            }
            expanded = expanded
                .checked_add(part.size())
                .ok_or_else(|| failure("PPTX size overflow"))?;
            if expanded > EXPANDED_LIMIT {
                return Err(failure("PPTX expanded size limit exceeded"));
            }
            let end = part
                .data_start()
                .checked_add(part.compressed_size())
                .ok_or_else(|| failure("PPTX offset overflow"))?;
            if end > directory_start as u64 {
                return Err(failure("PPTX part overlaps directory"));
            }
            if part.compressed_size() > 0 {
                ranges.push((part.data_start(), end));
            }
        }
        ranges.sort_unstable();
        if ranges.windows(2).any(|parts| parts[0].1 > parts[1].0) {
            return Err(failure("overlapping PPTX parts"));
        }
        Ok(Self { archive })
    }

    pub(super) fn read_part(&mut self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        let part = self
            .archive
            .by_name(name)
            .map_err(|_| failure("missing or unsupported PPTX part"))?;
        let expected = part.size();
        if expected > maximum.min(PART_LIMIT as usize) as u64 {
            return Err(failure("PPTX part read limit exceeded"));
        }
        let mut bytes = Vec::new();
        part.take(expected + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure("damaged PPTX part"))?;
        if bytes.len() as u64 != expected {
            return Err(failure("PPTX part length mismatch"));
        }
        Ok(bytes)
    }

    pub(super) fn verify_contents(&mut self) -> Result<()> {
        for index in 0..self.archive.len() {
            let part = self
                .archive
                .by_index(index)
                .map_err(|_| failure("unsupported PPTX part encoding"))?;
            let expected = part.size();
            let actual = std::io::copy(&mut part.take(expected + 1), &mut std::io::sink())
                .map_err(|_| failure("damaged PPTX part"))?;
            if actual != expected {
                return Err(failure("PPTX part length mismatch"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn archive(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in parts {
            writer
                .start_file(
                    *name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn headers(bytes: &[u8]) -> Vec<usize> {
        bytes
            .windows(4)
            .enumerate()
            .filter_map(|(at, value)| (value == b"PK\x01\x02").then_some(at))
            .collect()
    }

    #[test]
    fn reads_bounded_parts_and_checks_all_contents_without_extracting() {
        let bytes = archive(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("ppt/presentation.xml", b"<presentation/>"),
            ("ppt/media/image.png", b"binary"),
        ]);
        let mut package = Package::open(&bytes).unwrap();
        assert_eq!(
            package.read_part("ppt/presentation.xml", 100).unwrap(),
            b"<presentation/>"
        );
        assert!(package.read_part("ppt/presentation.xml", 2).is_err());
        assert!(package.read_part("missing.xml", 100).is_err());
        package.verify_contents().unwrap();
    }

    #[test]
    fn rejects_every_truncated_prefix_and_malformed_directory_counts() {
        let bytes = archive(&[("ppt/presentation.xml", b"<presentation/>")]);
        for length in 0..bytes.len() {
            assert!(Package::open(&bytes[..length]).is_err(), "prefix {length}");
        }
        let end = bytes.len() - 22;
        for (offset, value) in [(4, 1), (6, 1), (8, 2), (10, 0), (12, 0), (16, 0)] {
            let mut broken = bytes.clone();
            broken[end + offset] = value;
            assert!(Package::open(&broken).is_err(), "footer {offset}");
        }
        let mut too_large = vec![0; ARCHIVE_LIMIT + 1];
        too_large[..4].copy_from_slice(b"PK\x03\x04");
        assert!(Package::open(&too_large).is_err());
    }

    #[test]
    #[ignore = "requires DSH_TEST_PPTX pointing to an independently generated export"]
    fn validates_independently_generated_pptx() {
        let path = std::env::var("DSH_TEST_PPTX").expect("DSH_TEST_PPTX required");
        let bytes = crate::bounded_file::read(std::path::Path::new(&path), ARCHIVE_LIMIT).unwrap();
        let mut package = Package::open(&bytes).unwrap();
        assert!(!package
            .read_part("[Content_Types].xml", 8 * 1024 * 1024)
            .unwrap()
            .is_empty());
        assert!(!package
            .read_part("ppt/presentation.xml", 8 * 1024 * 1024)
            .unwrap()
            .is_empty());
        package.verify_contents().unwrap();
    }

    #[test]
    fn rejects_ambiguous_names_and_path_forms() {
        for name in [
            "../x",
            "/absolute",
            "C:/x",
            "a\\b",
            "a//b",
            "a/./b",
            "a//",
            "a\u{1}b",
        ] {
            assert!(
                Package::open(&archive(&[(name, b"data")])).is_err(),
                "{name:?}"
            );
        }
        assert!(Package::open(&archive(&[("a.xml", b"first"), ("A.XML", b"second")])).is_err());
        let mut bytes = archive(&[("a.xml", b"first"), ("b.xml", b"second")]);
        for at in 0..bytes.len() - 4 {
            if &bytes[at..at + 5] == b"b.xml" {
                bytes[at] = b'a';
            }
        }
        assert!(Package::open(&bytes).is_err());
    }

    #[test]
    fn rejects_declared_expansion_and_entry_count_before_reading_payloads() {
        let mut bytes = archive(&[("a", b"a")]);
        let at = headers(&bytes)[0];
        bytes[at + 24..at + 28].copy_from_slice(&((PART_LIMIT + 1) as u32).to_le_bytes());
        assert!(Package::open(&bytes).is_err());
        let mut bytes = archive(&[
            ("a", b"a"),
            ("b", b"b"),
            ("c", b"c"),
            ("d", b"d"),
            ("e", b"e"),
        ]);
        for at in headers(&bytes) {
            bytes[at + 24..at + 28].copy_from_slice(&(PART_LIMIT as u32).to_le_bytes());
        }
        assert!(Package::open(&bytes).is_err());
        let mut bytes = archive(&[("a", b"a")]);
        let end = bytes.len() - 22;
        for at in [end + 8, end + 10] {
            bytes[at..at + 2].copy_from_slice(&((ENTRY_LIMIT + 1) as u16).to_le_bytes());
        }
        assert!(Package::open(&bytes).is_err());
    }

    #[test]
    fn detects_corrupt_payloads_and_false_lengths() {
        let mut bytes = archive(&[("a.xml", b"original data")]);
        let position = zip::ZipArchive::new(Cursor::new(&bytes))
            .unwrap()
            .by_index_raw(0)
            .unwrap()
            .data_start() as usize;
        bytes[position] ^= 1;
        let mut package = Package::open(&bytes).unwrap();
        assert!(package.read_part("a.xml", 100).is_err());
        assert!(package.verify_contents().is_err());
        let mut bytes = archive(&[("a.xml", b"original data")]);
        let at = headers(&bytes)[0];
        bytes[at + 24..at + 28].copy_from_slice(&1_u32.to_le_bytes());
        let mut package = Package::open(&bytes).unwrap();
        assert!(package.read_part("a.xml", 100).is_err());
        assert!(package.verify_contents().is_err());
    }

    #[test]
    fn rejects_links_encryption_overlap_and_truncated_metadata() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("link", "outside", SimpleFileOptions::default())
            .unwrap();
        assert!(Package::open(&writer.finish().unwrap().into_inner()).is_err());
        let mut bytes = archive(&[("a", b"content")]);
        let at = headers(&bytes)[0];
        bytes[at + 8] |= 1;
        assert!(Package::open(&bytes).is_err());
        let mut bytes = archive(&[("a", b"first"), ("b", b"second")]);
        let entries = headers(&bytes);
        let first = bytes[entries[0] + 42..entries[0] + 46].to_vec();
        bytes[entries[1] + 42..entries[1] + 46].copy_from_slice(&first);
        assert!(Package::open(&bytes).is_err());
        let bytes = archive(&[("a", b"content")]);
        for length in [0, 1, 4, bytes.len() - 1] {
            assert!(Package::open(&bytes[..length]).is_err());
        }
    }

    #[test]
    fn reads_zip64_directory_with_small_bounded_parts() {
        let mut bytes = archive(&[("a.xml", b"data")]);
        let (start, count) = directory(&bytes).unwrap();
        let end = bytes.len() - 22;
        let mut classic = bytes.split_off(end);
        bytes.extend_from_slice(b"PK\x06\x06");
        bytes.extend_from_slice(&44_u64.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 8]);
        bytes.extend_from_slice(&(count as u64).to_le_bytes());
        bytes.extend_from_slice(&(count as u64).to_le_bytes());
        bytes.extend_from_slice(&((end - start) as u64).to_le_bytes());
        bytes.extend_from_slice(&(start as u64).to_le_bytes());
        bytes.extend_from_slice(b"PK\x06\x07");
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&(end as u64).to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        classic[8..20].fill(0xff);
        bytes.extend_from_slice(&classic);
        let mut package = Package::open(&bytes).unwrap();
        assert_eq!(package.read_part("a.xml", 10).unwrap(), b"data");
        package.verify_contents().unwrap();
    }
}
