//! Upstream terminal runtime limits. Execution and process ownership remain in
//! Pylon's existing terminal boundary.

pub use agent_client_protocol_schema::v1::TerminalExitStatus;
use std::time::Duration;

pub const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1_000_000;
pub const READER_DRAIN_GRACE: Duration = Duration::from_millis(200);
pub const KILL_ESCALATE_GRACE: Duration = Duration::from_secs(2);
pub const KILL_REPORT_BUDGET: Duration = Duration::from_secs(5);
pub const WAIT_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(1);
pub const WAIT_ERROR_BUDGET: Duration = Duration::from_secs(30);
pub const WAIT_ERROR_IDLE_RETRY: Duration = Duration::from_secs(5);

pub fn next_wait_retry_backoff(current: Duration) -> Duration {
    let next = current.checked_mul(2).unwrap_or(WAIT_RETRY_MAX_BACKOFF);
    next.min(WAIT_RETRY_MAX_BACKOFF)
}

/// Codeg's observable terminal completion has exactly two states.  A failed
/// wait is not exposed as a third state: without a known exit status callers
/// would treat it as still running and hang forever.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalCompletion {
    Running,
    Exited(TerminalExitStatus),
}

impl TerminalCompletion {
    pub fn exit_status(&self) -> Option<&TerminalExitStatus> {
        match self {
            Self::Running => None,
            Self::Exited(status) => Some(status),
        }
    }
}

pub fn map_exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    let signal =
        std::os::unix::process::ExitStatusExt::signal(&status).map(|value| value.to_string());
    #[cfg(not(unix))]
    let signal = None;
    TerminalExitStatus::new()
        .exit_code(status.code().and_then(|value| u32::try_from(value).ok()))
        .signal(signal)
}

pub fn output_limit(requested: Option<usize>) -> usize {
    requested.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT as usize)
}

/// 有界终端输出缓冲：可见窗口 `text[head..]` 恒 ≤ limit（不切断 UTF-8）。
/// 追加只推进 `head`；已截断的前缀累计到 ≥ limit 才压缩一次，把旧实现
/// 「每来一块就把整个 limit 窗口 memmove 一次」摊还成 O(1)/字节（#673）。
#[derive(Debug)]
pub struct TerminalOutputBuffer {
    text: String,
    head: usize,
    limit: usize,
    base_offset: u64,
    truncated: bool,
}

impl TerminalOutputBuffer {
    pub fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            head: 0,
            limit,
            base_offset: 0,
            truncated: false,
        }
    }

    pub fn append(&mut self, text: &str) {
        self.text.push_str(text);
        let visible = self.text.len() - self.head;
        if visible <= self.limit {
            return;
        }
        let mut start = self.head + (visible - self.limit);
        while start < self.text.len() && !self.text.is_char_boundary(start) {
            start += 1;
        }
        self.base_offset = self.base_offset.saturating_add((start - self.head) as u64);
        self.head = start;
        self.truncated = true;
        if self.head >= self.limit {
            self.text.drain(..self.head);
            self.head = 0;
        }
    }

    pub fn visible(&self) -> &str {
        &self.text[self.head..]
    }

    pub fn base_offset(&self) -> u64 {
        self.base_offset
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

/// Decode complete UTF-8 while retaining an incomplete trailing sequence for
/// the next pipe read; invalid complete bytes use lossy replacement.
pub fn decode_available_utf8(pending: &mut Vec<u8>) -> String {
    let mut output = String::new();
    let mut consumed = 0usize;
    let mut remaining = pending.as_slice();
    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                output.push_str(text);
                consumed += remaining.len();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&remaining[..valid]).unwrap());
                    consumed += valid;
                    remaining = &remaining[valid..];
                }
                match error.error_len() {
                    Some(length) => {
                        output.push_str(&String::from_utf8_lossy(&remaining[..length]));
                        consumed += length;
                        remaining = &remaining[length..];
                    }
                    None => break,
                }
            }
        }
    }
    pending.drain(..consumed);
    output
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    PowerShell,
    Cmd,
    Posix,
}

pub fn classify_shell_family(shell: &str) -> ShellFamily {
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    if name.contains("pwsh") || name.contains("powershell") {
        ShellFamily::PowerShell
    } else if name == "cmd" || name == "cmd.exe" {
        ShellFamily::Cmd
    } else {
        #[cfg(target_os = "windows")]
        {
            if name.contains("bash")
                || name.contains("zsh")
                || name.contains("fish")
                || name.ends_with("sh.exe")
            {
                ShellFamily::Posix
            } else {
                ShellFamily::Cmd
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            ShellFamily::Posix
        }
    }
}

pub fn default_platform_shell(comspec: Option<String>) -> String {
    #[cfg(windows)]
    {
        comspec
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        let _ = comspec;
        "/bin/sh".into()
    }
}

/// Arguments for codeg's shell wrapper. The command line remains one argv
/// element; callers must pass it to their existing process boundary.
pub fn shell_wrapper_args(shell: &str, line: &str) -> Vec<String> {
    match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            line.into(),
        ],
        ShellFamily::Cmd => vec!["/D".into(), "/S".into(), "/C".into(), line.into()],
        ShellFamily::Posix => vec!["-c".into(), line.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_terminal_limits_and_default_are_stable() {
        assert_eq!(output_limit(None), 1_000_000);
        assert_eq!(output_limit(Some(123)), 123);
        assert_eq!(READER_DRAIN_GRACE, Duration::from_millis(200));
        assert_eq!(KILL_ESCALATE_GRACE, Duration::from_secs(2));
        assert_eq!(KILL_REPORT_BUDGET, Duration::from_secs(5));
        assert_eq!(WAIT_ERROR_BUDGET, Duration::from_secs(30));
    }

    #[test]
    fn output_keeps_newest_utf8_and_decoder_keeps_partial_bytes() {
        let mut output = TerminalOutputBuffer::new(8);
        output.append("old-😀-new");
        assert_eq!(output.visible(), "😀-new");
        assert!(output.truncated());
        assert_eq!(output.base_offset(), 4);
        let mut pending = vec![0xf0, 0x9f];
        assert_eq!(decode_available_utf8(&mut pending), "");
        pending.extend([0x98, 0x80, b'!']);
        assert_eq!(decode_available_utf8(&mut pending), "😀!");
    }

    #[test]
    fn output_buffer_keeps_window_bounded_and_offsets_contiguous() {
        let limit = 16;
        let chunk = "0123456789abcdef";
        let mut output = TerminalOutputBuffer::new(limit);
        for _ in 0..1000 {
            output.append(chunk);
            assert!(output.visible().len() <= limit, "可见窗口恒 ≤ limit");
        }
        assert_eq!(output.visible(), chunk, "保留最新一块");
        assert_eq!(output.base_offset(), 1000 * chunk.len() as u64 - 16);
        assert!(output.truncated());
    }

    #[test]
    fn shell_wrapper_preserves_one_argument_command_shape() {
        assert_eq!(
            classify_shell_family("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            ShellFamily::PowerShell
        );
        assert_eq!(
            shell_wrapper_args("cmd.exe", "echo hi"),
            vec!["/D", "/S", "/C", "echo hi"]
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            shell_wrapper_args("/bin/sh", "printf hi"),
            vec!["-c", "printf hi"]
        );
        #[cfg(target_os = "windows")]
        assert_eq!(
            shell_wrapper_args("sh.exe", "printf hi"),
            vec!["-c", "printf hi"]
        );
    }

    #[test]
    fn exit_status_dto_preserves_unknown_code_and_signal_shape() {
        let status = TerminalExitStatus::default();
        assert_eq!(serde_json::to_value(status).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn default_shell_is_deterministic_without_environment() {
        #[cfg(windows)]
        assert_eq!(default_platform_shell(None), "cmd.exe");
        #[cfg(not(windows))]
        assert_eq!(default_platform_shell(None), "/bin/sh");
        assert_eq!(
            classify_shell_family(&default_platform_shell(None)),
            if cfg!(windows) {
                ShellFamily::Cmd
            } else {
                ShellFamily::Posix
            }
        );
    }

    #[test]
    fn wait_retry_backoff_doubles_and_caps() {
        assert_eq!(
            next_wait_retry_backoff(Duration::from_millis(10)),
            Duration::from_millis(20)
        );
        assert_eq!(
            next_wait_retry_backoff(Duration::from_millis(600)),
            WAIT_RETRY_MAX_BACKOFF
        );
        assert_eq!(
            next_wait_retry_backoff(WAIT_RETRY_MAX_BACKOFF),
            WAIT_RETRY_MAX_BACKOFF
        );
    }

    #[test]
    fn completion_has_only_running_or_known_exit_status() {
        let running = TerminalCompletion::Running;
        assert!(running.exit_status().is_none());
        let exited = TerminalCompletion::Exited(TerminalExitStatus::default());
        assert!(exited.exit_status().is_some());
    }
}
