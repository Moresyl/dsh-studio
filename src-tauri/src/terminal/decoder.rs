//! Turn a stream of pty bytes into strings without cutting characters in half.
//!
//! A read from a pty returns whatever bytes have arrived, and there is nothing to
//! stop the boundary falling in the middle of a multi-byte character — which is
//! the normal case for Chinese output and for the box-drawing and emoji that
//! progress bars are made of. Decoding each read on its own would put a `�` in
//! the middle of perfectly good text, roughly once per screenful.
//!
//! So the tail of an incomplete sequence is held back until the rest of it
//! arrives. That is the whole of this file, and it is worth its own module
//! because the distinction it rests on is easy to get backwards: a *cut short*
//! sequence must be carried, an *invalid* one must be replaced. `Utf8Error` tells
//! the two apart through `error_len`, and nothing else does.

/// Holds the incomplete tail between two reads.
#[derive(Debug, Default)]
pub struct Decoder {
    /// At most three bytes: the longest valid prefix of a UTF-8 sequence.
    carry: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode `chunk`, returning every character that is now complete.
    ///
    /// Bytes that cannot begin a character are replaced rather than dropped, so
    /// the length of what comes out still tracks the length of what went in —
    /// which matters, because a terminal writing binary to its own stdout is
    /// doing that on purpose and the cursor has to end up where it expects.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.extend_from_slice(chunk);

        let mut text = String::with_capacity(buffer.len());
        let mut rest: &[u8] = &buffer;

        loop {
            match std::str::from_utf8(rest) {
                Ok(whole) => {
                    text.push_str(whole);
                    break;
                }
                Err(problem) => {
                    let good = problem.valid_up_to();
                    text.push_str(
                        std::str::from_utf8(&rest[..good])
                            .expect("valid_up_to marks a valid prefix"),
                    );

                    match problem.error_len() {
                        // Genuinely not UTF-8. One replacement character per
                        // offending byte run, then keep going — the bytes after
                        // it are usually fine, and stopping here would lose them.
                        Some(bad) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[good + bad..];
                        }
                        // Cut short by the read boundary. Hold it for the next one.
                        None => {
                            self.carry.extend_from_slice(&rest[good..]);
                            break;
                        }
                    }
                }
            }
        }

        text
    }
}

#[cfg(test)]
mod tests {
    use super::Decoder;

    #[test]
    fn ascii_passes_straight_through() {
        let mut decoder = Decoder::new();
        assert_eq!(decoder.push(b"$ ls -l\r\n"), "$ ls -l\r\n");
    }

    #[test]
    fn a_split_character_survives_the_boundary() {
        // 一 is three bytes; the read lands after the first of them.
        let whole = "一".as_bytes();
        let mut decoder = Decoder::new();

        assert_eq!(decoder.push(&whole[..1]), "");
        assert_eq!(decoder.push(&whole[1..]), "一");
    }

    #[test]
    fn a_character_split_three_ways_still_arrives() {
        // Four bytes, delivered one at a time — the worst case a pty can produce.
        let whole = "🚀".as_bytes();
        let mut decoder = Decoder::new();

        assert_eq!(decoder.push(&whole[..1]), "");
        assert_eq!(decoder.push(&whole[1..2]), "");
        assert_eq!(decoder.push(&whole[2..3]), "");
        assert_eq!(decoder.push(&whole[3..]), "🚀");
    }

    #[test]
    fn text_around_a_split_is_not_held_back() {
        let mut decoder = Decoder::new();
        let mut chunk = b"ok ".to_vec();
        chunk.extend_from_slice(&"好".as_bytes()[..2]);

        // The prefix must come out now; only the fragment waits.
        assert_eq!(decoder.push(&chunk), "ok ");
        assert_eq!(decoder.push(&"好".as_bytes()[2..]), "好");
    }

    #[test]
    fn an_impossible_byte_is_replaced_and_reading_continues() {
        let mut decoder = Decoder::new();
        assert_eq!(decoder.push(b"a\xffb"), "a\u{fffd}b");
    }

    #[test]
    fn a_stray_continuation_byte_does_not_stall_the_stream() {
        // 0x80 can only ever be a continuation, so it cannot be a cut-short
        // sequence waiting for more. Carrying it would wedge the terminal.
        let mut decoder = Decoder::new();
        assert_eq!(decoder.push(b"\x80done"), "\u{fffd}done");
    }

    #[test]
    fn a_truncated_sequence_followed_by_garbage_recovers() {
        let mut decoder = Decoder::new();
        assert_eq!(decoder.push(&"好".as_bytes()[..2]), "");
        // The next read is not the continuation, so what was carried was never a
        // character. It has to be reported and abandoned, not held forever.
        assert_eq!(decoder.push(b"!"), "\u{fffd}!");
    }

    #[test]
    fn nothing_is_carried_once_a_chunk_ends_cleanly() {
        let mut decoder = Decoder::new();
        decoder.push("完成".as_bytes());
        assert_eq!(decoder.push(b""), "");
    }
}
