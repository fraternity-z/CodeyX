use anyhow::{Result, anyhow, ensure};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

pub(super) const MAX_FRAME: usize = 8 * 1024 * 1024;

pub(super) async fn read(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Value>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .await
            .map_err(|_| anyhow!("读取 MCP 消息失败"))?;
        if buffer.is_empty() {
            ensure!(line.is_empty(), "MCP 消息未完整结束");
            return Ok(None);
        }
        let size = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        ensure!(line.len() + size <= MAX_FRAME, "MCP 消息超过 8 MiB 上限");
        let complete = buffer[size - 1] == b'\n';
        line.extend_from_slice(&buffer[..size]);
        reader.consume(size);
        if complete {
            return serde_json::from_slice(&line)
                .map(Some)
                .map_err(|_| anyhow!("MCP 消息不是有效 JSON"));
        }
    }
}

pub(super) async fn write(writer: &mut (impl AsyncWrite + Unpin), value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() < MAX_FRAME, "MCP 消息超过 8 MiB 上限");
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| anyhow!("发送 MCP 消息失败"))?;
    writer
        .flush()
        .await
        .map_err(|_| anyhow!("刷新 MCP 消息失败"))
}
