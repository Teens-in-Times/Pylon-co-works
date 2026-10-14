//! 子进程启动收口：Windows 控制台窗口隐藏（`CREATE_NO_WINDOW`）。
//!
//! 这一层之所以是跨 crate 的地基模块，而不是某个 crate 内的局部 helper：发行构建
//! （#361）的 `pylon.exe` 是 **GUI 子系统**，进程没有自己的控制台。此时任何未带
//! `CREATE_NO_WINDOW` 的 console 子进程 spawn 都会由 Windows **分配一个新的可见
//! 控制台窗口**（用户看到黑框闪窗）；debug 构建是 console 子系统，子进程附着在
//! 父控制台上，这个缺陷不可见——所以覆盖必须落在**全仓生产 spawn**，而不是单点。
//!
//! 收口用 trait 而非自由函数：调用点同时使用 `std::process::Command` 与
//! `tokio::process::Command`，类型不同、语义相同，trait 让两种收口写法一致
//! 且可链式调用。
//!
//! 非 Windows 平台为 no-op（`CREATE_NO_WINDOW` 是 Windows 的 `CreateProcess`
//! 标志位，别的平台没有对应概念）。

use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

/// `CREATE_NO_WINDOW`：子进程不分配控制台窗口（控制台句柄为 NULL，不是"隐藏的
/// 窗口"，所以不会有一闪而过的黑框）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一收口：给子进程命令加上"不弹控制台窗口"。
pub trait HideConsoleWindow {
    /// Windows：设置 `CREATE_NO_WINDOW`；其他平台 no-op。返回 `&mut Self` 供链式调用。
    fn hide_console_window(&mut self) -> &mut Self;
}

impl HideConsoleWindow for StdCommand {
    fn hide_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl HideConsoleWindow for TokioCommand {
    fn hide_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// `CREATE_NEW_CONSOLE`：为子进程显式分配一个新控制台。
    ///
    /// 仅供下面差分用例的**控制组**使用（#617）：控制组必须有一个可看见的控制台
    /// 才能证明探针没坏，而"不加任何标志位"只会在父进程本身是控制台进程时成立——
    /// CI runner 与任何一种无控制台的宿主（编辑器任务、agent 执行器）都让控制组
    /// 静默失效。改成显式新建后，控制组的成立与父进程形态解耦。
    ///
    /// 落在这里（而非模块级）是刻意的：它是测试专用常量，放模块级会让非测试构建
    /// 多出一条 `dead_code`。
    #[cfg(windows)]
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    /// 设置标志位不得破坏 spawn：std 与 tokio 两条路径都必须仍能启动并等待退出。
    ///
    /// （标志位的**可见效果**由下面那条差分用例证明；这条只钉「加了标志位还能跑」。）
    #[cfg(windows)]
    #[tokio::test]
    async fn both_command_kinds_still_spawn_with_the_flag() {
        let mut std_command = StdCommand::new("cmd");
        std_command
            .args(["/C", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .hide_console_window();
        let status = std_command.status().expect("std spawn");
        assert!(status.success());

        let mut tokio_command = TokioCommand::new("cmd");
        tokio_command
            .args(["/C", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .hide_console_window();
        let status = tokio_command.status().await.expect("tokio spawn");
        assert!(status.success());
    }

    /// 差分验收：#361 的「不弹控制台窗口」是可机器验证的。
    ///
    /// 做法是把测试可执行文件自己再拉起来一次（`--exact console_probe_child`），
    /// 子进程用 `GetConsoleWindow()` 报告自己有没有控制台窗口，父进程收 stdout：
    /// - **控制组**（`CREATE_NEW_CONSOLE`）：子进程被显式分配到一个带窗口的控制台
    ///   → 非 0；
    /// - **实验组**（`CREATE_NO_WINDOW`）：控制台窗口句柄为 NULL → 0。
    ///
    /// 控制组是这条用例的关键：它证明探针本身能看见窗口，否则「读到 0」也可能只是
    /// 探针坏了。
    ///
    /// #617：控制组从"不加标志位"改为显式 `CREATE_NEW_CONSOLE`。原写法把控制组的
    /// 成立押在父进程自己有控制台上，CI（无控制台）下恒失败；新写法不依赖该前提。
    #[cfg(windows)]
    #[test]
    fn hiding_the_console_window_removes_the_window_handle() {
        let inherited = probe_child_console_window(ProbeConsole::ControlGroup);
        let hidden = probe_child_console_window(ProbeConsole::Hidden);
        assert_ne!(
            inherited, 0,
            "控制组必须看得见控制台窗口（否则探针无效，下面的 0 不能作数）"
        );
        assert_eq!(
            hidden, 0,
            "CREATE_NO_WINDOW 下子进程的控制台窗口句柄必须为 NULL"
        );
    }

    /// 探针子进程的控制台形态。
    #[cfg(windows)]
    #[derive(Clone, Copy)]
    enum ProbeConsole {
        /// 控制组：显式新建控制台，`GetConsoleWindow()` 必须非 0。
        ControlGroup,
        /// 实验组：`CREATE_NO_WINDOW`，`GetConsoleWindow()` 必须为 0。
        Hidden,
    }

    /// 把本测试可执行文件以 `console_probe_child` 用例再跑一次，返回它报告的 HWND。
    #[cfg(windows)]
    fn probe_child_console_window(console: ProbeConsole) -> isize {
        use std::os::windows::process::CommandExt;

        let exe = std::env::current_exe().expect("resolved test executable");
        let mut command = StdCommand::new(exe);
        command
            .args([
                "--exact",
                "child_command::tests::console_probe_child",
                "--nocapture",
            ])
            .env("PYLON_CONSOLE_PROBE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match console {
            ProbeConsole::ControlGroup => command.creation_flags(CREATE_NEW_CONSOLE),
            ProbeConsole::Hidden => command.hide_console_window(),
        };
        let output = command.output().expect("probe child must run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .lines()
            .find_map(|line| line.strip_prefix("PYLON_CONSOLE_WINDOW="))
            .and_then(|value| value.trim().parse::<isize>().ok())
            .unwrap_or_else(|| panic!("探针子进程没有报告 HWND：{stdout}"))
    }

    /// 探针本体：只有在 `PYLON_CONSOLE_PROBE` 下才做事，正常整轮测试里空过。
    #[cfg(windows)]
    #[test]
    fn console_probe_child() {
        if std::env::var_os("PYLON_CONSOLE_PROBE").is_none() {
            return;
        }
        let handle = unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() } as isize;
        println!("PYLON_CONSOLE_WINDOW={handle}");
    }

    /// 非 Windows：收口是 no-op，只需保证两种 Command 都可链式调用。
    #[cfg(not(windows))]
    #[test]
    fn non_windows_accepts_both_command_kinds() {
        let mut std_command = StdCommand::new("true");
        std_command.hide_console_window();
        let mut tokio_command = TokioCommand::new("true");
        tokio_command.hide_console_window();
    }
}
