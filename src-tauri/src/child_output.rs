//! Bounded line framing for output produced by untrusted child processes.

use tokio::io::{AsyncBufRead, AsyncBufReadExt as _, AsyncRead, AsyncReadExt as _};

const MAX_LINE_BYTES: usize = 32 * 1024;
const TRUNCATED: &[u8] = b" ... [line truncated]";

/// Read one line without allowing a missing newline to grow memory without a bound.
pub async fn next_line<R>(reader: &mut R, line: &mut Vec<u8>) -> std::io::Result<bool>
where
    R: AsyncBufRead + Unpin,
{
    line.clear();
    let content_limit = MAX_LINE_BYTES - TRUNCATED.len() - 1;
    let mut truncated = false;
    let mut saw_bytes = false;

    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if truncated {
                line.extend_from_slice(TRUNCATED);
            }
            return Ok(saw_bytes);
        }

        saw_bytes = true;
        let end = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |at| at + 1);
        let room = content_limit.saturating_sub(line.len());
        let kept = end.min(room);
        line.extend_from_slice(&available[..kept]);
        truncated |= kept < end;
        let complete = available[..end].ends_with(b"\n");
        reader.consume(end);

        if complete {
            if truncated {
                while line
                    .last()
                    .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
                {
                    line.pop();
                }
                line.extend_from_slice(TRUNCATED);
                line.push(b'\n');
            }
            return Ok(true);
        }
    }
}

/// Capture a stream without letting a child process choose the allocation size.
///
/// The rest of an oversized stream is still drained. That lets the child exit
/// instead of blocking forever on a full pipe while the caller waits for its
/// status, but no more untrusted bytes are retained in memory.
pub async fn capture<R>(mut reader: R, maximum: usize) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut body = Vec::with_capacity(maximum.min(64 * 1024));
    let mut limited = (&mut reader).take(maximum.saturating_add(1) as u64);
    limited.read_to_end(&mut body).await?;
    if body.len() <= maximum {
        return Ok(body);
    }

    tokio::io::copy(&mut reader, &mut tokio::io::sink()).await?;
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("child output exceeds the {maximum} byte safety limit"),
    ))
}

#[cfg(test)]
mod tests {
    use tokio::io::BufReader;

    use super::*;

    #[tokio::test]
    async fn long_lines_are_bounded_without_consuming_the_next_line() {
        let mut input = vec![b'x'; MAX_LINE_BYTES * 2];
        input.extend_from_slice(b"\nnext\n");
        let mut reader = BufReader::new(input.as_slice());
        let mut line = Vec::new();

        assert!(next_line(&mut reader, &mut line).await.expect("first line"));
        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.ends_with(b"[line truncated]\n"));
        assert!(next_line(&mut reader, &mut line)
            .await
            .expect("second line"));
        assert_eq!(line, b"next\n");
        assert!(!next_line(&mut reader, &mut line).await.expect("end"));
    }

    #[tokio::test]
    async fn unterminated_lines_and_empty_input_are_reported_once() {
        let mut reader = BufReader::new(b"last".as_slice());
        let mut line = Vec::new();
        assert!(next_line(&mut reader, &mut line).await.expect("last line"));
        assert_eq!(line, b"last");
        assert!(!next_line(&mut reader, &mut line).await.expect("end"));
    }

    #[tokio::test]
    async fn capture_accepts_the_limit_and_drains_an_oversized_stream() {
        assert_eq!(capture(b"12345".as_slice(), 5).await.unwrap(), b"12345");
        let failure = capture(b"123456789".as_slice(), 5)
            .await
            .expect_err("oversized output");
        assert_eq!(failure.kind(), std::io::ErrorKind::InvalidData);
    }
}
