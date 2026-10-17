//! Codex traffic capture adapter. Windows uses WinDivert and mitmproxy's TCP/IP
//! engine. Pool selection, credentials and chain policy stay in CodeyX.

pub mod protocol;
#[cfg(any(feature = "capture", test))]
mod socks;

#[cfg(windows)]
pub mod client;

#[cfg(all(windows, feature = "capture"))]
mod windows;

#[cfg(all(windows, feature = "capture"))]
pub use windows::run;
