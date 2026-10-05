// @vitest-environment node
/**
 * 刀3（#223 · 预设组装）：**`theme` 退场为计算视图** —— B1~B5。
 *
 * - **B1** 有效值等价：`effectivePresetTheme(preset)` == 该预设 5 个区域切面之并集（测试侧独立算一遍）；
 * - **B2** 键集完整：**没有任何键因为不属于任何区域而丢失**（静态不变量 + 逐套键数对基线）；
 * - **B3** 两条默认预设仍走"直给 `theme`"，出厂 10 套一律走引用表（回落路径不再被它们走到）；
 * - **B4** 「终端补全」机制确实没了（源码级扫描，含测试）；
 * - **B5** 模板库显示用的主题与落盘包的主题**同源**（一处算、两处用）。
 *
 * ★ 与「改造前」的逐字段对拍由两处外部证据承担（测试里读不到仓外路径）：
 *   ① A1 的契约夹具快照（`mergeTheme(effectivePresetTheme(preset))`，逐字节比对）；
 *   ② 仓外备份 `预设修正/备份/预设组装-刀3前-有效值-20260921/`（脚本逐字段对拍，见开发记录）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PRESETS, GLOBAL_PRESETS } from '../domains/theme/presets/index.ts'
import { PRESET_ZONES } from '../domains/theme/presetReducer.ts'
import { THEME_SETTING_KEYS, ZONE_FIELDS, THEME_FIELD_DEFS, ZONES } from '../domains/theme/themeFieldDefs.ts'
import { effectivePresetTheme, pickZoneFields, ZONE_PRESET_POOL } from '../domains/theme/zones/index.ts'
import { planGlobalPreset } from '../application/transactions/applyGlobalPreset.ts'
import { THEME_DEFAULTS } from '../domains/theme/themeFieldDefs.ts'

const REPO_ROOT = resolve(__dirname, '..', '..')

/**
 * 逐套预设的 `theme` 字段数基线（原取自开工前导出 `global-presets-theme.json`，逐套手抄）。
 *
 * ★ #238 刀5：按**新的真实键数**重算过一次 —— 真值由 `.agents/spec/238-刀5-probe-preset-counts.mts`
 * 跑出来（不是手推，也不是为了让测试绿而猜）。它的职责是「预设有效值不许**悄悄**丢键」；
 * 字段表**显式**增删时基线随表同步演进，属正常生命周期。
 *
 * 本刀的账（6 套「完整快照」型预设 = 5 套 terminal + `gui/solarized`，它们的 cc 区切面带 `cliHintMode`）：
 * `191 − 3（删 ccStatusFontSize / statusBg / statusBgImage）+ 1（加 ccHintFontSize）= 189`。
 * 新增的 `ccHintFontSize: 16` 是**手补进那 6 套出厂 cc 条目**的（生成脚本已删，见施工单 §6.2）。
 * 另外 4 套是**局部覆盖**型，值一个没动：
 * - `glass` 69：其 cc 区 21 键，本来就没有那三项、也没有 `cliHintMode` ⇒ 不进不出；
 * - `agent-command` / `agent-map` / `focus-flow` 各 36：cc 区仅 6 键，同理。
 *
 * ★ #238 刀7（删掉缩放）：`ccScale` 整字段删除 ⇒ 基线再按**真值**重算一次。
 * 本刀的账：**含 `ccScale` 键的预设各 −1**
 * - 6 套「完整快照」型（claude / nord / tokyo / solarized / amber / matrix）`189 → 188`；
 * - `glass` `69 → 68`（它的 cc 区切面里有 `ccScale: {tokens:100, model:100, mode:100}`）；
 * - `agent-command` / `agent-map` / `focus-flow` 的 36 **不动**（cc 区仅 6 键，从不含 `ccScale`）。
 * ★ 真值由脚本实测得出（不是手推）：逐套打印 `Object.keys(effectivePresetTheme(p)).length` 与
 * `'ccScale' in t`，结果与上面的账逐条一致（见刀7 开发记录「证据」）。
 *
 * ★ #238 刀8（删掉整体风格）：`ccVariant` 整字段删除 ⇒ 基线第三次按**真值**重算。
 * 本刀的账：**含 `ccVariant` 键的预设各 −1**
 * - 6 套「完整快照」型（claude / nord / tokyo / solarized / amber / matrix）`188 → 187`；
 * - `glass` `68 → 67`（它的 cc 区切面里有 `ccVariant`）；
 * - `agent-command` / `agent-map` / `focus-flow` 的 36 **不动**（cc 区不含 `ccVariant`）。
 * ★ 同样由脚本实测（`Object.keys(...).length` + `'ccVariant' in t`），与上面的账逐条一致。
 *
 * ★ #266 CC-07（设置页中控台多余项清理）：删掉 4 个 cc 字段
 * （`sendVariant` / `inputShowPlaceholder` / `prismOnColor` / `pillText`）⇒ 基线第四次按**真值**重算。
 * 本刀的账：**出厂数据里含这些键的预设各按实际含有数递减**
 * - 6 套「完整快照」型（claude / nord / tokyo / solarized / amber / matrix）`187 → 183`（四个键都有）；
 * - `glass` `67 → 65`（它的 cc 区切面只含 `pillText` / `prismOnColor` 两个，
 *   本来就没有 `sendVariant` / `inputShowPlaceholder`——与 `gui-cc.ts` 的 glass 条目一致）；
 * - `agent-command` / `agent-map` / `focus-flow` 的 36 **不动**（cc 区仅 6 键，四个键都不含）。
 * ★ 真值由脚本实测得出（`.agents/spec/266-probe-preset-counts.mts`，逐套打印
 * `Object.keys(effectivePresetTheme(preset)).length`），**不是手推**：实测
 * `claude/nord/tokyo/solarized/amber/matrix = 183`、`glass = 65`、`agent-* = 36`。
 *
 * ★ #266 刀7~13（第二批七刀）：再删 7 个 cc 字段
 * （`cliLinePadding` / `cliContentOffsetY` / `inputMode` / `inputVariant` / `cliOverflowMode` /
 * `footerLayout` / `inputMinHeight`）⇒ 基线第五次按**真值**重算。
 * 本刀的账：**出厂数据里含这些键的预设按实际含有数递减**
 * - 6 套「完整快照」型（claude / nord / tokyo / solarized / amber / matrix）`183 → 176`（七个键都有）；
 * - `glass` `65 → 63`（它的 cc 区切面只含 `inputMinHeight` / `cliLinePadding` 两个）；
 * - `agent-command` / `agent-map` / `focus-flow` 的 36 **不动**（cc 区仅 6 键，七个键都不含）。
 * ★ 真值同样由 `.agents/spec/266-probe-preset-counts.mts` 实测：本次实测
 * `claude/nord/tokyo/solarized/amber/matrix = 176`、`glass = 63`、`agent-* = 36`。
 *
 * ★ #266 刀2（空态收成「盒子 + 一道门」）：新增 `ccHiddenEmpty`（显隐的**空态切面**）
 * ⇒ 基线第六次按**真值**重算。本刀的账：**10 套的 cc 区切面各 +1 键**（出厂每套预设都带一份空态切面）
 * - 6 套「完整快照」型 + `glass`：`176 → 177` / `63 → 64`；
 * - `agent-command` / `agent-map` / `focus-flow`：`36 → 37`（刀2 之前它们的 cc 区不含任何名单键，
 *   空态靠**代码侧硬编码名单**兜着；那份名单搬进预设后，它们也必须各带一份，否则空态会静默变成"什么都不藏"）。
 * ★ 真值由 `.agents/spec/266-probe-preset-counts.mts` 实测（`THEME_SETTING_KEYS=177`、
 *   逐套打印 `Object.keys(effectivePresetTheme(p)).length`），**不是手推**。
 *
 * ★ #483（宠物链删除）：`showPet` 从 ThemeSettings/zones 工厂退役 ⇒ 基线第七次按**真值**重算：
 * - 6 套「完整快照」型（global 区切面含 showPet）：`177 → 176`；
 * - `glass` / `agent-command` / `agent-map` / `focus-flow` **不动**（切面本就不含 showPet）。
 *
 * ★ #266 CC-31（userTagText 退役）：「用户标签文字」字段整体退役（唯一消费者是死类名
 * `.term-user-tag`，删除前即无渲染效果）⇒ 基线第八次按**真值**重算：**10 套各 -1**
 * （chat 区切面均含 userTagText）：6 套完整快照型 `176 → 175`、`glass 64 → 63`、
 * `agent-command` / `agent-map` / `focus-flow` `37 → 36`。真值逐套实测 `Object.keys(effectivePresetTheme(p)).length`。
 */
const BASELINE_FIELD_COUNTS: Record<string, number> = {
  claude: 175, glass: 63, nord: 175, tokyo: 175, solarized: 175,
  amber: 175, matrix: 175, 'agent-command': 36, 'agent-map': 36, 'focus-flow': 36,
}

/** 该预设的有效值 —— 用测试侧独立算法（直接并池里的 5 个切面），不复用被测函数。 */
function unionOfZoneSlices(presetName: string, mode: 'gui' | 'terminal'): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const zone of PRESET_ZONES) {
    const entry = ZONE_PRESET_POOL[mode][zone].find(candidate => candidate.id === presetName)
    if (!entry) throw new Error(`${mode}/${zone} 解析不到 ${presetName}`)
    Object.assign(merged, entry.values)
  }
  return merged
}

describe('B1 有效值等价（视图 == 五区切面之并集）', () => {
  it('10 套出厂预设逐套：视图与测试侧独立算出的并集深度相等', () => {
    for (const preset of GLOBAL_PRESETS) {
      const union = unionOfZoneSlices(preset.name, preset.interfaceMode)
      const view = effectivePresetTheme(preset) as Record<string, unknown>
      expect(Object.keys(view).sort(), `${preset.name} 键集`).toEqual(Object.keys(union).sort())
      expect(view, `${preset.name} 逐字段`).toEqual(union)
    }
  })

  it('视图不引入任何默认值铺底：键集与并集**完全相等**（不是包含）', () => {
    for (const preset of GLOBAL_PRESETS) {
      const view = effectivePresetTheme(preset) as Record<string, unknown>
      const padded = Object.keys(view).filter(key => !(key in unionOfZoneSlices(preset.name, preset.interfaceMode)))
      expect(padded, `${preset.name} 不得多出并集以外的键（"先铺默认值"会多出这些）`).toEqual([])
      for (const key of Object.keys(view)) {
        expect(key in THEME_DEFAULTS || key === 'ccHidden' || key === 'ccLayout' || key === 'ccHiddenEmpty',
          `${preset.name}/${key} 应是主题字段`).toBe(true)
      }
    }
  })
})

describe('B2 键集完整（没有键因不属于任何区域而丢失）', () => {
  it('静态不变量：全部可被预设捕获的字段都落在 PRESET_ZONES 的区域内（layout 无字段）', () => {
    expect(ZONE_FIELDS.layout, 'layout 区没有字段').toEqual([])
    const covered = PRESET_ZONES.flatMap(zone => ZONE_FIELDS[zone])
    expect(covered.length, '五区字段数之和 == 可捕获字段数').toBe(THEME_SETTING_KEYS.length)
    expect(new Set(covered).size, '不得有字段被两个区域重复归属').toBe(THEME_SETTING_KEYS.length)
    // 反向：每个字段定义里的 zone 都必须是已知区域（新增字段写错 zone 即红）
    const badZone = Object.entries(THEME_FIELD_DEFS).filter(([, def]) => !ZONES.includes(def.zone))
    expect(badZone.map(([key]) => key), 'zone 必须是已知区域').toEqual([])
  })

  it('逐套对照改造前的键数（少一个键即红，不抽样）', () => {
    for (const preset of GLOBAL_PRESETS) {
      expect(Object.keys(effectivePresetTheme(preset)).length, `${preset.name} 键数`).toBe(BASELINE_FIELD_COUNTS[preset.name])
    }
  })

  it('视图逐套覆盖它每个区域切面的全部键（切面里的键一个都不许在合并中丢）', () => {
    for (const preset of GLOBAL_PRESETS) {
      const view = effectivePresetTheme(preset) as Record<string, unknown>
      for (const zone of PRESET_ZONES) {
        const sliceKeys = Object.keys(pickZoneFields(view, zone))
        const dataKeys = Object.keys(unionOfZoneSlices(preset.name, preset.interfaceMode)).filter(key => ZONE_FIELDS[zone].includes(key as never))
        expect(sliceKeys.sort(), `${preset.name}/${zone}`).toEqual(dataKeys.sort())
      }
    }
  })
})

describe('B3 两条默认预设仍走"直给 theme"', () => {
  it('视图对默认预设就是它自己写的 theme（不做任何区域拼装）', () => {
    for (const bucket of ['gui', 'terminal'] as const) {
      const preset = DEFAULT_PRESETS[bucket]
      expect(preset.theme, `${preset.name} 必须有 theme（类型上也收紧了）`).toBeTruthy()
      expect(effectivePresetTheme(preset), `${preset.name}`).toEqual(preset.theme)
    }
  })

  it('出厂 10 套一律带引用表 ⇒ planGlobalPreset 不再走"整份 theme"回落分支', () => {
    for (const preset of GLOBAL_PRESETS) {
      const plan = planGlobalPreset(preset.name, id => ({ id, tokens: {} } as never))
      if (plan.kind !== 'apply') throw new Error(`${preset.name} 应可应用`)
      expect(plan.zoneRefs, `${preset.name} 的引用表`).toBeTruthy()
    }
  })

  it('planGlobalPreset 的有效值就是视图（呈现方案 token 叠在视图之上）', () => {
    const glass = GLOBAL_PRESETS.find(preset => preset.name === 'glass')!
    const plain = planGlobalPreset('glass', id => ({ id, tokens: {} } as never))
    if (plain.kind !== 'apply') throw new Error('glass 应可应用')
    expect(plain.theme).toEqual(effectivePresetTheme(glass))

    const withTokens = planGlobalPreset('agent-command', id => ({ id, tokens: { msgStyle: 'bubble' } } as never))
    if (withTokens.kind !== 'apply') throw new Error('agent-command 应可应用')
    const view = effectivePresetTheme(GLOBAL_PRESETS.find(preset => preset.name === 'agent-command')!) as Record<string, unknown>
    expect(withTokens.theme).toEqual({ ...view, msgStyle: 'bubble' })
  })
})

describe('B4 「终端补全」机制确实没了（源码级扫描）', () => {
  // 名字要拼出来——否则这条扫描会把自己也扫成命中
  const BANNED = ['complete' + 'TerminalPreset', 'TERMINAL' + '_COMPLETION', 'TERMINAL_VISUAL' + '_COMPLETION']

  function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'target' || name.startsWith('.')) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
      else if (/\.(?:[cm]?[jt]sx?|mts|mjs)$/.test(name)) found.push(path)
    }
    return found
  }

  it('src/ 与 scripts/ 下零命中（含测试）', () => {
    const hits: string[] = []
    for (const root of ['src', 'scripts']) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const text = readFileSync(file, 'utf8')
        for (const banned of BANNED) {
          if (text.includes(banned)) hits.push(`${file.replace(REPO_ROOT, '')} ← ${banned}`)
        }
      }
    }
    expect(hits, '被删机制的名字不得再出现在源码或测试里').toEqual([])
    // 机制本体（补全模块与它的测试）也已删除
    expect(sourceFiles(join(REPO_ROOT, 'src', 'domains', 'theme', 'presets')).some(file => file.endsWith('completion.ts')), 'completion.ts 应已删除').toBe(false)
  })
})

describe('B5 模板库两处同源（显示用的 theme 与落盘包的主题）', () => {
  // #515 连带修复：契约改指 Solid 实体源码（TemplateLibrary.tsx React 薄桥已随实体化
  // 拆除）。实体里官方段是普通 map（非 useMemo），自定义段是 createMemo——仅段位标记
  // 改写，逐条断言语义原样保留。
  it('组件源码里：有效值只算一次、两处共用；官方段不再直接读 preset.theme', () => {
    const source = readFileSync(join(REPO_ROOT, 'src', 'components', 'settings', 'TemplateLibrary.solid.tsx'), 'utf8')
    // 只看**官方预设**那一段（自定义段读的是 `CustomPreset.theme`，与刀3 无关）
    const start = source.indexOf('const official: TemplateView[] = GLOBAL_PRESETS.map(')
    const end = source.indexOf('const custom = createMemo<')
    expect(start, '官方段必须存在').toBeGreaterThan(-1)
    expect(end, '自定义段必须存在').toBeGreaterThan(start)
    const official = source.slice(start, end)

    expect(official, '官方段不得再读 preset.theme（那会让两处不一致）').not.toContain('preset.theme')
    const calls = official.match(/effectivePresetTheme\(/g) ?? []
    expect(calls.length, '有效值只算一次（算两次就可能一处新一处旧）').toBe(1)
    expect(official, '加个局部变量、两处共用').toContain('const theme = effectivePresetTheme(preset)')
    expect(official, '显示用的主题由该局部变量喂').toContain('theme: { ...THEME_DEFAULTS, ...theme }')
    expect(official, '落盘包由同一个局部变量喂').toContain("source: 'builtin', theme: theme as unknown as")
  })
})
