//! Bounded line framing for output produced by untrusted child processes.

use tokio::io::{AsyncBufRead, AsyncBufReadExt as _};

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
}
