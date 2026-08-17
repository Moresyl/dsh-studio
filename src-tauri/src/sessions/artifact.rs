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

/// The log inside a session directory, or nothing when there is not one yet.
pub fn locate(dir: &Path) -> Option<PathBuf> {
    SUFFIXES
        .iter()
        .map(|suffix| dir.join(format!("{STEM}{suffix}")))
        .find(|path| path.is_file())
}

/// Read a log back as the JSONL text the harness wrote into it.
pub fn text(path: &Path) -> std::io::Result<String> {
    let bytes = fs::read(path)?;

    if path.extension().is_some_and(|suffix| suffix == "zstd") {
        return Ok(unframe(&bytes));
    }

    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(broken) => String::from_utf8_lossy(broken.as_bytes()).into_owned(),
    })
}

/// What one decode attempt found, and how much of the stream it used up.
enum Frame {
    Content(Vec<u8>, usize),
    /// A frame addressed to a different reader, stepped over by its own length.
    Skipped(usize),
    /// Nothing more can be read: the end of the file, or the end of what was
    /// committed to it.
    End,
}

/// Join every complete frame's plaintext back into one document.
fn unframe(bytes: &[u8]) -> String {
    let mut text = String::new();
    let mut at = 0;

    while at < bytes.len() {
        match frame(&bytes[at..]) {
            // A frame that reports no progress would otherwise be read forever.
            Frame::Content(_, 0) | Frame::Skipped(0) | Frame::End => break,
            Frame::Content(plain, used) => {
                text.push_str(&String::from_utf8_lossy(&plain));
                at += used;
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
fn frame(bytes: &[u8]) -> Frame {
    match StreamingDecoder::new(Cursor::new(bytes)) {
        Ok(mut decoder) => {
            let mut plain = Vec::new();
            // Everything up to here was committed and is kept; this frame was
            // not and is dropped whole, rather than half a batch of events being
            // passed off as the end of the conversation.
            if decoder.read_to_end(&mut plain).is_err() {
                return Frame::End;
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
}
