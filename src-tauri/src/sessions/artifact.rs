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
    let bytes = read_prefix(path, MAX_STORED_BYTES)?;

    if path.extension().is_some_and(|suffix| suffix == "zstd") {
        return Ok(unframe(&bytes));
    }

    let mut bytes = bytes;
    bytes.truncate(MAX_TEXT_BYTES);
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(broken) => lossy_prefix(broken.as_bytes(), MAX_TEXT_BYTES),
    })
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
fn unframe(bytes: &[u8]) -> String {
    unframe_with_limit(bytes, MAX_TEXT_BYTES)
}

fn unframe_with_limit(bytes: &[u8], maximum: usize) -> String {
    let mut text = String::new();
    let mut at = 0;

    while at < bytes.len() && text.len() < maximum {
        let remaining = maximum - text.len();
        match frame(&bytes[at..], remaining) {
            // A frame that reports no progress would otherwise be read forever.
            Frame::Content(_, 0) | Frame::Skipped(0) | Frame::End => break,
            Frame::Content(plain, used) => {
                push_lossy(&mut text, &plain, maximum);
                at += used;
            }
            Frame::Limit(plain) => {
                push_lossy(&mut text, &plain, maximum);
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

    text
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

fn lossy_prefix(bytes: &[u8], maximum: usize) -> String {
    let mut text = String::new();
    push_lossy(&mut text, bytes, maximum);
    text
}

fn push_lossy(text: &mut String, mut bytes: &[u8], maximum: usize) {
    while !bytes.is_empty() && text.len() < maximum {
        match std::str::from_utf8(bytes) {
            Ok(valid) => {
                push_valid(text, valid, maximum);
                return;
            }
            Err(broken) => {
                if let Ok(valid) = std::str::from_utf8(&bytes[..broken.valid_up_to()]) {
                    push_valid(text, valid, maximum);
                }
                if text.len().saturating_add('�'.len_utf8()) > maximum {
                    return;
                }
                text.push('�');
                let skip = broken
                    .error_len()
                    .unwrap_or(bytes.len() - broken.valid_up_to());
                bytes = &bytes[broken.valid_up_to().saturating_add(skip)..];
            }
        }
    }
}

fn push_valid(text: &mut String, valid: &str, maximum: usize) {
    let room = maximum.saturating_sub(text.len());
    let mut end = valid.len().min(room);
    while !valid.is_char_boundary(end) {
        end -= 1;
    }
    text.push_str(&valid[..end]);
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
    }

    #[test]
    fn invalid_utf8_replacement_cannot_expand_past_the_budget() {
        assert_eq!(lossy_prefix(&[b'a', 0xff, b'b'], 5), "a�b");
        assert_eq!(lossy_prefix(&[0xff; 100], 5), "�");
    }
}
