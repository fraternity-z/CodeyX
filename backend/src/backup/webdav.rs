use std::io::Read;
use std::path::Path;
use std::time::Duration;

use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::MAX_BACKUP_BYTES;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub url: String,
    pub username: String,
    pub password: String,
    #[serde(default, skip_serializing)]
    pub clear_password: bool,
    #[serde(default)]
    pub allow_http: bool,
}

impl Settings {
    fn endpoint(&self) -> Result<Url, String> {
        if self.url.len() > 4096 {
            return Err("WebDAV 地址过长".into());
        }
        let url = crate::config::validate_outbound_api_url(self.url.trim(), "WebDAV 地址")?;
        if url.scheme() != "https" && !self.allow_http {
            return Err("WebDAV 默认要求 HTTPS；使用 HTTP 前请明确允许未加密连接".into());
        }
        if url.query().is_some() || url.fragment().is_some() || !url.path().ends_with(".json") {
            return Err("WebDAV 地址应指向完整的 .json 文件，不能包含查询参数或片段".into());
        }
        if self.username.contains(':') || self.username.len() > 1024 || self.password.len() > 4096 {
            return Err("WebDAV 用户名或密码格式无效".into());
        }
        Ok(url)
    }

    pub(crate) fn public(&self) -> Value {
        json!({ "url": self.url, "username": self.username, "passwordConfigured": !self.password.is_empty(), "allowHttp": self.allow_http })
    }

    pub(crate) fn merge(mut self, previous: Self) -> Result<Self, String> {
        self.url = self.url.trim().to_string();
        if self.clear_password {
            self.password.clear();
        } else if self.password.is_empty()
            && self.url == previous.url
            && self.username == previous.username
        {
            self.password = previous.password;
        }
        self.endpoint()?;
        self.clear_password = false;
        Ok(self)
    }
}

pub(crate) fn load(path: &Path) -> Result<Settings, String> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(16 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "读取 WebDAV 设置失败")?;
            if bytes.len() > 16 * 1024 {
                return Err("WebDAV 设置文件过大".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "WebDAV 设置文件无效".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(_) => Err("读取 WebDAV 设置失败".into()),
    }
}

pub(crate) fn save(path: &Path, settings: Settings) -> Result<Value, String> {
    let settings = settings.merge(load(path)?)?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "序列化 WebDAV 设置失败")?;
    crate::fs_util::atomic_write_private_with_parent(path, &bytes)
        .map_err(|_| "保存 WebDAV 设置失败")?;
    Ok(settings.public())
}

pub(crate) async fn transfer(
    settings: &Settings,
    content: Option<String>,
) -> Result<Option<String>, String> {
    let url = settings.endpoint()?;
    let upload = content.is_some();
    if let Some(content) = &content {
        super::check_size(content.len())?;
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "创建 WebDAV 连接失败")?;
    let mut request = client.request(if upload { Method::PUT } else { Method::GET }, url);
    if !settings.username.is_empty() || !settings.password.is_empty() {
        request = request.basic_auth(&settings.username, Some(&settings.password));
    }
    if let Some(content) = content {
        request = request
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )
            .body(content);
    }
    let response = request.send().await.map_err(|_| {
        if upload {
            "WebDAV 上传结果未确认，请先下载检查云端文件后再决定是否重试"
        } else {
            "WebDAV 下载失败，请检查连接和证书"
        }
    })?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err("WebDAV 认证失败或没有访问权限".into());
        }
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => {
            return Err("WebDAV 文件或父目录不存在，请先创建目录并检查文件地址".into());
        }
        status if status.is_redirection() => {
            return Err("WebDAV 地址发生重定向，请填写最终文件地址".into());
        }
        status
            if !(status == StatusCode::OK
                || upload && matches!(status, StatusCode::CREATED | StatusCode::NO_CONTENT)) =>
        {
            return Err(format!("WebDAV 请求失败（HTTP {}）", status.as_u16()));
        }
        _ => {}
    }
    if upload {
        return Ok(None);
    }
    let bytes = crate::http_response::read_bounded_body(response, MAX_BACKUP_BYTES, "WebDAV 备份")
        .await
        .map_err(|_| "WebDAV 备份读取失败或超过 4 MiB")?;
    let content = String::from_utf8(bytes).map_err(|_| "WebDAV 备份不是 UTF-8 JSON")?;
    super::parse(&content)?;
    Ok(Some(content))
}
