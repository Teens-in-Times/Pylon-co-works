//! golden 基线（issue #364 必需项）：锁「Claude Code 磁盘格式 → IR」的映射形状。
//!
//! 输入夹具 `tests/fixtures/<scene>/`（JSONL），期望 `tests/expected/<scene>.json`
//! （段数组；`sourcePath` 已脱敏为 `<redacted>`——绝对路径因机器而异，不属于
//! 契约）。CLI 升级改落盘形状时本基线先红，避免静默漏解析；**基线不得为跑绿
//! 而改**——形状变化必须经人工核对（真实样本验证）后落新基线。
//!
//! 比对用 `serde_json::to_value` 语义等价（键序不参与比较——serde_json 默认
//! BTreeMap 序稳定，但等价比较让重排不构成假红）。

use std::path::Path;

use pylon_agent_history::{ClaudeCodeParser, ExternalHistoryParser};
use serde_json::json;

fn snapshot(
    summary: &pylon_agent_history::ExternalSessionSummary,
    events: &[pylon_agent_history::ExternalEvent],
) -> serde_json::Value {
    json!({
        "summary": {
            "agentId": summary.agent_id,
            "externalId": summary.external_id,
            "title": summary.title,
            "startedAt": summary.started_at,
            "lastActivityAt": summary.last_activity_at,
            "eventCount": summary.event_count,
            "sourcePath": "<redacted>",
            "skippedLineCount": summary.skipped_line_count,
        },
        "events": events.iter().map(|event| json!({
            "occurredAt": event.occurred_at,
            "payload": event.payload,
        })).collect::<Vec<_>>(),
    })
}

fn assert_scene_matches_baseline(scene: &str) {
    let root = Path::new("tests/fixtures").join(scene);
    let mut actual = Vec::new();
    for summary in ClaudeCodeParser.discover(&root) {
        let record = ClaudeCodeParser
            .read(&root, &summary.external_id)
            .expect("discover 出现的段必须可 read");
        actual.push(snapshot(&record.summary, &record.events));
    }
    let expected_path = Path::new("tests/expected").join(format!("{scene}.json"));
    let expected_text = std::fs::read_to_string(&expected_path)
        .unwrap_or_else(|error| panic!("golden 基线缺失 {expected_path:?}: {error}"));
    let expected: serde_json::Value = serde_json::from_str(&expected_text)
        .unwrap_or_else(|error| panic!("golden 基线不是合法 JSON {expected_path:?}: {error}"));
    assert_eq!(
        serde_json::to_value(&actual).expect("actual 序列化"),
        expected,
        "场景 {scene} 的解析结果偏离 golden 基线——若因 CLI 格式演进，请人工核对真实样本后落新基线"
    );
}

#[test]
fn golden_basic_conversation() {
    assert_scene_matches_baseline("basic-conversation");
}

#[test]
fn golden_tool_roundtrip() {
    assert_scene_matches_baseline("tool-roundtrip");
}

#[test]
fn golden_usage_dedupe() {
    assert_scene_matches_baseline("usage-dedupe");
}

#[test]
fn golden_clear_rollover() {
    assert_scene_matches_baseline("clear-rollover");
}

#[test]
fn golden_skip_noise() {
    assert_scene_matches_baseline("skip-noise");
}
