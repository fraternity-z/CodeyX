#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

//! FastCtx 工具执行的独立程序，避免 Codey 本体携带文件引擎和分词器常量。

use std::ffi::OsStr;

const CODEY_FASTCTX_NATIVE_ARGUMENT: &str = "--codey-fastctx-native";

fn main() {
    let mode = FastCtxMode::from_arguments(std::env::args_os());
    codey_error_log::install_panic_hook("fastctx", mode.stage());
    if let Err(error) = run(mode) {
        let error = format!("{error:#}");
        codey_error_log::record_process_failure_with_recoverability(
            classify_fastctx_failure(&error),
            mode.operation(),
            error.clone(),
            mode.stage(),
            false,
        );
        eprintln!("Codey FastCtx 运行失败：{error}");
        std::process::exit(1);
    }
}

fn run(mode: FastCtxMode) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async move {
        match mode {
            FastCtxMode::Native => codey_fastctx::native::run().await,
            // 上游会通过当前程序拉起 runtime-bootstrap/runtime-host，需保留 CLI 分发。
            _ => fastctx::cli::run()
                .await
                .map(|_| ())
                .map_err(anyhow::Error::msg),
        }
    });
    // stdio 阻塞读取不能取消，错误退出时不能等待仍打开的 stdin。
    runtime.shutdown_background();
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FastCtxMode {
    Native,
    RuntimeBootstrap,
    RuntimeHost,
    Cli,
}

impl FastCtxMode {
    fn from_arguments<I, S>(arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        match arguments.into_iter().nth(1).as_ref().map(AsRef::as_ref) {
            Some(argument) if argument == OsStr::new(CODEY_FASTCTX_NATIVE_ARGUMENT) => Self::Native,
            Some(argument) if argument == OsStr::new("runtime-bootstrap") => Self::RuntimeBootstrap,
            Some(argument) if argument == OsStr::new("runtime-host") => Self::RuntimeHost,
            _ => Self::Cli,
        }
    }

    const fn stage(self) -> &'static str {
        match self {
            Self::Native => "runtime.fastctx_native",
            Self::RuntimeBootstrap => "runtime.fastctx_bootstrap",
            Self::RuntimeHost => "runtime.fastctx_host",
            Self::Cli => "runtime.fastctx_cli",
        }
    }

    const fn operation(self) -> &'static str {
        match self {
            Self::Native => "run_fastctx_native",
            Self::RuntimeBootstrap => "run_fastctx_runtime_bootstrap",
            Self::RuntimeHost => "run_fastctx_runtime_host",
            Self::Cli => "run_fastctx_cli",
        }
    }
}

fn classify_fastctx_failure(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if [
        "transport closed",
        "connection closed",
        "control-center connection failed",
        "control-center input task failed",
        "control-center output task failed",
        "unexpectedly closed",
        "broken pipe",
        "stdin read",
        "unexpected eof",
    ]
    .iter()
    .any(|marker| error.contains(marker))
    {
        "fastctx_transport_closed"
    } else {
        "fastctx_process_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_and_internal_runtime_commands_have_distinct_modes() {
        for (argument, mode) in [
            (CODEY_FASTCTX_NATIVE_ARGUMENT, FastCtxMode::Native),
            ("runtime-bootstrap", FastCtxMode::RuntimeBootstrap),
            ("runtime-host", FastCtxMode::RuntimeHost),
            ("--help", FastCtxMode::Cli),
        ] {
            assert_eq!(
                FastCtxMode::from_arguments(["codey-fastctx", argument]),
                mode
            );
        }
    }

    #[test]
    fn runtime_commands_have_distinct_diagnostic_stages() {
        assert_eq!(FastCtxMode::Native.stage(), "runtime.fastctx_native");
        assert_eq!(
            FastCtxMode::RuntimeBootstrap.stage(),
            "runtime.fastctx_bootstrap"
        );
        assert_eq!(FastCtxMode::RuntimeHost.stage(), "runtime.fastctx_host");
    }

    #[test]
    fn transport_failures_are_classified_separately() {
        assert_eq!(
            classify_fastctx_failure("FastCtx native input failed: unexpected EOF"),
            "fastctx_transport_closed"
        );
        assert_eq!(
            classify_fastctx_failure("The FastCtx control-center connection failed: broken pipe"),
            "fastctx_transport_closed"
        );
        assert_eq!(
            classify_fastctx_failure("FastCtx native tool task failed"),
            "fastctx_process_failed"
        );
    }
}
