//! 只读工作区访问：所有路径先经过 containment 校验，再执行文件系统操作。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULT_PREVIEW_BYTES: usize = 256 * 1024;
pub const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 1000;
/// 0-A4（issue #286 / ADR 无关的量级抬升）：可编辑保存的文件大小上限——与
/// MAX_PREVIEW_BYTES 对齐：CM6 单内核视口渲染兜住 1MB，「<=1MB 即可写」；>1MB
/// 仍走截断预览保持只读。前端 FileSheet 读取显式传 maxBytes=MAX_PREVIEW_BYTES，
/// DEFAULT_PREVIEW_BYTES（256KB）继续作为未指定时的保守默认（右栏预览等）。
pub const MAX_SAVE_BYTES: usize = MAX_PREVIEW_BYTES;

/// R5b：Display/Error 改 thiserror derive（与手写 impl 文案逐字一致——
/// 每个变体输出 `code: message`，`Io` 变体**保留原行为**：内部 String 不参与
/// Display（wire 文案恒为 "io_error: 工作区 I/O 操作失败"），勿改成 {0}）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceError {
    #[error("absolute_path_rejected: 不允许使用绝对路径")]
    AbsolutePathRejected,
    #[error("traversal_rejected: 不允许路径穿越")]
    TraversalRejected,
    #[error("outside_root: 路径位于工作区之外")]
    OutsideRoot,
    #[error("not_found: 路径不存在")]
    NotFound,
    #[error("not_readable: 路径不可读取")]
    NotReadable,
    #[error("not_file: 路径不是文件")]
    NotFile,
    #[error("binary_file: 文件不是可预览的 UTF-8 文本")]
    BinaryFile,
    #[error("too_many_entries: 目录条目超过限制")]
    TooManyEntries,
    /// I08-A-FE-02：保存基线冲突——磁盘内容已在基线之后被外部修改，拒绝静默覆盖。
    #[error("conflict: 磁盘文件已被外部修改，保存已拒绝")]
    Conflict,
    /// I08-A-FE-02：文件过大，编辑保存超出安全上限（保持只读）。
    #[error("too_large: 文件过大，无法编辑保存")]
    TooLarge,
    #[error("io_error: 工作区 I/O 操作失败")]
    Io(String),
}

/// 相对路径 containment 预检（ISSUE-15 W2：git.rs 与 workspace 共用同一守卫）。
/// 与 normalize_relative 的拒绝集一致：NUL、空、absolute（`/` 前缀，含归一化后的
/// `//` UNC 与 `\\?\` Windows Prefix）、parent traversal（`..` 段）、Windows 盘符/
/// 冒号段。语义差异仅限空串：本函数对空/纯空白返回 false（git pathspec 无意义），
/// normalize_relative 对空串返回 "."（工作区文件操作指向根）。返回 true 仅表示
/// "结构上相对安全"，不替代文件系统层的 canonical containment（resolve_workspace_path）。
pub fn is_safe_relative_path(path: &str) -> bool {
    if path.contains('\0') || path.trim().is_empty() {
        return false;
    }
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        return false;
    }
    for part in normalized.split('/') {
        if part == ".." {
            return false;
        }
        // 盘符/冒号判定仅在 Windows 上生效——Linux 上合法冒号文件名不再误拒。
        #[cfg(windows)]
        if part.contains(':') {
            return false;
        }
    }
    true
}

/// 单段路径名（文件/目录名）合法性——供 create/rename 等以「名字」而非「路径」为
/// 输入的命令使用（0-C1：quick open 索引与文件树写命令的共用谓词）。与
/// `is_safe_relative_path`（整条相对路径）互补：这里拒绝的是任何平台上都不该
/// 新建的 segment。读取既有路径仍走 resolve_workspace_path 的 canonical 校验，
/// 本谓词只把守「新建名字」入口，因此比读取侧更严（冒号无条件拒绝）。
pub fn is_safe_segment(name: &str) -> bool {
    // 长度按 UTF-16 单位计（NTFS 上限口径），不按 chars()——星面字符 1 char =
    // 2 units，chars() 口径会放进超出 FS 上限的名字。
    if name.is_empty() || name.encode_utf16().count() > 255 {
        return false;
    }
    // Windows 会吞掉尾随空白与尾点；首尾空白在 UI 层也几乎必然是误输入。
    if name != name.trim() || name.ends_with('.') {
        return false;
    }
    // 控制字符（含 NUL）与 bidi 方向控制符（U+202A–202E、U+2066–2069、LRM/RLM）
    // 一律拒绝——后者在文件列表 UI 上有伪装欺骗面。
    if name.chars().any(|c| {
        (c as u32) < 0x20 || matches!(c as u32, 0x202A..=0x202E | 0x2066..=0x2069 | 0x200E | 0x200F)
    }) {
        return false;
    }
    // 路径分隔符与 Windows 保留符号。
    if name
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return false;
    }
    if name == "." || name == ".." {
        return false;
    }
    // Windows 保留设备名（含带扩展名形态：CON.txt、CON .txt 同样保留——stem
    // 先去尾空白再比对，防 "CON " 借扩展名形态绕过）。
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn normalize_relative(relative: &str) -> Result<PathBuf, WorkspaceError> {
    // O30：NUL 字节在 Windows 上必然导致 I/O 失败，入口即拒（按绝对路径类处理）。
    if relative.contains('\0') {
        return Err(WorkspaceError::AbsolutePathRejected);
    }
    if relative.trim().is_empty() {
        return Ok(PathBuf::from("."));
    }
    let normalized = relative.replace('\\', "/");
    // O30：starts_with('/') 已覆盖 "//" 前缀，死分支移除。
    if normalized.starts_with('/') {
        return Err(WorkspaceError::AbsolutePathRejected);
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(WorkspaceError::TraversalRejected);
        }
        // O30：盘符/冒号判定仅在 Windows 上生效——Linux 上合法冒号文件名不再误拒。
        #[cfg(windows)]
        if part.contains(':') {
            return Err(WorkspaceError::AbsolutePathRejected);
        }
        parts.push(part);
    }
    if parts.is_empty() {
        Ok(PathBuf::from("."))
    } else {
        Ok(parts.iter().collect())
    }
}

/// 解析并校验工作区内的现有路径。不存在路径统一返回 NotFound。
/// O29：返回 (canonical_root, canonical_path) 二元组——canonical root 只解析一次，
/// 调用方不再重复 root.canonicalize()。
fn resolve_workspace_path(
    root: &Path,
    relative: &str,
) -> Result<(PathBuf, PathBuf), WorkspaceError> {
    let relative = normalize_relative(relative)?;
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    if canonical == canonical_root || canonical.starts_with(&canonical_root) {
        Ok((canonical_root, canonical))
    } else {
        Err(WorkspaceError::OutsideRoot)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub source: String,
    pub path: String,
    pub exists: bool,
    pub readable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<u128>,
    pub hidden: bool,
    pub expandable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextPreview {
    pub relative_path: String,
    pub content: String,
    pub bytes_read: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    pub encoding: String,
}

fn is_ignored(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "build" | "target" | ".next" | ".vite" | "coverage"
    )
}

fn entry_kind(metadata: &fs::Metadata) -> (&'static str, bool) {
    if metadata.is_dir() {
        ("directory", true)
    } else if metadata.is_file() {
        ("file", false)
    } else if metadata.file_type().is_symlink() {
        ("symlink", false)
    } else {
        ("other", false)
    }
}

pub fn list_entries(
    root: &Path,
    relative: &str,
    include_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
    let (canonical_root, directory) = resolve_workspace_path(root, relative)?;
    if !directory.is_dir() {
        return Err(WorkspaceError::NotFile);
    }
    // P3 + O29：canonical root 由 resolve 一次解析并复用（不依赖循环变量），
    // symlink 条目 containment 校验直接用之，避免重复 root.canonicalize()。
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory).map_err(|e| WorkspaceError::Io(e.to_string()))? {
        let item = item.map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) || (!include_hidden && name.starts_with('.')) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(item.path()).map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let (kind, expandable) = entry_kind(&metadata);
        let mut safe = true;
        if metadata.file_type().is_symlink() {
            // 与 resolve_workspace_path 相同的 containment 语义：canonical 后必须
            // 落在 root 内；断链/不可解析一律视为不安全。
            safe = directory
                .join(&name)
                .canonicalize()
                .map(|canonical| canonical.starts_with(&canonical_root))
                .unwrap_or(false);
        }
        if !safe {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        let relative_path = if relative == "." || relative.is_empty() {
            name.clone()
        } else {
            format!(
                "{}/{}",
                relative.replace('\\', "/").trim_end_matches('/'),
                name
            )
        };
        entries.push(WorkspaceEntry {
            name: name.clone(),
            relative_path,
            kind: kind.to_string(),
            size: metadata.len(),
            modified_at,
            hidden: name.starts_with('.'),
            expandable,
        });
        if entries.len() > MAX_DIRECTORY_ENTRIES {
            return Err(WorkspaceError::TooManyEntries);
        }
    }
    entries.sort_by(|a, b| {
        let rank = |kind: &str| match kind {
            "directory" => 0,
            "file" => 1,
            "symlink" => 2,
            _ => 3,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// 0-C1：quick open 文件名索引的硬上限（条数）。前端匹配在本地做，索引新鲜度
/// 靠打开/刷新时重建，因此这里只保证有界返回，不做 watch。
pub const MAX_FILE_INDEX_ENTRIES: usize = 10_000;

/// 0-C1：quick open 文件名索引页——entries 为 root 相对路径（`/` 分隔），按
/// 小写不敏感字典序排序；truncated = 枚举在触及上限后仍有余量。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileIndexPage {
    pub entries: Vec<String>,
    pub truncated: bool,
}

/// 0-C1：全仓文件名枚举（quick open 索引）。只列文件（含 symlink 文件，不落
/// 内容读取）；目录不进索引。忽略清单与隐藏过滤与 `list_entries` 同源；symlink
/// 目录一律不下钻（防环、防 root 外逃逸）。单个目录读取失败跳过（锁定的目录
/// 不应让整个索引失败），仅 root 本身不可解析视为致命。条数触及
/// `max_entries`（钳制到 MAX_FILE_INDEX_ENTRIES）即停并置 truncated。
pub fn list_workspace_files(
    root: &Path,
    max_entries: Option<usize>,
) -> Result<WorkspaceFileIndexPage, WorkspaceError> {
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::Io(e.to_string())
        }
    })?;
    let limit = max_entries
        .unwrap_or(MAX_FILE_INDEX_ENTRIES)
        .min(MAX_FILE_INDEX_ENTRIES);
    let mut entries: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(canonical_root.clone());
    'walk: while let Some(dir) = queue.pop_front() {
        let read = match fs::read_dir(&dir) {
            Ok(read) => read,
            // 不可读目录跳过，不整体失败。
            Err(_) => continue,
        };
        // 前缀每目录算一次（队列不变式：dir 恒为 canonical_root 后代）。
        let prefix = match dir.strip_prefix(&canonical_root) {
            Ok(prefix) => prefix.to_path_buf(),
            Err(e) => return Err(WorkspaceError::Io(e.to_string())),
        };
        let prefix_text = prefix.to_string_lossy().replace('\\', "/");
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if is_ignored(&name) || name.starts_with('.') {
                continue;
            }
            // file_type() 不跟随 symlink，故 symlink 目录的 is_dir() 为 false——
            // 必须单独判定，否则目录 symlink 会落到下面的收录分支进索引（#603）。
            // 目录 symlink 一律不进也不下钻（防环、防 root 外逃逸）；文件 symlink
            // 照收（本枚举只列名字、不读内容）。
            let Ok(file_type) = item.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                if item.path().is_dir() {
                    continue;
                }
            } else if file_type.is_dir() {
                queue.push_back(item.path());
                continue;
            }
            if entries.len() >= limit {
                truncated = true;
                break 'walk;
            }
            let relative = if prefix_text.is_empty() {
                name
            } else {
                format!("{prefix_text}/{name}")
            };
            entries.push(relative);
        }
    }
    entries.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    Ok(WorkspaceFileIndexPage { entries, truncated })
}

/// R23：统一的 workspace 内文件打开通道——resolve → metadata 校验 → open →
/// canonicalize 复核（TOCTOU：resolve 与 open 之间路径可能被替换为指向 root 外
/// 的链接）。返回 (已打开文件, canonical 路径)；root 外一律 OutsideRoot。
fn open_workspace_file(root: &Path, relative: &str) -> Result<(fs::File, PathBuf), WorkspaceError> {
    let (canonical_root, path) = resolve_workspace_path(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if !metadata.is_file() {
        return Err(WorkspaceError::NotFile);
    }
    let file = fs::File::open(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    let canonical = path.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    if canonical != canonical_root && !canonical.starts_with(&canonical_root) {
        return Err(WorkspaceError::OutsideRoot);
    }
    Ok((file, canonical))
}

pub fn read_text(
    root: &Path,
    relative: &str,
    max_bytes: Option<usize>,
) -> Result<WorkspaceTextPreview, WorkspaceError> {
    let (mut file, path) = open_workspace_file(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    let total_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let limit = max_bytes
        .unwrap_or(DEFAULT_PREVIEW_BYTES)
        .min(MAX_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity(total_bytes.min(limit.saturating_add(1)));
    let mut limited = file.by_ref().take(limit as u64 + 1);
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.contains(&0) {
        return Err(WorkspaceError::BinaryFile);
    }
    let truncated = bytes.len() > limit;
    // C3：截断点可能切断多字节 UTF-8 字符——回退到最近字符边界，避免误报 binary。
    // S6：边界判定改为按 from_utf8 前缀可解码，不再用 0x80..=0xBF 续字节规则——
    // GBK 的 lead/trail 大量落此区间（如 啊=B0A1），旧逻辑会把整段回退清空
    // （end==0）而误报 BinaryFile。最大 UTF-8 字符宽 4 字节，至多回退 3 字节；
    // BOM 前缀对边界搜索透明。找不到 UTF-8 边界 = 非 UTF-8 内容，整段交给
    // decode_text 的 1 字节回退（R22），由解码结果判定，不再按字节区间猜测。
    // ISSUE-15 W3：C3 边界回退只在截断时生效——非截断文件必须整段交给 decode_text。
    // 旧逻辑无条件搜索"最后一个 UTF-8 合法边界"，对含 ASCII 前缀的 GBK 文件（如以
    // EF BB BF 开头的 GBK）会在 ASCII 处切断，导致首字符丢失/误报 utf-8。
    let cut = bytes.len().min(limit);
    let end = if truncated {
        let mut end = cut;
        for candidate in (cut.saturating_sub(3)..=cut).rev() {
            if candidate > 0 {
                let prefix = bytes[..candidate]
                    .strip_prefix(b"\xEF\xBB\xBF")
                    .unwrap_or(&bytes[..candidate]);
                if !prefix.is_empty() && std::str::from_utf8(prefix).is_ok() {
                    end = candidate;
                    break;
                }
            }
        }
        end
    } else {
        cut
    };
    let slice = &bytes[..end];
    let (content, encoding) = decode_text(slice)?;
    Ok(WorkspaceTextPreview {
        relative_path: relative.replace('\\', "/"),
        content,
        bytes_read: end,
        total_bytes,
        truncated,
        encoding: encoding.to_string(),
    })
}

/// R22 + ISSUE-15 W3：文本编码判定——仅当"EF BB BF 前缀且余下严格 UTF-8 可解码"时
/// 才确认 UTF-8 BOM 并剥离；否则 BOM 字节按内容处理（GBK 文件恰以 EF BB BF 开头
/// 时不得静默丢首字符）。判定顺序：带 BOM 的严格 UTF-8 → 无 BOM 的严格 UTF-8 →
/// GBK（基于原始字节，绝不预先剥离）。encoding 如实回填（"utf-8"/"gbk"）；三种
/// 途径都不可解码时按 binary 拒绝。GBK 为 2 字节字符：截断只会损坏末尾一个字符，
/// 解码报错后回退 1 字节重试，避免误报 binary（GBK 尾字节与 lead 字节区间重叠，
/// 只能按解码结果判定）。
fn decode_text(bytes: &[u8]) -> Result<(String, &'static str), WorkspaceError> {
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        if let Ok(text) = std::str::from_utf8(&bytes[3..]) {
            return Ok((text.to_string(), "utf-8"));
        }
        // BOM 前缀存在但余下不是严格 UTF-8 → 不剥离，按原始字节继续判定
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.to_string(), "utf-8"));
    }
    let mut slice = bytes;
    if bytes.len() > 1 {
        // ISSUE-15 W3：GBK 必须用 decode_without_bom_handling——默认 decode() 会做
        // BOM sniff 剥离 EF BB BF，对以该字节序列开头的 GBK 文件干扰解码（实测
        // err=true）；BOM 决策已由本函数显式完成，GBK 解码不得再自动 sniff。
        let (text, had_errors) = encoding_rs::GBK.decode_without_bom_handling(bytes);
        if !had_errors {
            return Ok((text.into_owned(), "gbk"));
        }
        slice = &bytes[..bytes.len() - 1];
    }
    let (text, had_errors) = encoding_rs::GBK.decode_without_bom_handling(slice);
    if had_errors {
        return Err(WorkspaceError::BinaryFile);
    }
    Ok((text.into_owned(), "gbk"))
}

// ── I08-A-FE-02：真实编辑/save vertical slice（write_text，AC-1）──────────────
// 保存语义：
// - 目标必须已存在（保存 = 覆盖已打开的文件），目录目标拒绝。
// - expected_baseline（前端"最近一次成功保存/加载的文本"）与磁盘当前解码文本不一致
//   → Conflict，绝不静默覆盖外部修改；force=true 显式跳过（冲突流程的"覆盖保存"）。
// - 编码 round-trip：UTF-8 BOM 保留；GBK 文件按 GBK 重新编码写回（不悄悄转码）。
// - > MAX_SAVE_BYTES 的文件/内容拒绝（TooLarge）——大文件本轮保持只读。

/// 原子写（#317 批次二 ③：改调本 crate 正身 [`atomic_write::write_file_atomically`]）。
/// 此前本处是无 fsync 的弱实现（`.{name}.pylon-save-{pid}` 临时名 + rename 失败时
/// remove+rename，有丢窗口），正身以 MoveFileExW(WRITE_THROUGH)/fsync 消除之；
/// 档位取 best_effort_data_file（保留历史「不 fsync」语义，父目录 create_dir_all
/// 对既有目标为 no-op）。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    use crate::atomic_write::{write_file_atomically, AtomicWriteOptions};
    write_file_atomically(path, bytes, AtomicWriteOptions::best_effort_data_file())
        .map_err(|e| WorkspaceError::Io(e.to_string()))
}

pub fn write_text(
    root: &Path,
    relative: &str,
    content: &str,
    expected_baseline: Option<&str>,
    force: bool,
) -> Result<WorkspaceTextPreview, WorkspaceError> {
    let relative = normalize_relative(relative)?;
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    let target = canonical_root.join(&relative);
    if !target.exists() {
        return Err(WorkspaceError::NotFound);
    }
    if target.is_dir() {
        return Err(WorkspaceError::NotFile);
    }
    if content.len() > MAX_SAVE_BYTES {
        return Err(WorkspaceError::TooLarge);
    }
    let bytes = fs::read(&target).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(WorkspaceError::TooLarge);
    }
    // 编码 round-trip：记录磁盘原文的 BOM 与解码编码，写回时保持一致
    let had_bom = bytes.starts_with(b"\xEF\xBB\xBF");
    let (disk_text, encoding) = decode_text(&bytes)?;
    if !force {
        if let Some(expected) = expected_baseline {
            if disk_text != expected {
                return Err(WorkspaceError::Conflict);
            }
        }
    }
    let out_bytes: Vec<u8> = if encoding == "gbk" {
        let (encoded, _, had_errors) = encoding_rs::GBK.encode(content);
        if had_errors {
            return Err(WorkspaceError::Io(
                "内容包含无法以 GBK 编码保存的字符".to_string(),
            ));
        }
        encoded.into_owned()
    } else {
        let mut out = Vec::with_capacity(content.len() + 3);
        if had_bom {
            out.extend_from_slice(b"\xEF\xBB\xBF");
        }
        out.extend_from_slice(content.as_bytes());
        out
    };
    write_atomic(&target, &out_bytes)?;
    // 返回保存后的新 preview：前端以此作为下一次保存的新基线
    let relative_str = relative.to_string_lossy().into_owned();
    read_text(root, &relative_str, None)
}

// ── workspace_search（后端施工计划书 Phase 1 §3）────────────────────────────

pub const SEARCH_MAX_RESULTS: usize = 200;
pub const SEARCH_MAX_FILES: usize = 400;
pub const SEARCH_MAX_BYTES_PER_FILE: usize = 256 * 1024;
pub const SEARCH_MAX_LINE_CHARS: usize = 500;

/// 搜索结果 DTO（wire camelCase：{path, line, lineText}；path 相对 root、`/` 分隔）。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub path: String,
    pub line: usize,
    pub line_text: String,
}

/// 搜索硬上限（防无界 IO/超大 payload；结果数 max_results 仅允许向下 clamp）。
#[derive(Debug, Clone, Copy)]
pub struct SearchLimits {
    pub max_results: usize,
    pub max_files: usize,
    pub max_bytes_per_file: usize,
    pub max_line_chars: usize,
}

/// 默认上限：max_results 参数只可向下 clamp 到硬上限 200。
pub fn default_search_limits(max_results: Option<usize>) -> SearchLimits {
    SearchLimits {
        max_results: max_results
            .unwrap_or(SEARCH_MAX_RESULTS)
            .min(SEARCH_MAX_RESULTS),
        max_files: SEARCH_MAX_FILES,
        max_bytes_per_file: SEARCH_MAX_BYTES_PER_FILE,
        max_line_chars: SEARCH_MAX_LINE_CHARS,
    }
}

/// 工作区全文行匹配（同步纯函数，command 应经 spawn_blocking 调用）。
/// 规则：空 query → 空列表；逐行大小写不敏感 contains（to_lowercase 折叠，
/// 中文恒等/ASCII 折叠/Unicode 边界由测试锁定）；忽略清单/隐藏过滤沿用
/// list_entries；目录 symlink 仅在 canonical 目标仍在 root 内时进入；文件
/// 打开沿用 open_workspace_file 的 containment 复核（TOCTOU）；GBK 复用
/// decode_text 解码后搜索；命中达 max_results 或扫描文件达 max_files 即停。
pub fn search(
    root: &Path,
    query: &str,
    limits: SearchLimits,
) -> Result<Vec<WorkspaceSearchResult>, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() || limits.max_results == 0 {
        return Ok(Vec::new());
    }
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let mut scanned_files = 0usize;
    // 方案 1D：canonical visited 集合防环——同 canonical 目录只扫描一次，
    // 内部目录 symlink/junction 环（指向自身/祖先）在此截断，避免无限递归。
    let mut visited = std::collections::HashSet::new();
    walk_search(
        root,
        root,
        "",
        query,
        &query_lower,
        limits,
        &mut results,
        &mut scanned_files,
        &mut visited,
    )?;
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(results)
}

#[allow(clippy::too_many_arguments)] // 搜索遍历携带限额与结果累加器
fn walk_search(
    root: &Path,
    dir: &Path,
    dir_relative: &str,
    query: &str,
    query_lower: &str,
    limits: SearchLimits,
    results: &mut Vec<WorkspaceSearchResult>,
    scanned_files: &mut usize,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), WorkspaceError> {
    if results.len() >= limits.max_results || *scanned_files >= limits.max_files {
        return Ok(());
    }
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    // 方案 1D：目录进入前 canonicalize 去重。注意这里对真实目录与 symlink 目录
    // 一视同仁——real 目录与指向它的 symlink canonical 后同键，只扫一次。
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if !visited.insert(canonical_dir) {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    for item in entries {
        if results.len() >= limits.max_results || *scanned_files >= limits.max_files {
            break;
        }
        let item = item.map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) || name.starts_with('.') {
            continue;
        }
        let metadata =
            fs::symlink_metadata(item.path()).map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let relative = if dir_relative.is_empty() {
            name.clone()
        } else {
            format!("{dir_relative}/{name}")
        };
        if metadata.file_type().is_symlink() {
            // 目录 symlink 仅在 canonical 目标仍在 root 内时进入；断链/外部/文件链接跳过。
            // 进入后由 visited 去重防环（目标已在遍历路径上 → 跳过）。
            let target = item.path().canonicalize().ok();
            if let Some(target) = target {
                if target.starts_with(&canonical_root) && target.is_dir() {
                    walk_search(
                        root,
                        &item.path(),
                        &relative,
                        query,
                        query_lower,
                        limits,
                        results,
                        scanned_files,
                        visited,
                    )?;
                }
            }
            continue;
        }
        if metadata.is_dir() {
            walk_search(
                root,
                &item.path(),
                &relative,
                query,
                query_lower,
                limits,
                results,
                scanned_files,
                visited,
            )?;
        } else if metadata.is_file() {
            if *scanned_files >= limits.max_files {
                break;
            }
            *scanned_files += 1;
            search_file(root, &relative, query, query_lower, limits, results)?;
        }
    }
    Ok(())
}

fn search_file(
    root: &Path,
    relative: &str,
    _query: &str,
    query_lower: &str,
    limits: SearchLimits,
    results: &mut Vec<WorkspaceSearchResult>,
) -> Result<(), WorkspaceError> {
    // 沿用 open_workspace_file 的 containment 复核（TOCTOU：walk 与 open 之间
    // 路径可能被替换为指向 root 外的链接）。
    let (file, _) = open_workspace_file(root, relative)?;
    let mut bytes = Vec::with_capacity(limits.max_bytes_per_file.min(64 * 1024));
    file.take(limits.max_bytes_per_file as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.contains(&0) {
        return Ok(()); // 二进制跳过（不参与匹配）
    }
    let (content, _) = match decode_text(&bytes) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(()), // 不可解码跳过
    };
    for (index, raw_line) in content.split('\n').enumerate() {
        if results.len() >= limits.max_results {
            break;
        }
        let line = raw_line.trim_end_matches('\r');
        if line.to_lowercase().contains(query_lower) {
            let mut line_text = line.to_string();
            if line_text.chars().count() > limits.max_line_chars {
                line_text = line_text.chars().take(limits.max_line_chars).collect();
            }
            results.push(WorkspaceSearchResult {
                path: relative.replace('\\', "/"),
                line: index + 1,
                line_text,
            });
        }
    }
    Ok(())
}

pub fn workspace_root(source: String, root: &Path) -> WorkspaceRoot {
    match root.canonicalize() {
        Ok(path) => WorkspaceRoot {
            source,
            path: path.to_string_lossy().into_owned(),
            exists: true,
            readable: fs::read_dir(&path).is_ok(),
        },
        Err(_) => WorkspaceRoot {
            source,
            path: root.to_string_lossy().into_owned(),
            exists: false,
            readable: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// P91 批 C1（横切 §3）：唯一临时目录名（pid + nanos）——原纯 nanos 命名
    /// 无 pid 维度，跨测试进程可碰撞（时钟回拨/同刻并发），pid 隔离后不可能复用
    /// 他人目录。
    fn unique_workspace_temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-workspace-test-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn fixture() -> (TempDir, PathBuf) {
        let dir = unique_workspace_temp("fixture");
        let root = dir.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "hello").unwrap();
        (TempDir(dir), root)
    }

    #[test]
    fn path_rejects_traversal_and_drive_prefix() {
        let (_dir, root) = fixture();
        assert_eq!(
            resolve_workspace_path(&root, "../secret"),
            Err(WorkspaceError::TraversalRejected)
        );
        assert_eq!(
            resolve_workspace_path(&root, "C:\\Windows\\win.ini"),
            Err(WorkspaceError::AbsolutePathRejected)
        );
        // O30：NUL 字节入口即拒
        assert_eq!(
            resolve_workspace_path(&root, "a\0b.txt"),
            Err(WorkspaceError::AbsolutePathRejected)
        );
        assert!(resolve_workspace_path(&root, "./src\\main.ts").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_root_is_rejected() {
        use std::os::unix::fs::symlink;
        let (dir, root) = fixture();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, root.join("link.txt")).unwrap();
        assert_eq!(
            resolve_workspace_path(&root, "link.txt"),
            Err(WorkspaceError::OutsideRoot)
        );
    }

    #[test]
    fn list_sorts_and_ignores_defaults() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::create_dir(root.join("z-dir")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        let result = list_entries(&root, ".", false).unwrap();
        assert_eq!(
            result.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["src", "z-dir", "a.txt"]
        );
    }

    #[test]
    fn text_preview_is_limited_and_rejects_nul() {
        let (_dir, root) = fixture();
        fs::write(root.join("long.txt"), "1234567890").unwrap();
        let preview = read_text(&root, "long.txt", Some(4)).unwrap();
        assert_eq!(preview.content, "1234");
        assert_eq!(preview.bytes_read, 4);
        assert_eq!(preview.total_bytes, 10);
        assert!(preview.truncated);
        fs::write(root.join("binary.bin"), [1u8, 0, 2]).unwrap();
        assert_eq!(
            read_text(&root, "binary.bin", None),
            Err(WorkspaceError::BinaryFile)
        );
    }

    #[test]
    fn text_preview_multibyte_truncation_stays_utf8() {
        // C3：256KB+ 中文文件，截断点落在多字节字符中间时回退到字符边界，
        // 不得误报 BinaryFile；内容必须是完整字符序列。
        let (_dir, root) = fixture();
        let content = "中".repeat(100_000);
        fs::write(root.join("zh.txt"), &content).unwrap();
        let preview = read_text(&root, "zh.txt", None).unwrap();
        assert!(preview.truncated);
        assert!(preview.bytes_read > 0);
        assert_eq!(preview.bytes_read % 3, 0, "截断必须停在 UTF-8 字符边界");
        assert_eq!(preview.bytes_read, preview.content.len());
        assert!(preview.content.chars().all(|c| c == '中'));
    }

    #[test]
    fn text_preview_detects_gbk_and_strips_utf8_bom() {
        // R22：GBK 字节文件可预览（encoding 回填 "gbk"）；UTF-8 BOM 剥离。
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]; // "中文测试"
        fs::write(root.join("gbk.txt"), gbk).unwrap();
        let preview = read_text(&root, "gbk.txt", None).unwrap();
        assert_eq!(preview.content, "中文测试");
        assert_eq!(preview.encoding, "gbk");
        fs::write(root.join("bom.txt"), b"\xEF\xBB\xBFhello").unwrap();
        let preview = read_text(&root, "bom.txt", None).unwrap();
        assert_eq!(preview.content, "hello");
        assert_eq!(preview.encoding, "utf-8");
        assert_eq!(preview.bytes_read, 8);
    }

    #[test]
    fn text_preview_gbk_truncation_backs_off() {
        // R22：GBK 2 字节字符被截断只剩 lead 字节时回退，不误报 binary。
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA]; // "中文测" + 截断的 "试"
        fs::write(root.join("gbk2.txt"), gbk).unwrap();
        let preview = read_text(&root, "gbk2.txt", Some(7)).unwrap();
        assert_eq!(preview.content, "中文测");
        assert_eq!(preview.encoding, "gbk");
    }

    #[test]
    fn text_preview_gbk_repeated_char_truncation_not_binary() {
        // S6：GBK 常用字 lead/trail 字节（啊=B0A1）全落 0x80..=0xBF，旧逻辑按
        // UTF-8 续字节回退会一路退到 end==0 而误报 BinaryFile；修复后整段交给
        // decode_text 的 GBK 1 字节回退，预览成功且 encoding=gbk。
        let (_dir, root) = fixture();
        let gbk: Vec<u8> = (0..=DEFAULT_PREVIEW_BYTES)
            .flat_map(|_| [0xB0u8, 0xA1])
            .collect();
        fs::write(root.join("gbk-rep.txt"), &gbk).unwrap();
        let preview = read_text(&root, "gbk-rep.txt", None).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.encoding, "gbk");
        assert_eq!(preview.bytes_read, DEFAULT_PREVIEW_BYTES);
        assert_eq!(preview.content, "啊".repeat(DEFAULT_PREVIEW_BYTES / 2));
    }

    // ── workspace_search（Phase 1 §3.3）──

    fn search_fixture() -> (TempDir, PathBuf) {
        let (dir, root) = fixture();
        fs::write(
            root.join("src/main.ts"),
            "hello world needle\nHELLO Rust\n中文内容 needle\n",
        )
        .unwrap();
        fs::write(root.join("docs.md"), "needle in docs\nplain\n").unwrap();
        fs::create_dir_all(root.join("src/node_modules")).unwrap();
        fs::write(root.join("src/node_modules/deep.txt"), "needle nested\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules/pkg.txt"),
            "needle in node_modules\n",
        )
        .unwrap();
        fs::write(root.join(".hidden.txt"), "needle hidden\n").unwrap();
        fs::write(
            root.join("gbk.txt"),
            [
                0xB2, 0xE2, 0xCE, 0xC4, 0x20, 0x6E, 0x65, 0x65, 0x64, 0x6C, 0x65, 0x0A,
            ],
        )
        .unwrap(); // "中文 needle\n" GBK
        fs::write(root.join("bom.md"), "\u{FEFF}needle bom\n").unwrap();
        fs::write(
            root.join("binary.bin"),
            [1u8, 0, 2, b'n', b'e', b'e', b'd', b'l', b'e'],
        )
        .unwrap();
        (dir, root)
    }

    #[test]
    fn search_matches_case_insensitive_and_line_numbers() {
        let (_dir, root) = search_fixture();
        let limits = default_search_limits(None);
        let found = search(&root, "NEEDLE", limits).unwrap();
        // 命中文件：src/main.ts（两行 needle 大小写）、docs.md、gbk.txt、bom.md；
        // 忽略 node_modules / .hidden / src/ignored；binary.bin 含 NUL 跳过
        let paths: Vec<&str> = found.iter().map(|r| r.path.as_str()).collect();
        assert!(
            paths.contains(&"src/main.ts"),
            "UTF-8 必须命中（{paths:?}）"
        );
        assert!(paths.contains(&"docs.md"), "普通文件必须命中");
        assert!(paths.contains(&"gbk.txt"), "GBK 解码后必须命中");
        assert!(paths.contains(&"bom.md"), "BOM 必须命中");
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "忽略目录（含嵌套）不得进入"
        );
        assert!(
            !paths.iter().any(|p| p.contains(".hidden")),
            "隐藏文件不得进入"
        );
        assert!(!paths.contains(&"binary.bin"), "二进制不得命中");
        let main_hits: Vec<_> = found.iter().filter(|r| r.path == "src/main.ts").collect();
        assert_eq!(main_hits.len(), 2, "多行命中逐行计（{main_hits:?}）");
        assert_eq!(main_hits[0].line, 1);
        assert_eq!(main_hits[1].line, 3);
        assert!(main_hits.iter().all(|r| !r.line_text.contains('\r')));
    }

    #[test]
    fn search_empty_query_and_limits() {
        let (_dir, root) = search_fixture();
        assert_eq!(
            search(&root, "   ", default_search_limits(None)).unwrap(),
            Vec::new(),
            "空 query 必须空列表不扫描"
        );
        let tiny = SearchLimits {
            max_results: 1,
            max_files: 400,
            max_bytes_per_file: 256 * 1024,
            max_line_chars: 500,
        };
        let found = search(&root, "needle", tiny).unwrap();
        assert!(found.len() <= 1, "max_results 必须截断");
        let clamped = default_search_limits(Some(9999));
        assert_eq!(
            clamped.max_results, SEARCH_MAX_RESULTS,
            "max_results 只能向下 clamp"
        );
        let zero = SearchLimits {
            max_results: 0,
            max_files: 400,
            max_bytes_per_file: 256 * 1024,
            max_line_chars: 500,
        };
        assert_eq!(search(&root, "needle", zero).unwrap(), Vec::new());
    }

    #[test]
    fn search_truncates_long_lines_and_sorts_stable() {
        let (_dir, root) = search_fixture();
        fs::write(
            root.join("long.txt"),
            format!("needle {}\n", "长".repeat(1200)),
        )
        .unwrap();
        let limits = SearchLimits {
            max_results: 200,
            max_files: 400,
            max_bytes_per_file: 256 * 1024,
            max_line_chars: 500,
        };
        let found = search(&root, "needle", limits).unwrap();
        let long = found
            .iter()
            .find(|r| r.path == "long.txt")
            .expect("long.txt 必须命中");
        assert!(long.line_text.chars().count() <= 500, "单行返回必须截断");
        let pairs: Vec<_> = found.iter().map(|r| (r.path.as_str(), r.line)).collect();
        let mut sorted = pairs.clone();
        sorted.sort_by(|a, b| a.0.cmp(b.0).then(a.1.cmp(&b.1)));
        assert_eq!(pairs, sorted, "输出必须稳定排序");
    }

    #[cfg(unix)]
    #[test]
    fn search_skips_symlinks_outside_root_and_broken() {
        use std::os::unix::fs::symlink;
        let (dir, root) = search_fixture();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "needle outside\n").unwrap();
        symlink(&outside, root.join("evil.txt")).unwrap();
        symlink(root.join("missing-target"), root.join("broken-link")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(
            !found.iter().any(|r| r.path == "evil.txt"),
            "root 外文件 symlink 不得进入"
        );
        assert!(
            !found.iter().any(|r| r.path == "broken-link"),
            "断链必须跳过"
        );
    }

    #[cfg(unix)]
    #[test]
    fn search_terminates_on_internal_directory_cycle() {
        // 方案 1D 测试门：目录内 symlink 指向祖先（环，canonical 仍在 root 内）
        // 必须有限时间返回，不得无限递归/栈溢出。
        use std::os::unix::fs::symlink;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), "needle in sub\n").unwrap();
        // sub/loop -> .. 即 root：walk 进入 sub 后再进入 root 会形成环。
        symlink("..", root.join("sub/loop")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(
            found.iter().any(|r| r.path == "sub/file.txt"),
            "环内正常文件仍应命中"
        );
    }

    #[cfg(unix)]
    #[test]
    fn search_scans_same_canonical_directory_once() {
        // 方案 1D：同 canonical 目录只扫一次——两个目录 symlink 指向同一真实目录，
        // 命中文件不重复出现。
        use std::os::unix::fs::symlink;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/only.txt"), "needle shared\n").unwrap();
        symlink("target", root.join("alias-a")).unwrap();
        symlink("target", root.join("alias-b")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        let hits: Vec<&str> = found.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            hits.iter().filter(|p| p.contains("only.txt")).count(),
            1,
            "同 canonical 目录只贡献一份结果: {hits:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn search_terminates_on_internal_junction_cycle() {
        // 方案 1D（Windows）：目录 junction 环同样必须有限时间返回。
        // junction/symlink 创建可能因权限不足（需开发者模式/管理员）失败——
        // 此时明确 skip 而非失败（方案标注：Windows junction 权限不满足时明确 skip）。
        use std::os::windows::fs::symlink_dir;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), "needle in sub\n").unwrap();
        if symlink_dir("..", root.join("sub/loop")).is_err() {
            eprintln!("skip: 创建 junction/symlink 无权限（需要开发者模式）");
            return;
        }
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(
            found.iter().any(|r| r.path == "sub/file.txt"),
            "环内正常文件仍应命中"
        );
    }

    #[test]
    fn search_missing_root_reports_not_found() {
        let (_dir, root) = search_fixture();
        let missing = root.join("no-such-dir");
        assert_eq!(
            search(&missing, "needle", default_search_limits(None)),
            Err(WorkspaceError::NotFound)
        );
    }

    #[test]
    fn workspace_error_display_is_stable() {
        // R5b 契约锁定：Display 文案（code: message）与手写 impl 逐字一致。
        assert_eq!(
            WorkspaceError::AbsolutePathRejected.to_string(),
            "absolute_path_rejected: 不允许使用绝对路径"
        );
        assert_eq!(
            WorkspaceError::TraversalRejected.to_string(),
            "traversal_rejected: 不允许路径穿越"
        );
        assert_eq!(
            WorkspaceError::OutsideRoot.to_string(),
            "outside_root: 路径位于工作区之外"
        );
        assert_eq!(
            WorkspaceError::NotFound.to_string(),
            "not_found: 路径不存在"
        );
        assert_eq!(
            WorkspaceError::NotReadable.to_string(),
            "not_readable: 路径不可读取"
        );
        assert_eq!(
            WorkspaceError::NotFile.to_string(),
            "not_file: 路径不是文件"
        );
        assert_eq!(
            WorkspaceError::BinaryFile.to_string(),
            "binary_file: 文件不是可预览的 UTF-8 文本"
        );
        assert_eq!(
            WorkspaceError::TooManyEntries.to_string(),
            "too_many_entries: 目录条目超过限制"
        );
        // Io 变体：内部 String 不参与 Display（历史契约，勿改）
        assert_eq!(
            WorkspaceError::Io("detail".into()).to_string(),
            "io_error: 工作区 I/O 操作失败"
        );
        // I08-A-FE-02：保存域错误码文案锁定（前端按 conflict/too_large 分类）
        assert_eq!(
            WorkspaceError::Conflict.to_string(),
            "conflict: 磁盘文件已被外部修改，保存已拒绝"
        );
        assert_eq!(
            WorkspaceError::TooLarge.to_string(),
            "too_large: 文件过大，无法编辑保存"
        );
    }

    // ── I08-A-FE-02：真实编辑/save vertical slice（write_text L1 证据，AC-1）──
    // 契约：write_text(root, relative, content, expected_baseline, force)
    // - 保存成功更新磁盘内容并返回新 preview（前端以此作新基线）
    // - expected_baseline 与磁盘当前文本不一致 → Conflict（外部修改不得被静默覆盖）
    // - force=true 显式跳过基线检查（冲突流程的"覆盖保存"）
    // - BOM/GBK 编码 round-trip；> MAX_SAVE_BYTES 拒绝（大文件保持只读）

    #[test]
    fn write_text_round_trips_content_and_returns_preview() {
        let (_dir, root) = fixture();
        fs::write(root.join("src/main.ts"), "const a = 1\n").unwrap();
        let preview = write_text(
            &root,
            "src/main.ts",
            "const a = 2\nconst b = 3\n",
            Some("const a = 1\n"),
            false,
        )
        .unwrap();
        assert_eq!(preview.content, "const a = 2\nconst b = 3\n");
        assert!(!preview.truncated);
        assert_eq!(preview.relative_path, "src/main.ts");
        let on_disk = fs::read_to_string(root.join("src/main.ts")).unwrap();
        assert_eq!(on_disk, "const a = 2\nconst b = 3\n", "保存必须真实写盘");
    }

    #[test]
    fn write_text_preserves_utf8_bom() {
        let (_dir, root) = fixture();
        fs::write(root.join("bom.ts"), b"\xEF\xBB\xBFhello\n").unwrap();
        write_text(&root, "bom.ts", "hello world\n", Some("hello\n"), false).unwrap();
        let bytes = fs::read(root.join("bom.ts")).unwrap();
        assert!(
            bytes.starts_with(b"\xEF\xBB\xBF"),
            "UTF-8 BOM 文件保存后必须保留 BOM"
        );
        let preview = read_text(&root, "bom.ts", None).unwrap();
        assert_eq!(preview.content, "hello world\n");
        assert_eq!(preview.encoding, "utf-8");
    }

    #[test]
    fn write_text_round_trips_gbk_encoding() {
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x0A]; // "中文测试\n"（GBK）
        fs::write(root.join("gbk.txt"), gbk).unwrap();
        write_text(&root, "gbk.txt", "新内容\n", Some("中文测试\n"), false).unwrap();
        let preview = read_text(&root, "gbk.txt", None).unwrap();
        assert_eq!(preview.content, "新内容\n");
        assert_eq!(
            preview.encoding, "gbk",
            "GBK 文件保存后必须仍以 GBK 编码写盘（不悄悄转 UTF-8）"
        );
    }

    // ── ISSUE-15 W3 RED fixtures：GBK 文件以 EF BB BF（UTF-8 BOM 字节）开头时，
    // 无条件剥 BOM 会静默丢首字符（修复前必须失败）──────────────────────────
    // 实证：GBK 字节序列 EF BB BF 41 42 BC D3 解码为 (EF BB)(BF 41)(42)(BC D3) 共 4
    // 字符且 GBK decode→encode 完美 round-trip；当前 decode_text 先 strip_prefix
    // b"\xEF\xBB\xBF" 再判定 → 首字符 (EF BB) 被静默丢弃。

    #[test]
    fn decode_text_keeps_gbk_bytes_starting_with_utf8_bom_bytes() {
        let bytes: &[u8] = &[0xEF, 0xBB, 0xBF, 0x41, 0x42, 0xBC, 0xD3];
        let (text, encoding) = decode_text(bytes).expect("GBK 必须可解码");
        assert_eq!(encoding, "gbk", "以 EF BB BF 开头的 GBK 不得误判为 utf-8");
        let (encoded, _, had_errors) = encoding_rs::GBK.encode(&text);
        assert!(!had_errors);
        assert_eq!(
            encoded.as_ref(),
            bytes,
            "GBK 解码→重新编码必须字节级还原（首字符不得丢失）"
        );
    }

    #[test]
    fn read_write_round_trips_gbk_file_starting_with_bom_bytes() {
        // 集成 RED：真实文件字节以 EF BB BF 开头 → read_text → write_text（原样写回）
        // → 磁盘字节必须与原始完全一致（首字符不得因剥 BOM 丢失）。
        let (_dir, root) = fixture();
        let original: &[u8] = &[0xEF, 0xBB, 0xBF, 0x41, 0x42, 0xBC, 0xD3];
        let path = "src/gbk-bom-prefix.txt";
        fs::write(root.join(path), original).unwrap();
        let preview = read_text(&root, path, None).unwrap();
        assert_eq!(
            preview.encoding, "gbk",
            "EF BB BF 前缀的 GBK 文件必须识别为 gbk 而非 utf-8"
        );
        write_text(&root, path, &preview.content, Some(&preview.content), false).unwrap();
        let on_disk = fs::read(root.join(path)).unwrap();
        assert_eq!(
            on_disk, original,
            "原样写回后磁盘字节必须逐字节一致（read→write 无损）"
        );
    }

    #[test]
    fn write_text_rejects_traversal_and_absolute_paths() {
        let (_dir, root) = fixture();
        assert_eq!(
            write_text(&root, "../secret", "x", Some("x"), false),
            Err(WorkspaceError::TraversalRejected)
        );
        assert_eq!(
            write_text(&root, "C:\\Windows\\win.ini", "x", Some("x"), false),
            Err(WorkspaceError::AbsolutePathRejected)
        );
        assert_eq!(
            write_text(&root, "a\0b.txt", "x", Some("x"), false),
            Err(WorkspaceError::AbsolutePathRejected)
        );
    }

    #[test]
    fn write_text_missing_file_returns_not_found() {
        let (_dir, root) = fixture();
        assert_eq!(
            write_text(&root, "nope.txt", "x", Some("x"), false),
            Err(WorkspaceError::NotFound)
        );
    }

    #[test]
    fn write_text_directory_target_returns_not_file() {
        let (_dir, root) = fixture();
        fs::create_dir(root.join("adir")).unwrap();
        assert_eq!(
            write_text(&root, "adir", "x", Some("x"), false),
            Err(WorkspaceError::NotFile)
        );
    }

    #[test]
    fn write_text_detects_external_modification_conflict_without_writing() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "v1\n").unwrap();
        // 磁盘内容已在基线之后被外部程序修改
        fs::write(root.join("a.txt"), "external change\n").unwrap();
        let error = write_text(&root, "a.txt", "user edit\n", Some("v1\n"), false)
            .expect_err("基线不匹配必须进入冲突流程");
        assert_eq!(error, WorkspaceError::Conflict);
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "external change\n",
            "冲突时不得静默覆盖磁盘内容"
        );
    }

    #[test]
    fn write_text_force_overwrites_despite_conflict() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "external change\n").unwrap();
        let preview = write_text(
            &root,
            "a.txt",
            "user overwrite\n",
            Some("old baseline\n"),
            true,
        )
        .unwrap();
        assert_eq!(preview.content, "user overwrite\n");
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "user overwrite\n"
        );
    }

    #[test]
    fn write_text_without_baseline_skips_conflict_check() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "whatever\n").unwrap();
        let preview = write_text(&root, "a.txt", "saved\n", None, false).unwrap();
        assert_eq!(preview.content, "saved\n");
    }

    #[test]
    fn write_text_rejects_oversized_content() {
        let (_dir, root) = fixture();
        fs::write(root.join("big.txt"), "small\n").unwrap();
        let huge = "x".repeat(MAX_SAVE_BYTES + 1);
        assert_eq!(
            write_text(&root, "big.txt", &huge, Some("small\n"), false),
            Err(WorkspaceError::TooLarge)
        );
    }

    #[test]
    fn write_text_rejects_oversized_existing_file() {
        let (_dir, root) = fixture();
        fs::write(root.join("big.txt"), "x".repeat(MAX_SAVE_BYTES + 1)).unwrap();
        assert_eq!(
            write_text(&root, "big.txt", "y", Some("y"), false),
            Err(WorkspaceError::TooLarge)
        );
    }

    // ── 0-C1：is_safe_segment（新建名字谓词）─────────────────────────────────

    #[test]
    fn safe_segment_accepts_plain_names() {
        assert!(is_safe_segment("a.txt"));
        assert!(is_safe_segment("中文.md"));
        assert!(is_safe_segment("a b.txt"));
        // 前导点是隐藏文件形态（.gitignore 必须可创建），仅尾点拒绝。
        assert!(is_safe_segment(".gitignore"));
        assert!(is_safe_segment("v1.2.3"));
    }

    #[test]
    fn safe_segment_rejects_separators_traversal_and_edge_whitespace() {
        assert!(!is_safe_segment(""));
        assert!(!is_safe_segment("  "));
        assert!(!is_safe_segment("a "));
        assert!(!is_safe_segment(" a"));
        assert!(!is_safe_segment("a."));
        assert!(!is_safe_segment("."));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a\\b"));
        assert!(!is_safe_segment("a:b"));
        assert!(!is_safe_segment("a*b"));
        assert!(!is_safe_segment("a?b"));
        assert!(!is_safe_segment("a\"b"));
        assert!(!is_safe_segment("a<b"));
        assert!(!is_safe_segment("a>b"));
        assert!(!is_safe_segment("a|b"));
        assert!(!is_safe_segment("a\nb"));
        assert!(!is_safe_segment("a\0b"));
    }

    #[test]
    fn safe_segment_rejects_windows_reserved_device_names() {
        for name in [
            "CON", "con", "Con.txt", "PRN", "AUX", "NUL", "com1", "LPT9", "lpt4.bak",
        ] {
            assert!(!is_safe_segment(name), "{name} 应被拒绝");
        }
        // 保留名仅在 stem 命中时拒绝；".con" 的 stem 为空，是合法隐藏名。
        assert!(is_safe_segment(".con"));
    }

    #[test]
    fn safe_segment_rejects_overlong_names() {
        assert!(is_safe_segment(&"a".repeat(255)));
        assert!(!is_safe_segment(&"a".repeat(256)));
        // UTF-16 口径：127 个星面字符 = 254 units 放行，128 个 = 256 units 拒绝。
        assert!(is_safe_segment(&"\u{1F600}".repeat(127)));
        assert!(!is_safe_segment(&"\u{1F600}".repeat(128)));
    }

    #[test]
    fn safe_segment_rejects_bidi_direction_controls() {
        assert!(!is_safe_segment("a\u{202E}b")); // RLO
        assert!(!is_safe_segment("\u{200F}a")); // RLM
        assert!(!is_safe_segment("a\u{2066}b")); // LRI
    }

    #[test]
    fn safe_segment_rejects_reserved_stem_with_trailing_space_before_extension() {
        assert!(!is_safe_segment("CON .txt"));
        assert!(!is_safe_segment("nul  .md"));
    }

    // ── 0-C1：list_workspace_files（quick open 索引）────────────────────────

    fn index_fixture() -> (TempDir, PathBuf) {
        let dir = unique_workspace_temp("index");
        let root = dir.join("root");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("src/main.ts"), "x").unwrap();
        fs::write(root.join("src/deep/util.ts"), "x").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(root.join(".hidden/secret.txt"), "x").unwrap();
        (TempDir(dir), root)
    }

    #[test]
    fn list_files_enumerates_files_skipping_ignored_and_hidden_dirs() {
        let (_dir, root) = index_fixture();
        let page = list_workspace_files(&root, None).unwrap();
        assert_eq!(
            page.entries,
            vec!["README.md", "src/deep/util.ts", "src/main.ts"]
        );
        assert!(!page.truncated);
    }

    #[test]
    fn list_files_does_not_follow_symlink_directories() {
        let (_dir, root) = index_fixture();
        // Windows 无开发者模式/特权时 symlink 创建失败——该环境直接跳过（断言
        // 在有特权环境与 CI 上生效）。
        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(root.join("node_modules"), root.join("link")).is_err() {
                return;
            }
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(root.join("node_modules"), root.join("link"))
                .is_err()
            {
                return;
            }
        }
        let page = list_workspace_files(&root, None).unwrap();
        // symlink 目录本身不进索引（只列文件），也不下钻出 node_modules 内容。
        assert_eq!(
            page.entries,
            vec!["README.md", "src/deep/util.ts", "src/main.ts"]
        );
    }

    /// #603 差分：文档契约是「含 symlink 文件、不含 symlink 目录」——只看目录那一侧，
    /// 会把「一律跳过 symlink」这种过度修正误判为通过。
    #[test]
    fn list_files_indexes_symlink_files_but_not_symlink_directories() {
        let (_dir, root) = index_fixture();
        #[cfg(unix)]
        {
            let linked_file =
                std::os::unix::fs::symlink(root.join("README.md"), root.join("readme-link.md"));
            let linked_dir =
                std::os::unix::fs::symlink(root.join("node_modules"), root.join("modules-link"));
            if linked_file.is_err() || linked_dir.is_err() {
                return;
            }
        }
        #[cfg(windows)]
        {
            let linked_file = std::os::windows::fs::symlink_file(
                root.join("README.md"),
                root.join("readme-link.md"),
            );
            let linked_dir = std::os::windows::fs::symlink_dir(
                root.join("node_modules"),
                root.join("modules-link"),
            );
            if linked_file.is_err() || linked_dir.is_err() {
                return;
            }
        }
        let page = list_workspace_files(&root, None).unwrap();
        assert!(
            page.entries.iter().any(|entry| entry == "readme-link.md"),
            "文件 symlink 必须进索引: {:?}",
            page.entries
        );
        assert!(
            !page
                .entries
                .iter()
                .any(|entry| entry.contains("modules-link")),
            "目录 symlink 不得进索引: {:?}",
            page.entries
        );
    }

    #[test]
    fn list_files_caps_at_limit_and_reports_truncated() {
        let (_dir, root) = index_fixture();
        let page = list_workspace_files(&root, Some(2)).unwrap();
        assert_eq!(page.entries.len(), 2);
        assert!(page.truncated);
        // 上限钳制：超过 MAX_FILE_INDEX_ENTRIES 的请求也被压回硬上限。
        let clamped = list_workspace_files(&root, Some(MAX_FILE_INDEX_ENTRIES + 500)).unwrap();
        assert!(!clamped.truncated);
        assert_eq!(clamped.entries.len(), 3);
    }

    #[test]
    fn list_files_exact_limit_is_not_truncated() {
        let (_dir, root) = index_fixture();
        // 恰好等于 limit（fixture 恒 3 个文件）：truncated 必须为 false。
        let page = list_workspace_files(&root, Some(3)).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert!(!page.truncated);
    }

    #[test]
    fn list_files_zero_limit_yields_empty_truncated_page() {
        let (_dir, root) = index_fixture();
        let page = list_workspace_files(&root, Some(0)).unwrap();
        assert!(page.entries.is_empty());
        assert!(page.truncated);
    }

    #[test]
    fn list_files_filters_hidden_files_in_root() {
        let (_dir, root) = index_fixture();
        fs::write(root.join(".env"), "x").unwrap();
        let page = list_workspace_files(&root, None).unwrap();
        assert_eq!(
            page.entries,
            vec!["README.md", "src/deep/util.ts", "src/main.ts"]
        );
    }

    #[test]
    fn list_files_missing_root_is_not_found() {
        let (dir, _root) = index_fixture();
        let missing = dir.0.join("root").join("nope");
        assert_eq!(
            list_workspace_files(&missing, None),
            Err(WorkspaceError::NotFound)
        );
    }
}
