//! One session's bytes, however the harness happened to write them.
//!
//! A session log is JSONL, and by default it is compressed: one Zstandard frame
//! holding the header line, then one frame per batch of events appended after
//! it. Reading it back is therefore not "decompress a file" but "decode frames
//! until they run out" — and running out early is normal. A session being
//! written right now ends in a frame that is not finished, and the harness
//! treats such a tail as not yet committed. So does this: the committed prefix
//! is the whole of what either reader sees.
//!
//! Decompression is pure Rust and one direction only. Nothing here writes a
//! session log, and nothing ever should — the harness appends to these files
//! while the app is running, and a second writer is how a conversation gets a
//! hole in it.

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
use ruzstd::decoding::StreamingDecoder;

/// What every session log is called inside its own directory, before the suffix.
const STEM: &str = "session";

/// The two encodings the harness writes, in the order it prefers them.
const SUFFIXES: [&str; 2] = [".jsonl.zstd", ".jsonl"];

/// A skippable frame's fixed header: four bytes of magic, four of length.
const SKIPPED_HEADER: usize = 8;

/// One session cannot spend the whole process before the library's corpus
/// budget gets a chance to evict it. The stored ceiling also bounds plain-text
/// reads; compressed frames have the tighter decoded ceiling below.
const MAX_STORED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 32 * 1024 * 1024;

/// The log inside a session directory, or nothing when there is not one yet.
pub fn locate(dir: &Path) -> Option<PathBuf> {
    SUFFIXES
        .iter()
        .map(|suffix| dir.join(format!("{STEM}{suffix}")))
        .find(|path| path.is_file())
}

/// Read a log back as the JSONL text the harness wrote into it.
pub fn text(path: &Path) -> std::io::Result<String> {
    read(path).map(|document| document.text)
}

pub struct Document {
    pub text: String,
    /// A size ceiling was reached, not an ordinary unfinished append frame.
    pub limited: bool,
}

pub fn read(path: &Path) -> std::io::Result<Document> {
    read_with_limits(path, MAX_STORED_BYTES, MAX_TEXT_BYTES)
}

fn read_with_limits(
    path: &Path,
    stored_maximum: u64,
    text_maximum: usize,
) -> std::io::Result<Document> {
    let compressed = path.extension().is_some_and(|suffix| suffix == "zstd");
    let maximum = if compressed {
        stored_maximum
    } else {
        text_maximum as u64
    };
    let mut bytes = read_prefix(path, maximum + 1)?;
    let mut limited = bytes.len() as u64 > maximum;
    bytes.truncate(maximum as usize);

    if compressed {
        let mut document = decode_with_limit(&bytes, text_maximum);
        document.limited |= limited;
        return Ok(document);
    }

    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(broken) => {
            let mut text = String::new();
            limited |= push_lossy(&mut text, broken.as_bytes(), text_maximum);
            text
        }
    };
    Ok(Document { text, limited })
}

/// What one decode attempt found, and how much of the stream it used up.
enum Frame {
    Content(Vec<u8>, usize),
    /// This frame crossed the decoded-text budget. Its safe prefix is kept and
    /// the rest of the artifact is deliberately not visited.
    Limit(Vec<u8>),
    /// A frame addressed to a different reader, stepped over by its own length.
    Skipped(usize),
    /// Nothing more can be read: the end of the file, or the end of what was
    /// committed to it.
    End,
}

/// Join every complete frame's plaintext back into one document.
#[cfg(test)]
fn unframe(bytes: &[u8]) -> String {
    unframe_with_limit(bytes, MAX_TEXT_BYTES)
}

#[cfg(test)]
fn unframe_with_limit(bytes: &[u8], maximum: usize) -> String {
    decode_with_limit(bytes, maximum).text
}

fn decode_with_limit(bytes: &[u8], maximum: usize) -> Document {
    let mut text = String::new();
    let mut at = 0;
    let mut limited = false;

    while at < bytes.len() && text.len() < maximum {
        let remaining = maximum - text.len();
        match frame(&bytes[at..], remaining) {
            // A frame that reports no progress would otherwise be read forever.
            Frame::Content(_, 0) | Frame::Skipped(0) | Frame::End => break,
            Frame::Content(plain, used) => {
                limited |= push_lossy(&mut text, &plain, maximum);
                at += used;
            }
            Frame::Limit(plain) => {
                push_lossy(&mut text, &plain, maximum);
                limited = true;
                break;
            }
            Frame::Skipped(used) => {
                if used > bytes.len() - at {
                    break;
                }
                at += used;
            }
        }
    }

    // Another frame remains after an exact budget-sized frame. Do not silently
    // label this prefix as the complete conversation.
    limited |= text.len() >= maximum && at < bytes.len();
    Document { text, limited }
}

/// Decode the frame starting at the front of `bytes`.
///
/// The reader is handed over by value rather than borrowed so that its position
/// comes back with it, which is the only way to know where the next frame
/// begins — a Zstandard frame does not carry its own compressed length.
fn frame(bytes: &[u8], maximum: usize) -> Frame {
    match StreamingDecoder::new(Cursor::new(bytes)) {
        Ok(mut decoder) => {
            let mut plain = Vec::new();
            // Everything up to here was committed and is kept; this frame was
            // not and is dropped whole, rather than half a batch of events being
            // passed off as the end of the conversation.
            if decoder
                .by_ref()
                .take(maximum.saturating_add(1) as u64)
                .read_to_end(&mut plain)
                .is_err()
            {
                return Frame::End;
            }
            if plain.len() > maximum {
                plain.truncate(maximum);
                return Frame::Limit(plain);
            }
            let used = decoder.into_inner().position() as usize;
            Frame::Content(plain, used)
        }
        Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
            length,
            ..
        })) => Frame::Skipped(SKIPPED_HEADER.saturating_add(length as usize)),
        Err(_) => Frame::End,
    }
}

fn read_prefix(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(maximum).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
fn lossy_prefix(bytes: &[u8], maximum: usize) -> String {
    let mut text = String::new();
    push_lossy(&mut text, bytes, maximum);
    text
}

fn push_lossy(text: &mut String, mut bytes: &[u8], maximum: usize) -> bool {
    while !bytes.is_empty() && text.len() < maximum {
        match std::str::from_utf8(bytes) {
            Ok(valid) => {
                return push_valid(text, valid, maximum);
            }
            Err(broken) => {
                if let Ok(valid) = std::str::from_utf8(&bytes[..broken.valid_up_to()]) {
                    if push_valid(text, valid, maximum) {
                        return true;
                    }
                }
                if text.len().saturating_add('�'.len_utf8()) > maximum {
                    return true;
                }
                text.push('�');
                let skip = broken
                    .error_len()
                    .unwrap_or(bytes.len() - broken.valid_up_to());
                bytes = &bytes[broken.valid_up_to().saturating_add(skip)..];
            }
        }
    }
    !bytes.is_empty()
}

fn push_valid(text: &mut String, valid: &str, maximum: usize) -> bool {
    let room = maximum.saturating_sub(text.len());
    let mut end = valid.len().min(room);
    while !valid.is_char_boundary(end) {
        end -= 1;
    }
    text.push_str(&valid[..end]);
    end < valid.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two frames, each one line, the way an appended log accumulates them.
    fn framed() -> Vec<u8> {
        let mut bytes = ruzstd::encoding::compress_to_vec(
            b"{\"type\":\"session\"}\n".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        bytes.extend(ruzstd::encoding::compress_to_vec(
            b"{\"seq\":1}\n{\"seq\":2}\n".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        ));
        bytes
    }

    /// The whole point of the format: a log is not one compressed document but
    /// a pile of them, and reading only the first would stop at the header.
    #[test]
    fn every_appended_frame_is_read_and_not_only_the_first() {
        let text = unframe(&framed());

        assert_eq!(text, "{\"type\":\"session\"}\n{\"seq\":1}\n{\"seq\":2}\n");
    }

    /// A session being written has a last frame that is not finished. Refusing
    /// the file for it would make every running session unreadable — which is
    /// exactly the session somebody is most likely to go looking for.
    #[test]
    fn a_half_written_tail_costs_its_own_frame_and_nothing_before_it() {
        let mut torn = framed();
        torn.extend(ruzstd::encoding::compress_to_vec(
            b"{\"seq\":3}\n".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        ));
        torn.truncate(torn.len() - 4);

        let text = unframe(&torn);

        assert!(text.contains("\"seq\":2"), "{text}");
        assert!(!text.contains("\"seq\":3"), "{text}");
    }

    /// Nothing to read is an empty document, never a panic and never a wait.
    #[test]
    fn nothing_at_all_reads_as_nothing_at_all() {
        assert_eq!(unframe(&[]), "");
        assert_eq!(unframe(&[0, 1, 2, 3]), "");
    }

    #[test]
    fn decompression_stops_at_the_text_budget() {
        let bytes = ruzstd::encoding::compress_to_vec(
            b"abcdefghijklmnopqrstuvwxyz".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );

        assert_eq!(unframe_with_limit(&bytes, 12), "abcdefghijkl");
        assert!(decode_with_limit(&bytes, 12).limited);
        assert!(!decode_with_limit(&bytes, 26).limited);
        assert!(!decode_with_limit(&bytes, 100).limited);
    }

    #[test]
    fn a_following_frame_at_the_exact_limit_is_reported() {
        let bytes = framed();
        let header = "{\"type\":\"session\"}\n";
        let document = decode_with_limit(&bytes, header.len());
        assert_eq!(document.text, header);
        assert!(document.limited);
        assert!(!decode_with_limit(&bytes, 1024).limited);
    }

    #[test]
    fn an_unfinished_frame_is_not_a_size_limit() {
        let mut bytes = framed();
        bytes.truncate(bytes.len() - 4);
        assert!(!decode_with_limit(&bytes, 1024).limited);
    }

    #[test]
    fn plain_files_report_only_actual_budget_overflow() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "dsh-session-budget-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(&vec![b'x'; MAX_TEXT_BYTES]).unwrap();
        drop(file);
        let exact = read(&path).unwrap();
        assert!(!exact.limited);
        assert_eq!(exact.text.len(), MAX_TEXT_BYTES);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let excess = read(&path).unwrap();
        assert!(excess.limited);
        assert_eq!(excess.text.len(), MAX_TEXT_BYTES);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_utf8_replacement_cannot_expand_past_the_budget() {
        assert_eq!(lossy_prefix(&[b'a', 0xff, b'b'], 5), "a�b");
        assert_eq!(lossy_prefix(&[0xff; 100], 5), "�");
        assert!(push_lossy(&mut String::new(), &[0xff; 100], 5));
        assert!(!push_lossy(&mut String::new(), &[b'a', 0xff, b'b'], 5));
        assert!(push_lossy(&mut String::new(), "你好吗".as_bytes(), 5));
        let bytes = ruzstd::encoding::compress_to_vec(
            &[0xff; 4][..],
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        assert!(decode_with_limit(&bytes, 5).limited);
    }

    #[test]
    fn compressed_file_reports_either_stored_or_decoded_limits() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "dsh-session-compressed-budget-{}-{}.zstd",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bytes = framed();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(&bytes).unwrap();
        drop(file);
        let complete = read_with_limits(&path, bytes.len() as u64, 1024).unwrap();
        assert!(!complete.limited);
        assert!(complete.text.contains("\"seq\":2"));
        assert!(
            read_with_limits(&path, bytes.len() as u64 - 1, 1024)
                .unwrap()
                .limited
        );
        assert!(
            read_with_limits(&path, bytes.len() as u64, 20)
                .unwrap()
                .limited
        );
        fs::remove_file(path).unwrap();
    }
}
