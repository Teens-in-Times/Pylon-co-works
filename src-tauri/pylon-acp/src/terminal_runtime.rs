//! Terminal registry seam adapted from codeg's `terminal_runtime.rs`.
//!
//! This module owns terminal instances and their observable lifecycle. Process
//! creation/response wiring is deliberately supplied by the caller; every
//! instance owns the existing `ManagedChild`, so no second process owner is
//! introduced.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::{watch, Mutex, Notify};

use super::terminal_policy::{
    decode_available_utf8, default_platform_shell, output_limit as resolve_output_limit,
    shell_wrapper_args, TerminalCompletion, TerminalOutputBuffer,
};
use super::ManagedChild;

const PROCESS_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

/// Codeg's error-only retry state. A healthy running process has no deadline;
/// after persistent wait errors we publish unknown completion once, but retain
/// the child and keep reaping at the slower idle cadence.
struct WaitRetry {
    deadline: Option<tokio::time::Instant>,
    backoff: std::time::Duration,
    published_unknown: bool,
}

impl Default for WaitRetry {
    fn default() -> Self {
        Self {
            deadline: None,
            backoff: PROCESS_POLL_INTERVAL,
            published_unknown: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub output: String,
    pub output_base_offset: u64,
    pub truncated: bool,
    pub exit_status: Option<super::terminal_policy::TerminalExitStatus>,
}

/// 输出窗口与退出状态共用一个 std 锁：追加是同步短临界区，读快照只需一次性拷贝，
/// 不再从 reader 线程 `block_on` 回异步运行时（#673）。
struct TerminalState {
    output: TerminalOutputBuffer,
    exit_status: Option<super::terminal_policy::TerminalExitStatus>,
}

struct TerminalInstance {
    session_id: String,
    child: Mutex<ManagedChild>,
    state: StdMutex<TerminalState>,
    completion: watch::Sender<TerminalCompletion>,
    reader_handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    kill: Notify,
}

impl TerminalInstance {
    async fn observe_process_status(
        &self,
        status: Result<Option<std::process::ExitStatus>, super::AcpError>,
        retry: &mut WaitRetry,
        now: tokio::time::Instant,
    ) -> Option<std::time::Duration> {
        use super::terminal_policy::{
            next_wait_retry_backoff, WAIT_ERROR_BUDGET, WAIT_ERROR_IDLE_RETRY,
        };
        match status {
            Ok(Some(status)) => {
                if !retry.published_unknown {
                    self.drain_readers().await;
                    self.mark_exited(super::terminal_policy::map_exit_status(status));
                }
                None
            }
            Ok(None) => {
                // try_wait differs from Codeg's blocking wait: None is a
                // successful observation, not another wait error.
                retry.deadline = None;
                retry.backoff = PROCESS_POLL_INTERVAL;
                Some(if retry.published_unknown {
                    WAIT_ERROR_IDLE_RETRY
                } else {
                    PROCESS_POLL_INTERVAL
                })
            }
            Err(error) => {
                let deadline = *retry.deadline.get_or_insert(now + WAIT_ERROR_BUDGET);
                if !retry.published_unknown && now >= deadline {
                    retry.published_unknown = true;
                    tracing::error!(%error, "terminal wait error budget exhausted; owner continues reaping");
                    self.append_output(
                        "\n[terminal exit status unavailable: could not reap the process]\n",
                    );
                    self.drain_readers().await;
                    self.mark_exited(super::terminal_policy::TerminalExitStatus::default());
                }
                if retry.published_unknown {
                    Some(WAIT_ERROR_IDLE_RETRY)
                } else {
                    retry.backoff = next_wait_retry_backoff(retry.backoff);
                    Some(retry.backoff)
                }
            }
        }
    }
    fn new(session_id: String, output_limit: usize, child: ManagedChild) -> Arc<Self> {
        let (completion, _) = watch::channel(TerminalCompletion::Running);
        Arc::new(Self {
            session_id,
            child: Mutex::new(child),
            state: StdMutex::new(TerminalState {
                output: TerminalOutputBuffer::new(output_limit),
                exit_status: None,
            }),
            completion,
            reader_handles: Mutex::new(Vec::new()),
            kill: Notify::new(),
        })
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TerminalState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn append_output(&self, text: &str) {
        self.lock_state().output.append(text);
    }

    fn mark_exited(&self, status: super::terminal_policy::TerminalExitStatus) {
        self.lock_state().exit_status = Some(status.clone());
        let _ = self
            .completion
            .send_replace(TerminalCompletion::Exited(status));
    }

    fn snapshot(&self) -> TerminalSnapshot {
        let state = self.lock_state();
        TerminalSnapshot {
            output: state.output.visible().to_string(),
            output_base_offset: state.output.base_offset(),
            truncated: state.output.truncated(),
            exit_status: state.exit_status.clone(),
        }
    }

    async fn drain_readers(&self) {
        let handles = std::mem::take(&mut *self.reader_handles.lock().await);
        for handle in handles {
            let abort = handle.abort_handle();
            if tokio::time::timeout(super::terminal_policy::READER_DRAIN_GRACE, handle)
                .await
                .is_err()
            {
                abort.abort();
            }
        }
    }

    async fn wait_for_exit(&self) -> Result<super::terminal_policy::TerminalExitStatus, String> {
        let mut completion = self.completion.subscribe();
        loop {
            if let Some(status) = completion.borrow_and_update().exit_status().cloned() {
                return Ok(status);
            }
            completion
                .changed()
                .await
                .map_err(|_| "terminal owner ended without exit status".to_string())?;
        }
    }

    async fn kill(&self) -> Result<(), String> {
        if self.completion.borrow().exit_status().is_some() {
            return Ok(());
        }
        self.kill.notify_one();
        tokio::time::timeout(
            super::terminal_policy::KILL_REPORT_BUDGET,
            self.wait_for_exit(),
        )
        .await
        .map_err(|_| "terminal kill report timed out".to_string())??;
        Ok(())
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    next_id: Mutex<u64>,
    terminals: Mutex<HashMap<String, Arc<TerminalInstance>>>,
}

impl TerminalRegistry {
    pub async fn create_shell(
        &self,
        session_id: String,
        shell: Option<String>,
        line: &str,
        cwd: Option<&Path>,
        output_limit: Option<usize>,
    ) -> Result<String, String> {
        let shell = shell.unwrap_or_else(|| default_platform_shell(None));
        let mut command = std::process::Command::new(&shell);
        command
            .args(shell_wrapper_args(&shell, line))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // #348 A3 + #363-1：terminal 输出走管道、不在用户桌面开控制台窗口；
        // agent 侧 terminal 与 agent 本体同属「agent 子进程」，同享 UTF-8 环境钉死。
        super::process::configure_agent_child(&mut command);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        // #363-2：与 agent 本体同一处置——fork→exec 窗口的 ETXTBSY 在预算内重试。
        let child = super::process::spawn_retrying_exec_busy(|| command.spawn())
            .await
            .map_err(|e| e.to_string())?;
        let mut child = ManagedChild::new(child);
        let stdout = child.take_stdout().map_err(|e| e.to_string())?;
        let stderr = child.take_stderr().map_err(|e| e.to_string())?;
        let limit = resolve_output_limit(output_limit);
        let (id, terminal) = self.insert(session_id, limit, child).await;
        let watcher = terminal.clone();
        tokio::spawn(async move {
            let mut poll_delay = PROCESS_POLL_INTERVAL;
            let mut retry = WaitRetry::default();
            loop {
                tokio::select! {
                    _ = watcher.kill.notified() => {
                        let child = {
                            let mut owned = watcher.child.lock().await;
                            std::mem::replace(&mut *owned, ManagedChild::empty())
                        };
                        let _ = tokio::task::spawn_blocking(move || {
                            let mut child = child;
                            let _ = child.terminate_gracefully();
                            std::thread::sleep(super::terminal_policy::KILL_ESCALATE_GRACE);
                            child.kill_and_wait()
                        }).await;
                        watcher.drain_readers().await;
                        watcher.mark_exited(super::terminal_policy::TerminalExitStatus::default());
                        break;
                    }
                    _ = tokio::time::sleep(poll_delay) => {
                        let status = watcher.child.lock().await.try_wait();
                        match watcher.observe_process_status(status, &mut retry, tokio::time::Instant::now()).await {
                            Some(delay) => poll_delay = delay,
                            None => break,
                        }
                    }
                }
            }
        });
        let stdout_reader = spawn_reader(stdout, terminal.clone());
        let stderr_reader = spawn_reader(stderr, terminal.clone());
        terminal
            .reader_handles
            .lock()
            .await
            .extend([stdout_reader, stderr_reader]);
        Ok(id)
    }

    /// 插入终端并**同时交回实例**（#653）。调用方不得在插入后二次查找：那两次加锁
    /// 之间 `clear()`（`stop_agent_runtime` → 切 Agent / reload / 空闲回收）可能已把
    /// 该终端摘掉，二次查找落空在 release（`panic = "abort"`）下会直接终止进程。
    async fn insert(
        &self,
        session_id: String,
        output_limit: usize,
        child: ManagedChild,
    ) -> (String, Arc<TerminalInstance>) {
        // id 计数锁卫不得跨过 terminals 锁的 await（#414：缩短临界区）。
        let id = {
            let mut next = self.next_id.lock().await;
            *next = next.saturating_add(1);
            format!("terminal-{}", *next)
        };
        let terminal = TerminalInstance::new(session_id, output_limit, child);
        self.terminals
            .lock()
            .await
            .insert(id.clone(), terminal.clone());
        (id, terminal)
    }

    async fn find(&self, id: &str, session_id: &str) -> Result<Arc<TerminalInstance>, String> {
        let terminal = self
            .terminals
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal {id} not found"))?;
        if terminal.session_id != session_id {
            return Err(format!(
                "terminal {id} does not belong to session {session_id}"
            ));
        }
        Ok(terminal)
    }

    pub async fn snapshot(&self, id: &str, session_id: &str) -> Result<TerminalSnapshot, String> {
        Ok(self.find(id, session_id).await?.snapshot())
    }

    pub async fn wait_for_exit(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<super::terminal_policy::TerminalExitStatus, String> {
        self.find(id, session_id).await?.wait_for_exit().await
    }

    pub async fn kill(&self, id: &str, session_id: &str) -> Result<(), String> {
        self.find(id, session_id).await?.kill().await
    }

    pub async fn release(&self, id: &str, session_id: &str) -> Result<(), String> {
        let terminal = self.find(id, session_id).await?;
        self.terminals.lock().await.remove(id);
        terminal.kill().await
    }

    /// #316：终止并清出某会话名下的全部终端（session 关闭/映射移除时调用），
    /// 返回清理数。终端进程是 Pylon 子进程——不清理会在 agent 重启后跨代泄漏。
    pub async fn release_session(&self, session_id: &str) -> usize {
        let owned: Vec<String> = {
            let terminals = self.terminals.lock().await;
            terminals
                .iter()
                .filter(|(_, terminal)| terminal.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &owned {
            // 先在独立作用域内取出再 await：`if let Some(x) = lock().await.remove(..)`
            // 的检视位临时守卫会活过整个分支体（#414：持注册表锁跨 kill().await）。
            let terminal = self.terminals.lock().await.remove(id);
            if let Some(terminal) = terminal {
                let _ = terminal.kill().await;
            }
        }
        owned.len()
    }

    /// #316：清空注册表全部终端（`stop_agent_runtime` 停旧 runtime 时调用），
    /// 返回清理数。
    pub async fn clear(&self) -> usize {
        let ids: Vec<String> = {
            let terminals = self.terminals.lock().await;
            terminals.keys().cloned().collect()
        };
        for id in &ids {
            // 同 release_session：检视位临时守卫不得跨 kill().await（#414）。
            let terminal = self.terminals.lock().await.remove(id);
            if let Some(terminal) = terminal {
                let _ = terminal.kill().await;
            }
        }
        ids.len()
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    terminal: Arc<TerminalInstance>,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut pending = Vec::new();
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = decode_available_utf8(&mut pending);
                    terminal.append_output(&text);
                }
                Err(_) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_policy::TerminalExitStatus;

    async fn insert_exited(registry: &TerminalRegistry, session_id: &str) -> String {
        let (id, terminal) = registry
            .insert(session_id.into(), 1024, ManagedChild::empty())
            .await;
        // 空 child 永远不会退出——预置已退出状态，让 release/clear 的 kill 走
        // 早退路径（测试只关心注册表清点与归属，不关心真实进程）。
        terminal.completion.send_replace(TerminalCompletion::Exited(
            TerminalExitStatus::new().exit_code(0),
        ));
        id
    }

    /// #316：release_session 只清指定会话名下的终端，其余会话不受累。
    #[tokio::test]
    async fn release_session_removes_only_matching_session() {
        let registry = TerminalRegistry::default();
        let a = insert_exited(&registry, "session-a").await;
        let b = insert_exited(&registry, "session-b").await;

        let removed = registry.release_session("session-a").await;
        assert_eq!(removed, 1);
        assert!(registry.snapshot(&a, "session-a").await.is_err());
        assert!(
            registry.snapshot(&b, "session-b").await.is_ok(),
            "其他会话的终端不得被误清"
        );

        let removed_again = registry.release_session("session-a").await;
        assert_eq!(removed_again, 0, "重复释放计数为 0（幂等）");
    }

    /// #316：clear 清空全部会话的终端（runtime 停止时调用）。
    #[tokio::test]
    async fn clear_removes_all_terminals_and_reports_count() {
        let registry = TerminalRegistry::default();
        insert_exited(&registry, "session-a").await;
        insert_exited(&registry, "session-b").await;
        insert_exited(&registry, "session-c").await;

        let removed = registry.clear().await;
        assert_eq!(removed, 3);
        let removed_again = registry.clear().await;
        assert_eq!(removed_again, 0, "重复 clear 计数为 0（幂等）");
    }

    #[tokio::test]
    async fn healthy_long_running_terminal_has_no_error_deadline() {
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        for elapsed in [0, 31, 300, 3600] {
            assert_eq!(
                instance
                    .observe_process_status(
                        Ok(None),
                        &mut retry,
                        now + std::time::Duration::from_secs(elapsed)
                    )
                    .await,
                Some(PROCESS_POLL_INTERVAL)
            );
            assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
            assert!(retry.deadline.is_none());
        }
    }

    #[tokio::test]
    async fn persistent_wait_errors_back_off_then_publish_unknown_once_and_keep_reaping() {
        use super::super::terminal_policy::{
            WAIT_ERROR_BUDGET, WAIT_ERROR_IDLE_RETRY, WAIT_RETRY_MAX_BACKOFF,
        };
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        let failure = || Err(super::super::AcpError::Child("injected wait error".into()));
        let mut previous = PROCESS_POLL_INTERVAL;
        for _ in 0..20 {
            let delay = instance
                .observe_process_status(failure(), &mut retry, now)
                .await
                .unwrap();
            assert!(delay >= previous && delay <= WAIT_RETRY_MAX_BACKOFF);
            previous = delay;
            assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
        }
        let deadline = now + WAIT_ERROR_BUDGET;
        assert_eq!(
            instance
                .observe_process_status(failure(), &mut retry, deadline)
                .await,
            Some(WAIT_ERROR_IDLE_RETRY)
        );
        assert_eq!(
            instance.wait_for_exit().await.unwrap(),
            TerminalExitStatus::default()
        );
        let output = instance.snapshot().output;
        assert!(output.contains("could not reap"));
        assert_eq!(
            instance
                .observe_process_status(failure(), &mut retry, deadline + WAIT_ERROR_IDLE_RETRY)
                .await,
            Some(WAIT_ERROR_IDLE_RETRY)
        );
        assert_eq!(instance.snapshot().output, output);
    }

    #[tokio::test]
    async fn successful_poll_resets_transient_wait_error_budget() {
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        instance
            .observe_process_status(
                Err(super::super::AcpError::Child("transient".into())),
                &mut retry,
                now,
            )
            .await;
        instance
            .observe_process_status(Ok(None), &mut retry, now)
            .await;
        instance
            .observe_process_status(
                Err(super::super::AcpError::Child("later".into())),
                &mut retry,
                now + std::time::Duration::from_secs(60),
            )
            .await;
        assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
        assert_eq!(retry.backoff, PROCESS_POLL_INTERVAL * 2);
    }

    #[tokio::test]
    async fn registry_confines_operations_to_session_owner() {
        let registry = TerminalRegistry::default();
        let (id, _) = registry
            .insert("session-a".into(), 4, ManagedChild::empty())
            .await;
        assert!(registry.snapshot(&id, "session-b").await.is_err());
        let instance = registry.find(&id, "session-a").await.unwrap();
        instance.append_output("abcde");
        let snapshot = registry.snapshot(&id, "session-a").await.unwrap();
        assert_eq!(snapshot.output, "bcde");
        assert_eq!(snapshot.output_base_offset, 1);
    }

    #[tokio::test]
    async fn streaming_output_stays_bounded_and_offsets_advance() {
        let registry = TerminalRegistry::default();
        let (id, instance) = registry
            .insert("session-a".into(), 8192, ManagedChild::empty())
            .await;
        let chunk = "x".repeat(8192);
        for _ in 0..64 {
            instance.append_output(&chunk);
        }
        let snapshot = registry.snapshot(&id, "session-a").await.unwrap();
        assert_eq!(snapshot.output.len(), 8192, "快照窗口恒等于 limit");
        assert_eq!(snapshot.output_base_offset, 63 * 8192);
        assert!(snapshot.truncated);
    }

    /// #653：insert 交出的就是注册表里的同一实例——调用方不再需要二次查找，也就
    /// 不会被并发 `clear()` 挡在「查不到」的那条 panic 路径上。
    #[tokio::test]
    async fn insert_returns_registered_instance() {
        let registry = TerminalRegistry::default();
        let (id, inserted) = registry
            .insert("session-a".into(), 1024, ManagedChild::empty())
            .await;
        let found = registry.find(&id, "session-a").await.unwrap();
        assert!(std::sync::Arc::ptr_eq(&inserted, &found));
    }

    #[tokio::test]
    async fn completion_watch_retains_exit_for_late_waiter() {
        let instance = TerminalInstance::new("session-a".into(), 100, ManagedChild::empty());
        instance.mark_exited(TerminalExitStatus::default());
        assert!(instance.wait_for_exit().await.is_ok());
    }

    #[tokio::test]
    async fn create_shell_drains_output_and_publishes_exit() {
        let registry = TerminalRegistry::default();
        let line = if cfg!(windows) {
            "echo terminal-registry"
        } else {
            "printf terminal-registry"
        };
        let id = registry
            .create_shell("session-a".into(), None, line, None, Some(1024))
            .await
            .unwrap();
        let status = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            registry.wait_for_exit(&id, "session-a"),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(status.exit_code.is_some() || status.signal.is_some());
        let snapshot = registry.snapshot(&id, "session-a").await.unwrap();
        assert!(snapshot.output.contains("terminal-registry"));
    }

    #[tokio::test]
    async fn kill_routes_through_owner_and_release_removes_terminal() {
        let registry = TerminalRegistry::default();
        let line = if cfg!(windows) {
            "ping -n 10 127.0.0.1 > nul"
        } else {
            "sleep 10"
        };
        let id = registry
            .create_shell("session-a".into(), None, line, None, Some(1024))
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            registry.kill(&id, "session-a"),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(registry.release(&id, "session-a").await.is_ok());
        assert!(registry.snapshot(&id, "session-a").await.is_err());
    }
}
