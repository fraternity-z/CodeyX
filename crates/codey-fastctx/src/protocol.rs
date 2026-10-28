use std::io;
use std::ops::Deref;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_PENDING_REQUESTS: usize = 1024;
const MAX_POOLED_FRAMES: usize = 4;
const MAX_POOLED_FRAME_CAPACITY: usize = 512 * 1024;
const INITIAL_FRAME_CAPACITY: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolLimits {
    pub max_frame_bytes: usize,
    pub max_queued_bytes: usize,
    pub max_pending_requests: usize,
}

impl Default for ProtocolLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_queued_bytes: DEFAULT_MAX_QUEUED_BYTES,
            max_pending_requests: DEFAULT_MAX_PENDING_REQUESTS,
        }
    }
}

impl ProtocolLimits {
    pub fn from_environment() -> Self {
        let defaults = Self::default();
        let max_frame_bytes = bounded_env_usize(
            "CODEY_FASTCTX_MAX_FRAME_BYTES",
            defaults.max_frame_bytes,
            64 * 1024,
            64 * 1024 * 1024,
        );
        let max_queued_bytes = bounded_env_usize(
            "CODEY_FASTCTX_MAX_QUEUED_BYTES",
            defaults.max_queued_bytes.max(max_frame_bytes),
            max_frame_bytes,
            128 * 1024 * 1024,
        );
        let max_pending_requests = bounded_env_usize(
            "CODEY_FASTCTX_MAX_PENDING_REQUESTS",
            defaults.max_pending_requests,
            16,
            16 * 1024,
        );
        Self {
            max_frame_bytes,
            max_queued_bytes,
            max_pending_requests,
        }
    }
}

fn bounded_env_usize(name: &str, default: usize, minimum: usize, maximum: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (*value >= minimum) && (*value <= maximum))
        .unwrap_or(default)
}

#[derive(Clone, Default)]
struct FramePool {
    frames: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl FramePool {
    fn take(&self) -> Vec<u8> {
        self.frames
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(INITIAL_FRAME_CAPACITY))
    }

    fn recycle(&self, mut bytes: Vec<u8>) {
        if bytes.capacity() > MAX_POOLED_FRAME_CAPACITY {
            return;
        }
        bytes.clear();
        let mut frames = self
            .frames
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if frames.len() < MAX_POOLED_FRAMES {
            frames.push(bytes);
        }
    }
}

pub struct ProtocolFrame {
    bytes: Option<Vec<u8>>,
    permit: Option<OwnedSemaphorePermit>,
    pool: FramePool,
}

impl ProtocolFrame {
    pub fn as_bytes(&self) -> &[u8] {
        self.bytes.as_deref().unwrap_or_default()
    }
}

impl Deref for ProtocolFrame {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.as_bytes()
    }
}

impl Drop for ProtocolFrame {
    fn drop(&mut self) {
        self.permit.take();
        if let Some(bytes) = self.bytes.take() {
            self.pool.recycle(bytes);
        }
    }
}

#[derive(Clone)]
pub struct FrameReader {
    limits: ProtocolLimits,
    pool: FramePool,
    queued_bytes: Arc<Semaphore>,
}

impl FrameReader {
    pub fn new(limits: ProtocolLimits) -> Self {
        Self {
            limits,
            pool: FramePool::default(),
            queued_bytes: Arc::new(Semaphore::new(limits.max_queued_bytes)),
        }
    }

    pub async fn read_line<R>(&self, reader: &mut R) -> io::Result<Option<ProtocolFrame>>
    where
        R: AsyncBufRead + Unpin,
    {
        let mut bytes = self.pool.take();
        bytes.clear();
        let read = {
            let mut limited = reader.take((self.limits.max_frame_bytes + 1) as u64);
            limited.read_until(b'\n', &mut bytes).await?
        };
        if read == 0 {
            self.pool.recycle(bytes);
            return Ok(None);
        }
        if bytes.len() > self.limits.max_frame_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("FastCtx 单帧超过 {} 字节上限", self.limits.max_frame_bytes),
            ));
        }
        if !bytes.ends_with(b"\n") {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "FastCtx 消息在换行分隔符前结束",
            ));
        }
        if bytes.len() > self.limits.max_queued_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "FastCtx 单帧需要 {} 字节，但队列预算只有 {} 字节",
                    bytes.len(),
                    self.limits.max_queued_bytes
                ),
            ));
        }
        let permit_count = u32::try_from(bytes.len().max(1)).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "FastCtx 帧无法计入字节预算")
        })?;
        let permit = self
            .queued_bytes
            .clone()
            .acquire_many_owned(permit_count)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "FastCtx 帧队列已经关闭"))?;
        Ok(Some(ProtocolFrame {
            bytes: Some(bytes),
            permit: Some(permit),
            pool: self.pool.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn protocol_limits_are_bounded_even_when_environment_is_absent_or_invalid() {
        let defaults = ProtocolLimits::default();
        assert_eq!(defaults.max_frame_bytes, DEFAULT_MAX_FRAME_BYTES);
        assert_eq!(defaults.max_queued_bytes, DEFAULT_MAX_QUEUED_BYTES);
        assert_eq!(defaults.max_pending_requests, DEFAULT_MAX_PENDING_REQUESTS);

        let configured = ProtocolLimits::from_environment();
        assert!((64 * 1024..=64 * 1024 * 1024).contains(&configured.max_frame_bytes));
        assert!(
            (configured.max_frame_bytes..=128 * 1024 * 1024).contains(&configured.max_queued_bytes)
        );
        assert!((16..=16 * 1024).contains(&configured.max_pending_requests));
    }

    #[tokio::test]
    async fn frame_reader_reuses_successful_frames_and_reports_clean_eof() {
        let limits = ProtocolLimits {
            max_frame_bytes: 64 * 1024,
            max_queued_bytes: 128 * 1024,
            max_pending_requests: 16,
        };
        let reader = FrameReader::new(limits);
        let bytes = b"{\"id\":\"native\"}\n";
        let mut input = BufReader::new(bytes.as_slice());
        let frame = reader.read_line(&mut input).await.unwrap().unwrap();
        assert_eq!(frame.as_bytes(), bytes);
        assert_eq!(&*frame, bytes);
        drop(frame);
        assert!(reader.read_line(&mut input).await.unwrap().is_none());

        let mut second = BufReader::new(bytes.as_slice());
        let recycled = reader.read_line(&mut second).await.unwrap().unwrap();
        assert_eq!(recycled.as_bytes(), bytes);
    }

    #[tokio::test]
    async fn frame_reader_rejects_a_truncated_frame() {
        let limits = ProtocolLimits {
            max_frame_bytes: 64 * 1024,
            max_queued_bytes: 128 * 1024,
            max_pending_requests: 16,
        };
        let reader = FrameReader::new(limits);
        let mut input = BufReader::new(b"{\"id\":1}".as_slice());
        let error = match reader.read_line(&mut input).await {
            Ok(_) => panic!("truncated frame must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn frame_reader_rejects_an_impossible_queue_budget_without_waiting() {
        let limits = ProtocolLimits {
            max_frame_bytes: 64,
            max_queued_bytes: 4,
            max_pending_requests: 16,
        };
        let reader = FrameReader::new(limits);
        let mut input = BufReader::new(b"{\"id\":1}\n".as_slice());
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            reader.read_line(&mut input),
        )
        .await
        .expect("invalid limits must fail instead of waiting forever");
        assert!(matches!(
            result,
            Err(error) if error.kind() == io::ErrorKind::InvalidInput
        ));
    }

    #[tokio::test]
    async fn frame_reader_rejects_oversized_lines_without_unbounded_growth() {
        let limits = ProtocolLimits {
            max_frame_bytes: 64 * 1024,
            max_queued_bytes: 128 * 1024,
            max_pending_requests: 16,
        };
        let reader = FrameReader::new(limits);
        let bytes = vec![b'A'; limits.max_frame_bytes + 1];
        let mut input = BufReader::new(bytes.as_slice());
        let result = reader.read_line(&mut input).await;
        assert!(matches!(
            result,
            Err(error) if error.kind() == io::ErrorKind::InvalidData
        ));
    }
}
