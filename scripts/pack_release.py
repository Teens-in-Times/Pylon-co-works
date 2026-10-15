"""Pylon Windows ZIP release packager（施工文档 Phase 1）。

产物布局：
    release/pylon-<version>-win64/
      pylon.exe
      pylon-detect.exe         # 独立 Agent 检测程序
      pylon-cli.exe            # CLI 工具（若存在）
      WebView2Loader.dll       # Tauri 启动必需（缺失 → 0xC0000135）
      resources/...            # 来自 src-tauri/target/release/resources
      agents.yaml              # 零 Agent 配置模板（仓库侧 agents.template.yaml，包内改名）
      README.txt
      LICENSE                  # 仓库许可原文（AGPL-3.0-only）
      NOTICE                   # 版权与第三方声明
      LICENSES/...             # 随附第三方许可原文
      portable.flag
      data/                    # 空目录，即唯一数据根（#482：便携唯一存储，flag 仅身份标记）
      tools/install-webview2.bat             # 缺 WebView2 Runtime 时的联网兜底安装
      resources/runtime/git/...              # Hermes 专用 PortableGit（完整运行时，仅 --with-runtime）
      resources/sdk/pylon-plugin-sdk.js     # 离线插件 SDK（纯浏览器 ESM）
      resources/sdk/pylon-plugin-manifest.schema.json
      tools/webview2-mcp/pylon-webview2-mcp.exe  # 自带的调试 MCP 服务器
      tools/webview2-mcp/README.md               # 接线与安全代价说明
      resources/docs-site/index.html        # 离线文档站（#371，pylon-docs:// 数据源）
    release/pylon-<version>-win64.zip
    release/pylon-<version>-win64.zip.sha256
    release/pylon-<version>-win64.manifest.json

脚本只负责收集、审计、压缩，不隐式执行构建；构建由 npm script 编排：
    npm run release:portable  =  build + plugin-sdk + docs:build:offline + tauri build --no-bundle + pylon-detect + pack

#402 起新增**显式**发行编排入口（不带编排参数时行为与历史一致）：
    --bump X.Y.Z-SUF   版本号落位 9 文件（package.json/tauri.conf/6 处 Cargo.toml + lock，
                       先例 6e7a22d3）并 pathspec 提交；--no-commit 只改不提交
    --build            本地跑 bun run release:portable 全链（#232 定位：预演/排障；
                       目标盘余量 < 10 GiB 时拒绝启动，#228/#399 纪律）
    --upload           main 归属守卫通过后打 v<version> tag 并推送，触发 release.yml
                       构建上传 GitHub Release（打 tag 即发行，#232）
组合示例（一键到「可发布」）：python scripts/pack_release.py --bump 0.3.2-EFF --build
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

# 标准输出固定为 UTF-8：Windows 上 stdout 默认走宿主 locale 编码，CI runner 是 cp1252，
# 而发行包内路径含中文（docs/说明书/...），直接 print 这些路径会抛 UnicodeEncodeError。
# 实测 release CI 在 zip/sha256/manifest 都已写出之后，崩在清单打印上（run 34594629111），
# 导致 verify_zip 从未执行。本地控制台能编码中文、CI 不能 —— 属 locale 依赖型缺陷，
# 故在脚本内固定编码，不依赖调用方设置 PYTHONIOENCODING。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent
SRC_TAURI_DIR = REPO_DIR / "src-tauri"
# #228 发行实践：G 盘满时本仓纪律是 CARGO_TARGET_DIR 落 D 盘（见 .agents/L.md）。
# cargo 与 tauri CLI 尊重该环境变量，本脚本随之从同源读取产物目录，保证
# 「构建指向哪、打包就从哪收」；未设置时维持默认 src-tauri/target。
_TARGET_ROOT = Path(os.environ.get("CARGO_TARGET_DIR", SRC_TAURI_DIR / "target"))
RELEASE_DIR = _TARGET_ROOT / "release"
TEMPLATE_DIR = REPO_DIR / "resources" / "release"
HERMES_RUNTIME_DIR = SRC_TAURI_DIR / "resources" / "runtime"
HERMES_RUNTIME_TREE = HERMES_RUNTIME_DIR / "git"
# 离线文档站（#371）的暂存源：stage-docs-site.mjs 每轮 rm+重铺保证新鲜。
# 打包从这里收（#471），不从 target 的 Tauri 增量拷贝收——那上面旧哈希代际永不清理。
DOCS_SITE_STAGED_DIR = SRC_TAURI_DIR / "resources" / "docs-site"
OUT_ROOT = REPO_DIR / "release"

EXE_NAME = "pylon.exe"
DETECT_EXE_NAME = "pylon-detect.exe"
# webview2-mcp：Pylon 自带的调试 MCP 服务器。它是**独立 crate**（不属 src-tauri
# workspace），release 产物落在自己的 target/ 下；包内与 README 同级放在 tools/ 里，
# 与其它随包脚本（install-webview2.bat 等）并列。
MCP_DIR = REPO_DIR / "tools" / "webview2-mcp"
# 独立 crate 不属 workspace：CARGO_TARGET_DIR 对它同样生效（ cargo 按调用进程环境），与上面同源。
MCP_RELEASE_DIR = Path(os.environ.get("CARGO_TARGET_DIR", MCP_DIR / "target")) / "release"
MCP_EXE_NAME = "pylon-webview2-mcp.exe"
MCP_PACKAGE_DIR = "tools/webview2-mcp"
TOP_DIR_PATTERN = re.compile(r"^pylon-[^/\\]+-win64/?$")

# agents.yaml 的禁令是防泄漏：不许把开发者/工作树的真实配置带进包。#372 起唯一例外
# 是包根的 agents.yaml——它只能由打包器从 release 模板（agents.template.yaml）改名
# 收取，内容是零 Agent 空表；任何其他位置（任意子目录）出现的 agents.yaml 仍视为
# 泄漏，一律拒绝。.env 没有例外。
FORBIDDEN_NAMES = {
    "agents.yaml",
    ".env",
}
# 发行模板在仓库侧不占用被禁的名字，打包时改名为包根 agents.yaml：用户拿到包即可
# 直接编辑预置 Agent，无需先复制改名。内容必须是零 Agent 空表——占位 Agent 必然
# 启动失败，首屏会变成报错而非引导（#326 裁决，#372 落地）。
AGENTS_TEMPLATE_SOURCE_NAME = "agents.template.yaml"
AGENTS_TEMPLATE_PACKAGED_NAME = "agents.yaml"
FORBIDDEN_SUFFIXES = (".pdb", ".rlib", ".d", ".key")
SENSITIVE_KEY_RE = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|token)\b\s*[:=]"
)
DRIVE_PATH_RE = re.compile(r"\b[A-Za-z]:[\\/]")
# C:\Windows（含子路径）是每台 Windows 机器都有的系统目录，不携带构建机信息；
# 说明书需如实描述「UNC cwd 被 cmd.exe 换成 C:\Windows」这类系统行为（#353）。
# 只豁免该字面前缀，其余盘符路径（尤其构建机独有盘符）照旧拒绝。
UNIVERSAL_SYSTEM_PATH_RE = re.compile(r"(?i)c:[\\/]windows\b")
PLACEHOLDER_MARKERS = ("path\\to", "path/to", "your-", "example", "占位", "...")
# 插件开发 SDK：发行包附带完整离线分发包（2026-09-01 用户决定——不再只带最小
# runtime 子集，插件开发者需拿到 testing.js + types/ 类型声明全套）。
DEV_SDK_DIR = REPO_DIR / "dist-plugin-sdk" / "normal"
DEV_SDK_REQUIRED = frozenset({
    "pylon-plugin-sdk.js",
    "testing.js",
    "pylon-plugin-manifest.schema.json",
})


class PackError(Exception):
    pass


# ── 版本解析 ──

def parse_version_from_package_json() -> str:
    data = json.loads((REPO_DIR / "package.json").read_text(encoding="utf-8"))
    return str(data.get("version", "")).strip()


def parse_version_from_tauri_conf() -> str:
    data = json.loads((SRC_TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))
    return str(data.get("version", "")).strip()


def parse_package_field_from_toml(text: str, field: str, origin: str) -> str:
    in_package = False
    for line in text.splitlines():
        if line.startswith("["):
            in_package = line.strip() == "[package]"
            continue
        if in_package:
            match = re.match(rf'^\s*{field}\s*=\s*"([^"]+)"\s*$', line)
            if match:
                return match.group(1).strip()
    raise PackError(f"{origin} [package] 段缺少 {field}")


def parse_version_from_cargo_toml() -> str:
    return parse_package_field_from_toml(
        (SRC_TAURI_DIR / "Cargo.toml").read_text(encoding="utf-8"), "version", "Cargo.toml"
    )


def resolve_version() -> str:
    versions = {
        "package.json": parse_version_from_package_json(),
        "tauri.conf.json": parse_version_from_tauri_conf(),
        "Cargo.toml": parse_version_from_cargo_toml(),
    }
    unique = set(versions.values())
    if len(unique) != 1 or "" in unique:
        raise PackError(f"三处版本不一致: {versions}")
    return unique.pop()


# ── 版本落位与发行编排（#402）──
# 落位域 = 先例 6e7a22d3 的 9 文件：package.json / tauri.conf.json / src-tauri 根与
# 携带同版本号的成员 crate 各自 Cargo.toml / Cargo.lock 的对应 version 行。
# 成员清单不硬编码（#259 教训）：从根 Cargo.toml 的 [workspace] members 动态解析，
# 凡 [package] version 与当前应用版本一致的成员一并落位，保持「随版本前进」的锁定步调。

BUMP_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+-[0-9A-Za-z]+$")
# #228/#399 两次实测：目标盘余量见底时 release 全链死在编译中途（os error 112），
# 与其烧半小时再炸，不如启动前拒绝。
MIN_BUILD_FREE_BYTES = 10 * 1024**3


def workspace_member_manifests(root_text: str) -> list[Path]:
    in_workspace = False
    members: list[Path] = []
    for line in root_text.splitlines():
        if line.startswith("["):
            in_workspace = line.strip() == "[workspace]"
            continue
        if not in_workspace:
            continue
        match = re.match(r'^\s*"([^"]+)"\s*,?\s*$', line)
        if match and match.group(1) != ".":
            members.append(SRC_TAURI_DIR / match.group(1) / "Cargo.toml")
    return members


def patch_cargo_lock(lock_path: Path, crate_versions: dict[str, str]) -> tuple[list[str], int]:
    """纯计算：返回替换后的行序列与替换数，不写盘——由调用方在各校验全过后统一落盘。"""
    lines = lock_path.read_text(encoding="utf-8").splitlines(keepends=True)
    remaining = dict(crate_versions)
    current_name: str | None = None
    patched = 0
    for index, line in enumerate(lines):
        name_match = re.match(r'^name = "([^"]+)"', line)
        if name_match:
            current_name = name_match.group(1)
            continue
        version_match = re.match(r'^version = "([^"]+)"', line)
        if version_match and current_name in remaining:
            eol = "\r\n" if line.endswith("\r\n") else "\n"
            lines[index] = f'version = "{remaining.pop(current_name)}"{eol}'
            patched += 1
    if remaining:
        raise PackError(
            f"Cargo.lock 缺少待落位 crate 的条目: {', '.join(sorted(remaining))}"
            "——lock 与 manifest 脱钩，先跑一次 cargo build 让 lock 回同步"
        )
    return lines, patched


def bump_version_files(new_version: str) -> tuple[list[Path], int]:
    """把 new_version 落位到全部版本文件。校验全过才写盘（任一计数不对即中止）。"""
    old = resolve_version()
    if not BUMP_VERSION_RE.match(new_version):
        raise PackError(f"版本号格式非法: {new_version}（需要 X.Y.Z-SUF，如 0.3.2-EFF）")
    if new_version == old:
        raise PackError(f"新版本号与当前相同: {new_version}")

    root_toml = SRC_TAURI_DIR / "Cargo.toml"
    root_text = root_toml.read_text(encoding="utf-8")
    manifests: list[Path] = [
        REPO_DIR / "package.json",
        SRC_TAURI_DIR / "tauri.conf.json",
    ]
    cargo_tomls = [root_toml]
    for member_manifest in workspace_member_manifests(root_text):
        member_text = member_manifest.read_text(encoding="utf-8")
        if parse_package_field_from_toml(member_text, "version", str(member_manifest)) == old:
            cargo_tomls.append(member_manifest)
    manifests.extend(cargo_tomls)

    # 先全量算补丁并核计数（manifest 计数 + lock 条目完整性），再统一写盘——半套落位比失败更糟。
    patched: list[tuple[Path, str]] = []
    crate_versions: dict[str, str] = {}
    for path in manifests:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            pattern = re.compile(rf'("version"\s*:\s*"){re.escape(old)}(")')
            new_text, count = pattern.subn(rf"\g<1>{new_version}\g<2>", text)
        else:
            pattern = re.compile(rf'^(version\s*=\s*"){re.escape(old)}("\s*)$', re.MULTILINE)
            new_text, count = pattern.subn(rf"\g<1>{new_version}\g<2>", text)
            crate_versions[parse_package_field_from_toml(new_text, "name", str(path))] = new_version
        if count != 1:
            raise PackError(
                f"{path} 中版本号 {old} 出现 {count} 次（应为 1）——落位中止，未写任何文件"
            )
        patched.append((path, new_text))

    lock_path = SRC_TAURI_DIR / "Cargo.lock"
    lock_lines, lock_count = patch_cargo_lock(lock_path, crate_versions)
    if lock_count != len(crate_versions):
        raise PackError(f"Cargo.lock 落位 {lock_count} 处（应为 {len(crate_versions)}）")

    for path, new_text in patched:
        path.write_text(new_text, encoding="utf-8")
    lock_path.write_text("".join(lock_lines), encoding="utf-8")
    return [path for path, _text in patched] + [lock_path], len(cargo_tomls)


def release_commit_message(new_version: str, cargo_toml_count: int) -> str:
    return (
        f"chore(release): {new_version} 版本号落位（package.json/tauri.conf/"
        f"{cargo_toml_count} 处 Cargo.toml + lock）——pack_release.py --bump 编排（#402）"
    )


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    # 参数一律走列表、不经 shell：message 里的反引号/括号不会被展开（见 L.md 088a5096 教训）。
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        raise PackError(f"git {' '.join(args)} 失败: {(result.stderr or result.stdout).strip()}")
    return result


def commit_version_bump(changed: list[Path], new_version: str, cargo_toml_count: int) -> str:
    status = _git("status", "--porcelain", "--", *[str(path) for path in changed])
    if not status.stdout.strip():
        raise PackError("版本文件无改动可提交——工作树与 HEAD 一致？")
    message = release_commit_message(new_version, cargo_toml_count)
    # pathspec 提交（AGENTS.md §2.5）：只带 9 个版本文件，不碰共享树上他人在途改动。
    _git("commit", "-m", message, "--", *[str(path) for path in changed])
    return message


def preflight_build_disk(target_root: Path | None = None) -> None:
    root = target_root if target_root is not None else _TARGET_ROOT
    probe = root
    while not probe.exists():
        if probe.parent == probe:
            raise PackError(f"无法定位构建目标盘: {root}")
        probe = probe.parent
    free = shutil.disk_usage(probe).free
    if free < MIN_BUILD_FREE_BYTES:
        raise PackError(
            f"构建目标盘余量 {free / 1024**3:.1f} GiB < 10 GiB（{probe}）——release 全链会在"
            "编译中途 os error 112。按 #228 纪律把 CARGO_TARGET_DIR 指到余量充足的盘后重试。"
        )
    print(f"构建目标盘余量: {free / 1024**3:.1f} GiB（{probe}）")


def run_release_build() -> None:
    print("== bun run release:portable（wasm + 前端 + SDK + 离线文档站 + tauri --no-bundle"
          " + pylon-detect + webview2-mcp + 打包审计）==")
    # bun 常是 npm 风格的 .cmd 垫片：CreateProcess 只自动补 .exe，裸 "bun" 会
    # WinError 2——先按 PATHEXT 解析真实路径，.cmd/.bat 经 cmd /c 启动。
    bun = shutil.which("bun")
    if not bun:
        raise PackError("PATH 上找不到 bun——--build 需要它编排 release:portable 全链")
    if bun.lower().endswith((".cmd", ".bat")):
        command: list[str] | str = ["cmd", "/c", bun, "run", "release:portable"]
    else:
        command = [bun, "run", "release:portable"]
    result = subprocess.run(command, cwd=REPO_DIR)
    if result.returncode != 0:
        raise PackError(f"release:portable 失败（exit {result.returncode}）")


def select_git_remote() -> str:
    remotes = [line.strip() for line in _git("remote").stdout.splitlines() if line.strip()]
    for preferred in ("github", "origin"):
        if preferred in remotes:
            return preferred
    raise PackError(f"未找到可用的 git 远端（现有: {remotes or '无'}）")


def github_release_url(remote: str, tag: str) -> str | None:
    url = _git("remote", "get-url", remote).stdout.strip()
    match = re.search(r"github\.com[:/](.+?)(?:\.git)?$", url)
    if not match:
        return None
    return f"https://github.com/{match.group(1)}/releases/tag/{tag}"


def upload_release(expected_version: str | None) -> None:
    version = resolve_version()
    if expected_version and version != expected_version:
        raise PackError(
            f"工作树版本 {version} 与 --bump 目标 {expected_version} 不一致——先完成落位提交"
        )
    tag = f"v{version}"
    remote = select_git_remote()
    if _git("rev-parse", "-q", "--verify", f"refs/tags/{tag}", check=False).returncode == 0:
        raise PackError(
            f"tag {tag} 已存在。CI 失败重试走 release.yml 的 workflow_dispatch（tag ref 上"
            " dispatch 等价重推）；确认作废才删 tag 重打。"
        )
    fetch = _git("fetch", remote, "main", check=False)
    if fetch.returncode != 0:
        raise PackError(
            f"git fetch {remote} main 失败: {(fetch.stderr or fetch.stdout).strip()}"
            "\n（先确认网络/代理：git config --get http.proxy）"
        )
    ancestor = _git("merge-base", "--is-ancestor", "HEAD", f"{remote}/main", check=False)
    if ancestor.returncode != 0:
        raise PackError(
            f"HEAD 不在 {remote}/main 上——#232 守卫要求发行内容经 PR 入 main（PR CI 全绿）。"
            f"请先推送分支、合并 PR，再在 main 上执行 --upload。"
        )
    _git("tag", tag, "HEAD")
    _git("push", remote, tag)
    print(f"OK: tag {tag} 已推送 → release.yml 开始构建并上传发行资产")
    url = github_release_url(remote, tag)
    if url:
        print(f"Release 页: {url}")
    print("进度查看: gh run watch（Actions 页）；CI 守卫：tag=package.json=tauri.conf + main 归属")


# ── 文件审计 ──

def is_text_file(path: Path) -> bool:
    return path.suffix.lower() in {".txt", ".yaml", ".yml", ".bat", ".ps1", ".json", ".md"}


def is_hermes_runtime_payload(rel_path: str) -> bool:
    """Return whether *rel_path* belongs to the upstream vendor tree.

    The release audit's secret/absolute-path rules are for Pylon-authored
    configuration and documentation. PortableGit ships thousands of upstream
    docs and scripts containing harmless example paths and words such as
    ``token``; scanning those files creates false positives and does not add
    useful protection. Keep the structural/forbidden-name checks for the tree,
    but restrict content scanning to our own runtime metadata and README.
    """
    return rel_path.replace("\\", "/").startswith("resources/runtime/git/")


def scan_text_file(rel_path: str, text: str) -> None:
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        residue = UNIVERSAL_SYSTEM_PATH_RE.sub("", stripped)
        if DRIVE_PATH_RE.search(residue):
            if not any(marker in stripped for marker in PLACEHOLDER_MARKERS):
                raise PackError(
                    f"包内文本文件含疑似本机绝对路径 {rel_path}:{line_no}: {stripped}"
                )
        if SENSITIVE_KEY_RE.search(stripped):
            if not any(marker in stripped for marker in PLACEHOLDER_MARKERS):
                raise PackError(
                    f"包内文本文件含疑似敏感配置 {rel_path}:{line_no}: {stripped}"
                )


def reject_forbidden(rel_path: str) -> None:
    name = Path(rel_path).name
    posix = rel_path.replace("\\", "/")
    if name.endswith(FORBIDDEN_SUFFIXES):
        raise PackError(f"包内出现禁止文件: {rel_path}")
    # 唯一放行点是包根的 agents.yaml（= AGENTS_TEMPLATE_PACKAGED_NAME，由打包器从
    # release 模板改名收取）；其余位置的 agents.yaml 与任何位置的 .env 都拒绝。
    if name in FORBIDDEN_NAMES and posix != AGENTS_TEMPLATE_PACKAGED_NAME:
        raise PackError(f"包内出现禁止文件: {rel_path}")
    if name.endswith(".env"):
        raise PackError(f"包内出现禁止文件: {rel_path}")
    if (
        posix == "src"
        or posix.startswith("src/")
        or posix == "src-tauri/src"
        or posix.startswith("src-tauri/src/")
        or posix == ".git"
        or posix.startswith(".git/")
        or posix == "node_modules"
        or posix.startswith("node_modules/")
    ):
        raise PackError(f"包内出现禁止路径: {rel_path}")


def hermes_runtime_is_complete(root: Path) -> bool:
    """Return whether a complete PortableGit tree is ready for packaging."""
    bash_candidates = [root / "bin" / "bash.exe", root / "usr" / "bin" / "bash.exe"]
    if not any(path.is_file() for path in bash_candidates):
        return False
    usr_bin = root / "usr" / "bin"
    required = ("true.exe", "cat.exe", "mktemp.exe", "mv.exe", "awk.exe", "grep.exe")
    if any(not (usr_bin / name).is_file() for name in required):
        return False
    return any(
        path.is_file()
        for path in (root / "usr" / "bin" / "msys-2.0.dll", root / "bin" / "msys-2.0.dll")
    )


def append_tree_files(
    files: list[tuple[Path, str]],
    source_root: Path,
    package_root: str,
) -> None:
    for root, _dirs, names in os.walk(source_root):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(source_root).as_posix()
            files.append((full, f"{package_root.rstrip('/')}/{rel}"))


def collect_docs_site() -> list[tuple[Path, str]]:
    """离线文档站（#371）取暂存源而非 target 的 Tauri 拷贝（#471）。

    Tauri 对 bundle.resources 的 target/release/resources 拷贝是增量合并：
    哈希文件名的旧代 chunk 永不清理，本地反复构建会把历史代际全带进 zip
    （0.3.4-LBI 实测本地 manifest 304 项 vs CI 282 项，差 22 项全为
    docs-site/assets 旧哈希变体）。暂存源每轮由 stage-docs-site.mjs rm+重铺
    保证新鲜，取源即与 CI 全新 checkout 同构，且对 target 区文件锁免疫。
    """
    files: list[tuple[Path, str]] = []
    append_tree_files(files, DOCS_SITE_STAGED_DIR, "resources/docs-site")
    return files


def collect_dev_sdk() -> list[tuple[Path, str]]:
    """收集完整插件开发 SDK（dist-plugin-sdk/normal 全量）到 resources/sdk/。

    发行包附带完整离线 SDK 分发包：pylon-plugin-sdk.js（纯浏览器 ESM runtime）
    + testing.js（测试基建）+ types/ 全套类型声明 + manifest schema。
    """
    if not DEV_SDK_DIR.is_dir():
        raise PackError(
            f"缺少插件开发 SDK 目录: {DEV_SDK_DIR}。"
            "请先运行 npm run build:plugin-sdk，再打包。"
        )

    files = {
        path.relative_to(DEV_SDK_DIR).as_posix(): path
        for path in DEV_SDK_DIR.rglob("*")
        if path.is_file()
    }
    missing = sorted(DEV_SDK_REQUIRED - files.keys())
    if missing:
        raise PackError(
            f"插件开发 SDK 缺少文件: {', '.join(missing)}。"
            "请重新运行 npm run build:plugin-sdk。"
        )
    return [(path, f"resources/sdk/{rel}") for rel, path in sorted(files.items())]


def collect_mcp_tool() -> list[tuple[Path, str]]:
    """webview2-mcp（Pylon 自带的调试 MCP 服务器）：exe + README。

    2026-09-17 仓库主决定：该工具随发行包分发。理由：它是把 AI 客户端接到
    **已安装的 Pylon** 上的唯一调试通道，源码仓里能 `cargo build`，拿到 zip 的人
    却拿不到。它与 app 的耦合方式是「外部进程 + WebView2 的 --remote-debugging-port」，
    不含任何调试构建要求，所以单独发一个二进制并不会把发行包变成开发版。

    必须存在：缺了它就等于发行包少了这条能力，且失败点会拖到用户真正需要调试时
    才暴露——按 pylon-detect 的规矩，构建期就报错并给出构建命令。
    README 与 exe 同级，讲清接线方式，以及「加上那一行等于把窗口对同机任何进程开放」
    这个必须先说清的代价。
    """
    exe = MCP_RELEASE_DIR / MCP_EXE_NAME
    if not exe.is_file():
        raise PackError(
            f"缺少 webview2-mcp 可执行文件: {exe}\n"
            "请先构建：cargo build --manifest-path tools/webview2-mcp/Cargo.toml --release"
        )
    readme = MCP_DIR / "README.md"
    if not readme.is_file():
        raise PackError(f"缺少 webview2-mcp 说明文档: {readme}")
    return [
        (exe, f"{MCP_PACKAGE_DIR}/{MCP_EXE_NAME}"),
        (readme, f"{MCP_PACKAGE_DIR}/README.md"),
    ]


def resolve_webview2_loader() -> Path:
    """定位 WebView2Loader.dll（exe 启动必需，缺失 → 0xC0000135）。

    `tauri build --no-bundle` 不执行 bundling 阶段，因此该 DLL 不会被拷进
    target/release/ 根；它只由 webview2-com-sys 的 build.rs 拷进 cargo OUT_DIR
    （<target>/<profile>/build/webview2-com-sys-*/out/<arch>/）。先认发布目录，
    再按上述布局回退——与下方 Hermes runtime 对 `--no-bundle` 的回退同一思路。

    发行目标是 x86_64-pc-windows-msvc，故只接受 x64 架构的副本：用错架构的
    DLL 会变成静默故障，不如显式报错。
    """
    direct = RELEASE_DIR / "WebView2Loader.dll"
    if direct.is_file():
        return direct
    # 与顶部 RELEASE_DIR 同源：CARGO_TARGET_DIR 指向哪，OUT_DIR 回退就搜哪。
    target_dir = _TARGET_ROOT
    for profile in ("release", "debug"):
        pattern = f"{profile}/build/webview2-com-sys-*/out/x64/WebView2Loader.dll"
        for candidate in sorted(target_dir.glob(pattern)):
            if candidate.is_file():
                return candidate
    raise PackError(
        f"release WebView2Loader.dll 不存在: {direct}；cargo OUT_DIR 回退也未命中"
        f"（{target_dir}/release/build/webview2-com-sys-*/out/x64/）。"
        "请先跑 npx tauri build --no-bundle。"
    )


def require_docs_site() -> None:
    """离线文档站（#371）显式存在性检查。

    收集走暂存源 DOCS_SITE_STAGED_DIR（#471：target 的 Tauri 增量拷贝残留历史
    哈希代际，不入包），这里钉「入口文件必须在暂存源」：缺产物说明构建链漏跑
    `bun run docs:build:offline`，应用内 Docs Sheet 会整站 404——按 webview2-mcp
    的既有规矩，构建期报错，不拖到用户打开文档时才暴露。
    """
    entry = DOCS_SITE_STAGED_DIR / "index.html"
    if not entry.is_file():
        raise PackError(
            f"缺少离线文档站入口: {entry}。\n"
            "请先运行 bun run docs:build:offline（release:portable 已内置该步），"
            "再重新打包。"
        )


def collect_source_files(version: str, with_runtime: bool = False) -> list[tuple[Path, str]]:
    """返回 [(源文件绝对路径, 包内相对路径（不含顶层目录）), ...]"""
    exe_path = RELEASE_DIR / EXE_NAME
    if not exe_path.is_file():
        raise PackError(f"release exe 不存在: {exe_path}（先跑 npx tauri build --no-bundle）")

    detector_path = RELEASE_DIR / DETECT_EXE_NAME
    if not detector_path.is_file():
        raise PackError(
            f"Agent detector 不存在: {detector_path}（先构建 --release --bin pylon-detect）"
        )

    files: list[tuple[Path, str]] = [
        (exe_path, EXE_NAME),
        (detector_path, DETECT_EXE_NAME),
    ]

    # Tauri release 必带组件：WebView2Loader.dll（exe 启动必需，缺失 → 0xC0000135
    # DLL 缺失）；pylon-cli.exe（标准组件，命令行管理界面）。
    loader_path = resolve_webview2_loader()
    files.append((loader_path, "WebView2Loader.dll"))

    cli_path = RELEASE_DIR / "pylon-cli.exe"
    if cli_path.is_file():
        files.append((cli_path, "pylon-cli.exe"))
    else:
        print("warn: 未找到 pylon-cli.exe，跳过该组件（不影响 GUI 启动）")

    files.extend(collect_mcp_tool())
    require_docs_site()

    resources_dir = RELEASE_DIR / "resources"
    if not resources_dir.is_dir():
        raise PackError(
            f"release resources 目录不存在: {resources_dir}。"
            "插件开发 SDK 是发行包必需资源。"
        )
    # 插件开发 SDK：完整离线分发包取自 dist-plugin-sdk/normal（2026-09-01 用户
    # 决定，不再使用 Tauri 拷贝的最小 runtime 子集——插件开发者需要 testing.js
    # 与 types/ 全套类型声明）。
    files.extend(collect_dev_sdk())
    for root, _dirs, names in os.walk(resources_dir):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(RELEASE_DIR).as_posix()
            if rel.startswith("resources/sdk/"):
                continue  # SDK 由 dist-plugin-sdk 全量提供，跳过 Tauri 最小集
            if rel.startswith("resources/docs-site/"):
                continue  # 文档站由暂存源提供（collect_docs_site，#471），跳过增量拷贝的残留代际
            files.append((full, rel))
    files.extend(collect_docs_site())

    # Hermes PortableGit runtime：默认排除（2026-08-31 用户决定——bash 已在标准路径
    # C:\Program Files\Git，发行包不再内置完整运行时；--with-runtime 可恢复）。
    if not with_runtime:
        files = [
            (source, rel)
            for source, rel in files
            if not rel.startswith("resources/runtime/")
        ]

    if with_runtime:
        # The Tauri resource copier normally places the runtime under
        # target/release/resources.  Keep a repository fallback for `--no-bundle`
        # layouts where that copy is skipped, while still requiring a complete
        # tree so a release can never silently omit Hermes' Bash dependency.
        packaged_runtime = RELEASE_DIR / "resources" / "runtime" / "git"
        runtime_source = packaged_runtime if hermes_runtime_is_complete(packaged_runtime) else HERMES_RUNTIME_TREE
        if not hermes_runtime_is_complete(runtime_source):
            raise PackError(
                "缺少完整的 Hermes PortableGit 运行时（resources/runtime/git）。"
                "请先运行 npm run prepare:hermes-runtime，再重新构建/打包。"
            )
        existing_paths = {rel for _src, rel in files}
        for runtime_rel in ["resources/runtime/portable-git.json", "resources/runtime/README.txt"]:
            source = HERMES_RUNTIME_DIR / Path(runtime_rel).name
            if runtime_rel not in existing_paths and source.is_file():
                files.append((source, runtime_rel))
                existing_paths.add(runtime_rel)
        # Add the binary tree only when Tauri did not already copy a *complete*
        # tree.  A partial target/release/resources copy must not shadow the
        # repository fallback.
        if not hermes_runtime_is_complete(packaged_runtime):
            files = [
                (source, rel)
                for source, rel in files
                if not rel.startswith("resources/runtime/git/")
            ]
            append_tree_files(files, runtime_source, "resources/runtime/git")

    for source_name, packaged_name in [
        (AGENTS_TEMPLATE_SOURCE_NAME, AGENTS_TEMPLATE_PACKAGED_NAME),
        ("README.txt", "README.txt"),
    ]:
        src = TEMPLATE_DIR / source_name
        if not src.is_file():
            raise PackError(f"缺少 release 模板: {src}")
        files.append((src, packaged_name))

    # 发行包附带用户文档（2026-09-01 规则）：仓库根 README.md + docs/说明书/ 全量进入包内。
    readme_src = REPO_DIR / "README.md"
    if not readme_src.is_file():
        raise PackError(f"缺少发行包 README: {readme_src}")
    files.append((readme_src, "README.md"))
    for rel in ("LICENSE", "NOTICE", "LICENSES/Apache-2.0.txt"):
        license_src = REPO_DIR / rel
        if not license_src.is_file():
            raise PackError(f"缺少发行包许可或来源声明: {license_src}")
        files.append((license_src, rel))
    manual_dir = REPO_DIR / "docs" / "说明书"
    if not manual_dir.is_dir():
        raise PackError(f"缺少发行包说明书目录: {manual_dir}")
    append_tree_files(files, manual_dir, "docs/说明书")

    bat_src = TEMPLATE_DIR / "tools" / "install-webview2.bat"
    if not bat_src.is_file():
        raise PackError(f"缺少 release 模板: {bat_src}")
    files.append((bat_src, "tools/install-webview2.bat"))

    # WebView2 bootstrapper 不再随包分发（2026-09-19 ADR-0014）：运行时按 Windows
    # 自带处理，缺 Runtime 的机器由 tools/install-webview2.bat 联网兜底安装。

    return files


# ── staging / 压缩 ──

def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_staging(version: str, files: list[tuple[Path, str]]) -> Path:
    top_dir = f"pylon-{version}-win64"
    staging_root = OUT_ROOT / top_dir
    if staging_root.exists():
        shutil.rmtree(staging_root)
    staging_root.mkdir(parents=True)

    # 空 data/ + portable.flag：data/ 即唯一数据根（#482），flag 仅身份标记不参与判定。
    (staging_root / "data").mkdir()
    (staging_root / "portable.flag").touch()

    for src, rel in files:
        dest = staging_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            raise PackError(f"staging 目标已存在（重复文件）: {rel}")
        shutil.copy2(src, dest)
    return staging_root


def audit_staging(staging_root: Path, top_dir: str) -> None:
    for root, _dirs, names in os.walk(staging_root):
        for name in names:
            full = Path(root) / name
            rel = full.relative_to(staging_root).as_posix()
            reject_forbidden(rel)
            if is_text_file(full) and not is_hermes_runtime_payload(rel):
                scan_text_file(rel, full.read_text(encoding="utf-8", errors="strict"))


def build_manifest(
    top_dir: str,
    files: list[tuple[Path, str]],
    staging_root: Path,
) -> list[dict]:
    entries: list[dict] = []
    # 固定目录项也进入 manifest（portable.flag 与 data/ 目录）
    for rel in ["portable.flag"]:
        full = staging_root / rel
        entries.append(
            {"path": rel, "size": full.stat().st_size, "sha256": file_sha256(full)}
        )
    for src, rel in files:
        full = staging_root / rel
        entries.append(
            {"path": rel, "size": full.stat().st_size, "sha256": file_sha256(full)}
        )
    entries.sort(key=lambda item: item["path"])
    return entries


def write_zip(
    staging_root: Path,
    top_dir: str,
    version: str,
    files: list[tuple[Path, str]],
) -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    zip_path = OUT_ROOT / f"{top_dir}.zip"
    if zip_path.exists():
        zip_path.unlink()

    entries = build_manifest(top_dir, files, staging_root)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 顶层目录条目
        zf.writestr(f"{top_dir}/", b"")
        zf.writestr(f"{top_dir}/data/", b"")
        for root, _dirs, names in os.walk(staging_root):
            for name in names:
                full = Path(root) / name
                rel = full.relative_to(staging_root).as_posix()
                zf.write(full, f"{top_dir}/{rel}")

    # hash 文件
    zip_sha256 = file_sha256(zip_path)
    sha_path = Path(str(zip_path) + ".sha256")
    sha_path.write_text(f"{zip_sha256}  {top_dir}.zip\n", encoding="utf-8")

    # manifest
    manifest = {
        "product": "Pylon",
        "version": version,
        "platform": "win64",
        "portable": True,
        "files": entries,
    }
    manifest_path = OUT_ROOT / f"{top_dir}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"OK: {zip_path} ({zip_path.stat().st_size:,} bytes)")
    print(f"OK: {sha_path}")
    print(f"OK: {manifest_path}")
    for item in entries:
        print(f"{item['size']:>12,}  {item['path']}")


def verify_zip(zip_path: Path) -> None:
    if not zip_path.is_file():
        raise PackError(f"zip 不存在: {zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        if bad is not None:
            raise PackError(f"ZIP testzip 失败: {bad}")
        names = zf.namelist()
        if not names:
            raise PackError("ZIP 为空")
        top_dirs = {name.split("/", 1)[0] for name in names}
        top_dirs.discard("")
        if len(top_dirs) != 1:
            raise PackError(f"ZIP 顶层目录不唯一: {sorted(top_dirs)}")
        top_dir = top_dirs.pop()
        if not TOP_DIR_PATTERN.match(top_dir):
            raise PackError(f"ZIP 顶层目录名非法: {top_dir}")

        prefix = top_dir + "/"
        for name in names:
            if not name.startswith(prefix) or name == prefix:
                continue
            rel = name[len(prefix):]
            if name.endswith("/"):
                continue
            reject_forbidden(rel)
            if rel not in {"portable.flag"}:
                continue
        # 文本扫描（不扫描 exe/字体）
        for info in zf.infolist():
            if info.is_dir():
                continue
            rel = info.filename[len(prefix):]
            if is_text_file(Path(rel)) and not is_hermes_runtime_payload(rel):
                text = zf.read(info).decode("utf-8", errors="strict")
                scan_text_file(rel, text)

    manifest_path = Path(str(zip_path).removesuffix(".zip") + ".manifest.json")
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with zipfile.ZipFile(zip_path) as zf:
            for entry in manifest.get("files", []):
                rel = entry["path"]
                info = zf.getinfo(f"{manifest['version'] and 'pylon-' + manifest['version'] + '-win64'}/{rel}")
                actual_size = info.file_size
                actual_hash = hashlib.sha256(zf.read(info)).hexdigest()
                if actual_size != entry.get("size") or actual_hash != entry.get("sha256"):
                    raise PackError(f"manifest 文件不匹配: {rel}")
        print(f"verify OK: manifest 与 ZIP 内容一致（{len(manifest.get('files', []))} 项）")
    else:
        print("warn: manifest 不存在，跳过 manifest 核对")

    print(f"verify OK: {zip_path}")


# ── main ──

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--with-runtime",
        action="store_true",
        help="包含 Hermes PortableGit 运行时（默认排除——bash 已在标准路径 C:\\Program Files\\Git，2026-08-31 决定）",
    )
    parser.add_argument(
        "--verify-only",
        metavar="ZIP",
        help="仅审计已存在的 release ZIP，不重新打包",
    )
    parser.add_argument(
        "--bump",
        metavar="X.Y.Z-SUF",
        help="版本号落位（package.json/tauri.conf/6 处 Cargo.toml + lock）并 pathspec 提交；"
        "与 --build/--upload 组合成一键编排",
    )
    parser.add_argument(
        "--no-commit",
        action="store_true",
        help="--bump 只改文件不提交（默认落位即提交）",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="本地跑 bun run release:portable 全链构建（#232 定位：预演/排障；"
        "正式发布走 --upload 打 tag 由 CI 构建）",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="main 归属守卫通过后打 v<version> tag 并推送，触发 release.yml 构建上传"
        " GitHub Release（#232：打 tag 即发行）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.verify_only:
        verify_zip(Path(args.verify_only))
        return 0

    orchestrated = False
    if args.bump:
        changed, cargo_toml_count = bump_version_files(args.bump)
        print(f"OK: 版本号落位 {args.bump}（{len(changed)} 文件: "
              + ", ".join(str(path.relative_to(REPO_DIR)) for path in changed) + "）")
        if args.no_commit:
            print("OK: 未提交（--no-commit）")
        else:
            print(f"OK: 已提交 — {commit_version_bump(changed, args.bump, cargo_toml_count)}")
        orchestrated = True
        if not (args.build or args.upload):
            print("下一步: 加 --build 本地预演构建；正式发布 = 分支 PR 入 main 后，在 main 上加 --upload")
    if args.build:
        preflight_build_disk()
        run_release_build()
        orchestrated = True
    if args.upload:
        upload_release(args.bump)
        orchestrated = True
    if orchestrated:
        return 0

    version = resolve_version()
    top_dir = f"pylon-{version}-win64"
    files = collect_source_files(version, args.with_runtime)

    staging_root = build_staging(version, files)
    try:
        audit_staging(staging_root, top_dir)
        write_zip(staging_root, top_dir, version, files)
    finally:
        # 连续执行两次不混入旧 staging 内容
        if staging_root.exists():
            shutil.rmtree(staging_root)

    # 压缩后审计：生成物自身再过一遍 allowlist/hash
    verify_zip(OUT_ROOT / f"{top_dir}.zip")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
