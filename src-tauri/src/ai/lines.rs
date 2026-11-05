//! Bounded newline framing for Pi's JSONL protocol.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

pub enum ReadLine {
    Line,
    Oversized,
    Eof,
}

/// Read one LF-terminated record with a hard size cap.
///
/// `BufRead::lines()` allocates without a bound, so a malformed or hostile
/// child process could exhaust memory. Oversized records are drained and
/// reported instead.
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
