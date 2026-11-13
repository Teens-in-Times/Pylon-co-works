"""pack_release.py 的离线审计测试（不触发真实构建/压缩大文件）。"""

import importlib.util
import json
import os
import shutil as shutil_mod
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any, cast
from unittest import mock

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "pack_release.py"
SPEC = importlib.util.spec_from_file_location("pack_release", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
# 动态加载的模块没有静态属性表：cast(Any) 让 pack.<name> 的读取与测试里的
# 模块级替身（OUT_ROOT / SRC_TAURI_DIR）都按测试惯用法通过类型检查。
pack = cast(Any, importlib.util.module_from_spec(SPEC))
SPEC.loader.exec_module(pack)


class VersionTests(unittest.TestCase):
    def test_three_version_files_are_consistent(self) -> None:
        # 三个版本源必须互相等。**不写死具体版本号**：字面量会在每次发版时假红，
        # 而且测不出本测试名承诺的"三处漂移"（旧写法只对着 "1.1.0" 断言，
        # 既从未比较过这三个文件，也在版本升到 1.6.0 后长期假红）。
        package = pack.parse_version_from_package_json()
        tauri = pack.parse_version_from_tauri_conf()
        cargo = pack.parse_version_from_cargo_toml()
        self.assertTrue(package)
        self.assertEqual(package, tauri)
        self.assertEqual(package, cargo)
        self.assertEqual(pack.resolve_version(), package)

    def test_cargo_toml_version_parser(self) -> None:
        # 与权威源（package.json）一致即可判定解析成功，不写死版本号。
        self.assertEqual(
            pack.parse_version_from_cargo_toml(),
            pack.parse_version_from_package_json(),
        )

    def test_cargo_toml_version_parser_reads_only_package_section(self) -> None:
        # [dependencies] 里的 version 不得被误当作包版本（合成输入，故可写死字面量）。
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Cargo.toml").write_text(
                '[dependencies]\nversion = "9.9.9"\n\n[package]\nname = "x"\nversion = "2.3.4"\n',
                encoding="utf-8",
            )
            previous = pack.SRC_TAURI_DIR
            pack.SRC_TAURI_DIR = root
            try:
                self.assertEqual(pack.parse_version_from_cargo_toml(), "2.3.4")
            finally:
                pack.SRC_TAURI_DIR = previous

    def test_top_dir_pattern(self) -> None:
        self.assertIsNotNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0-win64/sub"))
        self.assertIsNone(pack.TOP_DIR_PATTERN.match("pylon-1.1.0"))


class AuditTests(unittest.TestCase):
    def test_scan_rejects_real_windows_absolute_path(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("agents.yaml", "exe: F:\\Agent\\peri.exe")

    def test_scan_allows_placeholder_path(self) -> None:
        pack.scan_text_file("agents.template.yaml", "exe: C:\\path\\to\\your-agent.exe")

    def test_scan_allows_universal_system_path(self) -> None:
        # C:\Windows 不携带构建机信息（每台 Windows 都有）；#353 起说明书需如实
        # 描述 UNC cwd 绕行行为。大小写与子路径都豁免。
        pack.scan_text_file("docs/说明书/x.md", "UNC cwd 会被静默换成 C:\\Windows")
        pack.scan_text_file("docs/说明书/x.md", "改走 c:\\windows\\system32\\cmd.exe")

    def test_scan_still_rejects_non_system_drive_path(self) -> None:
        # 豁免只限 C:\Windows 字面前缀：其他盘符、伪装后缀、混合行都照旧拒绝。
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("docs/说明书/x.md", "落在 C:\\Users\\me\\notes")
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("docs/说明书/x.md", "C:\\WindowsxDE 拼写不算豁免")
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("docs/说明书/x.md", "C:\\Windows 旁边还有 F:\\Agent\\peri.exe")

    def test_scan_rejects_sensitive_value(self) -> None:
        with self.assertRaises(pack.PackError):
            pack.scan_text_file("config.yaml", "api_key: sk-123456")

    def test_scan_allows_sensitive_placeholder(self) -> None:
        pack.scan_text_file("config.example.yaml", "api_key: your-key")

    def test_reject_forbidden_names_and_suffixes(self) -> None:
        # agents.yaml 按位置区分（见 AgentsTemplatePackagingTests）；其余名字与
        # 后缀在任何位置都拒绝。
        for bad in ["resources/agents.yaml", "x.pdb", "a.rlib", "b.d", ".env", "x.env"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_reject_forbidden_parts(self) -> None:
        for bad in ["src/main.rs", "src-tauri/src/lib.rs", "node_modules/x.js"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)

    def test_allows_expected_package_files(self) -> None:
        for ok in ["pylon.exe", "pylon-detect.exe", "resources/fonts/a.ttf", "tools/install-webview2.bat", "portable.flag"]:
            pack.reject_forbidden(ok)


class McpToolPackagingTests(unittest.TestCase):
    """自带的调试 MCP 服务器必须随发行包分发（2026-09-17 仓库主决定）。

    它与 app 是「外部进程 + WebView2 --remote-debugging-port」的松耦合关系，
    源码仓能 `cargo build`、拿到 zip 的人却拿不到——所以把 exe 与 README 一起打进
    `tools/webview2-mcp/`。本测试钉住三件事：收集路径、缺 exe 必须构建期报错
    （而不是拖到用户需要调试时才发现）、README 必须能过发行包的内容审计。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-mcp-pack-test-"))
        self.old_release = pack.MCP_RELEASE_DIR
        self.old_dir = pack.MCP_DIR

    def tearDown(self) -> None:
        pack.MCP_RELEASE_DIR = self.old_release
        pack.MCP_DIR = self.old_dir
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exe_and_readme_land_under_tools_with_the_exe_name(self) -> None:
        release = self.tmp / "target" / "release"
        release.mkdir(parents=True)
        (release / pack.MCP_EXE_NAME).write_bytes(b"MZ-fake")
        docs = self.tmp / "docs"
        docs.mkdir()
        (docs / "README.md").write_text("# mcp", encoding="utf-8")
        pack.MCP_RELEASE_DIR = release
        pack.MCP_DIR = docs

        collected = dict(
            (rel, source) for source, rel in pack.collect_mcp_tool()
        )
        self.assertEqual(
            sorted(collected),
            [
                f"{pack.MCP_PACKAGE_DIR}/README.md",
                f"{pack.MCP_PACKAGE_DIR}/{pack.MCP_EXE_NAME}",
            ],
        )
        # 路径必须落在 tools/ 下：与随包脚本并列，且不进 src/ 这类被拒路径。
        for rel in collected:
            pack.reject_forbidden(rel)

    def test_missing_exe_fails_the_build_instead_of_shipping_silently(self) -> None:
        pack.MCP_RELEASE_DIR = self.tmp / "target" / "release"
        pack.MCP_DIR = pack.REPO_DIR / "tools" / "webview2-mcp"
        with self.assertRaises(pack.PackError) as raised:
            pack.collect_mcp_tool()
        # 报错要带出构建命令，否则拿到失败的人得回读脚本才知道怎么办。
        self.assertIn("--release", str(raised.exception))
        self.assertIn("tools/webview2-mcp", str(raised.exception))

    def test_missing_readme_fails_the_build(self) -> None:
        release = self.tmp / "target" / "release"
        release.mkdir(parents=True)
        (release / pack.MCP_EXE_NAME).write_bytes(b"MZ-fake")
        pack.MCP_RELEASE_DIR = release
        pack.MCP_DIR = self.tmp / "empty"
        with self.assertRaises(pack.PackError):
            pack.collect_mcp_tool()

    def test_the_shipped_readme_passes_the_release_audit(self) -> None:
        # README 是文本文件，会走 scan_text_file：里面不能有本机绝对路径或
        # 形如 `token: ...` 的敏感键，否则打包在审计阶段就会失败。
        readme = pack.REPO_DIR / "tools" / "webview2-mcp" / "README.md"
        self.assertTrue(readme.is_file())
        rel = f"{pack.MCP_PACKAGE_DIR}/README.md"
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, readme.read_text(encoding="utf-8"))


class StagingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-pack-test-"))
        self.old_out = pack.OUT_ROOT
        pack.OUT_ROOT = self.tmp / "release"

    def tearDown(self) -> None:
        pack.OUT_ROOT = self.old_out
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_staging_creates_portable_layout_and_audits(self) -> None:
        src = self.tmp / "fake.txt"
        src.write_text("hello", encoding="utf-8")
        staging = pack.build_staging("1.1.0", [(src, "fake.txt")])
        self.assertTrue((staging / "portable.flag").exists())
        self.assertTrue((staging / "data").is_dir())
        self.assertTrue((staging / "fake.txt").is_file())
        pack.audit_staging(staging, "pylon-1.1.0-win64")

    def test_write_zip_has_single_top_dir_and_manifest_hash(self) -> None:
        src = self.tmp / "fake.txt"
        src.write_text("hello", encoding="utf-8")
        files = [(src, "fake.txt")]
        staging = pack.build_staging("1.1.0", files)
        pack.write_zip(staging, "pylon-1.1.0-win64", "1.1.0", files)
        zip_path = pack.OUT_ROOT / "pylon-1.1.0-win64.zip"
        self.assertTrue(zip_path.exists())
        self.assertTrue((pack.OUT_ROOT / "pylon-1.1.0-win64.zip.sha256").exists())
        manifest = pack.OUT_ROOT / "pylon-1.1.0-win64.manifest.json"
        self.assertTrue(manifest.exists())
        manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        # webview2Bootstrapper 字段已随 ADR-0014 移除，不得回潜。
        self.assertNotIn("webview2Bootstrapper", manifest_data)
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            self.assertIn("pylon-1.1.0-win64/", names)
            self.assertIn("pylon-1.1.0-win64/data/", names)
            self.assertIn("pylon-1.1.0-win64/portable.flag", names)
            self.assertIn("pylon-1.1.0-win64/fake.txt", names)
        pack.verify_zip(zip_path)

    def test_staging_is_cleaned_between_runs(self) -> None:
        src = self.tmp / "old.txt"
        src.write_text("old", encoding="utf-8")
        pack.build_staging("1.1.0", [(src, "old.txt")])
        pack.build_staging("1.1.0", [(src, "new.txt")])
        staging = pack.OUT_ROOT / "pylon-1.1.0-win64"
        self.assertTrue((staging / "new.txt").exists())
        self.assertFalse((staging / "old.txt").exists())


class ManualPackagingTests(unittest.TestCase):
    """发行包必须打包 `docs/说明书/` **整个活目录**（2026-09-01 规则）。

    2026-09-15 仓库主决定：库内不再保留预打包的 `docs/说明书.zip`——它不会随文档更新、
    会变成陈旧副本；发行包改为每次从活目录全量收集。本测试把该约束钉住，防止有人改回
    “打一个预压包”或换成固定文件清单。
    """

    MANUAL_REL = "docs/说明书"

    def collected_manual(self) -> list[str]:
        manual = pack.REPO_DIR / "docs" / "说明书"
        files: list[tuple[Path, str]] = []
        pack.append_tree_files(files, manual, self.MANUAL_REL)
        return [rel for _src, rel in files]

    def test_every_manual_file_is_collected_recursively(self) -> None:
        manual = pack.REPO_DIR / "docs" / "说明书"
        self.assertTrue(manual.is_dir(), "发行包要求 docs/说明书/ 存在")
        expected = {
            f"{self.MANUAL_REL}/{path.relative_to(manual).as_posix()}"
            for path in manual.rglob("*")
            if path.is_file()
        }
        self.assertTrue(expected, "说明书目录不应为空")
        self.assertEqual(set(self.collected_manual()), expected)
        self.assertTrue(any(rel.endswith(".md") for rel in expected))

    def test_manual_is_packed_as_loose_files_not_a_prebuilt_archive(self) -> None:
        # 预压包不随文档更新 ⇒ 既不得在库内存在，也不得出现在收集结果里。
        self.assertFalse((pack.REPO_DIR / "docs" / "说明书.zip").exists())
        self.assertFalse([rel for rel in self.collected_manual() if rel.endswith(".zip")])

    def test_nested_subdirectories_are_walked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "说明书"
            (root / "sub").mkdir(parents=True)
            (root / "a.md").write_text("a", encoding="utf-8")
            (root / "sub" / "b.md").write_text("b", encoding="utf-8")
            files: list[tuple[Path, str]] = []
            pack.append_tree_files(files, root, self.MANUAL_REL)
            self.assertEqual(
                sorted(rel for _src, rel in files),
                [f"{self.MANUAL_REL}/a.md", f"{self.MANUAL_REL}/sub/b.md"],
            )


class AgentsTemplatePackagingTests(unittest.TestCase):
    """发行包自带零 Agent 的 agents.yaml（#372，模板源 agents.template.yaml）。

    禁止名语义：`agents.yaml` 的禁令是防泄漏——不许把工作树的真实配置带进包。
    唯一放行点是包根 agents.yaml（打包器从 release 模板改名收取），任意子目录的
    同名文件仍拒绝；.env 没有放行点。模板内容必须零 Agent：#326 裁决占位 Agent
    必然启动失败，裸启动是空态 + 引导——模板若含 `exe:` 占位行等于把必然失败的
    Agent 重新带回首屏。
    """

    def test_agents_yaml_allowed_only_as_packaged_template_location(self) -> None:
        pack.reject_forbidden("agents.yaml")
        for bad in ["resources/agents.yaml", "tools/agents.yaml", "sub/dir/agents.yaml"]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.reject_forbidden(bad)
        for env_bad in [".env", "sub/.env", "agents.yaml/.env"]:
            with self.assertRaises(pack.PackError, msg=env_bad):
                pack.reject_forbidden(env_bad)

    def test_template_is_collected_under_packaged_name(self) -> None:
        # 仓库侧模板不占用被禁的名字，映射关系钉死：agents.template.yaml → 包根 agents.yaml。
        self.assertEqual(pack.AGENTS_TEMPLATE_SOURCE_NAME, "agents.template.yaml")
        self.assertEqual(pack.AGENTS_TEMPLATE_PACKAGED_NAME, "agents.yaml")

    def test_template_exists_is_zero_agent_and_replaces_example(self) -> None:
        template = pack.TEMPLATE_DIR / pack.AGENTS_TEMPLATE_SOURCE_NAME
        self.assertTrue(template.is_file(), "发行模板 agents.template.yaml 必须存在")
        self.assertFalse(
            (pack.TEMPLATE_DIR / "agents.example.yaml").exists(),
            "旧 agents.example.yaml 模板已由 agents.template.yaml 取代，不得回潜",
        )
        text = template.read_text(encoding="utf-8")
        self.assertIn("agents: {}", text)
        self.assertNotIn("exe:", text, "模板不得预置任何 Agent（#326：占位 exe 必然启动失败）")

    def test_template_passes_release_audit_under_packaged_name(self) -> None:
        template = pack.TEMPLATE_DIR / pack.AGENTS_TEMPLATE_SOURCE_NAME
        rel = pack.AGENTS_TEMPLATE_PACKAGED_NAME
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, template.read_text(encoding="utf-8"))


class WebView2LoaderTests(unittest.TestCase):
    """锁定源包决定 DLL 来源；构建缓存布局、旧包和其他架构均不能替代它。"""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="pylon-loader-pack-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "cargo home 中文" / "webview2-com-sys-0.38.2"
        self.source.mkdir(parents=True)
        self.manifest = self.source / "Cargo.toml"
        self.manifest.write_text('[package]\nname = "webview2-com-sys"\n', encoding="utf-8")
        self.loader = self.source / "x64" / "WebView2Loader.dll"
        self.loader.parent.mkdir()
        self.loader.write_bytes(b"locked-x64-loader")
        self.package = {
            "name": "webview2-com-sys",
            "version": "0.38.2",
            "manifest_path": str(self.manifest),
        }
        patcher = mock.patch.object(pack.subprocess, "run")
        self.run = patcher.start()
        self.addCleanup(patcher.stop)
        self.set_metadata({"packages": [self.package]})
        roots = mock.patch.multiple(
            pack,
            SRC_TAURI_DIR=self.root / "src-tauri",
            _TARGET_ROOT=self.root / "target",
            RELEASE_DIR=self.root / "target" / "release",
        )
        roots.start()
        self.addCleanup(roots.stop)

    def set_metadata(self, metadata: object) -> None:
        self.run.return_value = subprocess.CompletedProcess(
            ["cargo", "metadata"], 0, json.dumps(metadata), ""
        )

    def test_uses_locked_source_without_building_or_reading_internal_target_layout(self) -> None:
        # 历史 release/debug 残留即使存在，也不能遮住当前锁定依赖。
        for relative in [
            "release/WebView2Loader.dll",
            "release/build/webview2-com-sys-old/out/x64/WebView2Loader.dll",
            "debug/build/webview2-com-sys-old/out/x64/WebView2Loader.dll",
        ]:
            stale = pack._TARGET_ROOT / relative
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_bytes(b"stale-loader")
        self.assertEqual(pack.resolve_webview2_loader(), self.loader)
        self.assertEqual(pack.resolve_webview2_loader().read_bytes(), b"locked-x64-loader")
        command = self.run.call_args.args[0]
        self.assertEqual(command[:2], ["cargo", "metadata"])
        for flag in ["--format-version=1", "--locked", "--offline"]:
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--filter-platform") + 1], "x86_64-pc-windows-msvc")
        self.assertEqual(self.run.call_args.kwargs["cwd"], pack.SRC_TAURI_DIR)

    def test_missing_x64_does_not_use_another_architecture_or_old_release_copy(self) -> None:
        self.loader.unlink()
        x86 = self.source / "x86" / "WebView2Loader.dll"
        x86.parent.mkdir()
        x86.write_bytes(b"wrong-architecture")
        pack.RELEASE_DIR.mkdir(parents=True)
        (pack.RELEASE_DIR / "WebView2Loader.dll").write_bytes(b"old-release")
        with self.assertRaisesRegex(pack.PackError, "缺少 x64 SDK 加载器"):
            pack.resolve_webview2_loader()

    def test_rejects_missing_and_ambiguous_dependency_instead_of_picking_a_cache_entry(self) -> None:
        for packages in [[], [{**self.package, "name": "webview2-com-sys-lookalike"}],
                         [self.package, {**self.package, "version": "0.37.0"}]]:
            with self.subTest(packages=packages):
                self.set_metadata({"packages": packages})
                with self.assertRaisesRegex(pack.PackError, "应恰有一个 webview2-com-sys"):
                    pack.resolve_webview2_loader()

    def test_metadata_failure_preserves_error_and_does_not_fall_back(self) -> None:
        pack.RELEASE_DIR.mkdir(parents=True)
        (pack.RELEASE_DIR / "WebView2Loader.dll").write_bytes(b"old-release")
        self.run.return_value = subprocess.CompletedProcess(
            ["cargo", "metadata"], 101, "", "lock file needs to be updated"
        )
        with self.assertRaisesRegex(pack.PackError, "lock file needs to be updated"):
            pack.resolve_webview2_loader()
        self.run.assert_called_once()

    def test_unavailable_cargo_is_a_pack_error(self) -> None:
        self.run.side_effect = FileNotFoundError("cargo unavailable")
        with self.assertRaisesRegex(pack.PackError, "无法运行 cargo metadata"):
            pack.resolve_webview2_loader()

    def test_rejects_invalid_metadata(self) -> None:
        for stdout in ["not json", "[]", '{"packages": null}']:
            with self.subTest(stdout=stdout):
                self.run.return_value.stdout = stdout
                with self.assertRaises(pack.PackError):
                    pack.resolve_webview2_loader()

    def test_rejects_relative_or_missing_source_manifest(self) -> None:
        for manifest in [None, "relative/Cargo.toml", str(self.root / "missing/Cargo.toml")]:
            with self.subTest(manifest=manifest):
                self.set_metadata({"packages": [{**self.package, "manifest_path": manifest}]})
                with self.assertRaises(pack.PackError):
                    pack.resolve_webview2_loader()


class DocsSitePackagingTests(unittest.TestCase):
    """离线文档站必须随发行包分发（#371）。

    Docs Sheet（pylon-docs:// scheme）的数据源就是包内 resources/docs-site/。
    收集取暂存源 src-tauri/resources/docs-site（#471：target 的 Tauri 增量拷贝
    会残留历史哈希代际，不入包），这里钉四件事：入口 index.html 缺失必须构建期
    报错（而不是拖到用户打开文档时 404）、报错带出补构建命令、产物形态能过发行
    内容审计（dist 里的 .json 会进文本审计，VitePress 产物不得触发 DRIVE_PATH/
    敏感键误报）、target 拷贝里的陈旧代际不得泄漏进收集结果。
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-docs-site-pack-test-"))
        self.old_release = pack.RELEASE_DIR
        self.old_staged = pack.DOCS_SITE_STAGED_DIR
        pack.RELEASE_DIR = self.tmp / "target" / "release"
        pack.DOCS_SITE_STAGED_DIR = self.tmp / "src-tauri" / "resources" / "docs-site"

    def tearDown(self) -> None:
        pack.RELEASE_DIR = self.old_release
        pack.DOCS_SITE_STAGED_DIR = self.old_staged
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_entry_fails_the_build_with_remedy(self) -> None:
        with self.assertRaises(pack.PackError) as raised:
            pack.require_docs_site()
        message = str(raised.exception)
        self.assertIn("docs:build:offline", message)
        self.assertIn("index.html", message)

    def test_guard_pins_to_staged_source_not_target_copy(self) -> None:
        # #471 回归钉的守卫半边：仅 target 有 Tauri 拷贝（历史构建残留的常见形态）、
        # 暂存源缺失时必须报错——守卫要钉在真正入包的源上，否则漏跑 docs:build:offline
        # 会被上一轮的 target 残留掩盖。
        docs_dir = pack.RELEASE_DIR / "resources" / "docs-site"
        (docs_dir / "assets").mkdir(parents=True)
        (docs_dir / "index.html").write_text("<!doctype html>", encoding="utf-8")
        with self.assertRaises(pack.PackError):
            pack.require_docs_site()

    def test_staged_docs_site_passes_entry_check_and_audit(self) -> None:
        docs_dir = pack.DOCS_SITE_STAGED_DIR
        (docs_dir / "assets").mkdir(parents=True)
        (docs_dir / "index.html").write_text(
            '<!doctype html><html lang="zh-CN"><head><script src="/assets/app.js"></script></head></html>',
            encoding="utf-8",
        )
        (docs_dir / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
        # 本地搜索索引产物是 .json，会进 is_text_file 审计
        (docs_dir / "assets" / "search-index.json").write_text(
            '{"fields": ["title"], "index": {}}', encoding="utf-8"
        )
        pack.require_docs_site()
        for rel in [
            "resources/docs-site/index.html",
            "resources/docs-site/assets/app.js",
            "resources/docs-site/assets/search-index.json",
        ]:
            pack.reject_forbidden(rel)
        pack.scan_text_file(
            "resources/docs-site/assets/search-index.json",
            (docs_dir / "assets" / "search-index.json").read_text(encoding="utf-8"),
        )

    def test_stale_target_copy_does_not_leak_into_collection(self) -> None:
        # #471 主钉：0.3.4-LBI 发行轮实测 target/release/resources/docs-site 累积
        # 4 代哈希（78 文件 vs 暂存源 56，差 22 项全进本地 zip）。此处以全量
        # collect_source_files 钉死：walk 跳过 target 的 docs-site、暂存源逐文件入包、
        # 其余资源（fonts 等）不受影响。重依赖（exe/loader/sdk/mcp）全用临时夹具。
        release = pack.RELEASE_DIR
        (release / "resources" / "fonts").mkdir(parents=True)
        (release / "pylon.exe").write_bytes(b"fake")
        (release / "pylon-detect.exe").write_bytes(b"fake")
        (release / "WebView2Loader.dll").write_bytes(b"fake")
        (release / "resources" / "fonts" / "inter.css").write_text("body{}", encoding="utf-8")
        # target 里的 Tauri 增量拷贝：上一代的旧哈希 chunk + 过期 index.html
        stale = release / "resources" / "docs-site" / "assets"
        stale.mkdir(parents=True)
        (release / "resources" / "docs-site" / "index.html").write_text("stale", encoding="utf-8")
        (stale / "app.OLDDASH.js").write_text("stale", encoding="utf-8")
        # 暂存源：本轮 docs:build:offline 的 rm+重铺产物
        fresh = pack.DOCS_SITE_STAGED_DIR
        (fresh / "assets").mkdir(parents=True)
        (fresh / "index.html").write_text("fresh", encoding="utf-8")
        (fresh / "assets" / "app.NEWDASH.js").write_text("fresh", encoding="utf-8")
        # 其余重依赖夹具：SDK 三件套 + webview2-mcp exe（README 走仓内真件）
        sdk = self.tmp / "dist-plugin-sdk" / "normal"
        sdk.mkdir(parents=True)
        for name in sorted(pack.DEV_SDK_REQUIRED):
            (sdk / name).write_text("fake", encoding="utf-8")
        old_sdk, old_mcp = pack.DEV_SDK_DIR, pack.MCP_RELEASE_DIR
        pack.DEV_SDK_DIR = sdk
        pack.MCP_RELEASE_DIR = self.tmp / "mcp-target" / "release"
        try:
            pack.MCP_RELEASE_DIR.mkdir(parents=True)
            (pack.MCP_RELEASE_DIR / pack.MCP_EXE_NAME).write_bytes(b"fake")
            with mock.patch.object(pack, "resolve_webview2_loader", return_value=release / "WebView2Loader.dll"):
                files = pack.collect_source_files("0.0.0")
        finally:
            pack.DEV_SDK_DIR, pack.MCP_RELEASE_DIR = old_sdk, old_mcp
        rels = [rel for _source, rel in files]
        self.assertIn("resources/docs-site/index.html", rels)
        self.assertIn("resources/docs-site/assets/app.NEWDASH.js", rels)
        self.assertNotIn("resources/docs-site/assets/app.OLDDASH.js", rels)
        self.assertEqual(
            [rel for rel in rels if rel.startswith("resources/docs-site/")],
            [
                "resources/docs-site/index.html",
                "resources/docs-site/assets/app.NEWDASH.js",
            ],
        )
        self.assertIn("resources/fonts/inter.css", rels)


class WebView2BootstrapperTests(unittest.TestCase):
    """发行包不再内置 WebView2 bootstrapper（2026-09-19 仓库主决定，ADR-0014）。

    运行时按 Windows 自带处理；缺 Runtime 的机器由随包 tools/install-webview2.bat
    兜底联网安装（微软 fwlink，与 Tauri 安装器的 downloadBootstrapper 同源）。
    本测试钉住：随包 bat 必须能过发行内容审计——它现在携带 fwlink 下载链接，
    而 DRIVE_PATH_RE / SENSITIVE_KEY_RE 对 URL 与 %TEMP% 变量必须保持静默。
    """

    def test_shipped_fallback_bat_passes_release_audit(self) -> None:
        bat = pack.REPO_DIR / "resources" / "release" / "tools" / "install-webview2.bat"
        self.assertTrue(bat.is_file(), "WebView2 兜底安装脚本是发行包必需模板")
        rel = "tools/install-webview2.bat"
        pack.reject_forbidden(rel)
        pack.scan_text_file(rel, bat.read_text(encoding="utf-8"))


class FakeGit:
    """pack._git 的替身：按子命令返回脚本化结果，记录全部调用供断言。"""

    def __init__(self, responses: dict[str, tuple[int, str]] | None = None) -> None:
        self.responses = responses or {}
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        self.calls.append(args)
        returncode, stdout = self.responses.get(args[0], (0, ""))
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    def invoked(self, command: str) -> list[tuple[str, ...]]:
        return [call for call in self.calls if call[0] == command]


class ReleaseOrchestrationTests(unittest.TestCase):
    """#402 发行编排（--bump/--build/--upload）。

    落位域 = 先例 6e7a22d3 的 9 文件；成员清单动态发现（[workspace] members 里
    [package] version 与应用版本一致的成员才随动，独立版本号的 crate 不动）。
    所有用例走合成仓库树，不触碰真实工作树，也不调真 git/构建。
    """

    OLD = "0.3.9-OLD"
    NEW = "0.4.0-TEST"

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="pylon-release-orch-test-"))
        self.old_repo = pack.REPO_DIR
        self.old_src_tauri = pack.SRC_TAURI_DIR
        self.old_git = pack._git
        pack.REPO_DIR = self.tmp
        pack.SRC_TAURI_DIR = self.tmp / "src-tauri"
        self._write_fake_repo()

    def tearDown(self) -> None:
        pack.REPO_DIR = self.old_repo
        pack.SRC_TAURI_DIR = self.old_src_tauri
        pack._git = self.old_git
        shutil_mod.rmtree(self.tmp, ignore_errors=True)

    def _write_fake_repo(self) -> None:
        tauri = pack.SRC_TAURI_DIR
        tauri.mkdir(parents=True, exist_ok=True)
        (self.tmp / "package.json").write_text(
            json.dumps({"name": "pylon", "private": True, "version": self.OLD}, indent=2) + "\n",
            encoding="utf-8",
        )
        (tauri / "tauri.conf.json").write_text(
            json.dumps({"$schema": "x", "version": self.OLD}, indent=2) + "\n",
            encoding="utf-8",
        )
        # pylon-acp/pylon-session 与应用版本同调；pylon-core 刻意独立版本号——不得被误落位。
        (tauri / "Cargo.toml").write_text(
            '[package]\nname = "pylon"\nversion = "%s"\nedition = "2021"\n\n'
            '[workspace]\nmembers = [\n    ".",\n    "pylon-core",\n    "pylon-acp",\n    "pylon-session",\n]\n'
            % self.OLD,
            encoding="utf-8",
        )
        for name, version in [
            ("pylon-core", "0.1.0"),
            ("pylon-acp", self.OLD),
            ("pylon-session", self.OLD),
        ]:
            crate = tauri / name
            crate.mkdir(exist_ok=True)
            (crate / "Cargo.toml").write_text(
                f'[package]\nname = "{name}"\nversion = "{version}"\nedition = "2021"\n',
                encoding="utf-8",
            )
        lock_blocks = []
        for name, version in [
            ("serde", "1.0.999"),
            ("pylon", self.OLD),
            ("pylon-acp", self.OLD),
            ("pylon-session", self.OLD),
        ]:
            block = f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
            if name != "pylon":
                block += 'dependencies = [\n "serde",\n]\n'
            lock_blocks.append(block)
        (tauri / "Cargo.lock").write_text(
            "# This file is automatically @generated by Cargo.\nversion = 3\n\n"
            + "\n".join(lock_blocks),
            encoding="utf-8",
        )

    # ── --bump ──

    def test_bump_rejects_bad_or_same_version(self) -> None:
        for bad in ["abc", "1.2.3", "1.2.3-", "1.2.3-S UF", ""]:
            with self.assertRaises(pack.PackError, msg=bad):
                pack.bump_version_files(bad)
        with self.assertRaises(pack.PackError, msg="与当前相同"):
            pack.bump_version_files(self.OLD)

    def test_bump_patches_manifests_and_lock_in_lockstep(self) -> None:
        changed, cargo_count = pack.bump_version_files(self.NEW)
        rels = sorted(str(path.relative_to(pack.REPO_DIR)).replace("\\", "/") for path in changed)
        self.assertEqual(
            rels,
            [
                "package.json",
                "src-tauri/Cargo.lock",
                "src-tauri/Cargo.toml",
                "src-tauri/pylon-acp/Cargo.toml",
                "src-tauri/pylon-session/Cargo.toml",
                "src-tauri/tauri.conf.json",
            ],
        )
        self.assertEqual(cargo_count, 3)
        # 三处主版本 + 随调成员全部落位；独立版本号的 pylon-core 与第三方 serde 不动。
        self.assertEqual(pack.resolve_version(), self.NEW)
        self.assertIn(f'version = "{self.NEW}"', (pack.SRC_TAURI_DIR / "pylon-acp" / "Cargo.toml").read_text(encoding="utf-8"))
        core = (pack.SRC_TAURI_DIR / "pylon-core" / "Cargo.toml").read_text(encoding="utf-8")
        self.assertIn('version = "0.1.0"', core)
        self.assertNotIn(self.OLD, core)
        lock = (pack.SRC_TAURI_DIR / "Cargo.lock").read_text(encoding="utf-8")
        self.assertEqual(lock.count(f'version = "{self.NEW}"'), 3)
        self.assertIn('version = "1.0.999"', lock)
        self.assertNotIn(self.OLD, lock)

    def test_bump_is_atomic_on_count_mismatch(self) -> None:
        # 构造计数异常：某成员 toml 出现两行可匹配的 version（非法 toml 仅为触发守卫），
        # 落位必须在写盘前中止，任何文件不得半套落位。
        member = pack.SRC_TAURI_DIR / "pylon-acp" / "Cargo.toml"
        member.write_text(
            f'[package]\nname = "pylon-acp"\nversion = "{self.OLD}"\nversion = "{self.OLD}"\n',
            encoding="utf-8",
        )
        with self.assertRaises(pack.PackError) as raised:
            pack.bump_version_files(self.NEW)
        self.assertIn("出现 2 次", str(raised.exception))
        self.assertIn(f'"version": "{self.OLD}"', (self.tmp / "package.json").read_text(encoding="utf-8"))
        self.assertIn(self.OLD, (pack.SRC_TAURI_DIR / "Cargo.lock").read_text(encoding="utf-8"))

    def test_bump_is_atomic_on_version_source_inconsistency(self) -> None:
        (pack.SRC_TAURI_DIR / "tauri.conf.json").write_text(
            json.dumps({"version": "9.9.9-DRIFT"}, indent=2) + "\n", encoding="utf-8"
        )
        with self.assertRaises(pack.PackError) as raised:
            pack.bump_version_files(self.NEW)
        self.assertIn("三处版本不一致", str(raised.exception))
        self.assertIn(f'"version": "{self.OLD}"', (self.tmp / "package.json").read_text(encoding="utf-8"))

    def test_lock_patch_missing_crate_fails_without_write(self) -> None:
        lock = pack.SRC_TAURI_DIR / "Cargo.lock"
        lock.write_text(
            'version = 3\n\n[[package]]\nname = "pylon"\nversion = "%s"\n' % self.OLD,
            encoding="utf-8",
        )
        with self.assertRaises(pack.PackError) as raised:
            pack.bump_version_files(self.NEW)
        self.assertIn("pylon-acp", str(raised.exception))
        # lock 缺条目时 manifest 同样不得落盘。
        self.assertIn(f'"version": "{self.OLD}"', (self.tmp / "package.json").read_text(encoding="utf-8"))
        self.assertIn(self.OLD, lock.read_text(encoding="utf-8"))

    def test_commit_message_and_pathspec_commit(self) -> None:
        changed, cargo_count = pack.bump_version_files(self.NEW)
        fake = FakeGit({"status": (0, " M package.json\n")})
        pack._git = fake
        message = pack.commit_version_bump(changed, self.NEW, cargo_count)
        self.assertIn(f"chore(release): {self.NEW} 版本号落位", message)
        self.assertIn("3 处 Cargo.toml + lock", message)
        commit_calls = fake.invoked("commit")
        self.assertEqual(len(commit_calls), 1)
        self.assertEqual(commit_calls[0][1], "-m")
        self.assertEqual(commit_calls[0][2], message)
        self.assertEqual(commit_calls[0][3], "--")
        self.assertEqual(len(commit_calls[0]) - 4, len(changed), "pathspec 必须逐文件列出")
        fake_empty = FakeGit({"status": (0, "")})
        pack._git = fake_empty
        with self.assertRaises(pack.PackError, msg="无改动"):
            pack.commit_version_bump(changed, self.NEW, cargo_count)

    # ── --build 预检 ──

    def test_preflight_build_disk_threshold(self) -> None:
        probe = Path(tempfile.gettempdir())
        with mock.patch.object(pack.shutil, "disk_usage") as usage:
            usage.return_value = mock.Mock(free=5 * 1024**3)
            with self.assertRaises(pack.PackError, msg="10 GiB"):
                pack.preflight_build_disk(probe)
            usage.return_value = mock.Mock(free=20 * 1024**3)
            pack.preflight_build_disk(probe)

    # ── --upload 守卫 ──

    def test_upload_refuses_when_head_not_on_main(self) -> None:
        fake = FakeGit({
            "remote": (0, "github\n"),
            "rev-parse": (1, ""),  # tag 不存在
            "fetch": (0, ""),
            "merge-base": (1, ""),  # HEAD 不是 main 祖先
        })
        pack._git = fake
        with self.assertRaises(pack.PackError) as raised:
            pack.upload_release(None)
        self.assertIn("PR", str(raised.exception))
        self.assertIn("main", str(raised.exception))
        self.assertEqual(fake.invoked("tag"), [])
        self.assertEqual(fake.invoked("push"), [])

    def test_upload_refuses_when_tag_exists(self) -> None:
        fake = FakeGit({"remote": (0, "github\n"), "rev-parse": (0, "abc\n")})
        pack._git = fake
        with self.assertRaises(pack.PackError) as raised:
            pack.upload_release(None)
        self.assertIn("已存在", str(raised.exception))
        self.assertIn("workflow_dispatch", str(raised.exception))
        self.assertEqual(fake.invoked("push"), [])

    def test_upload_refuses_when_fetch_fails_with_proxy_hint(self) -> None:
        fake = FakeGit({
            "remote": (0, "github\n"),
            "rev-parse": (1, ""),
            "fetch": (1, "could not resolve host"),
        })
        pack._git = fake
        with self.assertRaises(pack.PackError) as raised:
            pack.upload_release(None)
        self.assertIn("http.proxy", str(raised.exception))

    def test_upload_success_tags_head_and_pushes(self) -> None:
        fake = FakeGit({
            "remote": (0, "github\n"),
            "rev-parse": (1, ""),
            "fetch": (0, ""),
            "merge-base": (0, ""),
        })
        pack._git = fake
        pack.bump_version_files(self.NEW)  # 编排序：先落位（此处免提交），再上传
        pack.upload_release(self.NEW)
        tag_calls = fake.invoked("tag")
        self.assertEqual(tag_calls, [("tag", f"v{self.NEW}", "HEAD")])
        push_calls = fake.invoked("push")
        self.assertEqual(push_calls, [("push", "github", f"v{self.NEW}")])

    def test_upload_rejects_version_mismatch_with_bump_target(self) -> None:
        with self.assertRaises(pack.PackError) as raised:
            pack.upload_release("9.9.9-NOPE")
        self.assertIn("不一致", str(raised.exception))

    def test_select_remote_prefers_github_falls_back_to_origin(self) -> None:
        pack._git = FakeGit({"remote": (0, "upstream\norigin\ngithub\n")})
        self.assertEqual(pack.select_git_remote(), "github")
        pack._git = FakeGit({"remote": (0, "upstream\norigin\n")})
        self.assertEqual(pack.select_git_remote(), "origin")
        pack._git = FakeGit({"remote": (0, "upstream\n")})
        with self.assertRaises(pack.PackError, msg="远端"):
            pack.select_git_remote()


if __name__ == "__main__":
    unittest.main()
