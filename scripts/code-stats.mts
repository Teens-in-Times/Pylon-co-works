/**
 * code-stats.mts — Pylon 代码量多维统计（issue #231）。`bun scripts/code-stats.mts` 直跑，`--json` 出机器可读结果。
 *
 * 口径（明文写死，skill 文档同步）：
 * - 默认文件集：Git 已跟踪的当前工作树；--include-untracked 才加入未跟踪未忽略文件。
 * - 全仓源码总量包括声明文件、SDK、测试、工具与示例；物理行/非空行独立计数，可与 Git 对账。
 * - 语言：TS/TSX/JS/JSX、Rust、CSS、HTML、Python、Shell、C、PowerShell、Batch、RC。
 *   字体显式排除，二进制用 Git grep -I 排除；JSON/TOML/YAML/Markdown/锁文件不入源码。
 * - crate 区域清单：动态解析 `src-tauri/Cargo.toml` 的 `[workspace] members`（剔除主包 "."），
 *   解析失败才退回 CRATES_FALLBACK 静态快照——新拆 crate 不再需要改本脚本（#247 拆分 → #259 漂移修复）。
 * - 插件开发 SDK 不计入生产/测试：`src/sdk/`（SDK 源码，build-plugin-sdk.mjs 的输入）与
 *   `src-tauri/resources/`（发行包内嵌 SDK 与数据）。`examples/`、`src-tauri/vendor/`、构建产物同属排除面，
 *   但在「生产口径排除面」表中单列；声明文件也单列，不从全仓总量中消失。
 * - 测试拆分：
 *   · TS/JS 按文件级：`__tests__` / `__fixtures__` / `__mocks__` / `test` / `tests` 目录、
 *     `*.test.*` / `*.spec.*` 文件名、`src/test-utils/`；
 *   · Rust 按**行级**：`#[cfg(test)]`（含 any/all/not 组合求值）标注的 item 区域在词法层面切出——
 *     词法器处理 raw string（`r#"…"#`，可跨行）、嵌套块注释、char 与生命周期歧义；
 *   · Rust 测试专属文件：父模块中 `#[cfg(test)] mod x;` 声明的文件、`tests/` 目录（集成测试）、
 *     `src-tauri/pylon-fake-agent/**`（test-agent 专属假 agent，#382 起为独立 crate）。
 * - 行类型按轻量词法分析估算，不等同于编译器；代码行=非空非纯注释，行内尾注计入代码行。
 *   跨行字符串/块注释的内部行按内容归类（code/comment），内部纯空行仍为空行（#259 前内部行一律误计空行）。
 * - 工具链（scripts/、tools/、markdown gen+parity、根配置）与排除面一样不计入生产口径，单列存照。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { basename, dirname as posixDirname } from 'node:path/posix'
import { fileURLToPath } from 'node:url'

// ── 语言与扩展名 ────────────────────────────────────────────────────────────

type LangId = 'ts' | 'tsx' | 'js' | 'jsx' | 'rs' | 'css' | 'html' | 'py' | 'sh' | 'c' | 'ps1' | 'bat' | 'rc'

const LANG_LABEL: Record<LangId, string> = {
  ts: 'TypeScript', tsx: 'TSX (Solid)', js: 'JavaScript', jsx: 'JSX',
  rs: 'Rust', css: 'CSS', html: 'HTML', py: 'Python', sh: 'Shell', c: 'C', ps1: 'PowerShell',
  bat: 'Batch', rc: 'Windows RC',
}

const LANG_BY_EXT: Record<string, LangId> = {
  ts: 'ts', mts: 'ts', cts: 'ts',
  tsx: 'tsx', jsx: 'jsx',
  js: 'js', mjs: 'js', cjs: 'js',
  rs: 'rs', css: 'css', html: 'html', htm: 'html',
  py: 'py', sh: 'sh', bash: 'sh', c: 'c', h: 'c', ps1: 'ps1', bat: 'bat', cmd: 'bat', rc: 'rc',
}

const TS_FAMILY = new Set<LangId>(['ts', 'tsx', 'js', 'jsx'])
const DECLARATION_FILE = /\.d\.[cm]?ts$/i
const FONT_FILE = /\.(?:woff2?|ttf|ttc|otf|eot)$/i
// 锁文件按扩展名已被排除（.lock/.json/.yaml 不在计入集），此处显式列全作为口径存照。
const LOCK_FILES = new Set([
  'bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'Cargo.lock', 'composer.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock',
])

// ── 路径分类 ────────────────────────────────────────────────────────────────

export type Bucket = 'production' | 'test' | 'tooling' | 'sdk' | 'examples' | 'vendored' | 'declarations' | 'other'

export interface Classification {
  bucket: Bucket
  area: string
  lang: LangId
}

// 生产口径的区域：前端 + Tauri 本体 + 各子 crate。crate 清单的唯一事实源是 Cargo workspace 成员
// （main 动态解析注入）；此兜底清单仅在 Cargo.toml 不可读时生效，为 2026-09 快照存照（#259）。
export const CRATES_FALLBACK = [
  'pet-core', 'pylon-acp', 'pylon-canonical-types', 'pylon-compute',
  'pylon-core', 'pylon-foundations', 'pylon-markdown', 'pylon-session',
] as const

/** 解析 `[workspace] members = [...]`：剔除主包 "."，保持声明顺序；无 members 段返回空数组。 */
export function parseWorkspaceCrates(toml: string): string[] {
  const m = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(toml)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]).filter(name => name !== '.')
}

export const AREA_LABEL: Record<string, string> = {
  frontend: '前端 src/',
  'rust-app': 'Tauri 本体 src-tauri/src',
  'tooling-scripts': '工具链 scripts/',
  'tooling-tools': '工具链 tools/（webview2-mcp）',
  'tooling-markdown': '工具链 markdown gen+parity',
  'tooling-root-config': '根配置（vite/vitest/eslint）',
  sdk: '插件开发 SDK（src/sdk + resources）',
  examples: '示例插件 examples/',
  vendored: '第三方 vendor/',
  declarations: '类型声明（不进入运行时代码拆分）',
  'root-misc': '根目录散置',
}

/** `crate:*` 区域的标签随 workspace 成员动态生成，其余查静态表。 */
export function areaLabel(id: string): string {
  return id.startsWith('crate:') ? `crate ${id.slice('crate:'.length)}` : AREA_LABEL[id] ?? id
}

/** 纯路径规则；Rust 父模块声明与 crate 清单由调用方注入（需要读父文件/Cargo.toml）。返回 null = 不计入任何口径。 */
export function classifyPath(
  path: string,
  rustParentTestMods?: ReadonlySet<string>,
  crates: readonly string[] = CRATES_FALLBACK,
): Classification | null {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  const lang = LANG_BY_EXT[ext]
  if (!lang) return null
  if (DECLARATION_FILE.test(path)) return { bucket: 'declarations', area: 'declarations', lang }
  if (LOCK_FILES.has(basename(path))) return null

  // 排除面（优先于一切生产规则）
  if (path.startsWith('src-tauri/vendor/')) return { bucket: 'vendored', area: 'vendored', lang }
  if (path.startsWith('src-tauri/resources/')) return { bucket: 'sdk', area: 'sdk', lang }
  if (path.startsWith('src/sdk/')) return { bucket: 'sdk', area: 'sdk', lang }
  if (path.startsWith('dist-plugin-sdk/') || path.startsWith('dist-plugin-devkit/') || path.startsWith('dist-plugin/')) {
    return { bucket: 'sdk', area: 'sdk', lang }
  }
  if (path.startsWith('examples/')) return { bucket: 'examples', area: 'examples', lang }

  // 工具链（不计入生产口径，单列存照）
  if (path.startsWith('src-tauri/pylon-markdown/gen/') || path.startsWith('src-tauri/pylon-markdown/parity/')) {
    return { bucket: 'tooling', area: 'tooling-markdown', lang }
  }
  if (path.startsWith('scripts/')) return { bucket: 'tooling', area: 'tooling-scripts', lang }
  if (path.startsWith('tools/')) return { bucket: 'tooling', area: 'tooling-tools', lang }
  if (/^(?:vite\.[\w-]+\.config|vite\.config|vitest\.config|vitest\.setup|eslint\.config)\.[cm]?[jt]s$/.test(path)) {
    return { bucket: 'tooling', area: 'tooling-root-config', lang }
  }

  // 生产区域
  let area: string
  let bucket: Bucket
  const crate = crates.find(c => path.startsWith(`src-tauri/${c}/`))
  if (crate) { area = `crate:${crate}`; bucket = 'production' }
  else if (path.startsWith('src-tauri/')) { area = 'rust-app'; bucket = 'production' }
  else if (path.startsWith('src/')) { area = 'frontend'; bucket = 'production' }
  else if (path === 'index.html') { area = 'frontend'; bucket = 'production' }
  else { area = 'root-misc'; bucket = 'other' }

  // 测试判定（只覆盖生产区域；工具链/排除面不再细分）
  if (bucket === 'production' && (isTestPathTs(path) || isTestPathRust(path, rustParentTestMods))) bucket = 'test'
  return { bucket, area, lang }
}

/** TS/JS 测试文件判据（文件级）。mock/demo 数据（如 demoData.ts）不是测试，不在此列。 */
export function isTestPathTs(path: string): boolean {
  const lang = LANG_BY_EXT[path.slice(path.lastIndexOf('.') + 1)]
  if (!lang || !TS_FAMILY.has(lang)) return false
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return true
  if (/(?:^|\/)(?:__tests__|__fixtures__|__mocks__|test|tests|test-utils)\//.test(path)) return true
  return false
}

/** Rust 测试专属文件判据（不含内联——内联由词法器按行切）。 */
export function isTestPathRust(path: string, rustParentTestMods?: ReadonlySet<string>): boolean {
  if (LANG_BY_EXT[path.slice(path.lastIndexOf('.') + 1)] !== 'rs') return false
  if (/(?:^|\/)tests\//.test(path)) return true
  // test-agent 专属假 agent（#382 起独立 crate）：Cargo feature 门控的测试基建，永远不进生产构建。
  if (path.startsWith('src-tauri/pylon-fake-agent/')) return true
  return rustParentTestMods?.has(stemOf(path)) ?? false
}

const stemOf = (path: string) => {
  const base = basename(path)
  return base.slice(0, base.lastIndexOf('.'))
}

/** Rust 文件的父模块声明文件候选（2018 版布局 + mod.rs 老布局都覆盖）。 */
export function rustParentCandidates(path: string): string[] {
  if (/(?:^|\/)bin\//.test(path)) return [] // bin 下每个文件都是独立 crate 根
  const stem = stemOf(path)
  if (stem === 'lib' || stem === 'main') return [] // crate 根
  const dir = posixDirname(path)
  const base = stem === 'mod' ? posixDirname(dir) : dir
  if (!base || base === '.') return []
  return [
    `${base}/mod.rs`, `${base}/lib.rs`, `${base}/main.rs`,
    `${posixDirname(base)}/${basename(base)}.rs`,
  ]
}

// ── 行统计骨架 ──────────────────────────────────────────────────────────────

type LineClass = 'code' | 'comment' | 'blank'

export interface LineStat {
  code: number
  comment: number
  blank: number
  total: number
}

const emptyStat = (): LineStat => ({ code: 0, comment: 0, blank: 0, total: 0 })

function addStat(target: LineStat, source: LineStat) {
  target.code += source.code
  target.comment += source.comment
  target.blank += source.blank
  target.total += source.total
}

function statOf(lineClass: LineClass[], skip?: boolean[]): LineStat {
  const stat = emptyStat()
  for (let i = 0; i < lineClass.length; i++) {
    if (skip?.[i]) continue
    stat[lineClass[i]]++
    stat.total++
  }
  return stat
}

const statTestOf = (lineClass: LineClass[], isTest: boolean[]) => statOf(lineClass.map((c, i) => isTest[i] ? c : null).filter((c): c is LineClass => c !== null))

/** 逐字符扫描共通骨架：每个物理行恰好分类一次（code/comment/blank 三类互斥且完备）。 */
abstract class LineScanner {
  private lineClass: LineClass[] = []
  private lineHasCode = false
  private lineHasComment = false
  private lineHasNonWs = false

  private flushLine() {
    this.lineClass.push(!this.lineHasNonWs ? 'blank' : this.lineHasCode ? 'code' : 'comment')
    this.lineHasCode = this.lineHasComment = this.lineHasNonWs = false
  }

  /** 当前行号 = 已完成的行数。 */
  protected get lineCount(): number {
    return this.lineClass.length
  }

  protected markCode() { this.lineHasNonWs = true; this.lineHasCode = true }
  protected markComment() { this.lineHasNonWs = true; this.lineHasComment = true }

  /** 在子扫描器的内层循环里消费换行（多行注释/字符串共用），保证行号推进。 */
  protected stepInner(text: string, i: number): number {
    if (text[i] === '\r' && text[i + 1] === '\n') { this.flushLine(); return i + 2 }
    if (text[i] === '\n' || text[i] === '\r') { this.flushLine(); return i + 1 }
    return i
  }

  /** 子类实现：从 i 起消费一个「词汇」，返回新的 i。空白与换行由基类统一处理。 */
  protected abstract consume(text: string, i: number): number

  run(text: string): LineClass[] {
    const src = text.replace(/^\uFEFF/, '')
    const n = src.length
    let i = 0
    while (i < n) {
      const ch = src[i]
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++
        i++
        this.flushLine()
        continue
      }
      if (ch === ' ' || ch === '\t') { i++; continue }
      i = this.consume(src, i)
    }
    // 末尾纯空白且无换行仍是一个物理行；末尾换行不产生额外行。
    if (text.length > 0 && !/[\r\n]$/.test(text)) this.flushLine()
    return this.lineClass
  }
}

const isIdentStart = (ch: string) => /[A-Za-z_]/.test(ch)
const isIdentChar = (ch: string) => /[A-Za-z0-9_]/.test(ch)

function skipQuoted(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue }
    if (text[j] === '"') return j
  }
  return text.length
}

/** TS/JS 语义的单行字符串（不可跨行，`\<换行>` 续行除外）。step 用于把续行换行计入物理行。 */
function skipEscapedString(text: string, i: number, step?: (j: number) => number): number {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j]
    if (ch === '\\') {
      const nx = text[j + 1]
      if (step && (nx === '\n' || nx === '\r')) { j = step(j + 1) - 1; continue } // 续行：换行仍占一个物理行
      j++; continue
    }
    if (ch === quote) return j + 1
    if (ch === '\n' || ch === '\r') return j // 未闭合容错
  }
  return text.length
}

// ── Rust 词法器（行级测试拆分的核） ─────────────────────────────────────────

const RUST_ITEM_KEYWORDS = new Set(['mod', 'fn', 'use', 'const', 'static', 'impl', 'trait', 'struct', 'enum', 'type', 'union', 'macro_rules'])

export interface RustAnalysis {
  lineClass: LineClass[]
  /** 每物理行是否落在 #[cfg(test)] item 区域内。 */
  isTestLine: boolean[]
  /** 被测试门控的 mod 名（含 `mod x;` 外置声明），供子文件判定复用。 */
  testModDecls: Set<string>
  /** 切出的测试区域个数。 */
  testRegions: number
  /** #[test] / #[tokio::test] 属性个数。 */
  testAttrCount: number
}

/**
 * 求 `cfg(...)` 在「生产构建」下的真值：false = 该 item 只在测试构建编译（test-only）。
 * test/test-agent→false；其他谓词视为未知，只有所有可能的生产构建均不成立才排入测试侧。
 * `cfg_attr(...)` 不是门禁，恒留在生产侧。
 */
export function attrExcludesFromProduction(attrInner: string): boolean {
  return evalCfgProduction(attrInner.trim()) === false
}

function evalCfgProduction(expr: string): boolean | undefined {
  const m = /^cfg\s*\(/.exec(expr)
  if (!m) return true // 非 cfg 门禁（含 cfg_attr）：不排除
  const inner = matchParens(expr, m[0].length - 1)
  if (inner === null) return true
  return evalCfgListProduction(inner)
}

function evalCfgListProduction(expr: string): boolean | undefined {
  const s = expr.trim()
  const notM = /^not\s*\(/.exec(s)
  if (notM) {
    const inner = matchParens(s, notM[0].length - 1)
    const value = inner === null ? undefined : evalCfgListProduction(inner)
    return value === undefined ? undefined : !value
  }
  const combM = /^(?:any|all)\s*\(/.exec(s)
  if (combM) {
    const inner = matchParens(s, combM[0].length - 1)
    if (inner === null) return true
    const parts = splitTopLevel(inner).filter(part => part.trim().length > 0).map(p => evalCfgListProduction(p))
    if (s.startsWith('any')) return parts.includes(true) ? true : parts.includes(undefined) ? undefined : false
    return parts.includes(false) ? false : parts.includes(undefined) ? undefined : true
  }
  const kv = /^([\w]+)\s*=\s*"([^"]*)"/.exec(s)
  if (kv) {
    if (kv[1] === 'feature' && kv[2] === 'test-agent') return false
    return undefined
  }
  if (s === 'test') return false
  return undefined
}

function matchParens(expr: string, openIdx: number): string | null {
  let depth = 0
  for (let i = openIdx; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === '"') { i = skipQuoted(expr, i); continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return expr.slice(openIdx + 1, i) }
  }
  return null
}

function splitTopLevel(expr: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === '"') { i = skipQuoted(expr, i); continue }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1 }
  }
  parts.push(expr.slice(start))
  return parts
}

interface Region { base: number; started: boolean; startLine: number }

class RustScanner extends LineScanner {
  private braceDepth = 0
  private pendingGateLine = -1
  private readonly active: Region[] = []
  private readonly ranges: [number, number][] = []
  readonly testModDecls = new Set<string>()
  testAttrCount = 0
  private fileExcludedByInnerAttr = false

  protected consume(text: string, i: number): number {
    const n = text.length
    const ch = text[i]

    if (ch === '/' && text[i + 1] === '/') {
      this.markComment()
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++
      return i
    }
    if (ch === '/' && text[i + 1] === '*') {
      this.markComment()
      let depth = 0
      i += 2
      while (i < n) {
        const stepped = this.stepInner(text, i)
        if (stepped !== i) { i = stepped; continue } // 换行已消费，禁止再 i++（否则吞掉下一行首字符乃至空行）
        this.markComment() // 注释内部行：有内容即 comment（空行仍为 blank）
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; continue }
        if (text[i] === '*' && text[i + 1] === '/') {
          if (depth === 0) return i + 2
          depth--
          i += 2
          continue
        }
        i++
      }
      return i
    }
    // 内层属性 #![...] → 可整文件门控
    if (ch === '#' && text[i + 1] === '!' && text[i + 2] === '[') {
      this.markCode()
      const attr = this.readAttr(text, i + 2)
      if (attr && attrExcludesFromProduction(attr.inner)) this.fileExcludedByInnerAttr = true
      return attr ? attr.endAfter : i + 3
    }
    // 外层属性 #[...]
    if (ch === '#' && text[i + 1] === '[') {
      const attrStartLine = this.lineCount
      this.markCode()
      const attr = this.readAttr(text, i + 1)
      if (attr) {
        if (attr.inner === 'test' || attr.inner === 'tokio::test' || attr.inner.startsWith('tokio::test(')) this.testAttrCount++
        if (attrExcludesFromProduction(attr.inner)) this.pendingGateLine = attrStartLine
      }
      return attr ? attr.endAfter : i + 2
    }
    // 字符串：raw 家族（r"…" r#"…"# br cr，可跨行）优先
    const raw = matchRawStringPrefix(text, i)
    if (raw !== null) {
      this.markCode()
      return this.skipRawString(text, i + raw.prefixLen, raw.hashes)
    }
    if (ch === '"') {
      this.markCode()
      return this.skipRustString(text, i) // Rust 常规字符串可跨行
    }
    // char 字面量 vs 生命周期
    if (ch === '\'') {
      this.markCode()
      if (text[i + 1] === '\\') {
        let j = i + 2
        if (text[j] === 'u' && text[j + 1] === '{') {
          while (j < n && text[j] !== '}') j++
          j++
        } else if (text[j] === 'x') j += 3
        else j += 1
        if (text[j] === '\'') return j + 1
        return i + 1 // 不完整转义：按生命周期兜底
      }
      if (i + 2 < n && text[i + 2] === '\'' && text[i + 1] !== '\n' && text[i + 1] !== '\r') return i + 3
      return i + 1 // 生命周期 'a / 'static
    }
    // 结构字符：驱动测试区域的开合
    if (ch === '{' || ch === '}' || ch === ';') {
      this.markCode()
      const top = this.active[this.active.length - 1]
      if (ch === '{') {
        this.braceDepth++
        if (top && !top.started) top.started = true
      } else if (ch === '}') {
        this.braceDepth--
        if (top && top.started && this.braceDepth === top.base) {
          this.ranges.push([top.startLine, this.lineCount])
          this.active.pop()
        }
      } else if (top && !top.started) {
        this.ranges.push([top.startLine, this.lineCount])
        this.active.pop()
      }
      this.pendingGateLine = -1
      return i + 1
    }
    // 标识符/关键字
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < n && isIdentChar(text[j])) j++
      const word = text.slice(i, j)
      if (this.pendingGateLine >= 0 && RUST_ITEM_KEYWORDS.has(word)) {
        this.active.push({ base: this.braceDepth, started: false, startLine: this.pendingGateLine })
        this.pendingGateLine = -1
        if (word === 'mod') {
          let k = j
          while (k < n && (text[k] === ' ' || text[k] === '\t')) k++
          let m = k
          while (m < n && isIdentChar(text[m])) m++
          if (m > k) this.testModDecls.add(text.slice(k, m))
        }
      }
      this.markCode()
      return j
    }
    this.markCode()
    return i + 1
  }

  /** Rust 常规字符串：可跨行，`\` 转义；字符串内部有内容的行按 code 计（空行仍为 blank）。 */
  private skipRustString(text: string, i: number): number {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') {
        this.markCode()
        const nx = text[j + 1]
        if (nx === '\n' || nx === '\r') { j = this.stepInner(text, j + 1) - 1; continue }
        j++; continue
      }
      const stepped = this.stepInner(text, j)
      if (stepped !== j) { j = stepped - 1; continue } // 抵消 for 的 j++：换行已消费
      this.markCode()
      if (text[j] === '"') return j + 1
    }
    return text.length
  }

  private skipRawString(text: string, i: number, hashes: number): number {
    const n = text.length
    let j = i
    while (j < n) {
      const next = this.stepInner(text, j)
      if (next !== j) { j = next; continue }
      this.markCode() // raw string 内部行：有内容即 code，否则整行会被误计为 blank
      if (text[j] === '"') {
        let k = j + 1
        let cnt = 0
        while (text[k] === '#' && cnt < hashes) { k++; cnt++ }
        if (cnt === hashes) return k
      }
      j++
    }
    return n
  }

  /** 从 bracketIdx（指向 `[`）读属性；跨行时推进行号。返回 inner 与 `]` 之后的位置。 */
  private readAttr(text: string, bracketIdx: number): { inner: string; endAfter: number } | null {
    let depth = 1 // bracketIdx 处的起始 `[` 已在计数内
    let j = bracketIdx + 1
    const start = j
    while (j < text.length) {
      const ch = text[j]
      if (ch === '"') {
        this.markCode()
        j++
        while (j < text.length) {
          if (text[j] === '\\') {
            const nx = text[j + 1]
            if (nx === '\n' || nx === '\r') { j = this.stepInner(text, j + 1); continue }
            j += 2; continue
          }
          const stepped = this.stepInner(text, j)
          if (stepped !== j) { j = stepped; continue }
          if (!/\s/.test(text[j])) this.markCode()
          if (text[j] === '"') { j++; break }
          j++
        }
        continue
      }
      const stepped = this.stepInner(text, j)
      if (stepped !== j) { j = stepped; continue }
      if (!/\s/.test(ch)) this.markCode()
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) return { inner: text.slice(start, j), endAfter: j + 1 }
      }
      j++
    }
    return null
  }
}

/** r"…" / r#"…"# / br / cr 家族；b"/c" 退化为标识符+字符串，不影响分类。 */
function matchRawStringPrefix(text: string, i: number): { prefixLen: number; hashes: number } | null {
  let j = i
  if (text[j] === 'b' || text[j] === 'c') j++
  if (text[j] !== 'r') return null
  j++
  let hashes = 0
  while (text[j] === '#') { hashes++; j++ }
  if (text[j] !== '"') return null
  return { prefixLen: j - i + 1, hashes }
}

export function analyzeRust(src: string): RustAnalysis {
  const scanner = new RustScanner()
  const lineClass = scanner.run(src)
  const total = lineClass.length
  const isTestLine = new Array<boolean>(total).fill(false)
  for (const [start, end] of scanner.ranges) {
    for (let l = Math.max(0, start); l <= Math.min(total - 1, end); l++) isTestLine[l] = true
  }
  if (scanner.fileExcludedByInnerAttr) isTestLine.fill(true)
  return {
    lineClass,
    isTestLine,
    testModDecls: scanner.testModDecls,
    testRegions: scanner.ranges.length,
    testAttrCount: scanner.testAttrCount,
  }
}

// ── TS/JS 扫描器 ────────────────────────────────────────────────────────────

const TS_KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])

type TsCtx = { kind: 'code'; brace: number } | { kind: 'template' }

class TsScanner extends LineScanner {
  private readonly stack: TsCtx[] = [{ kind: 'code', brace: 0 }]
  private lastSig = ''
  private lastWord = ''

  protected consume(text: string, i: number): number {
    const n = text.length
    const ch = text[i]
    const top = this.stack[this.stack.length - 1]

    if (top.kind === 'template') {
      this.markCode()
      if (ch === '\\') {
        const nx = text[i + 1]
        if (nx === '\n' || nx === '\r') return this.stepInner(text, i + 1) // 模板内续行：换行仍是物理行
        return i + 2
      }
      if (ch === '`') { this.stack.pop(); this.noteSig('`'); return i + 1 }
      if (ch === '$' && text[i + 1] === '{') {
        this.stack.push({ kind: 'code', brace: 0 })
        this.lastSig = ''
        this.lastWord = ''
        return i + 2
      }
      this.noteSig(ch)
      return i + 1
    }

    if (ch === '/' && text[i + 1] === '/') {
      this.markComment()
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++
      return i
    }
    if (ch === '/' && text[i + 1] === '*') {
      this.markComment()
      i += 2
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') { this.markComment(); this.noteSig('/'); return i + 2 }
        const stepped = this.stepInner(text, i)
        if (stepped !== i) { i = stepped; continue } // 换行已消费，禁止再 i++
        this.markComment()
        i++
      }
      return i
    }
    if (ch === '/' && this.regexAllowed()) {
      this.markCode()
      this.noteSig('/')
      i++
      let inClass = false
      while (i < n) {
        const c = text[i]
        if (c === '\\') { i += 2; continue }
        if (c === '\n' || c === '\r') return i // 正则不跨行：容错退回
        if (inClass) { if (c === ']') inClass = false }
        else if (c === '[') inClass = true
        else if (c === '/') { this.noteSig('/'); return i + 1 }
        i++
      }
      return i
    }
    if (ch === '"' || ch === '\'') {
      this.markCode()
      this.noteSig(ch)
      return skipEscapedString(text, i, this.stepInner.bind(this))
    }
    if (ch === '`') {
      this.markCode()
      this.stack.push({ kind: 'template' })
      this.noteSig(ch)
      return i + 1
    }
    if (ch === '{' || ch === '}') {
      this.markCode()
      if (ch === '{') top.brace++
      else if (top.brace > 0) top.brace--
      else if (this.stack.length > 1) {
        this.stack.pop() // 关闭 ${} 插值，回到模板
        this.noteSig('}')
        return i + 1
      }
      this.noteSig(ch)
      return i + 1
    }
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < n && isIdentChar(text[j])) j++
      this.markCode()
      this.lastSig = text[j - 1]
      this.lastWord = text.slice(i, j)
      return j
    }
    this.markCode()
    this.noteSig(ch)
    return i + 1
  }

  private noteSig(ch: string) {
    this.lastSig = ch
  }

  private regexAllowed(): boolean {
    if (!this.lastSig) return true
    if (/[({[,;=:!&|?+\-*%^<>~]/.test(this.lastSig)) return true
    if (this.lastSig === ')' || this.lastSig === ']') return false
    if (this.lastSig === '}') return true
    return TS_KEYWORDS_BEFORE_REGEX.has(this.lastWord)
  }
}

export function analyzeTsLike(src: string): LineClass[] {
  return new TsScanner().run(src)
}

// ── 其余语言扫描器 ──────────────────────────────────────────────────────────

class CssScanner extends LineScanner {
  protected consume(text: string, i: number): number {
    if (text[i] === '/' && text[i + 1] === '*') {
      this.markComment()
      i += 2
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { this.markComment(); return i + 2 }
        const stepped = this.stepInner(text, i)
        if (stepped !== i) { i = stepped; continue } // 换行已消费，禁止再 i++
        this.markComment()
        i++
      }
      return i
    }
    if (text[i] === '"' || text[i] === "'") { this.markCode(); return skipEscapedString(text, i, this.stepInner.bind(this)) }
    this.markCode()
    return i + 1
  }
}

class HtmlScanner extends LineScanner {
  protected consume(text: string, i: number): number {
    if (text.slice(i, i + 4) === '<!--') {
      this.markComment()
      i += 4
      while (i < text.length) {
        if (text.slice(i, i + 3) === '-->') { this.markComment(); return i + 3 }
        const stepped = this.stepInner(text, i)
        if (stepped !== i) { i = stepped; continue } // 换行已消费，禁止再 i++
        this.markComment()
        i++
      }
      return i
    }
    if (text[i] === '"' || text[i] === "'") { this.markCode(); return skipEscapedString(text, i, this.stepInner.bind(this)) }
    this.markCode()
    return i + 1
  }
}

class HashCommentScanner extends LineScanner {
  private prev = ''
  protected consume(text: string, i: number): number {
    const ch = text[i]
    if (ch === '#' && this.prev !== '$') {
      this.markComment()
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      this.prev = ''
      return i
    }
    this.markCode()
    if (ch === '"' || ch === "'") { this.prev = ch; return skipEscapedString(text, i, this.stepInner.bind(this)) }
    this.prev = ch
    return i + 1
  }
}

class PythonScanner extends LineScanner {
  protected consume(text: string, i: number): number {
    const ch = text[i]
    if (ch === '#') {
      this.markComment()
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      return i
    }
    if (ch === '"' || ch === "'") {
      const triple = text.slice(i, i + 3)
      if (triple === '"""' || triple === "'''") {
        this.markCode()
        const close = text.indexOf(triple, i + 3)
        const end = close < 0 ? text.length : close
        for (let j = i + 3; j < end; j++) {
          const stepped = this.stepInner(text, j)
          if (stepped !== j) { j = stepped - 1; continue } // 抵消 for 的 j++：换行已消费
          this.markCode() // 三引号内部行：有内容即 code
        }
        if (close < 0) return text.length
        this.markCode()
        return close + 3
      }
      this.markCode()
      return skipEscapedString(text, i, this.stepInner.bind(this))
    }
    this.markCode()
    return i + 1
  }
}

class CScanner extends LineScanner {
  protected consume(text: string, i: number): number {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      this.markComment()
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      return i
    }
    if (ch === '/' && text[i + 1] === '*') {
      this.markComment()
      i += 2
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { this.markComment(); return i + 2 }
        const stepped = this.stepInner(text, i)
        if (stepped !== i) { i = stepped; continue } // 换行已消费，禁止再 i++
        this.markComment()
        i++
      }
      return i
    }
    if (ch === '"' || ch === "'") { this.markCode(); return skipEscapedString(text, i, this.stepInner.bind(this)) }
    this.markCode()
    return i + 1
  }
}

class BatchScanner extends LineScanner {
  protected consume(text: string, i: number): number {
    const lineStart = text.lastIndexOf('\n', i - 1) + 1
    if (/^\s*$/.test(text.slice(lineStart, i)) && /^(?:@?rem(?:\s|$)|::)/i.test(text.slice(i))) {
      this.markComment()
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++
      return i
    }
    this.markCode()
    return i + 1
  }
}

export function scanLines(lang: LangId, src: string): LineClass[] {
  switch (lang) {
    case 'rs': return new RustScanner().run(src)
    case 'ts': case 'tsx': case 'js': case 'jsx': return new TsScanner().run(src)
    case 'css': return new CssScanner().run(src)
    case 'html': return new HtmlScanner().run(src)
    case 'py': return new PythonScanner().run(src)
    case 'sh': case 'ps1': return new HashCommentScanner().run(src)
    case 'c': case 'rc': return new CScanner().run(src)
    case 'bat': return new BatchScanner().run(src)
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

interface FileRecord {
  path: string
  cls: Classification
  prod: LineStat
  test: LineStat
  rustTestRegions?: number
  rustTestAttrs?: number
  tsTestCases?: number
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

export interface SourceInventory {
  files: number
  total: number
  nonblank: number
  byLang: Partial<Record<LangId, { files: number; total: number; nonblank: number }>>
  skipped: Record<'font' | 'binary' | 'nonSource' | 'missing', string[]>
  sources: { path: string; lang: LangId; text: string; total: number; nonblank: number }[]
}

/** Git 的物理行口径：LF 分行（兼容 CRLF），无末尾 LF 的最后一行也计入。 */
export function countPhysicalLines(text: string): { total: number; nonblank: number } {
  if (text.length === 0) return { total: 0, nonblank: 0 }
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return { total: lines.length, nonblank: lines.filter(line => /\S/.test(line)).length }
}

/** 全仓总量不经过生产/测试排除规则；Git -I 负责二进制判定，空文件仍计文件数。 */
export function collectSourceInventory(root: string, includeUntracked = false): SourceInventory {
  const paths = [...new Set(git(root, ['ls-files', '-z', '--cached',
    ...(includeUntracked ? ['--others', '--exclude-standard'] : [])]).split('\0').filter(Boolean))]
  let textPaths: string
  try {
    textPaths = git(root, ['grep', '--no-textconv', '-I', '-l', '-z',
      ...(includeUntracked ? ['--untracked', '--exclude-standard'] : []), '-e', '^', '--', '.'])
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 1) throw error
    textPaths = '' // Git grep 的 1 表示无匹配（空仓或只有空文件/二进制）。
  }
  const textPathSet = new Set(textPaths.split('\0'))
  const inventory: SourceInventory = {
    files: 0, total: 0, nonblank: 0, byLang: {},
    skipped: { font: [], binary: [], nonSource: [], missing: [] }, sources: [],
  }
  for (const path of paths) {
    if (FONT_FILE.test(path)) { inventory.skipped.font.push(path); continue }
    const absolutePath = resolve(root, path)
    if (!existsSync(absolutePath)) { inventory.skipped.missing.push(path); continue }
    // 先按 Git 结果判断非空文件，避免把未识别扩展名的图片藏进 nonSource。
    const content = readFileSync(absolutePath)
    // Git grep 会跳过只有一个末尾空行的文本；纯换行内容仍是文本。
    const onlyNewlines = content.every(byte => byte === 10 || byte === 13)
    if (content.length > 0 && !textPathSet.has(path) && !onlyNewlines) { inventory.skipped.binary.push(path); continue }
    const lang = LANG_BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
    if (!lang) { inventory.skipped.nonSource.push(path); continue }
    const text = content.toString('utf8')
    const counts = countPhysicalLines(text)
    inventory.files++
    inventory.total += counts.total
    inventory.nonblank += counts.nonblank
    const totals = inventory.byLang[lang] ?? { files: 0, total: 0, nonblank: 0 }
    totals.files++
    totals.total += counts.total
    totals.nonblank += counts.nonblank
    inventory.byLang[lang] = totals
    inventory.sources.push({ path, lang, text, ...counts })
  }
  return inventory
}

function collect(inventory: SourceInventory, crates: readonly string[]): FileRecord[] {
  const sourceByPath = new Map(inventory.sources.map(source => [source.path, source]))
  const rustParentCache = new Map<string, Set<string>>()
  const records: FileRecord[] = []

  for (const { path, lang, text: src, total } of inventory.sources) {
    let parentMods: Set<string> | undefined
    if (lang === 'rs' && !/(?:^|\/)tests\//.test(path)) {
      const parent = rustParentCandidates(path).find(c => sourceByPath.has(c))
      if (parent) {
        let mods = rustParentCache.get(parent)
        if (!mods) {
          mods = analyzeRust(sourceByPath.get(parent)!.text).testModDecls
          rustParentCache.set(parent, mods)
        }
        parentMods = mods
      }
    }

    const cls = classifyPath(path, parentMods, crates)
    if (!cls) throw new Error(`源码未分类：${path}`)

    if (lang === 'rs') {
      const analysis = analyzeRust(src)
      const isTestFile = cls.bucket === 'test'
      records.push({
        path, cls,
        prod: isTestFile ? emptyStat() : statOf(analysis.lineClass, analysis.isTestLine),
        test: isTestFile ? statOf(analysis.lineClass) : statTestOf(analysis.lineClass, analysis.isTestLine),
        rustTestRegions: analysis.testRegions,
        rustTestAttrs: analysis.testAttrCount,
      })
    } else {
      const whole = statOf(scanLines(lang, src))
      const isTestFile = cls.bucket === 'test'
      records.push({
        path, cls,
        prod: isTestFile ? emptyStat() : whole,
        test: isTestFile ? whole : emptyStat(),
        // 粗计数：it(/test( 调用次数，仅测试文件的参考维度
        tsTestCases: isTestFile ? (src.match(/\b(?:it|test)\s*\(/g) ?? []).length : 0,
      })
    }
    const record = records[records.length - 1]
    if (record.prod.total + record.test.total !== total) {
      throw new Error(`物理行数不一致：${path}（Git 口径 ${total}，词法器 ${record.prod.total + record.test.total}）`)
    }
  }
  return records
}

// ── 渲染辅助 ────────────────────────────────────────────────────────────────

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += WIDE_CHAR.test(ch) ? 2 : 1
  return w
}

const padEndD = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)))
const padStartD = (s: string, w: number) => ' '.repeat(Math.max(0, w - displayWidth(s))) + s

export function formatNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function table(headers: string[], rows: string[][], aligns: ('l' | 'r')[]): string[] {
  const widths = headers.map((h, c) => Math.max(displayWidth(h), ...rows.map(r => displayWidth(r[c] ?? ''))))
  const line = (cells: string[]) => cells.map((cell, c) => aligns[c] === 'r' ? padStartD(cell, widths[c]) : padEndD(cell, widths[c])).join('  ')
  return [line(headers), ...rows.map(line)]
}

const section = (title: string) => ['', `━━ ${title} ━━`, '']

const pct = (part: number, whole: number) => whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`

const localDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const firstSegmentUnder = (path: string, rootDir: string) => {
  if (path === 'index.html') return '(根级)'
  const dir = posixDirname(path)
  if (dir === rootDir) return '(根级)'
  if (dir.startsWith(`${rootDir}/`)) return dir.slice(rootDir.length + 1).split('/')[0]
  // rootDir 之外的落点（src-tauri 根文件、tests/ 集成测试）
  if (dir === posixDirname(rootDir)) return '(仓根文件)'
  if (/(?:^|\/)tests\b/.test(dir)) return 'tests/（集成测试）'
  return '(其它)'
}

/** crate 清单唯一事实源是 Cargo workspace 成员；Cargo.toml 不可读或无 members 段时退回兜底快照。 */
function loadWorkspaceCrates(root: string): string[] {
  try {
    const parsed = parseWorkspaceCrates(readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8'))
    if (parsed.length > 0) return parsed
  } catch { /* 落到兜底 */ }
  return [...CRATES_FALLBACK]
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const rootIndex = process.argv.indexOf('--root')
  if (rootIndex >= 0 && (!process.argv[rootIndex + 1] || process.argv[rootIndex + 1].startsWith('--'))) {
    throw new Error('--root 需要仓库路径')
  }
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const includeUntracked = process.argv.includes('--include-untracked')
  const crates = loadWorkspaceCrates(root)
  const inventory = collectSourceInventory(root, includeUntracked)
  const records = collect(inventory, crates)
  const head = git(root, ['rev-parse', '--short', 'HEAD']).trim()
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()

  const production = emptyStat()
  const test = emptyStat()
  const prodByLang = new Map<LangId, { stat: LineStat; files: number }>()
  const areas = new Map<string, { files: number; prod: LineStat; test: LineStat }>()
  const excludedAreas = new Map<string, { files: number; stat: LineStat }>()
  const moduleFrontend = new Map<string, { files: number; prod: LineStat; test: LineStat }>()
  const moduleRust = new Map<string, { files: number; prod: LineStat; test: LineStat }>()
  const topFiles: FileRecord[] = []
  let rustInlineTestFiles = 0
  let rustInlineRegions = 0
  const rustInlineStat = emptyStat()
  let rustUnitTestFiles = 0
  const rustUnitTestStat = emptyStat()
  let rustIntegFiles = 0
  const rustIntegStat = emptyStat()
  let rustTestAttrCount = 0
  let tsTestFiles = 0
  const tsTestStat = emptyStat()
  let tsTestCaseCount = 0

  const bump = (map: Map<string, { files: number; prod: LineStat; test: LineStat }>, key: string, rec: FileRecord) => {
    const rec0 = map.get(key) ?? { files: 0, prod: emptyStat(), test: emptyStat() }
    rec0.files++
    addStat(rec0.prod, rec.prod)
    addStat(rec0.test, rec.test)
    map.set(key, rec0)
  }

  for (const rec of records) {
    const { cls } = rec
    if (cls.bucket === 'production' || cls.bucket === 'test') {
      addStat(production, rec.prod)
      addStat(test, rec.test)
      if (cls.bucket === 'production') {
        const l = prodByLang.get(cls.lang) ?? { stat: emptyStat(), files: 0 }
        addStat(l.stat, rec.prod)
        if (rec.prod.total > 0) l.files++
        prodByLang.set(cls.lang, l)
        if (rec.prod.total > 0) topFiles.push(rec)
      }
      bump(areas, cls.area, rec)
      if (cls.area === 'frontend') bump(moduleFrontend, firstSegmentUnder(rec.path, 'src'), rec)
      else if (cls.area === 'rust-app') bump(moduleRust, firstSegmentUnder(rec.path, 'src-tauri/src'), rec)
      else if (cls.area.startsWith('crate:')) bump(moduleRust, areaLabel(cls.area), rec)

      if (cls.lang === 'rs') rustTestAttrCount += rec.rustTestAttrs ?? 0
      if (cls.lang === 'rs' && cls.bucket === 'production' && rec.test.total > 0) {
        rustInlineTestFiles++
        rustInlineRegions += rec.rustTestRegions ?? 0
        addStat(rustInlineStat, rec.test)
      }
      if (cls.lang === 'rs' && cls.bucket === 'test') {
        if (/(?:^|\/)tests\//.test(rec.path)) { rustIntegFiles++; addStat(rustIntegStat, rec.test) }
        else { rustUnitTestFiles++; addStat(rustUnitTestStat, rec.test) }
      }
      if (cls.lang !== 'rs' && cls.bucket === 'test') {
        tsTestFiles++
        addStat(tsTestStat, rec.test)
        tsTestCaseCount += rec.tsTestCases ?? 0
      }
    } else {
      const rec0 = excludedAreas.get(cls.area) ?? { files: 0, stat: emptyStat() }
      rec0.files++
      addStat(rec0.stat, rec.prod)
      addStat(rec0.stat, rec.test)
      excludedAreas.set(cls.area, rec0)
    }
  }

  // ── 输出 ──
  const out: string[] = []
  out.push(`Pylon 代码量统计 · ${localDate()} · ${branch}@${head}`)
  const scanBasis = includeUntracked ? 'Git 当前工作树：已跟踪 + 未跟踪未忽略' : 'Git 当前工作树：仅已跟踪'
  out.push(`扫描基础：${scanBasis}，含已跟踪文件的未提交修改。`)
  out.push('全仓源码包含测试、声明、SDK、工具、示例；排除字体、Git 判定的二进制、文档/配置/锁文件。')
  out.push('物理行包含注释与空行；非空行仍含注释。下方代码/注释分类及生产/测试拆分为词法估算。')
  const langOrder: LangId[] = ['ts', 'tsx', 'js', 'jsx', 'rs', 'css', 'html', 'py', 'sh', 'c', 'ps1', 'bat', 'rc']
  out.push(...section(`全仓源码 · ${inventory.files} 文件 · ${formatNumber(inventory.total)} 物理行 · ${formatNumber(inventory.nonblank)} 非空行`))
  out.push(...table(['语言', '文件', '物理行', '非空行'], langOrder.filter(lang => inventory.byLang[lang]).map(lang => {
    const totals = inventory.byLang[lang]!
    return [LANG_LABEL[lang], String(totals.files), formatNumber(totals.total), formatNumber(totals.nonblank)]
  }), ['l', 'r', 'r', 'r']))
  out.push(`排除：字体 ${inventory.skipped.font.length}、二进制 ${inventory.skipped.binary.length}、非源码文本 ${inventory.skipped.nonSource.length}、工作树缺失 ${inventory.skipped.missing.length} 个文件（路径见 --json repository.skipped）。`)
  out.push(`生产子集另排除声明、SDK、examples、vendor、工具链；crate 随 Cargo workspace（${crates.length} 个）。`)
  const langRows = langOrder.filter(l => prodByLang.has(l)).map(l => {
    const { stat, files } = prodByLang.get(l)!
    return [LANG_LABEL[l], String(files), formatNumber(stat.code), formatNumber(stat.comment), formatNumber(stat.blank), formatNumber(stat.total)]
  })
  const prodFileCount = [...prodByLang.values()].reduce((a, b) => a + b.files, 0)
  out.push(...section(`生产代码（按语言）· ${prodFileCount} 文件 · 合计 ${formatNumber(production.total)} 行`))
  out.push(...table(
    ['语言', '文件', '代码行', '注释行', '空行', '合计'],
    [...langRows, ['合计', String(prodFileCount), formatNumber(production.code), formatNumber(production.comment), formatNumber(production.blank), formatNumber(production.total)]],
    ['l', 'r', 'r', 'r', 'r', 'r'],
  ))

  out.push(...section('测试代码'))
  out.push(...table(
    ['测试类别', '文件', '代码行', '注释行', '空行', '合计'],
    [
      ['TS/JS 测试文件（文件级）', String(tsTestFiles), formatNumber(tsTestStat.code), formatNumber(tsTestStat.comment), formatNumber(tsTestStat.blank), formatNumber(tsTestStat.total)],
      [`Rust 内联 #[cfg(test)]（${rustInlineRegions} 个区域）`, String(rustInlineTestFiles), formatNumber(rustInlineStat.code), formatNumber(rustInlineStat.comment), formatNumber(rustInlineStat.blank), formatNumber(rustInlineStat.total)],
      ['Rust 测试专属文件', String(rustUnitTestFiles), formatNumber(rustUnitTestStat.code), formatNumber(rustUnitTestStat.comment), formatNumber(rustUnitTestStat.blank), formatNumber(rustUnitTestStat.total)],
      ['Rust 集成测试 tests/', String(rustIntegFiles), formatNumber(rustIntegStat.code), formatNumber(rustIntegStat.comment), formatNumber(rustIntegStat.blank), formatNumber(rustIntegStat.total)],
      ['测试合计', String(tsTestFiles + rustInlineTestFiles + rustUnitTestFiles + rustIntegFiles), formatNumber(test.code), formatNumber(test.comment), formatNumber(test.blank), formatNumber(test.total)],
    ],
    ['l', 'r', 'r', 'r', 'r', 'r'],
  ))
  out.push(`测试/生产 代码行比：${(test.code / Math.max(1, production.code)).toFixed(2)} : 1`)
  out.push(`测试标记粗计数（非实际执行用例数）：Rust #[test]/#[tokio::test] ${formatNumber(rustTestAttrCount)} 个 · TS it()/test() 文本匹配 ${formatNumber(tsTestCaseCount)} 个`)

  out.push(...section('生产区域分布（代码行）'))
  out.push('（文件列含该区域的测试文件；合计行 = 生产 + 测试物理行）')
  out.push(...table(
    ['区域', '文件', '生产代码行', '合计行', '占比'],
    [...areas.entries()]
      .filter(([id]) => id === 'frontend' || id === 'rust-app' || id.startsWith('crate:'))
      .sort((a, b) => b[1].prod.total - a[1].prod.total)
      .map(([id, r]) => [areaLabel(id), String(r.files), formatNumber(r.prod.code), formatNumber(r.prod.total + r.test.total), pct(r.prod.code, production.code)]),
    ['l', 'r', 'r', 'r', 'r'],
  ))

  out.push(...section('排除面与工具链（不计入生产/测试口径，存照）'))
  out.push(...table(
    ['类别', '文件', '代码行', '合计行'],
    [...excludedAreas.entries()]
      .sort((a, b) => b[1].stat.total - a[1].stat.total)
      .map(([id, r]) => [areaLabel(id), String(r.files), formatNumber(r.stat.code), formatNumber(r.stat.total)]),
    ['l', 'r', 'r', 'r'],
  ))

  out.push(...section('前端 src/ 模块分布（代码行：生产 / 测试）'))
  out.push(...table(
    ['模块', '文件', '生产', '测试'],
    [...moduleFrontend.entries()].sort((a, b) => b[1].prod.total - a[1].prod.total)
      .map(([k, v]) => [k, String(v.files), formatNumber(v.prod.code), formatNumber(v.test.code)]),
    ['l', 'r', 'r', 'r'],
  ))

  out.push(...section('src-tauri/ 模块分布（代码行：生产 / 测试）'))
  out.push(...table(
    ['模块', '文件', '生产', '测试'],
    [...moduleRust.entries()].sort((a, b) => b[1].prod.total - a[1].prod.total)
      .map(([k, v]) => [k, String(v.files), formatNumber(v.prod.code), formatNumber(v.test.code)]),
    ['l', 'r', 'r', 'r'],
  ))

  out.push(...section('最大生产文件 Top 15（按物理行）'))
  topFiles.sort((a, b) => (b.prod.total + b.test.total) - (a.prod.total + a.test.total))
  for (const [idx, rec] of topFiles.slice(0, 15).entries()) {
    out.push(`${String(idx + 1).padStart(2)}. ${padStartD(formatNumber(rec.prod.total + rec.test.total), 6)} 行（生产代码 ${formatNumber(rec.prod.code)}）  ${rec.path}`)
  }

  if (process.argv.includes('--json')) {
    const { sources: _sources, ...repository } = inventory
    void _sources
    const json = {
      meta: { date: new Date().toISOString(), branch, head, scanBasis, root, includeUntracked,
        lineCounting: 'LF physical lines; includes final unterminated line; nonblank includes comments',
        breakdown: 'heuristic lexical classification; test marker counts are not executed test counts' },
      repository,
      production: { ...production, files: prodFileCount, byLang: Object.fromEntries([...prodByLang].map(([l, v]) => [l, v.stat])) },
      test: {
        ...test,
        tsFiles: tsTestFiles,
        rustInlineFiles: rustInlineTestFiles, rustInlineRegions,
        rustUnitFiles: rustUnitTestFiles, rustIntegrationFiles: rustIntegFiles,
        rustTestAttrCount, tsTestCaseCount,
      },
      areas: Object.fromEntries([...areas].map(([id, r]) => [id, r])),
      excluded: Object.fromEntries([...excludedAreas].map(([id, r]) => [id, r])),
      modules: { frontend: Object.fromEntries(moduleFrontend), rust: Object.fromEntries(moduleRust) },
      topFiles: topFiles.slice(0, 15).map(r => ({ path: r.path, total: r.prod.total + r.test.total, productionCode: r.prod.code })),
    }
    console.log(JSON.stringify(json, null, 2))
  } else {
    console.log(out.join('\n'))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
