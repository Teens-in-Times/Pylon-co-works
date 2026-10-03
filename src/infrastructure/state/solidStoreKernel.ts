import { unwrap } from 'solid-js/store'
import { createStore, produce } from 'solid-js/store'

/**
 * Solid store 内核（#515 前端全量 Solid 化批0）：zustand 运行时的就地置换件。
 *
 * 各域 store 的状态本体从 zustand `create` 换成 `solid-js/store` 细粒度 store，
 * 但对外**保 zustand 门面签名**（getState / setState(partial, replace?) / subscribe /
 * getInitialState）。#515 W3 起 React 面退役、过渡 shim 已删除：各 store 直接
 * `export const useXxxStore: SolidStoreKernel<T> = kernel` 直连本门面，消费面统一是
 * getState/setState/subscribe 直用与 createZustandSignal（组件响应式读取）。
 *
 * 语义对齐点（zustand v5 vanilla）：
 * - `setState(partial)` 浅合并；partial / updater **求值结果与当前 state 同一引用时整体跳过**
 *   （两形态一致，不合并、不通知——zustand 的 `Object.is` 守卫在 setState 入口统一生效）；
 *   合并后必产新通知（无值级判等——与 zustand 一致，判等在消费侧）。
 * - `setState(next, true)` 整体替换（resetStores 的 `setState(getInitialState(), true)` 依赖）。
 * - `subscribe(listener)` 收 `(state, prevState)`；⚠️ prevState 与 state 同一引用且为**写后值**
 *   （produce/reconcile 就地改写裸对象，无写前快照）——不要拿它做 diff，zustand 语义在此不成立。
 * - `getInitialState()` 返回**创建时的初始对象**（浅捕获；嵌套对象与 zustand 一样
 *   不做深拷贝——写入方各自负责 clone，见 themeStore resetTheme 的 structuredClone）。
 * - 状态本体是 Solid store 代理：引用跨写入稳定，读取方拿到的代理可当不可变快照用
 *   （一切写入必须经 action 的 set，代理外无写通道）。
 */

export interface SolidStoreKernel<T extends object> {
  /** zustand `getState()` 等价：当前状态（Solid store 代理）。 */
  getState: () => T
  /** zustand `setState(partial | updater, replace?)` 等价。 */
  setState: (partial: Partial<T> | ((state: T) => Partial<T>), replace?: boolean) => void
  /** zustand `subscribe(listener)` 等价；listener 收 `(state, prevState)`。 */
  subscribe: (listener: (state: T, prevState: T) => void) => () => void
  /** zustand `getInitialState()` 等价：创建时的初始状态对象。 */
  getInitialState: () => T
  /** 通知计数（每次 set 单调 +1）——外部快照缓存以它判「快照是否过期」。 */
  getVersion: () => number
  /**
   * Solid store 代理本体（终态直连用；state 即终态读取面）。
   * ⚠️ 当前全仓无调用方（#520 S2-P2 审计：零读取者）——逃生口仅为内核调试保留，勿在生产代码使用。
   */
  readonly state: T
}

export function createSolidStoreKernel<T extends object>(initial: T): SolidStoreKernel<T> {
  const [state, setState] = createStore<T>(initial)
  const initialState = { ...initial }
  const listeners = new Set<(state: T, prevState: T) => void>()
  // current = unwrap 后的裸对象树：getState() 的消费者（纯 reducer、structuredClone、
  // 旧 React 面）拿到的是普通对象（zustand 同款），不会漏出不可克隆的 Solid 代理。
  // 一切写入仍走 setState（produce/reconcile 改写同一裸对象），`state` 代理照常响应。
  const current = unwrap(state) as T
  let version = 0

  const notify = (prev: T) => {
    version += 1
    for (const listener of [...listeners]) listener(current, prev)
  }

  const kernel: SolidStoreKernel<T> = {
    getState: () => current,
    setState: (partial, replace) => {
      const next = typeof partial === 'function' ? partial(current) : partial
      // zustand 同款：next 与当前 state 同一引用 ⇒ 整体跳过（不写、不通知），两形态
      // 一致——zustand 的守卫对 partial / updater 结果统一 `Object.is` 判断，不分函数
      // 与对象形态。replace 调用点审计：persist hydration 传**新建** merged、resetStores
      // 传 getInitialState() **新拷贝**，均恒 ≠ current，不受本守卫影响。
      if (Object.is(next, current)) return
      // ★ replace 不得用 `reconcile`：reconcile 为了细粒度更新会**就地合并旧树的嵌套
      //   数据**（数组走 `setProperty(previous, 'length', …)` 逐位覆写）——旧状态里的
      //   嵌套对象/数组可能藏着**调用方自有引用**（zustand 时代一直如此共享：出厂区域
      //   预设池的 `values` 数组经 `effectivePresetTheme`/`filterPresetTheme` 浅拷贝进
      //   state；hydration merge 的 `...current` 还会把 `DEFAULTS` 的数组铺进初始树）。
      //   就地改写等于把这些外部数据打穿（#515 定位：defaultPresets「铁律1」在批0 后
      //   必红的根因——resetStores 一跑，出厂池的 ccHidden 数组被清空）。zustand v5 的
      //   replace 从不改写旧状态 ⇒ 这里用 produce 逐键**整键换入**（数组/对象按引用整
      //   替，solid 对非 merge 赋值不做就地合并），并删除 next 缺席的键（replace=整体
      //   置换语义），旧树除根属性引用外零触碰；代理身份照旧稳定。
      setState(produce(s => {
        const target = s as Record<string, unknown>
        const patch = next as Record<string, unknown>
        if (replace) {
          for (const key of Object.keys(target)) {
            if (!(key in patch)) delete target[key]
          }
        }
        Object.assign(target, patch)
      }))
      notify(current)
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getInitialState: () => initialState,
    getVersion: () => version,
    state,
  }
  return kernel
}

/**
 * 浅比较判等（原 zustand `useShallow` 的本地等价，React shim 退役后自本文件导出）。
 * 消费面：createMemo 的 `equals` 选项（App.solid themeBaseline / Settings.solid
 * themeState）——滤掉「引用变了、浅内容没变」的写入，避免无值变化的下游重算。
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const keysA = Object.keys(a as Record<string, unknown>)
  const keysB = Object.keys(b as Record<string, unknown>)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

/** solidStoreBridge 兼容的最小结构面（ getState/subscribe 双件套）。 */
export interface ZustandStoreLike<T> {
  getState: () => T
  subscribe: (listener: (state: T) => void) => () => void
}

/** zustand persist 的字符串存储接口（createJSONStorage 包一层前的形状）。 */
export interface PersistStringStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * localStorage 安全解析（createJSONStorage(() => localStorage) 的等价惰性 + 吞异常）：
 * node 测试环境无 localStorage ⇒ 返回 null ⇒ persist 整体 no-op（zustand 同款），
 * jsdom / WebView2 / 浏览器 mock 下返回真存储。
 */
export function resolveLocalStorage(): PersistStringStorage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

export interface SolidPersistOptions<T extends object> {
  /** zustand persist `name`：localStorage 键。 */
  name: string
  version?: number
  /** null = 存储不可用（node 测试环境），persist 整体 no-op。 */
  storage: PersistStringStorage | null
  partialize?: (state: T) => Partial<T>
  /** 缺省 `{ ...current, ...persisted }`（zustand 默认 merge）。 */
  merge?: (persisted: unknown, current: T) => T
  /**
   * 版本不一致时的一次性语义迁移；跑过必回写一次（zustand 同款行为）。
   * **必须同步返回**——返回 Promise/thenable 会被拒收（console.error + 丢弃 persisted，
   * 保持初始态不回写），同步内核无法等待。
   */
  migrate?: (persisted: unknown, version: number | undefined) => T | Partial<T>
  onRehydrateStorage?: () => (state?: T, error?: unknown) => void
}

/**
 * zustand `persist` 中间件的本仓子集复刻（#515 批0）。
 *
 * 只实现本仓实际用到的语义，磁盘信封**逐字节兼容** zustand createJSONStorage 的
 * `{"state":…,"version":N}`——存量 localStorage 条目原地可读，无一次性搬家：
 * - 读到合法信封 → 版本不一致走 `migrate` 并**回写一次**；一致则只落 `merge`；
 *   版本错位且**无 migrate**、或 migrate 返回 **Promise**（异步不受支持）→ zustand
 *   同款「丢弃 + 告警」：console.error 后丢弃 persisted，保持内存初始态，**不回写**；
 * - hydrate 落盘走 merge 后的整份状态但**不触发写盘**（先 hydrate 后挂写回订阅）；
 * - 写回在每次 set 通知后同步执行（zustand 同款：resetStores 依赖同步落盘），
 *   载荷经 `partialize` 白名单（缺省整份状态，函数成员被 JSON.stringify 自然丢弃）；
 *   写回异常（配额满 / 隐私模式）就地吞掉并 console.error——writeBack 是订阅
 *   listener，异常越出会中止 notify 循环，zustand 的写回在 notify 后执行无此问题；
 * - 解析失败 / 上述丢弃路径：放弃该 persisted（zustand 同款，错误经
 *   onRehydrateStorage 的 error 位可见），内存初始态兜底。
 */
export function attachSolidPersist<T extends object>(kernel: SolidStoreKernel<T>, options: SolidPersistOptions<T>): void {
  // 存储不可用（node 测试环境）⇒ 整体 no-op，内存态兜底（zustand createJSONStorage 同款）。
  const storage = options.storage
  if (!storage) return
  const version = options.version ?? 0
  // 写回**同步**执行（zustand 同款：resetStores 依赖同步落盘）。★ 异常就地吞掉并
  // console.error：writeBack 挂在 subscribe 上，`storage.setItem` / `JSON.stringify`
  // （含 partialize）抛错若越出会**中止 notify 循环**——其后的 listener（全部 React
  // 订阅者）收不到通知 → UI stale。zustand 的写回在 setState 包装内、notify **之后**
  // 执行，异常本就不截断订阅者；这里对齐「写回失败不阻断状态传播」（配额满 / 隐私
  // 模式抛错时状态照常更新，仅落盘失败，persist 名即 store 标识随日志可见）。
  const writeBack = (state: T) => {
    try {
      const payload = options.partialize ? options.partialize(state) : state
      storage.setItem(options.name, JSON.stringify({ state: payload, version }))
    } catch (error) {
      console.error(`[solidStoreKernel] persist「${options.name}」写回失败：状态已在内存生效，仅落盘未成`, error)
    }
  }

  // —— hydration（同步存储 ⇒ 全程同步，与 zustand toThenable 的同步路径一致）——
  // 读盘/解析失败走 zustand 同款静默路径：错误经 onRehydrateStorage 的 error 位可见，
  // 内存初始态兜底（customPresetStore 的搬家读等消费方依赖「corrupt envelope 不炸不响」）。
  let hydrated = false
  let hydrateError: unknown
  try {
    const raw = storage.getItem(options.name)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { state?: unknown; version?: number } | null
      const persisted = (parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed) as unknown
      const storedVersion = parsed && typeof parsed === 'object' ? (parsed as { version?: number }).version : undefined
      let migrated: unknown = persisted
      let didMigrate = false
      // 「丢弃 persisted」路径（zustand 同款「丢弃 + 告警」）：保持内存初始态、
      // 跳过 merge、不回写；错误经 onRehydrateStorage 的 error 位可见。
      let discardPersisted = false
      if (storedVersion !== version && !options.migrate) {
        // 版本错位且无 migrate：旧形状若静默混入（partialize 白名单外的字段、
        // 已改语义的值），比整份丢弃更危险——console.error 后按初始态兜底。
        console.error(`[solidStoreKernel] persist「${options.name}」版本错位（磁盘 ${String(storedVersion)} ≠ 代码 ${version}）且未提供 migrate：丢弃 persisted，保持初始态`)
        hydrateError = new Error(`persist「${options.name}」版本错位（磁盘 ${String(storedVersion)} ≠ 代码 ${version}）且未提供 migrate，已丢弃 persisted`)
        discardPersisted = true
      } else if (storedVersion !== version && options.migrate) {
        migrated = options.migrate(persisted, storedVersion)
        if (typeof (migrated as { then?: unknown } | null | undefined)?.then === 'function') {
          // thenable（如 async migrate）：本内核同步 hydrate，无法等待。若照旧 spread，
          // merged 会是空壳且 didMigrate=true ⇒ **立即用内存初始态回写磁盘**——持久化
          // 数据不可逆丢失。对齐 zustand「丢弃 + 告警」：放弃该 persisted，不落 merge。
          console.error(`[solidStoreKernel] persist「${options.name}」migrate 返回了 Promise（异步 migrate 不受支持）：丢弃 persisted，保持初始态`)
          hydrateError = new Error(`persist「${options.name}」migrate 返回 Promise（异步 migrate 不受支持），已丢弃 persisted`)
          discardPersisted = true
        } else {
          didMigrate = true
        }
      }
      if (!discardPersisted) {
        const current = kernel.getState()
        const merged = options.merge
          ? options.merge(migrated, current)
          : { ...current, ...(migrated as Partial<T>) }
        kernel.setState(merged, true)
        hydrated = true
        if (didMigrate) {
          // zustand 同款：migrate 后的回写走**正常写回路径**（经 partialize 白名单）。
          writeBack(kernel.getState())
        }
      }
    }
  } catch (error) {
    hydrateError = error
  }
  options.onRehydrateStorage?.()(hydrated ? kernel.getState() : undefined, hydrateError)

  kernel.subscribe(state => writeBack(state))
}
