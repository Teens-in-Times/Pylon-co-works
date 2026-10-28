//! 用户 home 目录解析（全仓唯一实现，#685）。
//!
//! `USERPROFILE` 优先、`HOME` 兜底：Windows 通常只有前者，Unix 只有后者。
//! 宿主 `external_history` 与 `pylon-core` 的检测证据共用本模块——先前两份
//! 同语义副本只靠注释约定一致，任一侧增加回退即漂移。

use std::path::{Path, PathBuf};

/// 解析用户 home：显式值优先，否则读环境变量。
pub fn resolve_home_dir(explicit: Option<&Path>) -> Option<PathBuf> {
    explicit.map(Path::to_path_buf).or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    })
}

/// 无显式覆盖的 home（仅读环境变量）。
pub fn home_dir() -> Option<PathBuf> {
    resolve_home_dir(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_home_wins_over_environment() {
        let explicit = Path::new("/tmp/explicit-home");
        assert_eq!(
            resolve_home_dir(Some(explicit)),
            Some(explicit.to_path_buf())
        );
    }
}
