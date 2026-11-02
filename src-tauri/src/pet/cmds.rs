//! 宠物状态命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::pet;
use crate::AppState;
use pylon_foundations::await_guard::HeldAcrossAwait;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::Manager;

/// 宠物状态落盘路径（统一从 AppState 的一次性 DataDirs 取）。
pub(crate) fn pet_persist_path(state: &AppState) -> Result<std::path::PathBuf, PylonError> {
    Ok(crate::paths::pet_persist_path(state.data_dirs()?))
}

/// 尽力持久化（同步路径：Exit 兜底）：路径解析或写盘失败只 warn，不阻断主流程。
pub(crate) fn persist_pet_if_possible(app: &tauri::AppHandle, pet: &pet::PetState) {
    let state = app.state::<AppState>();
    match pet_persist_path(&state) {
        Ok(path) => {
            if let Err(error) = pet::save_to_file(pet, &path) {
                tracing::warn!("persist pet state failed: {error}");
            }
        }
        Err(error) => tracing::warn!("resolve pet persist path failed: {}", error.raw_message()),
    }
}

/// 命令路径的写盘（R6a：移出 pet 锁内 IO）。
/// 写序由 `pet_write_lock`（tokio Mutex）保证：序列化在临界区内执行，后写状态必
/// ≥ 先写状态（无乱序覆盖）；pet 锁只做内存序列化（微秒级）；fs 写经
/// `spawn_blocking` 在阻塞线程池执行，不阻塞 async 运行时。
/// 失败只 warn（尽力持久化语义，与同步路径一致）。
/// O20：返回是否真正写盘成功——失败时调用方不得刷新节流时间戳（可重试）。
// R6a/O20：pet_write_lock 跨 spawn_blocking await 保证写序（fs 写在阻塞池，锁只做内存序列化外的写盘串行）
pub(crate) async fn persist_pet_async(state: &AppState) -> bool {
    let path = match pet_persist_path(state) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("resolve pet persist path failed: {}", error.raw_message());
            return false;
        }
    };
    let _write_guard = HeldAcrossAwait::new(state.pet.write_lock().lock().await);
    // 显式块限定 pet 锁守卫作用域：序列化（内存，微秒级）后立即释放，
    // 绝不把 std MutexGuard 带过 spawn_blocking await（跨 await 不 Send）。
    let json = {
        let pet_arc = state.pet.inner();
        let pet = match pet_arc.lock() {
            Ok(pet) => pet,
            Err(_) => {
                tracing::warn!("pet lock poisoned; skip persist");
                return false;
            }
        };
        match pet::serialize_state(&pet) {
            Ok(json) => json,
            Err(error) => {
                tracing::warn!("serialize pet state failed: {error}");
                return false;
            }
        }
    };
    match tokio::task::spawn_blocking(move || pet::write_json_atomic(&path, &json)).await {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            tracing::warn!("persist pet state failed: {error}");
            false
        }
        Err(error) => {
            tracing::warn!("persist pet task failed: {error}");
            false
        }
    }
}

/// 失败自愈重试间隔（G6-07b）：写盘失败后恢复 dirty 并 sleep 本间隔再重试——
/// 无新突变时 notify 无人唤醒，自愈计时器保证失败不悬挂（最坏丢失窗口 ≤60s）。
/// 取代 G6-07b 前的 get_pet re-arm 兜底（三层机制 → 两层：coalescing + Exit）。
const PET_FLUSH_RETRY_MS: u64 = 60_000;

/// R17：coalescing 落盘后台任务的 debounce 间隔——唤醒后合并 2s 内的连续突变。
const PET_FLUSH_DEBOUNCE_MS: u64 = 2_000;

// R17：进程级单例（宠物全局唯一）——状态突变路径不直接写盘，只置 dirty 并
// 唤醒后台任务；后台任务 debounce 后统一落盘（coalescing）。
// 替代"写锁 + 节流 + spawn_blocking"三件套的命令路径组合：写盘时机从"每次
// 突变立即写"变为"debounce 后合并写"，最坏丢失窗口仍 ≤60s（re-arm 兜底）。
static PET_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PET_NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();
static PET_FLUSH_SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// I18 W2（LR2-WI09，CR-001 修复）：轮询突变检测纯函数——返回是否发生实际变更（应 mark_dirty）。
/// 检测键：settle 更新 last_tick_at_ms、跨天更新 last_seen_day、check_sleepy 的「醒→睡」转移、
/// poll_voice 返回变更。**已入睡态 check_sleepy 恒返 true 但无状态变更**——以 machine 是否变化
/// 判定入睡 dirty（避免入睡期每轮冗余写盘）；入睡转移当次仍计 dirty（睡态本身已落盘）。
fn poll_changed(pet: &mut pet::PetState) -> bool {
    let tick_before = pet.last_tick_at_ms;
    let day_before = pet.last_seen_day;
    // CR-101：machine_before 必须在 daily_visit 之前捕获——apply 内 HSM 自动入睡
    // （energy≤15 && idle）可能在该步触发转移；之后再捕获会漏检该转移的 dirty
    // （入睡态不落盘 ≤60s 窗口）。
    let machine_before = pet.machine;
    pet::daily_visit(pet);
    let mut changed = pet.last_tick_at_ms != tick_before || pet.last_seen_day != day_before;
    let sleepy = pet::check_sleepy(pet);
    changed |= sleepy && pet.machine != machine_before;
    changed |= pet::poll_voice(pet);
    changed
}

/// 状态突变路径标记：置 dirty 并唤醒后台落盘任务（写盘时机由 debounce 决定）。
fn mark_dirty() {
    PET_DIRTY.store(true, Ordering::Release);
    PET_NOTIFY.notify_waiters();
}

/// Exit 兜底的有界 drain（lib.rs RunEvent::Exit 调用）：清 dirty 后直接同步
/// 持久化，后台任务不再重复写盘（在途写盘不受影响，与 R6a 尽力语义一致）。
pub(crate) fn drain_pet_dirty() {
    PET_DIRTY.store(false, Ordering::Release);
}

/// debounce 静默判定：消费 dirty 标志——置位说明唤醒窗口内仍有待写突变。
fn consume_dirty() -> bool {
    PET_DIRTY.swap(false, Ordering::AcqRel)
}

/// lazily spawn（get_pet 首次调用）：进程生命周期内只启动一个后台任务。
/// G6-07a：任务自启动检查存量 dirty——首个 get_pet 懒启动前 restore()/pet_action
/// 产生的突变（通知在无等待者时丢失）由 pet_flush_loop 的外层 while 先消费。
fn ensure_flush_task(app: &tauri::AppHandle) {
    if PET_FLUSH_SPAWNED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tokio::spawn(async move { pet_flush_loop(app).await });
}

/// 后台 coalescing 落盘任务：唤醒后 debounce 2s；期间新突变再次置 dirty 则
/// 继续合并；dirty 静默后写盘一次。写失败恢复 dirty 并 sleep PET_FLUSH_RETRY_MS
/// 自愈重试（G6-07b：无新突变时 notify 无人唤醒，自愈计时器兜底，不热循环）。
/// G6-07a：外层先消费存量 dirty 再等待通知——覆盖"任务 spawn 前 notify 已丢失"
/// 的启动窗口（首个 get_pet 懒启动前 restore()/pet_action 产生的突变，最长
/// 延迟 PET_FLUSH_RETRY_MS 才落盘）。判空检查在写盘之后——写盘先于判空，
/// 单次突变（含正常路径唤醒）必落盘；失败路径恢复 dirty + 自愈重试。
async fn pet_flush_loop(app: tauri::AppHandle) {
    loop {
        // 存量 dirty 立即处理（while 条件消费）：启动窗口与正常唤醒统一走
        // 同一条"debounce → 写盘 → 静默检查"批次。
        while consume_dirty() {
            tokio::time::sleep(Duration::from_millis(PET_FLUSH_DEBOUNCE_MS)).await;
            let state = app.state::<AppState>();
            if !persist_pet_async(&state).await {
                PET_DIRTY.store(true, Ordering::Release);
                // G6-07b：自愈重试——sleep 后回到外层 while 重新消费存量 dirty
                tokio::time::sleep(Duration::from_millis(PET_FLUSH_RETRY_MS)).await;
                break;
            }
            if !consume_dirty() {
                break;
            }
        }
        PET_NOTIFY.notified().await;
    }
}

#[tauri::command]
pub(crate) async fn get_pet(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    // R6a：pet 锁守卫限定在显式块内——块结束即释放（std MutexGuard 不可跨
    // await 保持 Send；显式块作用域比 drop(pet) 更可靠），下方 await 全部锁外。
    let value = {
        let pet_arc = state.pet.inner();
        let mut pet = pet_arc.lock().map_err(|e| e.to_string())?;
        // I18 W2（LR2-WI09）：轮询实际突变 → 统一 dirty/flush 契约（CR-001 修复后
        // 语义：已入睡态 check_sleepy 恒返 true 但无状态变更，不计 dirty——否则
        // 入睡期每轮冗余写盘）
        if poll_changed(&mut pet) {
            mark_dirty();
        }
        let msg = pet.msg.take();
        let mut value = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
        if let Some(message) = msg {
            value["msg"] = serde_json::Value::String(message);
        }
        value
    };
    // R17：get_pet 首次调用 lazily spawn coalescing 后台落盘任务（进程级单例）。
    // G6-07b：re-arm 兜底已删——失败自愈由 pet_flush_loop 的 PET_FLUSH_RETRY_MS
    // 计时器承担（三层机制 → 两层：coalescing + Exit）。
    ensure_flush_task(&app);
    Ok(value)
}

#[tauri::command]
pub(crate) async fn pet_action(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    action: String,
    value: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    // R6a：pet 锁守卫限定在显式块内（块结束即释放，std MutexGuard 不可跨 await）。
    let result = {
        let pet_arc = state.pet.inner();
        let mut pet = pet_arc.lock().map_err(|e| e.to_string())?;
        let mut sleepy_result: Option<bool> = None;
        match action.as_str() {
            "poke" => {
                pet::on_poke(&mut pet);
            }
            "feed" => {
                pet::on_feed(&mut pet);
            }
            "play" => {
                pet::on_play(&mut pet);
            }
            "rename" => {
                if let Some(v) = value {
                    pet::rename(&mut pet, &v);
                }
            }
            "daily" => {
                pet::daily_visit(&mut pet);
            }
            "sleepy" => {
                sleepy_result = Some(pet::check_sleepy(&mut pet));
            }
            "nostalgia" => {
                pet::recall_memory(&mut pet);
            }
            // M10：装扮装备/卸下（equip 失败返回原因，不 panic）
            "equip" => {
                let item_id = value.ok_or_else(|| "equip requires item id".to_string())?;
                pet::equip(&mut pet, &item_id).map_err(PylonError::Protocol)?;
            }
            "unequip" => {
                pet::unequip(&mut pet);
            }
            "restore" => {
                let raw = value.ok_or_else(|| "restore requires pet state".to_string())?;
                let saved = serde_json::from_str(&raw)
                    .map_err(|error| format!("invalid pet state: {error}"))?;
                pet::restore(&mut pet, saved);
            }
            _ => {
                return Err(PylonError::Protocol(format!("unknown action: {}", action)));
            }
        }
        let msg = pet.msg.take();
        let mut result = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
        if let Some(sleepy) = sleepy_result {
            // 透传 check_sleepy 结果，前端据此切换睡眠动画/状态
            result["sleepy"] = serde_json::Value::Bool(sleepy);
        }
        if let Some(message) = msg {
            result["msg"] = serde_json::Value::String(message);
        }
        result
    };
    // R6a：状态突变路径不直接写盘（磁盘 IO 全量移出 pet 锁 + 命令路径）。
    // R17：统一 mark_dirty——poke/play 连点等高频突变由后台任务 debounce 合并
    // 为一次写盘；写失败恢复 dirty 由后台任务 PET_FLUSH_RETRY_MS 自愈重试。
    mark_dirty();
    Ok(result)
}

#[allow(dead_code)] // 宠物时钟（未来接入宠物事件）
fn real_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_flag_mark_consume_and_drain_round_trips() {
        PET_DIRTY.store(false, Ordering::Release);
        assert!(!consume_dirty());
        mark_dirty();
        assert!(PET_DIRTY.load(Ordering::Acquire));
        assert!(consume_dirty());
        assert!(!consume_dirty());
        mark_dirty();
        drain_pet_dirty();
        assert!(!PET_DIRTY.load(Ordering::Acquire));
        PET_DIRTY.store(false, Ordering::Release);
    }

    #[test]
    fn poll_changed_asleep_same_minute_does_not_dirty() {
        // CR-001 回归：已入睡 + 同分钟（dt=0）→ check_sleepy 恒返 true 但无状态变更，
        // poll_changed 必须返回 false（否则入睡期每轮冗余 dirty 写盘）。
        // CR-103：last_seen_day 置未来 → visit 必然 no-op（today ≤ last_seen_day），
        // 测试与真实时钟/时区/跨天边界解耦（东八区晨间窗口不再失败）。
        let now = real_now_ms();
        let mut pet = pet::PetState::new_at(now.saturating_sub(60_000));
        pet.machine = pylon_pet_core::PetMachineState::Asleep;
        pet.last_tick_at_ms = now; // dt=0，隔离 settle 衰减
        pet.last_seen_day = u64::MAX; // 防 daily_visit 时区注入误触发跨天 visit
        assert!(
            !poll_changed(&mut pet),
            "已入睡 + dt=0 不得计为实际变更（CR-001）"
        );
    }

    #[test]
    fn poll_changed_sleep_transition_counts_as_change() {
        // 醒→睡转移当次必须计 dirty（睡态本身需落盘）
        let now = real_now_ms();
        let mut pet = pet::PetState::new_at(now.saturating_sub(60_000));
        pet.last_tick_at_ms = now; // dt=0，隔离 settle——changed 仅来自醒→睡转移
        pet.last_seen_day = u64::MAX; // 防跨天 visit 干扰（断言仍成立）
                                      // new_at 初始 machine=Awake(Idle)、last_activity=0 → check_sleepy(now) 触发入睡
        assert!(poll_changed(&mut pet), "醒→睡转移必须计 dirty（CR-001）");
    }

    #[test]
    fn poll_changed_hsm_auto_sleep_transition_counts_as_change() {
        // CR-101：apply(Visit) 内 HSM 自动入睡（energy≤15 && idle）的转移必须计 dirty——
        // machine_before 在 daily_visit 之前捕获后，该转移可被识别（入睡态落盘）。
        let now = real_now_ms();
        let mut pet = pet::PetState::new_at(now.saturating_sub(60_000));
        pet.last_tick_at_ms = now; // dt=0
        pet.last_seen_day = u64::MAX; // 防跨天 visit 干扰
        pet.energy = 10; // ≤15 → HSM 自动入睡阈值
                         // new_at 初始 machine=Awake(Idle)、last_activity=0 → HSM 在 daily_visit 内入睡
        assert!(
            poll_changed(&mut pet),
            "HSM 自动入睡转移必须计 dirty（CR-101）"
        );
    }
}
