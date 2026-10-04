//! Git 接口（B5）：固定 runner → 只读查询 + 受限写操作。
//!
//! 安全面：
//! - 命令以参数数组执行（无 shell 拼接，防注入）
//! - 固定 cwd（调用方传入已校验的工作区 root）
//! - diff 的 path 参数做相对路径 + containment 校验（复用 workspace 语义）
//! - 输出截断（diff 256KB / status 2000 条 / history 200 条）
//! - 输出有界（G5-4）：读任务分块 drain，stdout 只保留前 MAX_READ_BYTES（16MB）、
//!   stderr 保留前 64KB；超限继续读入丢弃直到 EOF（防 git 阻塞写管道 = A1 不回归、
//!   防 EPIPE 误报失败），内存有界、超限保留头部（E17：截断标记文案不变）
//! - tokio process + 超时（大仓库防挂起）
//! - 非 git 仓库 / git 不可用 → 明确错误（code=git_error）
//! - 写操作只开放 stage/unstage/commit/branch/pull/push；不提供 reset、force push、
//!   forced checkout，且禁止交互式凭据提示

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::child_command::HideConsoleWindow;

/// diff 输出上限（字节）。
pub const MAX_DIFF_BYTES: usize = 256 * 1024;
/// 0-C2：git_show_file 输出上限（两版本文本数据面）。// 1MB
pub const MAX_SHOW_FILE_BYTES: usize = 1024 * 1024;
/// status 条目上限。
pub const MAX_STATUS_ENTRIES: usize = 2000;
/// history 条数上限。
pub const MAX_HISTORY: usize = 200;
/// git 命令超时。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// pull/push 允许更长的本地/网络传输时间，但仍保持有界。
pub const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
/// G5-4：stdout 读取保留上限——超大 diff/status 只保留头部，其余继续读入丢弃。
/// pub（新测试引用）；≥ MAX_DIFF_BYTES 且覆盖巨型 diff 首段（E17：16MB 上限远超现实场景）。
pub const MAX_READ_BYTES: usize = 16 * 1024 * 1024;
/// G5-4：stderr 读取保留上限（64KB > 512 字节错误截断点）。
const MAX_STDERR_KEEP_BYTES: usize = 64 * 1024;
/// G5-4：读任务单次 read 分块大小。
const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    /// porcelain 状态码（如 " M"/"A "/"??"；v2 的 '.' 归一为空格，与 v1 wire 兼容）。
    pub status: String,
    /// 是否已暂存（索引区变更）。
    pub staged: bool,
}

/// ISSUE-15 W1：分支信息（porcelain v2 `--branch` header 解析）。
/// detached HEAD → `branch.head (detached)`；无提交（unborn）→ `branch.oid (initial)`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    /// 当前分支名；detached HEAD 时为 None。
    pub branch: Option<String>,
    /// HEAD 是否处于 detached 状态。
    pub detached: bool,
    /// HEAD commit 完整 oid；无任何提交时为 None。
    pub head: Option<String>,
}

/// ISSUE-15 W1：`git status --porcelain=v2 -z --branch` 的完整结果（branch + entries）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: GitBranchInfo,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    /// Unix 秒时间戳（前端自行格式化）。
    pub date: String,
    pub subject: String,
}

/// 写操作统一回执：摘要供 UI 反馈，最新 status 供调用方原子刷新。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub summary: String,
    pub status: GitStatusResult,
}

fn is_git_error(stderr: &str) -> bool {
    stderr.contains("not a git repository") || stderr.contains("Not a git repository")
}

/// G5-4：有界 drain——分块读取，只保留前 keep_bytes，超限继续读入并丢弃直到 EOF。
/// 禁止用 `tokio::io::take` 提前关流：take 达上限即关闭读端，git 继续写管道会
/// EPIPE/SIGPIPE（写失败），超限输出被误报为"git 命令失败"；本循环读到 EOF，
/// 管道始终被消费（不回归 A1 管道缓冲死锁），内存有界（保留上限 + 分块缓冲）。
async fn drain_bounded<R>(out: &mut R, keep_bytes: usize) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(keep_bytes.min(8192));
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        match tokio::io::AsyncReadExt::read(out, &mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < keep_bytes {
                    let keep = n.min(keep_bytes - buf.len());
                    buf.extend_from_slice(&chunk[..keep]);
                }
            }
            Err(_) => break,
        }
    }
    buf
}

async fn run_git_with_timeout(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(String, String), String> {
    run_git_with_timeout_env(cwd, args, timeout, None).await
}

/// P91 批 C1（横切 §4）：`host_env` 参数化变体——在**子进程内**注入模拟宿主环境
/// （Command env），供 locale 契约测试使用；本进程全局 env 不再被 `set_var` 变异
/// （进程级操作与并行测试竞态）。应用顺序：先 host_env、后固定 LC_ALL/LANG=C
/// 覆盖，与生产 env 语义一致（固定 C locale 压过宿主 locale）；生产入口
/// [`run_git_with_timeout`] 恒传 `None`（行为不变）。
async fn run_git_with_timeout_env(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    host_env: Option<&[(&str, &str)]>,
) -> Result<(String, String), String> {
    let probe = run_git_probe_with_timeout(cwd, args, timeout, host_env).await?;
    if probe.code == Some(0) {
        return Ok((probe.stdout, probe.stderr));
    }
    let detail = if probe.stderr.trim().is_empty() {
        probe.stdout.trim()
    } else {
        probe.stderr.trim()
    };
    let detail = detail.chars().take(512).collect::<String>();
    Err(if is_git_error(&probe.stderr) {
        format!("not a git repository: {detail}")
    } else {
        format!("git 命令失败 ({detail})")
    })
}

/// exit-code 有界探针：同一 runner 纪律（参数数组、固定 cwd、C locale、
/// `GIT_TERMINAL_PROMPT=0`、超时 kill、有界 drain），但不做成功/失败折叠——
/// `merge-base --is-ancestor` / `diff --quiet` 以退出码 0/1 编码布尔答案，
/// 折叠语义会把「1 = 否」误作失败丢弃。退出码语义由调用方解释。
async fn run_git_probe_with_timeout(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    host_env: Option<&[(&str, &str)]>,
) -> Result<GitProbe, String> {
    // 审查修复：超时必须 kill 子进程（Command::output 默认 kill_on_drop=false，
    // 超时后 git 会滞留并占用 index 锁）。
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    // #361：发行构建是 GUI 子系统，git 这类 console 子进程不加 CREATE_NO_WINDOW
    // 会各自弹出一个可见控制台窗口（本函数在 workbench 里是热路径）。
    cmd.hide_console_window();
    if let Some(host_env) = host_env {
        for (key, value) in host_env {
            cmd.env(key, value);
        }
    }
    cmd
        // G5-5：固定 C locale——is_git_error 依赖英文文案（"not a git
        // repository"），宿主 locale（如 zh_CN）下 git 输出本地化文案会误判普通
        // 失败（message 语义漂移）。只覆盖 LC_ALL/LANG 两个变量，不 env_clear
        // （保留 PATH 等）；Windows 无 locale 变量时零影响。放在 host_env 之后
        // 以保证固定值压过模拟宿主值（与生产 env 语义一致）。
        .env("LC_ALL", "C")
        .env("LANG", "C")
        // 写操作不能弹出终端/GCM 凭据窗口；缺少凭据时明确失败并交给 UI 展示。
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("git 不可用: {error}"))?;
    // A1 死锁修复（2026-08-02）：wait 之前必须真正并发读 stdout/stderr。原实现
    // 把读管道写成 async 块，只在 wait 返回后才 join——两个读 future 在子进程
    // 运行期间从未被 poll，输出超过 OS 管道缓冲（Windows 默认 4096B）时子进程
    // 阻塞在 write 上永不退出 → 必现 10s 超时。这里 take 出管道句柄后用
    // tokio::spawn 启动两个读任务与 wait 并发消费（各自 5s 超时防挂死，
    // 进程退出即 EOF），读任务返回 Vec<u8> 而非共享缓冲。
    // G5-4：读任务从 read_to_end（内存无界，大仓库可 GB 级）改为手动 drain 循环
    // （drain_bounded）：stdout 只保留前 MAX_READ_BYTES、stderr 保留前
    // MAX_STDERR_KEEP_BYTES，超限继续读入丢弃直到 EOF——禁止 take 提前关流
    // （git EPIPE → 误报失败），管道始终被消费（A1 不回归）。
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read_stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout.as_mut() {
            tokio::time::timeout(Duration::from_secs(5), drain_bounded(out, MAX_READ_BYTES))
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    });
    let read_stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr.as_mut() {
            tokio::time::timeout(
                Duration::from_secs(5),
                drain_bounded(err, MAX_STDERR_KEEP_BYTES),
            )
            .await
            .unwrap_or_default()
        } else {
            Vec::new()
        }
    });
    // 审查修复：超时必须 kill 子进程（Command::output 默认 kill_on_drop=false，
    // 超时后 git 会滞留并占用 index 锁）。
    let status = match tokio::time::timeout(timeout, async {
        let status = child
            .wait()
            .await
            .map_err(|error| format!("git 命令失败: {error}"))?;
        Ok::<std::process::ExitStatus, String>(status)
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("git 命令超时".to_string());
        }
    };
    let stdout_bytes = read_stdout_task.await.unwrap_or_default();
    let stderr_bytes = read_stderr_task.await.unwrap_or_default();
    Ok(GitProbe {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
    })
}

/// [`run_git_probe_with_timeout`] 的返回：退出码 + 两路输出（有界）。
struct GitProbe {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<(String, String), String> {
    run_git_with_timeout(cwd, args, GIT_TIMEOUT).await
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("至少选择一个文件".to_string());
    }
    if paths.len() > MAX_STATUS_ENTRIES {
        return Err(format!("单次最多处理 {MAX_STATUS_ENTRIES} 个文件"));
    }
    if let Some(path) = paths
        .iter()
        .find(|path| !crate::workspace::is_safe_relative_path(path))
    {
        return Err(format!("Git path 必须是相对路径且不能穿越: {path}"));
    }
    Ok(())
}

fn operation_summary(stdout: &str, fallback: &str) -> String {
    let summary = stdout.trim();
    if summary.is_empty() {
        return fallback.to_string();
    }
    summary.chars().take(2048).collect()
}

async fn operation_result(
    cwd: &Path,
    stdout: &str,
    fallback: &str,
) -> Result<GitOperationResult, String> {
    Ok(GitOperationResult {
        summary: operation_summary(stdout, fallback),
        status: git_status(cwd).await?,
    })
}

/// porcelain v1 的 XY 码转 v2（'.' 表示"无变更"）→ v1 空格表示，保持 wire 兼容。
fn normalize_status_code(xy: &str) -> String {
    xy.chars().map(|c| if c == '.' { ' ' } else { c }).collect()
}

/// porcelain v2 -z 记录（NUL 分隔）的普通条目：`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`。
/// 路径可能含空格 → splitn 限制字段数，末段整体作为路径。
fn parse_regular_entry(rest: &str) -> Option<(String, bool, String)> {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path))
}

/// rename/copy 条目：`2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <dst>\0<src>\0`。
/// 返回路径（目标）与"下一记录为 src、需跳过"标记。
fn parse_rename_entry(rest: &str) -> Option<(String, bool, String, bool)> {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path, true))
}

/// unmerged 条目：`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`。
fn parse_unmerged_entry(rest: &str) -> Option<(String, bool, String)> {
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next()?;
    let path = parts.last().unwrap_or("").to_string();
    if path.is_empty() {
        return None;
    }
    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    Some((normalize_status_code(xy), staged, path))
}

/// porcelain v2 -z 解析（纯函数，可注入合成输入单测）。
/// 记录以 NUL 分隔；header `# branch.oid <oid>` / `# branch.head <name>`；
/// 条目 `1`/`2`/`u`/`?`/`!`。路径永不加引号：修复 v1 下含符号路径被 C-quote 的失真，
/// 以及 `line[3..].split(" -> ")` 对文件名含 ` -> ` 的误切分。状态码重建为 v1 兼容
/// 两字符（'.' → 空格；untracked/ignored 为 "??"/"!!"）。
fn parse_status_v2(input: &str) -> GitStatusResult {
    let mut branch = GitBranchInfo {
        branch: None,
        detached: false,
        head: None,
    };
    let mut entries = Vec::new();
    let records: Vec<&str> = input.split('\0').collect();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.oid ") {
            let oid = rest.trim();
            // unborn 分支（无任何提交）的占位 oid 不构成真实 head
            branch.head = (oid != "(initial)").then(|| oid.to_string());
            continue;
        }
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            let name = rest.trim();
            if name == "(detached)" {
                branch.branch = None;
                branch.detached = true;
            } else {
                branch.branch = Some(name.to_string());
            }
            continue;
        }
        if entries.len() >= MAX_STATUS_ENTRIES {
            // 超限仍须消费 rename 的 src 记录，避免把 src 误解析成独立条目
            if record.starts_with("2 ") {
                i += 1;
            }
            continue;
        }
        let parsed = if let Some(rest) = record.strip_prefix("? ") {
            Some(("??".to_string(), false, rest.to_string(), false))
        } else if let Some(rest) = record.strip_prefix("! ") {
            Some(("!!".to_string(), false, rest.to_string(), false))
        } else if let Some(rest) = record.strip_prefix("1 ") {
            parse_regular_entry(rest).map(|(s, st, p)| (s, st, p, false))
        } else if let Some(rest) = record.strip_prefix("2 ") {
            parse_rename_entry(rest)
        } else if let Some(rest) = record.strip_prefix("u ") {
            parse_unmerged_entry(rest).map(|(s, st, p)| (s, st, p, false))
        } else {
            None
        };
        let Some((status_code, staged, path, skip_source)) = parsed else {
            continue;
        };
        if skip_source {
            i += 1;
        }
        entries.push(GitStatusEntry {
            path,
            status: status_code,
            staged,
        });
    }
    GitStatusResult { branch, entries }
}

/// 工作区变更列表 + 分支信息（ISSUE-15 W1）：`git status --porcelain=v2 -z --branch`。
/// - v2 -z 以 NUL 分隔、路径永不加引号：修复 v1 下含符号（如 U+2192）路径被
///   C-quote 成 `"a → b.txt"` 导致的路径失真，以及文件名含 ` -> ` 的误切分。
/// - `--branch` header 在同一进程返回 `# branch.oid` / `# branch.head`
///   （detached 为 `(detached)`、无提交时为 `(initial)`），供 GitPanel 展示。
pub async fn git_status(cwd: &Path) -> Result<GitStatusResult, String> {
    let (stdout, _) = run_git(cwd, &["status", "--porcelain=v2", "-z", "--branch"]).await?;
    Ok(parse_status_v2(&stdout))
}

/// 工作区/暂存区 diff：staged=true → `git diff --cached`；否则 `git diff`。
/// path 可选（必须相对且不穿越）。输出截断 MAX_DIFF_BYTES。
pub async fn git_diff(cwd: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path {
        if !crate::workspace::is_safe_relative_path(path) {
            return Err("diff path 必须是相对路径且不能穿越".to_string());
        }
        args.push("--");
        args.push(path);
    }
    let (stdout, _) = run_git(cwd, &args).await?;
    if stdout.len() <= MAX_DIFF_BYTES {
        return Ok(stdout);
    }
    let mut end = MAX_DIFF_BYTES.saturating_sub(3);
    while end > 0 && !stdout.is_char_boundary(end) {
        end -= 1;
    }
    Ok(format!(
        "{}...（diff 超过 {MAX_DIFF_BYTES} 字节已截断）",
        &stdout[..end]
    ))
}

/// 0-C2（issue #288）：rev 白名单——commit hash（7-40 位 hex）/ HEAD（含 ~N 后缀）/
/// index stage（:0-:3，冲突流 ours/theirs/base 读取）。rev 恒作为单参数传给 git
/// （防选项注入），本谓词在调用侧先行拒绝非法形态，不依赖 git 自身拒绝。
pub fn is_safe_rev(rev: &str) -> bool {
    if let Some(stripped) = rev.strip_prefix(':') {
        return matches!(stripped, "0" | "1" | "2" | "3");
    }
    if rev == "HEAD" {
        return true;
    }
    if let Some(depth) = rev.strip_prefix("HEAD~") {
        return !depth.is_empty() && depth.bytes().all(|b| b.is_ascii_digit());
    }
    let hex_only = !rev.is_empty()
        && rev.len() <= 40
        && rev
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'));
    hex_only && rev.len() >= 7
}

/// 0-C2：单文件两版本全文（diff 前端化与冲突流的数据面）。输出有界
/// MAX_SHOW_FILE_BYTES（超限截断，口径同 git_diff）。
pub async fn git_show_file(cwd: &Path, rev: &str, path: &str) -> Result<String, String> {
    if !is_safe_rev(rev) {
        return Err("rev 必须是 7-40 位 hash、HEAD(~N) 或 :0-:3 stage".to_string());
    }
    if !crate::workspace::is_safe_relative_path(path) {
        return Err("show path 必须是相对路径且不能穿越".to_string());
    }
    let (stdout, _) = run_git(cwd, &["show", &format!("{rev}:{path}")]).await?;
    if stdout.len() <= MAX_SHOW_FILE_BYTES {
        return Ok(stdout);
    }
    let mut end = MAX_SHOW_FILE_BYTES.saturating_sub(3);
    while end > 0 && !stdout.is_char_boundary(end) {
        end -= 1;
    }
    Ok(format!(
        "{}...（文件超过 {MAX_SHOW_FILE_BYTES} 字节已截断）",
        &stdout[..end]
    ))
}

/// 0-C2：merge/rebase/cherry-pick 进行态 + 冲突文件清单（GitPanel 横幅与冲突流入口）。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitSequenceState {
    /// "none" | "rebase" | "merge" | "cherry-pick"
    pub kind: String,
    /// status unmerged 条目派生（UU/AA/DD 及含 U 的双字码）。
    pub conflicts: Vec<String>,
}

/// 0-C2：rebase/merge/cherry-pick 进行态探测——`.git` 元数据文件存在性
/// （rebase-merge/rebase-apply/MERGE_HEAD/CHERRY_PICK_HEAD）。
pub async fn git_sequence_state(cwd: &Path) -> Result<GitSequenceState, String> {
    let (stdout, _) = run_git(cwd, &["rev-parse", "--git-dir"]).await?;
    let git_dir = PathBuf::from(stdout.trim());
    let git_dir = if git_dir.is_absolute() {
        git_dir
    } else {
        cwd.join(git_dir)
    };
    let exists = |rel: &str| git_dir.join(rel).exists();
    let kind = if exists("rebase-merge") || exists("rebase-apply") {
        "rebase"
    } else if exists("MERGE_HEAD") {
        "merge"
    } else if exists("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else {
        "none"
    };
    let conflicts = if kind == "none" {
        Vec::new()
    } else {
        let status = git_status(cwd).await?;
        status
            .entries
            .iter()
            .filter(|entry| {
                let code = entry.status.as_bytes();
                matches!(entry.status.as_str(), "AA" | "DD")
                    || code.first().is_some_and(|b| *b == b'U')
                    || code.get(1).is_some_and(|b| *b == b'U')
            })
            .map(|entry| entry.path.clone())
            .collect()
    };
    Ok(GitSequenceState {
        kind: kind.to_string(),
        conflicts,
    })
}

/// 提交历史：`git log --format=%H%x00%an%x00%at%x00%s`（NUL 分隔字段，行分隔 commit）。
/// 审查修复：limit=0 返回空列表（原实现 max(1) 会错误返回 1 条）。
pub async fn git_history(cwd: &Path, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let limit = match limit {
        Some(0) => return Ok(Vec::new()),
        Some(n) => n.min(MAX_HISTORY),
        None => 50,
    };
    let format = "%H%x00%an%x00%at%x00%s";
    let (stdout, _) = match run_git(
        cwd,
        &["log", &format!("-n{limit}"), &format!("--format={format}")],
    )
    .await
    {
        Ok(result) => result,
        // 空仓库（无任何 commit）视为空历史，而非错误
        Err(error) if error.contains("does not have any commits") => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut commits = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\0');
        let (hash, author, date, subject) = (
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
            fields.next().unwrap_or("").to_string(),
        );
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash,
            author,
            date,
            subject,
        });
        if commits.len() >= limit {
            break;
        }
    }
    Ok(commits)
}

/// 将选定的工作区相对路径加入 index。参数通过 `--` 与 git 选项隔离。
pub async fn git_stage(cwd: &Path, paths: &[String]) -> Result<GitOperationResult, String> {
    validate_paths(paths)?;
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    let (stdout, _) = run_git(cwd, &args).await?;
    operation_result(cwd, &stdout, "已暂存所选文件").await
}

/// 从 index 撤销暂存，但保留工作区内容。
///
/// 有 HEAD 时使用 `restore --staged`；unborn 仓库没有可 restore 的 tree，改用
/// `rm --cached --ignore-unmatch`。两条路径都不暴露 reset，也不删除工作区文件。
pub async fn git_unstage(cwd: &Path, paths: &[String]) -> Result<GitOperationResult, String> {
    validate_paths(paths)?;
    let has_head = git_status(cwd).await?.branch.head.is_some();
    let mut args = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        vec!["rm", "--cached", "--ignore-unmatch", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    let (stdout, _) = run_git(cwd, &args).await?;
    operation_result(cwd, &stdout, "已取消暂存所选文件").await
}

/// 提交当前 index。只接受显式非空 message，不打开编辑器。
pub async fn git_commit(cwd: &Path, message: &str) -> Result<GitOperationResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交说明不能为空".to_string());
    }
    if message.chars().count() > 10_000 {
        return Err("提交说明不能超过 10000 个字符".to_string());
    }
    let (stdout, _) = run_git(cwd, &["commit", "-m", message]).await?;
    operation_result(cwd, &stdout, "提交成功").await
}

async fn validate_branch_name(cwd: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 255 || name.starts_with('-') {
        return Err("分支名无效".to_string());
    }
    run_git(cwd, &["check-ref-format", "--branch", name])
        .await
        .map_err(|_| "分支名无效".to_string())?;
    Ok(name.to_string())
}

/// 创建并切换到新分支；不提供覆盖已有分支的 `-C` 或强制 checkout。
pub async fn git_create_branch(cwd: &Path, name: &str) -> Result<GitOperationResult, String> {
    let name = validate_branch_name(cwd, name).await?;
    let (stdout, _) = run_git(cwd, &["switch", "-c", &name]).await?;
    operation_result(cwd, &stdout, "已创建并切换分支").await
}

/// 切换到已有本地分支；不提供 `--force`、`--discard-changes` 等破坏性参数。
pub async fn git_switch_branch(cwd: &Path, name: &str) -> Result<GitOperationResult, String> {
    let name = validate_branch_name(cwd, name).await?;
    let (stdout, _) = run_git(cwd, &["switch", "--", &name]).await?;
    operation_result(cwd, &stdout, "已切换分支").await
}

/// 从当前分支配置的 upstream 拉取，仅允许 fast-forward，避免隐式 merge commit。
pub async fn git_pull(cwd: &Path) -> Result<GitOperationResult, String> {
    let (stdout, _) =
        run_git_with_timeout(cwd, &["pull", "--ff-only"], GIT_NETWORK_TIMEOUT).await?;
    operation_result(cwd, &stdout, "已经是最新版本").await
}

/// 推送当前分支到已配置的 upstream。不提供 `--force` / `--force-with-lease`。
pub async fn git_push(cwd: &Path) -> Result<GitOperationResult, String> {
    let (stdout, stderr) = run_git_with_timeout(cwd, &["push"], GIT_NETWORK_TIMEOUT).await?;
    let output = if stdout.trim().is_empty() {
        stderr.as_str()
    } else {
        stdout.as_str()
    };
    operation_result(cwd, output, "推送完成").await
}

// ── #368：stash 三件套 ───────────────────────────────────────────────────

/// stash 条目上限（与 history 同数量级的有界口径）。
pub const MAX_STASH_ENTRIES: usize = 200;

/// stash 条目（git_stash_list 响应）。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    /// stash ref 形态（`stash@{0}`，%gd）。
    pub id: String,
    /// 一行说明（%gs，reflog 原始 subject）。
    pub subject: String,
}

/// stash 回执摘要：优先 stdout；git 把 "No local changes to save" 这类
/// 退出 0 的提示写到 stderr——stdout 为空时以 stderr 为准，而非笼统 fallback。
fn stash_summary(stdout: &str, stderr: &str, fallback: &str) -> String {
    let summary = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    if summary.is_empty() {
        return fallback.to_string();
    }
    summary.chars().take(2048).collect()
}

/// stash 清单：`git stash list --format=%gd%x00%gs`（NUL 分隔，行分隔条目）。
/// 空 stash 是空列表而非错误（与 history 的空仓库口径一致）。
pub async fn git_stash_list(cwd: &Path) -> Result<Vec<GitStashEntry>, String> {
    let (stdout, _) = run_git(cwd, &["stash", "list", "--format=%gd%x00%gs"]).await?;
    let mut stashes = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\0');
        let (Some(id), Some(subject)) = (fields.next(), fields.next()) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if stashes.len() >= MAX_STASH_ENTRIES {
            break;
        }
        stashes.push(GitStashEntry {
            id: id.to_string(),
            subject: subject.to_string(),
        });
    }
    Ok(stashes)
}

/// 贮藏工作区与 index。message 省略时由 git 生成默认说明（"WIP on <branch>…"）；
/// include_untracked 对应 `-u`（untracked 文件一并入栈）。
pub async fn git_stash_push(
    cwd: &Path,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<GitOperationResult, String> {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(message) = message {
        if message.chars().count() > 10_000 {
            return Err("贮藏说明不能超过 10000 个字符".to_string());
        }
        args.extend(["-m", message]);
    }
    let (stdout, stderr) = run_git(cwd, &args).await?;
    let summary = stash_summary(&stdout, &stderr, "已贮藏工作区变更");
    Ok(GitOperationResult {
        summary,
        status: git_status(cwd).await?,
    })
}

/// 弹出指定 stash（默认栈顶 index=0）并恢复为工作区变更；pop 产生冲突时
/// stash 保留（git 语义），错误经 runner 折叠返回给 UI 展示。
pub async fn git_stash_pop(cwd: &Path, index: usize) -> Result<GitOperationResult, String> {
    if index >= MAX_STASH_ENTRIES {
        return Err(format!("stash 索引超出范围（0..{MAX_STASH_ENTRIES}）"));
    }
    let (stdout, stderr) = run_git(cwd, &["stash", "pop", &format!("stash@{{{index}}}")]).await?;
    let summary = stash_summary(&stdout, &stderr, "已恢复贮藏的变更");
    Ok(GitOperationResult {
        summary,
        status: git_status(cwd).await?,
    })
}

// ── #368：删分支（未落地工作保护 + 比较删除）────────────────────────────

/// 本地分支 tip（`refs/heads/<name>` 全限定精确匹配）；`Ok(None)` = 分支不存在。
///
/// 不用 `rev-parse <name>`：裸名解析 tag 优先（同名 tag 会冒名回答分支），且其
/// 非零退出把「分支不存在」与「探针失败」混进同一个 Err。for-each-ref 全限定
/// 模式 + refname 精确过滤：`<name>/sub` 子命名空间不得冒名（for-each-ref 的
/// 模式匹配含前缀树，必须逐行比对完整 refname）。
async fn local_branch_tip(cwd: &Path, name: &str) -> Result<Option<String>, String> {
    let refname = format!("refs/heads/{name}");
    let (stdout, _) = run_git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(objectname)",
            &refname,
        ],
    )
    .await?;
    for line in stdout.lines() {
        if let Some((ref_name, oid)) = line.split_once('\t') {
            if ref_name == refname && !oid.trim().is_empty() {
                return Ok(Some(oid.trim().to_string()));
            }
        }
    }
    Ok(None)
}

/// `ancestor` 是否可从 `descendant` 到达（`merge-base --is-ancestor` 的退出码
/// 语义：0 = 是，1 = 否，其余 = 探针失败）。探针失败折为 Err，交调用方保守处置。
async fn git_is_ancestor(cwd: &Path, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let probe = run_git_probe_with_timeout(
        cwd,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        GIT_TIMEOUT,
        None,
    )
    .await?;
    match probe.code {
        Some(0) => Ok(true),
        // 退出码 1 只有在无任何 stderr 时才是「否」这个答案；带输出的 1 属于
        // 环境异常，按探针失败保守处理（与 git_trees_equal 同一纪律）。
        Some(1) if probe.stderr.trim().is_empty() => Ok(false),
        _ => Err(format!(
            "git 命令失败 ({})",
            probe.stderr.trim().chars().take(512).collect::<String>()
        )),
    }
}

/// 两个提交的树是否相等（`diff --quiet` 退出码语义，同 [`git_is_ancestor`]）。
/// 树相等即 squash 落地形态——commit message 不参与判定。
///
/// 陷阱（Windows git 实测）：非仓库目录下 `git diff --quiet a b` 以 **退出码 1**
/// 退出（stderr "error: Could not access 'a'"）——1 在这里不是「树不等」的答案。
/// 真实的「树不等」是静默退出 1（--quiet 压掉全部输出），故 exit 1 必须搭配
/// 空 stderr 才采信，其余一律按探针失败。
async fn git_trees_equal(cwd: &Path, a: &str, b: &str) -> Result<bool, String> {
    let probe =
        run_git_probe_with_timeout(cwd, &["diff", "--quiet", a, b], GIT_TIMEOUT, None).await?;
    match probe.code {
        Some(0) => Ok(true),
        Some(1) if probe.stderr.trim().is_empty() => Ok(false),
        _ => Err(format!(
            "git 命令失败 ({})",
            probe.stderr.trim().chars().take(512).collect::<String>()
        )),
    }
}

/// 删除本地分支（带「未落地工作」保护）。
///
/// 保护语义（Codeg `work_task/git.rs` 的 `branch_holds_unlanded_work` 同源）：
/// 分支 tip 已并入当前 HEAD（`merge-base --is-ancestor`）或与 HEAD 树相等
/// （`diff --quiet`，squash 落地形态）才可删；两者皆否 = 还有未落地工作，拒绝。
/// 任何探针失败（git 不可用/超时/中间态）一律按「有未落地工作」保守处理——
/// 删除是不可逆的一半，不确定性保留分支。base 取当前 HEAD；当前分支自身、
/// 不存在的分支先行拒绝。删除本体用 `update-ref -d refs/heads/<name> <tip>`：
/// 比较与删除在单次 git 操作内完成，探针与删除之间 ref 被并发移动时 git 拒绝
/// 执行（竞态窗口关闭）。
pub async fn git_delete_branch(cwd: &Path, name: &str) -> Result<GitOperationResult, String> {
    let name = validate_branch_name(cwd, name).await?;
    let status = git_status(cwd).await?;
    if status.branch.branch.as_deref() == Some(name.as_str()) {
        return Err(format!("分支 {name} 是当前所在分支，不能删除"));
    }
    let Some(tip) = local_branch_tip(cwd, &name).await? else {
        return Err(format!("分支 {name} 不存在"));
    };
    // base = 当前 HEAD。分支存在 ⇒ 仓库必有提交 ⇒ HEAD 可解析；解析异常按
    // 探针失败保守拒绝（unborn 仓库不可能有本地分支，此为防御路径）。
    let head = run_git_probe_with_timeout(
        cwd,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        GIT_TIMEOUT,
        None,
    )
    .await?;
    let base = if head.code == Some(0) {
        head.stdout.trim().to_string()
    } else {
        return Err(format!("无法确认分支 {name} 是否已落地，已保留分支"));
    };
    let landed = match git_is_ancestor(cwd, &tip, &base).await {
        Ok(true) => true,
        // 非祖先 → 看 squash 形态（树相等）；树探针失败同样保守拒绝
        Ok(false) => git_trees_equal(cwd, &base, &tip).await.unwrap_or(false),
        Err(_) => false,
    };
    if !landed {
        return Err(format!(
            "分支 {name} 还有未落地的提交，未删除；确认不再需要时请先合并或手工处理"
        ));
    }
    let (stdout, _) = run_git(
        cwd,
        &["update-ref", "-d", &format!("refs/heads/{name}"), &tip],
    )
    .await?;
    let _ = stdout;
    Ok(GitOperationResult {
        summary: format!("已删除分支 {name}"),
        status: git_status(cwd).await?,
    })
}

// ── #368：log 图（结构化 parents/refs 分页）─────────────────────────────

/// log 图单页条目。parents/refs 结构化交给前端算 lane——不传 `--graph`：
/// 图字符混进行文本会破坏 NUL 分隔解析，且 lane 布局属表现层。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitGraphEntry {
    pub hash: String,
    /// 完整 parent hash（根提交为空；merge 提交 ≥2 个）。
    pub parents: Vec<String>,
    pub author: String,
    /// Unix 秒（%at）。
    pub date: i64,
    pub subject: String,
    /// decorations（%D，如 `HEAD -> main, origin/main`；无装饰为空串）。
    pub refs: String,
}

/// log 图单页（hasMore 供前端「加载更多」续页）。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogGraphPage {
    pub commits: Vec<GitCommitGraphEntry>,
    pub has_more: bool,
}

/// 结构化 log 分页：`--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D`，多取 1 条
/// 定 hasMore。limit 上限 MAX_HISTORY，limit=0 返回空页，None 默认 50（与
/// git_history 同口径）。显式 `--decorate=short`：runner 的 stdout 是管道，
/// log.decorate=auto 在非 TTY 下不输出 decorations。path 可选（相对且不穿越，
/// 复用 workspace 语义）；first_parent 对应 `--first-parent`（合并线视图）。
pub async fn git_log_graph(
    cwd: &Path,
    skip: Option<usize>,
    limit: Option<usize>,
    first_parent: bool,
    path: Option<&str>,
) -> Result<GitLogGraphPage, String> {
    if let Some(path) = path {
        if !crate::workspace::is_safe_relative_path(path) {
            return Err("log path 必须是相对路径且不能穿越".to_string());
        }
    }
    let limit = match limit {
        Some(0) => {
            return Ok(GitLogGraphPage {
                commits: Vec::new(),
                has_more: false,
            })
        }
        Some(n) => n.min(MAX_HISTORY),
        None => 50,
    };
    let skip_arg = format!("--skip={}", skip.unwrap_or(0));
    let count_arg = format!("-n{}", limit + 1);
    let mut args: Vec<&str> = vec![
        "log",
        "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D",
        "--decorate=short",
        &skip_arg,
        &count_arg,
    ];
    if first_parent {
        args.push("--first-parent");
    }
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    let (stdout, _) = match run_git(cwd, &args).await {
        Ok(result) => result,
        // 空仓库（无任何 commit）视为空页，而非错误（与 git_history 口径一致）
        Err(error) if error.contains("does not have any commits") => {
            return Ok(GitLogGraphPage {
                commits: Vec::new(),
                has_more: false,
            });
        }
        Err(error) => return Err(error),
    };
    let mut commits = Vec::new();
    for line in stdout.lines() {
        let mut fields = line.split('\0');
        let hash = fields.next().unwrap_or("");
        if hash.is_empty() {
            continue;
        }
        let parents = fields.next().unwrap_or("");
        let author = fields.next().unwrap_or("");
        let date = fields.next().unwrap_or("");
        let subject = fields.next().unwrap_or("");
        let refs = fields.next().unwrap_or("");
        commits.push(GitCommitGraphEntry {
            hash: hash.to_string(),
            parents: parents.split_whitespace().map(String::from).collect(),
            author: author.to_string(),
            date: date.parse().unwrap_or(0),
            subject: subject.to_string(),
            refs: refs.to_string(),
        });
        if commits.len() > limit {
            break;
        }
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(GitLogGraphPage { commits, has_more })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建临时 git 仓库：init + 用户配置 + 初始 commit。
    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@pylon.local"]);
        run(&["config", "user.name", "Pylon Test"]);
    }

    struct TempRepo(std::path::PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// P91 批 C1（横切 §3）：唯一临时仓库名（pid + nanos）——原纯 pid 命名在
    /// 上次运行崩溃残留同名目录时会被 create_dir_all 静默复用（最危险形态）。
    fn unique_git_temp(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-git-test-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn temp_repo(name: &str) -> TempRepo {
        let dir = unique_git_temp(name);
        std::fs::create_dir_all(&dir).unwrap();
        init_repo(&dir);
        TempRepo(dir)
    }

    fn run_sync(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git must run");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn write_operations_stage_unstage_and_commit_without_reset() {
        let repo = temp_repo("write-stage-commit");
        std::fs::write(repo.0.join("a file.txt"), "v1").unwrap();

        let staged = git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("stage must succeed");
        assert!(staged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && entry.staged));

        let unstaged = git_unstage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("unstage in unborn repo must succeed");
        assert!(
            repo.0.join("a file.txt").exists(),
            "unstage 不得删除工作区文件"
        );
        assert!(unstaged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && !entry.staged));

        git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .unwrap();
        let committed = git_commit(&repo.0, "first commit")
            .await
            .expect("commit must succeed");
        assert!(committed.status.entries.is_empty());
        assert_eq!(
            run_sync(&repo.0, &["log", "-1", "--format=%s"]),
            "first commit"
        );

        std::fs::write(repo.0.join("a file.txt"), "v2").unwrap();
        git_stage(&repo.0, &["a file.txt".to_string()])
            .await
            .unwrap();
        let unstaged = git_unstage(&repo.0, &["a file.txt".to_string()])
            .await
            .expect("unstage with HEAD must succeed");
        assert!(unstaged
            .status
            .entries
            .iter()
            .any(|entry| entry.path == "a file.txt" && !entry.staged));
    }

    #[tokio::test]
    async fn write_operations_reject_unsafe_paths_and_empty_commit() {
        let repo = temp_repo("write-validation");
        for path in ["../outside", "C:\\Windows\\x", ""] {
            let error = git_stage(&repo.0, &[path.to_string()])
                .await
                .expect_err("unsafe path must fail before git");
            assert!(error.contains("相对路径"), "unexpected error: {error}");
        }
        assert!(git_stage(&repo.0, &[]).await.is_err());
        assert!(git_commit(&repo.0, "   ").await.is_err());
    }

    #[tokio::test]
    async fn branch_operations_create_and_switch_without_force() {
        let repo = temp_repo("write-branches");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        let initial = git_status(&repo.0).await.unwrap().branch.branch.unwrap();

        let created = git_create_branch(&repo.0, "feature/safe")
            .await
            .expect("create branch must succeed");
        assert_eq!(
            created.status.branch.branch.as_deref(),
            Some("feature/safe")
        );
        let switched = git_switch_branch(&repo.0, &initial)
            .await
            .expect("switch branch must succeed");
        assert_eq!(
            switched.status.branch.branch.as_deref(),
            Some(initial.as_str())
        );
        for invalid in ["-force", "bad..name", "bad~name"] {
            assert!(git_create_branch(&repo.0, invalid).await.is_err());
        }
    }

    #[tokio::test]
    async fn pull_and_push_use_configured_upstream_without_force() {
        let seed = temp_repo("network-seed");
        std::fs::write(seed.0.join("shared.txt"), "v1").unwrap();
        run_sync(&seed.0, &["add", "shared.txt"]);
        run_sync(&seed.0, &["commit", "-q", "-m", "init"]);

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let remote_path = std::env::temp_dir().join(format!(
            "pylon-git-test-network-remote-{}-{nonce}",
            std::process::id()
        ));
        let clone_path = std::env::temp_dir().join(format!(
            "pylon-git-test-network-clone-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&remote_path).unwrap();
        run_sync(&remote_path, &["init", "--bare", "-q"]);
        let remote = remote_path.to_string_lossy().into_owned();
        run_sync(&seed.0, &["remote", "add", "origin", &remote]);
        run_sync(&seed.0, &["push", "-q", "-u", "origin", "HEAD"]);

        let clone_parent = clone_path.parent().unwrap();
        let clone_name = clone_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        run_sync(clone_parent, &["clone", "-q", &remote, &clone_name]);
        run_sync(&clone_path, &["config", "user.email", "test@pylon.local"]);
        run_sync(&clone_path, &["config", "user.name", "Pylon Test"]);

        std::fs::write(seed.0.join("shared.txt"), "v2").unwrap();
        run_sync(&seed.0, &["add", "shared.txt"]);
        run_sync(&seed.0, &["commit", "-q", "-m", "seed update"]);
        git_push(&seed.0).await.expect("push must succeed");
        git_pull(&clone_path)
            .await
            .expect("pull --ff-only must succeed");
        assert_eq!(
            std::fs::read_to_string(clone_path.join("shared.txt")).unwrap(),
            "v2"
        );

        std::fs::write(clone_path.join("clone.txt"), "from clone").unwrap();
        run_sync(&clone_path, &["add", "clone.txt"]);
        run_sync(&clone_path, &["commit", "-q", "-m", "clone update"]);
        git_push(&clone_path).await.expect("push must succeed");
        assert_eq!(
            run_sync(&clone_path, &["rev-parse", "HEAD"]),
            run_sync(&remote_path, &["rev-parse", "HEAD"])
        );

        std::fs::remove_dir_all(&clone_path).ok();
        std::fs::remove_dir_all(&remote_path).ok();
    }

    #[tokio::test]
    async fn status_lists_modified_and_untracked() {
        let repo = temp_repo("status");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        std::fs::write(repo.0.join("new.txt"), "x").unwrap();

        let result = git_status(&repo.0).await.expect("status must succeed");
        let modified = result
            .entries
            .iter()
            .find(|e| e.path == "a.txt")
            .expect("modified entry");
        assert_eq!(modified.status, " M");
        assert!(!modified.staged);
        let untracked = result
            .entries
            .iter()
            .find(|e| e.path == "new.txt")
            .expect("untracked entry");
        assert_eq!(untracked.status, "??");
    }

    // ── ISSUE-15 W1：porcelain v1 解析协议缺陷的 RED 证据已实现前捕获 ──
    // （v1 解析器已删除；以下集成与合成测试锁定的契约在 v2 -z 下必须保持）

    #[tokio::test]
    async fn status_keeps_unicode_symbol_path_unquoted() {
        // 集成 RED：真实仓库中的 Unicode 符号路径（Windows 可创建），git_status
        // 返回的 path 不得带引号（v1 实测输出 `?? "a → b.txt"`，当前实现失真）。
        let repo = temp_repo("unicode-symbol");
        std::fs::write(repo.0.join("a → b.txt"), "c").unwrap();
        let result = git_status(&repo.0).await.expect("status must succeed");
        let entry = result
            .entries
            .iter()
            .find(|e| e.path == "a → b.txt")
            .expect("unicode symbol entry");
        assert_eq!(entry.status, "??");
        assert!(
            !entry.path.starts_with('"'),
            "路径不得带引号: {}",
            entry.path
        );
    }

    // ── ISSUE-15 W1：porcelain v2 -z 解析 + branch/detached DTO ──

    #[test]
    fn parse_status_v2_handles_all_record_kinds() {
        // 合成 NUL 记录：覆盖 header、空格路径、rename（目标+src 下一条）、
        // unmerged、untracked（含换行/制表符路径——Windows 文件系统不可真实创建）、
        // ignored。路径均无引号。
        let input = "\
# branch.oid 0123456789abcdef0123456789abcdef01234567\0\
# branch.head feature/x\0\
1 .M N... 100644 100644 100644 1111111 2222222 a file with spaces.txt\0\
2 R. N... 100644 100644 100644 1111111 2222222 R100 dst name.txt\0src name.txt\0\
u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflicted file.txt\0\
? a -> b.txt\0\
? new\nline.txt\0\
? tab\tfile.txt\0\
! ignored dir/\0\
";
        let result = parse_status_v2(input);
        assert_eq!(
            result.branch.head.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(result.branch.branch.as_deref(), Some("feature/x"));
        assert!(!result.branch.detached);

        let entries = &result.entries;
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[0].path, "a file with spaces.txt");
        assert_eq!(entries[0].status, " M");
        assert!(!entries[0].staged);
        assert_eq!(entries[1].path, "dst name.txt");
        assert_eq!(entries[1].status, "R ");
        assert!(entries[1].staged);
        assert_eq!(entries[2].path, "conflicted file.txt");
        assert_eq!(entries[2].status, "UU");
        assert!(entries[2].staged);
        // v2 -z 路径永不加引号、不按 " -> " 误切分（v1 缺陷的等价契约）
        assert_eq!(entries[3].path, "a -> b.txt");
        assert_eq!(entries[3].status, "??");
        assert_eq!(entries[4].path, "new\nline.txt");
        assert_eq!(entries[4].status, "??");
        assert_eq!(entries[5].path, "tab\tfile.txt");
        assert_eq!(entries[5].status, "??");
        assert_eq!(entries[6].path, "ignored dir/");
        assert_eq!(entries[6].status, "!!");
    }

    #[test]
    fn parse_status_v2_parses_detached_and_unborn_headers() {
        let detached = parse_status_v2("# branch.oid abcdef\0# branch.head (detached)\0");
        assert!(detached.branch.detached);
        assert!(detached.branch.branch.is_none());
        assert_eq!(detached.branch.head.as_deref(), Some("abcdef"));

        // unborn 分支：oid 为 (initial)，不构成真实 head
        let unborn = parse_status_v2("# branch.oid (initial)\0# branch.head master\0");
        assert!(!unborn.branch.detached);
        assert_eq!(unborn.branch.branch.as_deref(), Some("master"));
        assert!(unborn.branch.head.is_none());
    }

    #[test]
    fn parse_status_v2_keeps_entry_cap_and_consumes_rename_source() {
        // MAX_STATUS_ENTRIES 超限后仍须消费 rename 的 src 记录，不得误解析成条目
        let mut records = String::new();
        for n in 0..(MAX_STATUS_ENTRIES + 2) {
            records.push_str(&format!("1 M. N... 100644 100644 100644 x x file{n}.txt\0"));
        }
        records.push_str("2 R. N... 100644 100644 100644 x x R100 final.txt\0src.txt\0");
        let result = parse_status_v2(&records);
        assert_eq!(result.entries.len(), MAX_STATUS_ENTRIES);
        assert!(
            !result.entries.iter().any(|e| e.path == "src.txt"),
            "rename src 不得被解析成独立条目"
        );
    }

    #[tokio::test]
    async fn status_reports_current_branch_and_head() {
        let repo = temp_repo("branch");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(!result.branch.detached);
        assert!(result.branch.branch.is_some(), "非 detached 必须有分支名");
        let head = result.branch.head.expect("有提交必须有 head oid");
        assert_eq!(head.len(), 40, "head 应为完整 40 位 oid: {head}");
    }

    #[tokio::test]
    async fn status_reports_detached_head() {
        let repo = temp_repo("detached");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        run(&["checkout", "-q", "--detach"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(result.branch.detached, "detached HEAD 必须标记");
        assert!(result.branch.branch.is_none(), "detached 无分支名");
        assert!(result.branch.head.is_some(), "detached 仍有 head oid");
    }

    #[tokio::test]
    async fn status_reports_unborn_branch_without_head() {
        let repo = temp_repo("unborn");
        let result = git_status(&repo.0).await.expect("status must succeed");
        assert!(!result.branch.detached);
        assert!(result.branch.branch.is_some(), "unborn 分支有默认分支名");
        assert!(result.branch.head.is_none(), "无提交时 head 必须为 None");
    }

    #[tokio::test]
    async fn status_reports_rename_destination() {
        let repo = temp_repo("rename");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        run(&["mv", "a.txt", "new name.txt"]);

        let result = git_status(&repo.0).await.expect("status must succeed");
        let entry = result
            .entries
            .iter()
            .find(|e| e.path == "new name.txt")
            .expect("renamed entry");
        assert_eq!(entry.status, "R ", "rename 状态码须 v1 兼容");
        assert!(entry.staged, "git mv 后的 rename 视为 staged");
    }

    // ── ISSUE-15 W2 RED fixtures：git path 守卫缺 Windows 盘符/冒号检查（修复前必须失败）──
    // 原 is_relative_safe_path 只拒 NUL/空/absolute/../..；`C:\x` 归一化为
    // `C:/x` 不命中任何规则 → 放行（原集成测试 is_err 靠 git 自己拒绝越界
    // pathspec，正违反 ISSUE-15"禁止依赖 git 拒绝越界 pathspec 作为安全边界"）。
    // 修复后守卫为 workspace 共享谓词 is_safe_relative_path（git.rs 与 workspace.rs 同源）。

    #[test]
    fn path_guard_rejects_windows_drive_paths() {
        for bad in ["C:\\Windows\\x", "C:/Windows/x", "C:relative.txt"] {
            assert!(
                !crate::workspace::is_safe_relative_path(bad),
                "守卫必须拒绝 Windows 盘符路径: {bad:?}"
            );
        }
        // 已正确处理的不回归钉：UNC / Windows Prefix / absolute / traversal / NUL / 空
        for bad in [
            "\\\\server\\share\\x",
            "//server/share/x",
            "\\\\?\\C:\\x",
            "//?/C:/x",
            "/absolute/path",
            "../outside",
            "a/../../outside",
            "a\0b.txt",
            "  ",
        ] {
            assert!(
                !crate::workspace::is_safe_relative_path(bad),
                "应拒绝: {bad:?}"
            );
        }
        for good in ["a.txt", "dir/a b.txt", "测试/文件.txt", "a/./b.txt"] {
            assert!(
                crate::workspace::is_safe_relative_path(good),
                "应放行: {good:?}"
            );
        }
    }

    #[tokio::test]
    async fn diff_rejects_drive_paths_at_guard_not_git() {
        // 集成 RED：drive 路径必须在我们的守卫层拒绝（错误消息来自守卫），
        // 而不是依赖 git 报 "outside repository"。
        let repo = temp_repo("path-guard");
        let error = git_diff(&repo.0, Some("C:\\Windows\\x"), false)
            .await
            .expect_err("drive 路径必须在守卫层拒绝");
        assert!(
            error.contains("必须是相对路径"),
            "错误必须来自我们的守卫而非 git: {error}"
        );
    }

    #[tokio::test]
    async fn diff_reports_workspace_changes_and_respects_path_guard() {
        let repo = temp_repo("diff");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();

        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("diff must succeed");
        assert!(diff.contains("-v1"), "diff 应含旧内容");
        assert!(diff.contains("+v2"), "diff 应含新内容");
        // 路径守卫：穿越路径拒绝
        assert!(git_diff(&repo.0, Some("../outside"), false).await.is_err());
        assert!(git_diff(&repo.0, Some("C:\\Windows\\x"), false)
            .await
            .is_err());
        // 限定路径：命中
        let scoped = git_diff(&repo.0, Some("a.txt"), false)
            .await
            .expect("scoped diff");
        assert!(scoped.contains("+v2"));
    }

    #[tokio::test]
    async fn history_returns_commits_newest_first() {
        let repo = temp_repo("history");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "second"]);

        let commits = git_history(&repo.0, Some(10))
            .await
            .expect("history must succeed");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second");
        assert_eq!(commits[1].subject, "first");
        assert_eq!(commits[0].author, "Pylon Test");
        assert!(!commits[0].hash.is_empty());
        assert!(!commits[0].date.is_empty());
    }

    #[tokio::test]
    async fn history_zero_limit_returns_empty() {
        // 审查修复回归：limit=0 返回空，而非 1 条
        let repo = temp_repo("limit-zero");
        let commits = git_history(&repo.0, Some(0))
            .await
            .expect("zero limit must succeed");
        assert!(commits.is_empty(), "limit=0 必须返回空列表");
        // None → 默认 50（空仓库也为空但成功）
        let commits = git_history(&repo.0, None)
            .await
            .expect("default limit must succeed");
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn non_git_directory_returns_clear_error() {
        let dir = std::env::temp_dir().join(format!("pylon-git-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = git_status(&dir).await.expect_err("non-repo must fail");
        assert!(
            error.contains("not a git repository"),
            "错误应明确非 git 仓库: {error}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn locale_override_keeps_english_error_detection() {
        // G5-5：宿主 locale 非 C 时 git 文案可能本地化——run_git 固定 LC_ALL/LANG=C
        // （子进程继承覆盖，不 env_clear）。本机 git 构建对 locale 无感知（实测
        // zh_CN 仍英文），故本测试钉住可观测契约：宿主 locale 被设为 zh_CN 时，
        // 非 git 目录错误仍命中 is_git_error 的英文检测（在 locale 感知的 git
        // 构建上该测试修复前必失败、修复后通过；本机为契约钉）。限制记录：
        // run_git 不支持注入命令参数（Command::new("git") 固定），机制级
        // 直测（PATH 前置 fake git）已实测不可行（std 对无扩展名程序按 .exe
        // 解析，.bat 不命中）且会污染并行测试的 PATH——采用方案 G5-5 兜底形态。
        // P91 批 C1（横切 §4）：宿主 locale 改经 run_git_with_timeout_env 在
        // **子进程内**注入（Command env）——不再 set_var/remove_var 本进程全局
        // LC_ALL/LANG（进程级 env 变异与并行测试竞态）。错误映射发生在
        // run_git_with_timeout 内层，与 git_status 同层断言同一契约。
        let dir = std::env::temp_dir().join(format!("pylon-git-nonrepo-zh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = run_git_with_timeout_env(
            &dir,
            &["status"],
            GIT_TIMEOUT,
            Some(&[("LC_ALL", "zh_CN.UTF-8"), ("LANG", "zh_CN.UTF-8")]),
        )
        .await
        .expect_err("non-repo must fail");
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            error.contains("not a git repository"),
            "宿主 locale 覆盖下错误检测必须仍走英文: {error}"
        );
    }

    #[tokio::test]
    async fn git_diff_large_output_does_not_deadlock() {
        // A1 回归：输出超过 OS 管道缓冲（Windows 4096B）时，读任务必须与 wait
        // 并发——否则 git 阻塞在写管道上永不退出，10s 必超时。全行改写使 diff
        // 输出 ~2MB（远超 MAX_DIFF_BYTES），同时验证截断标记。
        let repo = temp_repo("large-diff");
        let line = "line_aaaaaaaaaa_bbbbbbbbbb_cccccccccc_dddddddddd_eeeeeeeeee\n";
        let old = line.repeat(20_000);
        std::fs::write(repo.0.join("big.txt"), &old).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "big.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        let new = line.repeat(20_000).replace('a', "x");
        std::fs::write(repo.0.join("big.txt"), &new).unwrap();

        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("large diff must succeed within timeout");
        assert!(
            diff.contains("已截断"),
            "超过 {MAX_DIFF_BYTES} 的输出必须截断"
        );
    }

    #[tokio::test]
    async fn oversized_output_is_bounded_keeps_head_and_marker() {
        // G5-4（E17）：>16MB 输出——run_git 读任务有界化：直接调 run_git 断言
        // 返回 stdout ≤ MAX_READ_BYTES（内存有界）且保留头部（不是尾部）；git_diff
        // 的截断标记文案不变。若回归为 read_to_end 或 take 提前关流：前者返回
        // 18MB+ 全量（断言失败），后者 git EPIPE 误报失败（expect 失败）。
        let repo = temp_repo("oversize-diff");
        let line = "line_aaaaaaaaaa_bbbbbbbbbb_cccccccccc_dddddddddd_eeeeeeeeee\n";
        // 150k 行 ≈ 9MB/侧：diff 输出 ≈ 18MB > MAX_READ_BYTES(16MB)
        let old = line.repeat(150_000);
        std::fs::write(repo.0.join("huge.txt"), &old).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("git must run");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["add", "huge.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        let new = line.repeat(150_000).replace('a', "x");
        std::fs::write(repo.0.join("huge.txt"), &new).unwrap();

        let (stdout, _) = run_git(&repo.0, &["diff", "--", "huge.txt"])
            .await
            .expect(">16MB 输出不得因 EPIPE/超时误报失败");
        assert!(
            stdout.len() <= MAX_READ_BYTES,
            "run_git 输出必须 ≤ MAX_READ_BYTES（内存有界），实际 {}",
            stdout.len()
        );
        assert!(
            stdout.starts_with("diff --git"),
            "超限输出必须保留头部（E17），实际前缀: {}",
            &stdout[..stdout.len().min(40)]
        );
        let diff = git_diff(&repo.0, None, false)
            .await
            .expect("git_diff 超限场景必须成功");
        assert!(diff.contains("已截断"), "截断标记文案必须仍在（E17）");
    }

    // ── 0-C2：is_safe_rev 白名单 ─────────────────────────────────────────────

    #[test]
    fn safe_rev_accepts_hash_head_and_stage() {
        assert!(is_safe_rev("1234567"));
        assert!(is_safe_rev(&"a".repeat(40)));
        assert!(is_safe_rev("HEAD"));
        assert!(is_safe_rev("HEAD~3"));
        assert!(is_safe_rev(":0"));
        assert!(is_safe_rev(":2"));
    }

    #[test]
    fn safe_rev_rejects_options_and_malformed() {
        for bad in [
            "",
            "123456",          // 太短
            "abcdefgh",        // 非 hex（g-z）
            "--output=/tmp/x", // 选项注入
            "HEAD~",
            "HEAD~x",
            ":4",
            ":",
            "main", // 分支名不进白名单（reset/checkout 另行裁决）
            "HEAD~2 --signoff",
            "abc123 --output=/tmp/x",
        ] {
            assert!(!is_safe_rev(bad), "{bad:?} 应被拒绝");
        }
    }

    // ── 0-C2：git_show_file ──────────────────────────────────────────────────

    #[tokio::test]
    async fn show_file_reads_head_and_hash_content() {
        let repo = temp_repo("show_file");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();

        assert_eq!(git_show_file(&repo.0, "HEAD", "a.txt").await.unwrap(), "v1");
        let hash = run_sync(&repo.0, &["rev-parse", "HEAD"]);
        let hash = hash.trim().to_string();
        assert_eq!(git_show_file(&repo.0, &hash, "a.txt").await.unwrap(), "v1");
        assert!(git_show_file(&repo.0, "HEAD", "missing.txt").await.is_err());
    }

    #[tokio::test]
    async fn show_file_rejects_unsafe_rev_and_path() {
        let repo = temp_repo("show_file_guard");
        assert!(git_show_file(&repo.0, "--output=/tmp/x", "a.txt")
            .await
            .is_err());
        assert!(git_show_file(&repo.0, "HEAD", "../outside.txt")
            .await
            .is_err());
        assert!(git_show_file(&repo.0, "main", "a.txt").await.is_err());
    }

    // ── 0-C2：git_sequence_state ─────────────────────────────────────────────

    #[tokio::test]
    async fn sequence_state_none_on_clean_repo() {
        let repo = temp_repo("sequence_none");
        std::fs::write(repo.0.join("a.txt"), "v").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);

        let state = git_sequence_state(&repo.0).await.unwrap();
        assert_eq!(state.kind, "none");
        assert!(state.conflicts.is_empty());
    }

    #[tokio::test]
    async fn sequence_state_reports_merge_in_progress() {
        let repo = temp_repo("sequence_merge");
        std::fs::write(repo.0.join("a.txt"), "v").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        // 模拟 merge 进行态：MERGE_HEAD 元数据文件（git merge 冲突时留下的就是它）
        let git_dir = run_sync(&repo.0, &["rev-parse", "--git-dir"]);
        let git_dir = repo.0.join(git_dir.trim());
        std::fs::write(
            git_dir.join("MERGE_HEAD"),
            "1234567890abcdef1234567890abcdef12345678
",
        )
        .unwrap();

        let state = git_sequence_state(&repo.0).await.unwrap();
        assert_eq!(state.kind, "merge");
        assert!(
            state.conflicts.is_empty(),
            "无 unmerged 条目时 conflicts 为空"
        );
    }

    // ── 0-C2：真实冲突仓库的 stage 读取（:1/:2/:3）与 conflicts 派生 ──────────

    #[tokio::test]
    async fn show_file_reads_stage_entries_during_conflict() {
        let repo = temp_repo("conflict_stage");
        std::fs::write(
            repo.0.join("a.txt"),
            "base
",
        )
        .unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "base"]);
        // 默认分支名随 git init 配置（main/master），不可硬编码——须在切 feature 前取
        let default_branch = run_sync(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        run_sync(&repo.0, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(
            repo.0.join("a.txt"),
            "feature
",
        )
        .unwrap();
        run_sync(&repo.0, &["commit", "-q", "-am", "feature"]);
        run_sync(&repo.0, &["checkout", "-q", default_branch.trim()]);
        std::fs::write(
            repo.0.join("a.txt"),
            "main
",
        )
        .unwrap();
        run_sync(&repo.0, &["commit", "-q", "-am", "main"]);
        // 制造真实冲突（merge feature → 默认分支冲突，exit code 非零属预期）
        let _ = std::process::Command::new("git")
            .args(["merge", "feature"])
            .current_dir(&repo.0)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        let state = git_sequence_state(&repo.0).await.unwrap();
        assert_eq!(state.kind, "merge");
        assert!(
            state.conflicts.iter().any(|p| p == "a.txt"),
            "conflicts 应含 a.txt"
        );
        assert_eq!(
            git_show_file(&repo.0, ":2", "a.txt").await.unwrap(),
            "main
",
            ":2 = ours"
        );
        assert_eq!(
            git_show_file(&repo.0, ":3", "a.txt").await.unwrap(),
            "feature
",
            ":3 = theirs"
        );
    }

    // ── #368：stash 三件套 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn stash_push_pop_list_roundtrip() {
        let repo = temp_repo("stash-roundtrip");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);

        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        std::fs::write(repo.0.join("untracked.txt"), "u").unwrap();
        let pushed = git_stash_push(&repo.0, Some("wip changes"), true)
            .await
            .expect("stash push must succeed");
        assert!(
            pushed.summary.contains("wip changes"),
            "summary 应含自定义说明: {}",
            pushed.summary
        );
        let status = git_status(&repo.0).await.unwrap();
        assert!(
            status.entries.is_empty(),
            "入栈后工作区应干净: {:?}",
            status.entries
        );
        assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "v1");
        assert!(
            !repo.0.join("untracked.txt").exists(),
            "-u 应把 untracked 一并入栈"
        );

        let list = git_stash_list(&repo.0).await.expect("stash list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "stash@{0}");
        assert!(list[0].subject.contains("wip changes"));

        let popped = git_stash_pop(&repo.0, 0).await.expect("stash pop");
        assert_eq!(std::fs::read_to_string(repo.0.join("a.txt")).unwrap(), "v2");
        assert_eq!(
            std::fs::read_to_string(repo.0.join("untracked.txt")).unwrap(),
            "u"
        );
        assert!(
            popped
                .status
                .entries
                .iter()
                .any(|e| e.path == "a.txt" && !e.staged),
            "pop 后变更为未暂存工作区形态"
        );
        assert!(
            git_stash_list(&repo.0).await.unwrap().is_empty(),
            "pop 后栈应清空"
        );
    }

    #[tokio::test]
    async fn stash_push_without_changes_is_noop_success() {
        let repo = temp_repo("stash-noop");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        let pushed = git_stash_push(&repo.0, None, false)
            .await
            .expect("无可贮藏也是成功（git 退出 0）");
        assert!(
            pushed.summary.contains("No local changes"),
            "git 的 stderr 提示应作为回执: {}",
            pushed.summary
        );
        assert!(git_stash_list(&repo.0).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stash_pop_rejects_out_of_range_index() {
        let repo = temp_repo("stash-guard");
        let error = git_stash_pop(&repo.0, MAX_STASH_ENTRIES)
            .await
            .expect_err("越界索引必须在守卫层拒绝");
        assert!(error.contains("索引超出范围"), "unexpected: {error}");
        let error = git_stash_pop(&repo.0, 0)
            .await
            .expect_err("空栈 pop 必须失败（git: No stash entries found）");
        assert!(error.contains("git 命令失败"), "unexpected: {error}");
    }

    // ── #368：删分支（未落地保护 + 比较删除）────────────────────────────────

    #[tokio::test]
    async fn delete_branch_refuses_current_unlanded_and_missing() {
        let repo = temp_repo("delete-guard");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        let default_branch = run_sync(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let default_branch = default_branch.trim().to_string();

        run_sync(&repo.0, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.0.join("a.txt"), "feature work").unwrap();
        run_sync(&repo.0, &["commit", "-q", "-am", "feature work"]);
        run_sync(&repo.0, &["checkout", "-q", &default_branch]);

        let error = git_delete_branch(&repo.0, &default_branch)
            .await
            .expect_err("当前分支必须拒删");
        assert!(error.contains("当前所在分支"), "unexpected: {error}");
        let error = git_delete_branch(&repo.0, "feature")
            .await
            .expect_err("未落地分支必须拒删");
        assert!(error.contains("未落地"), "unexpected: {error}");
        let error = git_delete_branch(&repo.0, "no-such-branch")
            .await
            .expect_err("不存在的分支必须报错");
        assert!(error.contains("不存在"), "unexpected: {error}");
        assert!(
            run_sync(&repo.0, &["branch", "--list", "feature"]).contains("feature"),
            "拒删后分支必须还在"
        );
    }

    #[tokio::test]
    async fn delete_branch_allows_merged_and_squash_landed() {
        let repo = temp_repo("delete-landed");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "init"]);
        let default_branch = run_sync(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let default_branch = default_branch.trim().to_string();

        // 形态一：真合并落地（tip 是 HEAD 祖先）
        run_sync(&repo.0, &["checkout", "-q", "-b", "merged-branch"]);
        std::fs::write(repo.0.join("b.txt"), "b").unwrap();
        run_sync(&repo.0, &["add", "b.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "b work"]);
        run_sync(&repo.0, &["checkout", "-q", &default_branch]);
        run_sync(
            &repo.0,
            &[
                "merge",
                "-q",
                "--no-ff",
                "-m",
                "merge branch",
                "merged-branch",
            ],
        );
        let deleted = git_delete_branch(&repo.0, "merged-branch")
            .await
            .expect("已并入分支可删");
        assert!(deleted.summary.contains("已删除分支 merged-branch"));
        assert!(
            run_sync(&repo.0, &["branch", "--list", "merged-branch"]).is_empty(),
            "删除必须真实生效"
        );

        // 形态二：squash 落地（树相等、非祖先——commit message 不参与判定）
        run_sync(&repo.0, &["checkout", "-q", "-b", "squash-branch"]);
        std::fs::write(repo.0.join("c.txt"), "c").unwrap();
        run_sync(&repo.0, &["add", "c.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "c work"]);
        run_sync(&repo.0, &["checkout", "-q", &default_branch]);
        run_sync(&repo.0, &["merge", "--squash", "-q", "squash-branch"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "squash c work"]);
        git_delete_branch(&repo.0, "squash-branch")
            .await
            .expect("树相等的 squash 落地分支可删");
        assert!(run_sync(&repo.0, &["branch", "--list", "squash-branch"]).is_empty());
    }

    #[tokio::test]
    async fn delete_probe_failures_surface_as_errors() {
        // 探针在非仓库目录必然失败——Err 语义存在，git_delete_branch 的
        // 保守映射（Err => 有未落地工作）据此拒绝删除。
        let dir =
            std::env::temp_dir().join(format!("pylon-git-probe-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(git_is_ancestor(&dir, "a", "b").await.is_err());
        assert!(git_trees_equal(&dir, "a", "b").await.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── #368：log 图（结构化 parents/refs 分页）─────────────────────────────

    #[tokio::test]
    async fn log_graph_pagination_parents_and_decorations() {
        let repo = temp_repo("log-graph");
        std::fs::write(repo.0.join("a.txt"), "v1").unwrap();
        run_sync(&repo.0, &["add", "a.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "root"]);
        let default_branch = run_sync(&repo.0, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let default_branch = default_branch.trim().to_string();

        run_sync(&repo.0, &["checkout", "-q", "-b", "side"]);
        std::fs::write(repo.0.join("side.txt"), "s1").unwrap();
        run_sync(&repo.0, &["add", "side.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "side one"]);
        run_sync(&repo.0, &["checkout", "-q", &default_branch]);
        std::fs::write(repo.0.join("a.txt"), "v2").unwrap();
        run_sync(&repo.0, &["commit", "-q", "-am", "main one"]);
        run_sync(
            &repo.0,
            &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
        );
        std::fs::write(repo.0.join("b.txt"), "b").unwrap();
        run_sync(&repo.0, &["add", "b.txt"]);
        run_sync(&repo.0, &["commit", "-q", "-m", "main two"]);

        // 分页：limit=2 → 2 条 + hasMore；skip 续页到尽头
        let page1 = git_log_graph(&repo.0, None, Some(2), false, None)
            .await
            .expect("page 1");
        assert_eq!(page1.commits.len(), 2);
        assert!(page1.has_more);
        assert_eq!(page1.commits[0].subject, "main two");
        assert!(page1.commits[0].date > 0, "date 必须是 Unix 秒数值");
        let page2 = git_log_graph(&repo.0, Some(2), Some(2), false, None)
            .await
            .expect("page 2");
        assert_eq!(page2.commits.len(), 2);
        // 仓库共 5 个提交：skip=2 取 2 条后仍有余量 → hasMore
        assert!(page2.has_more);
        assert_eq!(page2.commits[0].subject, "main one");
        let page3 = git_log_graph(&repo.0, Some(4), Some(2), false, None)
            .await
            .expect("page 3");
        assert_eq!(page3.commits.len(), 1);
        assert!(!page3.has_more);
        assert_eq!(page3.commits[0].subject, "root");

        // merge 提交双亲 + 根提交无亲
        let full = git_log_graph(&repo.0, None, Some(50), false, None)
            .await
            .expect("full page");
        let merge = full
            .commits
            .iter()
            .find(|c| c.subject == "merge side")
            .expect("merge commit");
        assert_eq!(merge.parents.len(), 2);
        let root = full.commits.last().unwrap();
        assert_eq!(root.subject, "root");
        assert!(root.parents.is_empty());
        // 装饰：runner 的 stdout 是管道（log.decorate=auto 不生效），必须显式
        // --decorate=short——HEAD 与当前分支名出现在 tip 的 refs
        let tip = &full.commits[0];
        assert!(tip.refs.contains("HEAD"), "refs: {}", tip.refs);
        assert!(
            tip.refs.contains(default_branch.as_str()),
            "refs 应含当前分支名: {}",
            tip.refs
        );

        // first_parent：只约束遍历（侧线提交不进入结果）；%P 数据面保持忠实
        // （merge 的完整双亲原样返回），lane 截断属前端表现层。
        let fp = git_log_graph(&repo.0, None, Some(50), true, None)
            .await
            .expect("first-parent page");
        assert!(!fp.commits.iter().any(|c| c.subject == "side one"));
        assert_eq!(
            fp.commits.len(),
            4,
            "遍历收缩为主线：main two/merge side/main one/root"
        );
        let fp_merge = fp
            .commits
            .iter()
            .find(|c| c.subject == "merge side")
            .expect("first-parent 仍含 merge 提交");
        assert_eq!(fp_merge.parents.len(), 2, "%P 数据面忠实于完整双亲");

        // path 过滤：只看 a.txt 的历史
        let scoped = git_log_graph(&repo.0, None, Some(50), false, Some("a.txt"))
            .await
            .expect("scoped page");
        assert!(
            scoped
                .commits
                .iter()
                .all(|c| ["root", "main one"].contains(&c.subject.as_str())),
            "a.txt 历史不应含侧线/合并提交: {:?}",
            scoped
                .commits
                .iter()
                .map(|c| &c.subject)
                .collect::<Vec<_>>()
        );

        // limit=0 / 越界 skip / path 守卫
        assert!(git_log_graph(&repo.0, None, Some(0), false, None)
            .await
            .unwrap()
            .commits
            .is_empty());
        let beyond = git_log_graph(&repo.0, Some(99), Some(5), false, None)
            .await
            .expect("beyond page");
        assert!(beyond.commits.is_empty() && !beyond.has_more);
        assert!(
            git_log_graph(&repo.0, None, None, false, Some("../outside"))
                .await
                .is_err()
        );
        assert!(
            git_log_graph(&repo.0, None, None, false, Some("C:\\Windows\\x"))
                .await
                .is_err()
        );
    }
}
