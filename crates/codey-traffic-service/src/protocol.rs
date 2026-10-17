use std::{fmt, net::SocketAddr};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const VERSION: u32 = 1;
pub const MAX_FRAME: usize = 4096;

/// Sent over a local private pipe, never via arguments, environment or disk.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    pub version: u32,
    pub gateway: SocketAddr,
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Start {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Start")
            .field("version", &self.version)
            .field("gateway", &self.gateway)
            .field("credential", &"[redacted]")
            .finish()
    }
}

impl Start {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != VERSION {
            return Err("代理服务协议版本不兼容");
        }
        if !self.gateway.ip().is_loopback() || self.gateway.port() == 0 {
            return Err("代理服务只能连接 CodeyX 的本地代理入口");
        }
        if self.username.is_empty()
            || self.password.is_empty()
            || self.username.len() > 255
            || self.password.len() > 255
            || self.username.contains('\0')
            || self.password.contains('\0')
        {
            return Err("本地代理入口凭据无效");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub enum Reply {
    Ready { version: u32 },
    Stopped,
    Failed { code: String },
}

pub fn pipe_name(session: uuid::Uuid) -> Result<String, &'static str> {
    if session.is_nil() {
        return Err("代理服务会话标识无效");
    }
    Ok(format!(r"\\.\pipe\CodeyXTraffic-{}", session.simple()))
}

pub fn job_name(session: uuid::Uuid) -> Result<String, &'static str> {
    if session.is_nil() {
        return Err("代理服务会话标识无效");
    }
    Ok(format!(r"Local\CodeyXTraffic-{}", session.simple()))
}

pub async fn read_frame<T: for<'a> Deserialize<'a>>(
    io: &mut (impl AsyncRead + Unpin),
) -> Result<T, &'static str> {
    let size = io
        .read_u32_le()
        .await
        .map_err(|_| "代理服务控制连接已关闭")? as usize;
    if size == 0 || size > MAX_FRAME {
        return Err("代理服务控制消息大小无效");
    }
    let mut bytes = vec![0; size];
    io.read_exact(&mut bytes)
        .await
        .map_err(|_| "代理服务控制消息不完整")?;
    // serde errors may contain user data; never propagate them to logs or UI.
    serde_json::from_slice(&bytes).map_err(|_| "代理服务控制消息无效")
}

pub async fn write_frame<T: Serialize>(
    io: &mut (impl AsyncWrite + Unpin),
    value: &T,
) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| "代理服务控制消息无效")?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err("代理服务控制消息大小无效");
    }
    io.write_u32_le(bytes.len() as u32)
        .await
        .map_err(|_| "代理服务控制连接已关闭")?;
    io.write_all(&bytes)
        .await
        .map_err(|_| "代理服务控制连接已关闭")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start() -> Start {
        Start {
            version: VERSION,
            gateway: "127.0.0.1:24817".parse().unwrap(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        }
    }

    #[test]
    fn only_authenticated_loopback_gateways_are_allowed() {
        let mut value = start();
        assert!(value.validate().is_ok());
        value.gateway = "[::1]:24817".parse().unwrap();
        assert!(value.validate().is_ok());
        for address in [
            "0.0.0.0:24817",
            "192.0.2.1:24817",
            "127.0.0.1:0",
            "[::]:24817",
        ] {
            value.gateway = address.parse().unwrap();
            assert!(value.validate().is_err());
        }
        value = start();
        value.version += 1;
        assert!(value.validate().is_err());
        value = start();
        value.password.clear();
        assert!(value.validate().is_err());
        value.password = "x".repeat(256);
        assert!(value.validate().is_err());
        value.password = "x\0y".into();
        assert!(value.validate().is_err());
    }

    #[test]
    fn credentials_are_redacted_and_sessions_are_not_global() {
        let value = format!("{:?}", start());
        assert!(!value.contains("fixture-"));
        assert!(pipe_name(uuid::Uuid::nil()).is_err());
        assert!(job_name(uuid::Uuid::nil()).is_err());
        let id = uuid::Uuid::new_v4();
        assert!(
            pipe_name(id)
                .unwrap()
                .starts_with(r"\\.\pipe\CodeyXTraffic-")
        );
        assert!(job_name(id).unwrap().starts_with(r"Local\CodeyXTraffic-"));
    }

    #[tokio::test]
    async fn bounded_frames_roundtrip_and_reject_untrusted_data() {
        let (mut writer, mut reader) = tokio::io::duplex(MAX_FRAME + 4);
        let reply = Reply::Ready { version: VERSION };
        write_frame(&mut writer, &reply).await.unwrap();
        assert_eq!(read_frame::<Reply>(&mut reader).await.unwrap(), reply);
        writer.write_u32_le((MAX_FRAME + 1) as u32).await.unwrap();
        assert!(read_frame::<Start>(&mut reader).await.is_err());
        let invalid = br#"{"state":"fixture-password"}"#;
        writer.write_u32_le(invalid.len() as u32).await.unwrap();
        writer.write_all(invalid).await.unwrap();
        assert!(
            !read_frame::<Reply>(&mut reader)
                .await
                .unwrap_err()
                .contains("fixture")
        );
        writer.write_u32_le(10).await.unwrap();
        drop(writer);
        assert!(read_frame::<Start>(&mut reader).await.is_err());
    }
}
