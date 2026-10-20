use std::time::Duration;

use anyhow::{Result, ensure};

const NATIVE_QUIT_SCRIPT: &str = r#"(async () => {
  const bridge = window.electronBridge;
  if (typeof bridge?.sendMessageFromView !== "function") return false;
  await bridge.sendMessageFromView({ type: "quit-app", relaunch: false });
  return true;
})()"#;

pub(crate) async fn request_native_quit(websocket_url: &str) -> Result<()> {
    let response = codey_runtime_core::bridge::evaluate_script_with_await_promise_timeout(
        websocket_url,
        NATIVE_QUIT_SCRIPT,
        true,
        Duration::from_secs(3),
    )
    .await?;
    ensure!(
        super::runtime_value(&response).and_then(serde_json::Value::as_bool) == Some(true),
        "native Codex quit bridge is unavailable"
    );
    Ok(())
}
