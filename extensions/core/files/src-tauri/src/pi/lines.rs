//! Bounded newline framing for Pi's JSONL protocol.
//!
//! `BufRead::lines()` allocates without a bound, so a malformed or hostile
//! child process could exhaust memory. Records over the cap are drained and
//! reported instead of buffered.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

pub enum ReadLine {
    Line,
    Oversized,
    Eof,
}

/// Read one LF-terminated record with a hard size cap.
pub async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    out: &mut Vec<u8>,
    limit: usize,
) -> io::Result<ReadLine> {
    out.clear();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if out.is_empty() && !oversized {
                return Ok(ReadLine::Eof);
            }
            return Ok(if oversized {
                ReadLine::Oversized
            } else {
                ReadLine::Line
            });
        }
        if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
            if !oversized {
                if out.len() + index > limit {
                    oversized = true;
                    out.clear();
                } else {
                    out.extend_from_slice(&available[..index]);
                }
            }
            reader.consume(index + 1);
            return Ok(if oversized {
                ReadLine::Oversized
            } else {
                ReadLine::Line
            });
        }
        let available_len = available.len();
        if !oversized {
            if out.len() + available_len > limit {
                oversized = true;
                out.clear();
            } else {
                out.extend_from_slice(available);
            }
        }
        reader.consume(available_len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn reads_lines_and_reports_oversized_records() {
        let input = b"one\ntwo\nthree\n".to_vec();
        let mut reader = BufReader::new(input.as_slice());
        let mut out = Vec::new();
        for expected in ["one", "two", "three"] {
            assert!(matches!(read_bounded_line(&mut reader, &mut out, 16).await.unwrap(), ReadLine::Line));
            assert_eq!(String::from_utf8_lossy(&out), expected);
        }
        assert!(matches!(read_bounded_line(&mut reader, &mut out, 16).await.unwrap(), ReadLine::Eof));

        let input = b"a\n0123456789abcdef\nb\n".to_vec();
        let mut reader = BufReader::new(input.as_slice());
        assert!(matches!(read_bounded_line(&mut reader, &mut out, 8).await.unwrap(), ReadLine::Line));
        assert!(matches!(read_bounded_line(&mut reader, &mut out, 8).await.unwrap(), ReadLine::Oversized));
        assert!(matches!(read_bounded_line(&mut reader, &mut out, 8).await.unwrap(), ReadLine::Line));
        assert_eq!(String::from_utf8_lossy(&out), "b");
    }
}
