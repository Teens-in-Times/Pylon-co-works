//! 原 plugin_cmds.rs `mod tests` 原样搬移（issue #228 批次D 结构拆分）。
//! `use super::*` 经 mod.rs 的 glob 再导出覆盖全部子模块符号。

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::http::{header, Request, StatusCode};

use super::*;

fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "pylon-phase7-{name}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn fixture(dir: &Path, version: &str, bytes: &[u8]) {
    fs::create_dir_all(dir.join("dist")).unwrap();
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(
        dir.join(MANIFEST),
        format!(r#"{{"schema":1,"id":"p.demo","name":"Demo","version":"{version}","api":"1.0","kind":"feature","web":{{"entry":"dist/entry.js"}}}}"#),
    )
    .unwrap();
    fs::write(dir.join("dist/entry.js"), b"export default {};").unwrap();
    fs::write(dir.join("assets/pixel.bin"), bytes).unwrap();
}

#[test]
fn first_list_self_heals_a_missing_plugin_directory() {
    let store = temp("first-list");
    assert!(!store.exists());
    ensure_layout_at(&store).expect("first list must create its layout");
    assert!(list_installed_at(&store)
        .expect("empty first list")
        .is_empty());
    assert!(packages(&store).is_dir());
    assert!(data(&store).is_dir());
    assert!(runtime(&store).is_dir());
    assert!(transactions(&store).is_dir());
    assert!(state_path(&store).is_file());
    fs::remove_dir_all(store).ok();
}

#[test]
fn rejects_path_escape() {
    assert!(validate_plugin_id("p.demo").is_ok());
    assert!(validate_plugin_id("../evil").is_err());
    assert!(validate_relative_path("assets/a.bin").is_ok());
    assert!(validate_relative_path("../evil").is_err());
    assert!(decode_component("..%2Fevil").is_err());
}

#[test]
fn rejects_removed_v01_manifest_fields() {
    let dir = temp("removed-manifest-fields");
    fixture(&dir, "1.0.0", &[]);
    let mut manifest = read_manifest(&dir).unwrap();
    manifest["signature"] = serde_json::json!("legacy-signature");
    fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(matches!(
        manifest_details(&dir),
        Err(PluginError::ManifestInvalid(message)) if message.contains("signature")
    ));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn rejects_invalid_dependency_range_in_manifest_shape_validation() {
    let dir = temp("invalid-dependency-range");
    fixture(&dir, "1.0.0", &[]);
    let mut manifest = read_manifest(&dir).unwrap();
    manifest["dependencies"] = serde_json::json!({ "service.clock": ">=1.0.0" });
    fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();

    assert!(matches!(
        manifest_details(&dir),
        Err(PluginError::ManifestInvalid(message))
            if message.contains("dependencies.service.clock")
    ));
    fs::remove_dir_all(dir).ok();
}

#[test]
fn binary_versions_pointer_and_data_retention() {
    let base = temp("install");
    let store = base.join("store");
    let one = base.join("one");
    let two = base.join("two");
    fixture(&one, "1.0.0", &[0, 159, 146, 150, 255]);
    fixture(&two, "2.0.0", &[1, 2, 3]);
    ensure_at(&store).unwrap();
    let v1 = install_at(&store, &one, "p.demo").unwrap();
    fs::write(data(&store).join("p.demo/user.db"), b"keep").unwrap();
    let v2 = install_at(&store, &two, "p.demo").unwrap();
    assert_ne!(
        v1.package.package_instance_id,
        v2.package.package_instance_id
    );
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&v2.package.package_instance_id)
    );
    assert!(packages(&store)
        .join("p.demo")
        .join(&v1.package.package_instance_id)
        .is_dir());
    let rolled_back = rollback_at(&store, "p.demo".into(), None).unwrap();
    assert_eq!(
        rolled_back.package.package_instance_id,
        v1.package.package_instance_id
    );
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&v1.package.package_instance_id)
    );
    uninstall_at(&store, "p.demo", false).unwrap();
    assert!(data(&store).join("p.demo/user.db").is_file());
    fs::remove_dir_all(base).ok();
}

#[test]
fn v2_list_and_enablement_share_the_active_package_state() {
    let base = temp("list-enabled");
    let store = base.join("store");
    let source = base.join("source");
    fixture(&source, "1.0.0", &[1]);
    ensure_at(&store).unwrap();
    install_at(&store, &source, "p.demo").unwrap();

    let initial = list_installed_at(&store).unwrap();
    assert_eq!(initial.len(), 1);
    assert!(initial[0].enabled);
    set_enabled_at(&store, "p.demo", false).unwrap();
    assert!(!list_installed_at(&store).unwrap()[0].enabled);
    set_enabled_at(&store, "p.demo", true).unwrap();
    assert!(list_installed_at(&store).unwrap()[0].enabled);
    assert!(set_enabled_at(&store, "missing.plugin", false).is_err());
    fs::remove_dir_all(base).ok();
}

#[test]
fn range_resource_and_traversal_guard() {
    let base = temp("resource");
    let store = base.join("store");
    let source = base.join("source");
    fixture(&source, "1.0.0", &[0, 1, 2, 3, 4, 5]);
    ensure_at(&store).unwrap();
    let package = install_at(&store, &source, "p.demo").unwrap().package;
    let request = Request::builder()
        .uri(format!(
            "pylon-plugin://localhost/{}/assets/pixel.bin",
            package.package_instance_id
        ))
        .header(header::RANGE, "bytes=2-4")
        .body(Vec::new())
        .unwrap();
    let response = resource_response_at(&store, request);
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body(), &[2, 3, 4]);
    let escape = Request::builder()
        .uri(format!(
            "pylon-plugin://localhost/{}/..%2Fstate.json",
            package.package_instance_id
        ))
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        resource_response_at(&store, escape).status(),
        StatusCode::BAD_REQUEST
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn interrupted_transaction_recovery_keeps_pointer() {
    let base = temp("recovery");
    let store = base.join("store");
    let source = base.join("source");
    fixture(&source, "1.0.0", &[9]);
    ensure_at(&store).unwrap();
    let active = install_at(&store, &source, "p.demo")
        .unwrap()
        .package
        .package_instance_id;
    let orphan_id = "p.demo@2.0.0-deadbeef";
    let orphan = packages(&store).join("p.demo").join(orphan_id);
    fs::create_dir_all(&orphan).unwrap();
    write_journal(
        &store,
        &Journal {
            operation_id: "interrupted".into(),
            plugin_id: "p.demo".into(),
            package_instance_id: orphan_id.into(),
            previous_active: Some(active.clone()),
            created_package: true,
        },
    )
    .unwrap();
    recover(&store).unwrap();
    assert!(!orphan.exists());
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&active)
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn staged_package_keeps_pointer_until_commit() {
    let base = temp("shadow-stage-commit");
    let store = base.join("store");
    let one = base.join("one");
    let two = base.join("two");
    fixture(&one, "1.0.0", &[1]);
    fixture(&two, "2.0.0", &[2]);
    ensure_at(&store).unwrap();
    let old = install_at(&store, &one, "p.demo").unwrap();

    let staged = stage_at(&store, &two, "p.demo").unwrap();
    assert!(!staged.package.active);
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&old.package.package_instance_id)
    );
    assert!(packages(&store)
        .join("p.demo")
        .join(&staged.package.package_instance_id)
        .is_dir());

    let committed = commit_stage_at(&store, &staged.operation_id).unwrap();
    assert!(committed.package.active);
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&staged.package.package_instance_id)
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn abort_and_recovery_preserve_old_pointer_and_remove_only_new_package() {
    let base = temp("shadow-stage-abort");
    let store = base.join("store");
    let one = base.join("one");
    let two = base.join("two");
    fixture(&one, "1.0.0", &[1]);
    fixture(&two, "2.0.0", &[2]);
    ensure_at(&store).unwrap();
    let old = install_at(&store, &one, "p.demo").unwrap();

    let aborted = stage_at(&store, &two, "p.demo").unwrap();
    let aborted_path = packages(&store)
        .join("p.demo")
        .join(&aborted.package.package_instance_id);
    abort_stage_at(&store, &aborted.operation_id).unwrap();
    assert!(!aborted_path.exists());
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&old.package.package_instance_id)
    );

    let interrupted = stage_at(&store, &two, "p.demo").unwrap();
    let interrupted_path = packages(&store)
        .join("p.demo")
        .join(&interrupted.package.package_instance_id);
    recover(&store).unwrap();
    assert!(!interrupted_path.exists());
    assert_eq!(
        read_state(&store).unwrap().active_versions.get("p.demo"),
        Some(&old.package.package_instance_id)
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn runtime_directory_cleanup_is_scoped_and_idempotent() {
    let root = temp("runtime");
    fs::create_dir_all(runtime(&root)).unwrap();
    create_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
    fs::write(
        runtime(&root).join("p.demo@1.0.0#run-1/temp.bin"),
        b"temporary",
    )
    .unwrap();
    cleanup_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
    cleanup_runtime_at(&root, "p.demo@1.0.0#run-1").unwrap();
    assert!(!runtime(&root).join("p.demo@1.0.0#run-1").exists());
    assert!(create_runtime_at(&root, "../escape").is_err());
    fs::remove_dir_all(root).ok();
}

#[test]
fn binary_larger_than_legacy_invoke_limit_installs_on_disk() {
    let base = temp("large-binary");
    let store = base.join("store");
    let source = base.join("source");
    fixture(&source, "1.0.0", &[]);
    let large = source.join("resources/model.bin");
    fs::create_dir_all(large.parent().unwrap()).unwrap();
    File::create(&large)
        .unwrap()
        .set_len(33 * 1024 * 1024)
        .unwrap();
    ensure_at(&store).unwrap();
    let installed = install_at(&store, &source, "p.demo").unwrap();
    let copied = packages(&store)
        .join("p.demo")
        .join(installed.package.package_instance_id)
        .join("resources/model.bin");
    assert_eq!(copied.metadata().unwrap().len(), 33 * 1024 * 1024);
    fs::remove_dir_all(base).ok();
}

// ── P53 D6：zip / URL 安装源 ──

fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = Default::default();
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn install_zip_rejects_path_traversal_entries() {
    let base = temp("zip-slip");
    let zip_path = base.join("evil.zip");
    let dest = base.join("dest");
    fs::create_dir_all(&base).unwrap();
    write_test_zip(&zip_path, &[("../evil.txt", b"escape")]);
    assert!(matches!(
        extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
        Err(PluginError::SourceInvalid(message)) if message.contains("unsafe zip entry")
    ));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_zip_rejects_oversized_extraction() {
    let base = temp("zip-oversize");
    let zip_path = base.join("big.zip");
    let dest = base.join("dest");
    fs::create_dir_all(&base).unwrap();
    let payload = vec![0u8; 4096];
    write_test_zip(
        &zip_path,
        &[
            ("pylon-plugin.json", b"{\"schema\":1}"),
            ("blob.bin", &payload),
        ],
    );
    // 实际写入计费（review P0-1）：take 限幅截断后触发 size mismatch 或超限拒绝，
    // 两条路径都是 fail-closed（不信任中央目录声明值）
    assert!(matches!(
        extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, 1024),
        Err(PluginError::SourceInvalid(message))
            if message.contains("exceeds limit") || message.contains("size mismatch")
    ));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_zip_requires_manifest_at_root() {
    let base = temp("zip-manifest");
    let zip_path = base.join("no-manifest.zip");
    let dest = base.join("dest");
    fs::create_dir_all(&base).unwrap();
    write_test_zip(&zip_path, &[("dist/entry.js", b"export default {};")]);
    assert!(matches!(
        extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
        Err(PluginError::SourceInvalid(message)) if message.contains("pylon-plugin.json")
    ));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_from_zip_rolls_back_store_on_invalid_manifest() {
    let base = temp("zip-rollback");
    let store = base.join("store");
    let zip_path = base.join("broken.zip");
    fs::create_dir_all(&base).unwrap();
    // 合法 zip 结构，但 manifest 缺 id → stage/commit 失败必须回滚
    write_test_zip(
        &zip_path,
        &[
            ("pylon-plugin.json", b"{\"schema\":1,\"name\":\"broken\"}"),
            ("dist/entry.js", b"export default {};"),
        ],
    );
    ensure_layout_at(&store).unwrap();
    let state_before = fs::read_to_string(state_path(&store)).unwrap_or_default();
    let extracted = base.join("extracted");
    extract_zip_archive(
        &zip_path,
        &extracted,
        MAX_INSTALL_ZIP_BYTES,
        MAX_INSTALL_EXTRACT_BYTES,
    )
    .unwrap();
    assert!(install_at(&store, &extracted, "p.demo").is_err());
    assert_eq!(
        fs::read_to_string(state_path(&store)).unwrap_or_default(),
        state_before
    );
    assert!(packages(&store)
        .join("p.demo")
        .read_dir()
        .map(|mut d| d.next().is_none())
        .unwrap_or(true));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_from_zip_installs_valid_package() {
    let base = temp("zip-happy");
    let store = base.join("store");
    let zip_path = base.join("demo.zip");
    fs::create_dir_all(&base).unwrap();
    write_test_zip(
        &zip_path,
        &[
            ("pylon-plugin.json", b"{\"schema\":1,\"id\":\"p.demo\",\"name\":\"Demo\",\"version\":\"1.0.0\",\"api\":\"1.0\",\"kind\":\"feature\",\"web\":{\"entry\":\"dist/entry.js\"}}"),
            ("dist/entry.js", b"export default {};"),
        ],
    );
    ensure_layout_at(&store).unwrap();
    let extracted = base.join("extracted");
    extract_zip_archive(
        &zip_path,
        &extracted,
        MAX_INSTALL_ZIP_BYTES,
        MAX_INSTALL_EXTRACT_BYTES,
    )
    .unwrap();
    let installed = install_at(&store, &extracted, "p.demo").unwrap();
    assert_eq!(installed.package.plugin_id, "p.demo");
    let state = read_state(&store).unwrap();
    assert_eq!(
        state.active_versions.get("p.demo").map(String::as_str),
        Some(installed.package.package_instance_id.as_str())
    );
    fs::remove_dir_all(base).ok();
}

#[tokio::test]
async fn extract_zip_off_thread_surfaces_extraction_errors() {
    let base = temp("zip-off-thread");
    let good = base.join("good.zip");
    let bad = base.join("bad.zip");
    fs::create_dir_all(&base).unwrap();
    write_test_zip(
        &good,
        &[
            ("pylon-plugin.json", b"{\"schema\":1}"),
            ("dist/entry.js", b"export default {};"),
        ],
    );
    write_test_zip(&bad, &[("dist/entry.js", b"export default {};")]);
    let extracted = base.join("extracted");
    extract_zip_off_thread(good, &extracted).await.unwrap();
    assert!(extracted.join("pylon-plugin.json").is_file());
    // 阻塞线程池边界不改写错误类型：校验失败仍是 SourceInvalid，而非 task panic。
    let error = extract_zip_off_thread(bad, &base.join("bad-out"))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        PluginError::SourceInvalid(message) if message.contains("pylon-plugin.json")
    ));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_zip_rejects_symlink_entries() {
    let base = temp("zip-symlink");
    let zip_path = base.join("link.zip");
    let dest = base.join("dest");
    fs::create_dir_all(&base).unwrap();
    let file = File::create(&zip_path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = Default::default();
    zip.add_symlink("evil-link", "../target", options).unwrap();
    zip.finish().unwrap();
    assert!(matches!(
        extract_zip_archive(&zip_path, &dest, MAX_INSTALL_ZIP_BYTES, MAX_INSTALL_EXTRACT_BYTES),
        Err(PluginError::SourceInvalid(message)) if message.contains("symlink")
    ));
    fs::remove_dir_all(base).ok();
}

#[test]
fn install_url_validation_rejects_non_https() {
    assert!(validate_install_url("https://example.com/demo.zip").is_ok());
    assert!(validate_install_url("http://example.com/demo.zip").is_err());
    assert!(validate_install_url("ftp://example.com/demo.zip").is_err());
    assert!(validate_install_url("file:///C:/demo.zip").is_err());
    assert!(validate_install_url("not a url").is_err());
}

#[test]
fn install_redirect_decision_rejects_non_https_and_excess_hops() {
    assert!(install_redirect_decision(1, "https").is_ok());
    // hops（previous().len()）= 已完成跳数 + 1：len == MAX 即第 5 跳仍放行，
    // len == MAX+1 即第 6 跳拒绝（实际允许 INSTALL_MAX_REDIRECTS 跳）
    assert!(install_redirect_decision(INSTALL_MAX_REDIRECTS, "https").is_ok());
    assert!(
        install_redirect_decision(INSTALL_MAX_REDIRECTS + 1, "https")
            .eq(&Err("too many redirects"))
    );
    assert!(install_redirect_decision(0, "http").eq(&Err("redirect to non-https url")));
    assert!(install_redirect_decision(0, "ftp").eq(&Err("redirect to non-https url")));
}
