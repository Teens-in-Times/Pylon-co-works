//! Tauri 与独立宠物核心状态机之间的薄适配层。

pub(crate) mod cmds;

pub use pylon_pet_core::{
    AchievementInfo, AiEvent, CosmeticInfo, DayPart, GrowthStage, PetState, ToolKind, ToolOutcome,
};
use serde::Serialize;
use std::sync::Arc;

/// #707-A：宠物域——状态槽与落盘写序锁（R6a）单一所有者，不再平铺 AppState
/// 的 shared `pet` + app_only `pet_write_lock` 两处。域方法保持既有锁形态：
/// 状态槽仍是 `Arc<Mutex<PetState>>`（sink/命令/restore 以 Arc 消费），写序锁
/// 仍是 tokio Mutex（序列化在临界区内执行，后写状态 ≥ 先写状态；fs 写经
/// spawn_blocking 移出 async 运行时）。
#[derive(Clone, Default)]
pub(crate) struct PetDomain {
    state: Arc<std::sync::Mutex<PetState>>,
    write_lock: Arc<tokio::sync::Mutex<()>>,
}

impl PetDomain {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 宠物状态槽（Arc 克隆；既有 pet 域函数与 PetReactionSink 以 Arc 消费）。
    pub(crate) fn inner(&self) -> Arc<std::sync::Mutex<PetState>> {
        self.state.clone()
    }

    /// R6a：宠物落盘写序锁——persist_pet_async 的临界区守卫。
    pub(crate) fn write_lock(&self) -> &tokio::sync::Mutex<()> {
        &self.write_lock
    }
}

#[derive(Debug, Serialize)]
pub struct PetView<'a> {
    #[serde(flatten)]
    pub state: &'a PetState,
    pub stage: GrowthStage,
    pub title: &'static str,
    pub age_days: u64,
    pub next_stage_xp: Option<u32>,
    pub growth_progress: u8,
    /// M7：捏朋友进行中（前端进度展示）。
    pub crafting: bool,
    /// M8：当前时段（dawn/day/dusk/night）——前端可显示时段状态/差异。
    pub day_part: DayPart,
    /// M9：成就全量目录 + 解锁标志（前端徽章墙/进度展示）。
    pub achievements: Vec<AchievementInfo>,
    /// M10：装扮全量目录 + 拥有标志（前端外观/装备界面）。
    pub cosmetics: Vec<CosmeticInfo>,
}

pub fn view(state: &PetState) -> PetView<'_> {
    let stage = state.stage();
    // O14：now_ms() 只取一次，age_days/day_part 共用（两次调用间时钟偏移原可致
    // 展示不一致，行为等价且更省一次系统调用）。
    let now = now_ms();
    PetView {
        state,
        stage,
        title: stage.title(),
        age_days: state.age_days(now),
        next_stage_xp: state.next_stage_xp(),
        growth_progress: state.growth_progress(),
        crafting: state.pending_action.is_some(),
        day_part: state.day_part(now),
        // G6-01：目录构建知识收敛到 pet-core（骨架 OnceLock 缓存 + 现算标志，
        // 桥接层双轨实现删除——原 achievement_directory/cosmetic_directory）。
        achievements: state.achievement_info(),
        cosmetics: state.cosmetic_info(),
    }
}

/// 统一事件入口：注入本地时区偏移（M8 时段感知）后 apply。
/// 时段判定粒度是小时，事件路径每次 set 的成本（一次 GetLocalTime）可忽略。
fn apply(state: &mut PetState, event: AiEvent) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.apply(event, now_ms());
}

pub fn restore(state: &mut PetState, saved: PetState) {
    state.set_local_offset_minutes(local_offset_minutes());
    *state = PetState::restore(saved, now_ms());
}

pub fn on_user_sent(state: &mut PetState) {
    apply(state, AiEvent::UserSent);
}

pub fn on_first_chunk(state: &mut PetState) {
    apply(state, AiEvent::FirstChunk);
}

pub fn on_done(state: &mut PetState) {
    apply(state, AiEvent::PromptCompleted);
}

pub fn on_error(state: &mut PetState) {
    apply(state, AiEvent::PromptFailed);
}

pub fn on_poke(state: &mut PetState) {
    apply(state, AiEvent::Poke);
}

pub fn on_feed(state: &mut PetState) {
    apply(state, AiEvent::Feed);
}

/// M4：玩耍（消耗 energy，恢复 fun/降低孤独；60s bond 冷却）。
pub fn on_play(state: &mut PetState) {
    apply(state, AiEvent::Play);
}

pub fn on_usage_update(state: &mut PetState, total: u64) {
    apply(state, AiEvent::TokenUsage { total });
}

/// M5：工具开始（带分类）——吃代码/捏朋友信号。
pub fn on_tool_started_kind(state: &mut PetState, kind: ToolKind) {
    apply(state, AiEvent::ToolStarted { kind });
}

/// M5：工具被取消（打断）。
pub fn on_tool_cancelled(state: &mut PetState) {
    apply(state, AiEvent::ToolCancelled);
}

/// M5：工作模式切换。
pub fn on_mode_changed(state: &mut PetState, mode: &str) {
    apply(
        state,
        AiEvent::ModeChanged {
            mode: mode.to_string(),
        },
    );
}

/// M5：模型切换。
pub fn on_model_changed(state: &mut PetState, model: &str) {
    apply(
        state,
        AiEvent::ModelChanged {
            model: model.to_string(),
        },
    );
}

/// M5：agent 拒绝。
pub fn on_refused(state: &mut PetState) {
    apply(state, AiEvent::PromptRefused);
}

/// M5：达到轮次上限。
pub fn on_maxed(state: &mut PetState) {
    apply(state, AiEvent::PromptMaxed);
}

/// M5：prompt 超时（发呆）。
pub fn on_timeout(state: &mut PetState) {
    apply(state, AiEvent::PromptTimeout);
}

/// M5：输出含代码块。
pub fn on_code_seen(state: &mut PetState) {
    apply(state, AiEvent::CodeSeen);
}

/// M5：记录吃过的代码文件名（脱敏摘要）。
pub fn record_code_file(state: &mut PetState, file: &str) {
    state.record_code_file(file);
}

pub fn on_tool_success(state: &mut PetState) {
    apply(
        state,
        AiEvent::ToolCall {
            outcome: ToolOutcome::Succeeded,
        },
    );
}

pub fn on_tool_failure(state: &mut PetState) {
    apply(
        state,
        AiEvent::ToolCall {
            outcome: ToolOutcome::Failed,
        },
    );
}

pub fn on_agent_connected(state: &mut PetState) {
    apply(state, AiEvent::AgentConnected);
}

pub fn on_agent_crashed(state: &mut PetState) {
    apply(state, AiEvent::AgentCrashed);
}

pub fn recall_memory(state: &mut PetState) {
    state.msg = state
        .recall_memory()
        .or_else(|| Some("还没有形成长期记忆。".into()));
}

pub fn check_sleepy(state: &mut PetState) -> bool {
    state.check_sleepy(now_ms())
}

pub fn daily_visit(state: &mut PetState) {
    apply(state, AiEvent::Visit);
}

/// M6：主动说话（需求危机/延迟行为完成 → msg）。get_pet 轮询调用。
pub fn poll_voice(state: &mut PetState) -> bool {
    state.poll_voice(now_ms())
}

pub fn rename(state: &mut PetState, value: &str) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.rename(value, now_ms());
}

/// M10：装备装扮（校验拥有/成长解锁；失败返回原因字符串）。
pub fn equip(state: &mut PetState, item_id: &str) -> Result<(), String> {
    state.set_local_offset_minutes(local_offset_minutes());
    state.equip(item_id).map(|_| ())
}

/// M10：卸下装扮。
pub fn unequip(state: &mut PetState) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.unequip();
}

/// 本地时区偏移（分钟，东正西负）：R16：chrono Local 取真实分钟偏移
/// （含 DST、半时区）；其他平台回退 UTC（0）。时段判定精度为小时，偏移
/// 进程内不变，进程级缓存一次。
fn local_offset_minutes() -> i32 {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicI32, Ordering};
        static CACHED_OFFSET: AtomicI32 = AtomicI32::new(i32::MIN);
        let cached = CACHED_OFFSET.load(Ordering::Relaxed);
        if cached != i32::MIN {
            return cached;
        }
        // local_minus_utc() 返回秒（i32），/60 → 分钟（东八区 +8 → +480；
        // DST/半时区也正确——A2 修单位，R16 修精度）。
        let minutes = chrono::Local::now().offset().local_minus_utc() / 60;
        CACHED_OFFSET.store(minutes, Ordering::Relaxed);
        minutes
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn now_ms() -> u64 {
    // R4：统一走 Timestamp（Unix 毫秒），不再重复 SystemTime 换算。
    crate::time::Timestamp::now().as_u64()
}

/// 序列化宠物状态（R6a：与磁盘写分离——调用方可在锁内只做内存序列化，
/// 慢速 fs 写移出 pet 锁经 [`Self::write_json_atomic`] 执行）。
pub fn serialize_state(state: &PetState) -> Result<String, String> {
    serde_json::to_string(state).map_err(|e| e.to_string())
}

/// G6-08：写序锁（护 **rename 序**）——异步路径（persist_pet_async 的
/// spawn_blocking 闭包）与 Exit 同步路径（save_to_file）串行化"唯一 temp +
/// rename"，杜绝"旧序列化后 rename 覆盖新档"的关窗竞态（最后 rename 者必为
/// 最新状态）。与 `pet_write_lock`（AppState 字段，tokio Mutex，护 **序列化序**）
/// 职责正交——一个护序列化序、一个护 rename 序，两层锁各司其职。
/// 两个调用方均为非 async 上下文，锁内无 await、无嵌套调用（本函数不调用
/// 自身/其他写盘函数），无死锁风险；未竞争时开销可忽略。
static STATE_FILE_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 原子写：唯一临时文件 + rename，中断也不会留下半截 JSON。经 agent_config
/// 正身 [`pylon_foundations::atomic_write::AtomicWriteOptions`] 收敛（issue #228 批次D；
/// 旧内联 temp 生成器删除）。历史行为保留：不 fsync 临时文件（best-effort
/// 存档路径，与 lifecycle MCP 同源），失败告警后仍返回 Err。
pub fn write_json_atomic(path: &std::path::Path, json: &str) -> Result<(), String> {
    let _write_guard = STATE_FILE_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    if let Err(error) = pylon_foundations::atomic_write::write_file_atomically(
        path,
        json.as_bytes(),
        pylon_foundations::atomic_write::AtomicWriteOptions::best_effort_data_file(),
    ) {
        tracing::warn!("write state file failed: {error}");
        return Err(error.to_string());
    }
    Ok(())
}

/// 序列化 + 原子写（Exit 兜底等同步路径；高频路径请用 serialize_state + write_json_atomic 分离）。
pub fn save_to_file(state: &PetState, path: &std::path::Path) -> Result<(), String> {
    let json = serialize_state(state)?;
    write_json_atomic(path, &json)
}

/// 容错读：文件缺失/损坏一律返回 None（启动时静默降级为新宠物）。
/// O17：读前预检大小（>16MB 视为损坏返回 None）——防止意外超大文件
/// 被 read_to_string 全量读入内存（正常档 <1KB，16MB 是宽松上限）。
const MAX_STATE_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub fn load_from_file(path: &std::path::Path) -> Option<PetState> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_STATE_FILE_BYTES {
        tracing::warn!("state file too large ({} bytes), treating as corrupt", len);
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_round_trips_state() {
        let dir = crate::test_utils::unique_temp("pet-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pylon-pet.json");
        let mut pet = PetState::new_at(1_000);
        pet.apply(AiEvent::PromptCompleted, 2_000);
        save_to_file(&pet, &path).expect("save must succeed");
        let loaded = load_from_file(&path).expect("load must succeed");
        assert_eq!(loaded.name, "微栖");
        assert_eq!(loaded.xp, pet.xp);
        assert_eq!(loaded.stats.prompts_completed, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_missing_or_corrupt_returns_none() {
        let dir = crate::test_utils::unique_temp("pet-bad");
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.json");
        assert!(load_from_file(&missing).is_none());
        let corrupt = dir.join("corrupt.json");
        std::fs::write(&corrupt, "{not json").unwrap();
        assert!(load_from_file(&corrupt).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn visit_absence_increases_loneliness_not_happiness() {
        // I18 W4（用户 2026-08-12 拍板「loneliness 增长」）：缺席跨天 → loneliness 增长，
        // happiness 不再被扣减（旧实现 happiness -= loneliness 让缺席只降快乐且 loneliness 恒 0）。
        let mut pet = PetState::new_at(1_000);
        // CR-002：last_tick 置近 now（settle dt=0 无衰减）——隔离 settle，loneliness 增长仅来自 visit
        pet.last_tick_at_ms = 3 * 86_400_000;
        let happiness_before = pet.happiness;
        let loneliness_before = pet.loneliness;
        // 3 天后的 Visit（跨天触发 visit 效果）
        pet.apply(AiEvent::Visit, 3 * 86_400_000 + 1_000);
        assert_eq!(
            pet.loneliness,
            loneliness_before + 6,
            "缺席 3 天 → loneliness += 3×2=6（仅 visit 贡献）"
        );
        assert_eq!(
            pet.happiness, happiness_before,
            "缺席不再直接扣 happiness（用户拍板口径）"
        );
    }

    #[test]
    fn restore_then_immediate_poll_does_not_sleep() {
        // I18 W3（LR2-WI09）：restore 视为苏醒——last_activity_at_ms = now 而非 0
        //（serde skip 运行时字段），否则首轮轮询 check_sleepy 按 0 起算空闲 →
        // 立即入睡，与「又亮起来了」文案冲突。经可观察行为断言（不立即入睡）。
        let saved = PetState::new_at(1_000);
        let mut restored = PetState::restore(saved, 999_000);
        assert!(
            !restored.check_sleepy(999_100),
            "restore 后立即轮询不得入睡（旧实现 last_activity=0 → 立即入睡）"
        );
    }

    #[test]
    fn restore_dedups_unlocked_achievements() {
        // I18 W4（LR2-WI09）：损坏存档重复成就 id → 去重（重复 id 会错误触发
        // unlock_achievements 的 len≥表长 early-exit 漏解锁）；未知 id 剔除保留诊断。
        let mut saved = PetState::new_at(1_000);
        let first_unlocked = saved
            .achievement_info()
            .into_iter()
            .find(|a| !a.unlocked)
            .map(|a| a.id)
            .expect("存在未解锁成就");
        saved.unlocked = vec![
            first_unlocked.to_string(),
            first_unlocked.to_string(),
            "ghost_achievement".into(),
        ];
        let restored = PetState::restore(saved, 2_000);
        assert_eq!(
            restored
                .unlocked
                .iter()
                .filter(|id| **id == first_unlocked)
                .count(),
            1,
            "重复成就 id 必须去重"
        );
        assert!(
            !restored.unlocked.iter().any(|id| id == "ghost_achievement"),
            "未知成就 id 必须剔除"
        );
    }
}

#[cfg(test)]
mod pet_domain_tests {
    use super::*;

    /// #707-A：域槽位单实例（inner 返回同一 Arc）+ 写序锁持有期互斥（R6a）。
    #[test]
    fn pet_domain_slot_is_shared_and_write_lock_is_exclusive() {
        let domain = PetDomain::new();
        let first = domain.inner();
        let second = domain.inner();
        assert!(
            Arc::ptr_eq(&first, &second),
            "inner 必须返回同一状态槽 Arc"
        );
        let guard = domain.write_lock().try_lock();
        assert!(guard.is_ok(), "空闲写锁必须可获取");
        assert!(
            domain.write_lock().try_lock().is_err(),
            "持有期间写锁必须互斥（persist_pet_async 串行化前提）"
        );
    }
}
