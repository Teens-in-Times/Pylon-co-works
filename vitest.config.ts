import { globSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// #279 逐梯队 Solid 化 → #515/#520 全量终态：solid 编译面扩展到全 src——
// `.solid.tsx` 后缀即 solid 编译与 solid-dom 分组（与 vite.config.ts 同一正则）。
// #520 W4：React 面退役，@vitejs/plugin-react 不再加载；原 react-dom/react-shared
// 历史分组名已随 React 退役改名 jsdom-mock/jsdom-shared，承载非 solid 的
// jsdom 逻辑/纯 DOM 测试。
const SOLID_WORKBENCH_FILES = /src\/.*\.solid(?:\.test)?\.tsx$/

// #175：非 watch 模式 vitest 默认吃满 availableParallelism（20 核开发机 = 19 worker）。
// 实测满载下全量必红：worker 内存峰值把 16GB 级开发机推进分页，事件循环整段冻结，
// waitFor 的定时器连同其自身 1s 预算都无法触发（30s 测试看门狗收尸），失败集合
// 在轮间漂移（solidRendererSurface / KernelRoot / issue150）。压到一半并行度后
// 实测全量绿且比满载更快（分页消失，吞吐反升：177-213s → 131-135s）。
// 小核机器（CI 4 vCPU）维持上游默认行为，不引入新变量。
const availableParallelism = os.availableParallelism()
const maxWorkers = availableParallelism >= 12 ? '50%' : undefined

// Preserve the environment declared by each test; directory names do not imply DOM use.
const testFiles = [...globSync(['scripts/*.test.mts', 'src/**/*.test.{ts,tsx}'])]
  .map(file => file.replaceAll('\\', '/')).sort()
function testGroup(file: string): 'node' | 'node-shared' | 'jsdom-mock' | 'jsdom-shared' | 'solid-dom' {
  const source = readFileSync(file, 'utf8')
  if (!/@(?:vitest|jest)-environment\s+jsdom/.test(source)) {
    return /\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(/.test(source) ? 'node' : 'node-shared'
  }
  if (file.endsWith('.solid.test.tsx')) return 'solid-dom'
  return /\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(/.test(source) ? 'jsdom-mock' : 'jsdom-shared'
}

// 前端测试：
// - scripts/*.test.mts：node 环境（#228 批次F 起全部为 vitest describe/it +
//   expect 形态，旧 runner 的顶层 assert + console.log 已迁清）
// - src/**/*.test.{ts,tsx}：组件行为测试；文件内可用环境注释声明 jsdom
// - Solid renderer 只转换 *.solid.tsx；其余 *.tsx 不含 JSX（#520 W4 起 React 面已退役）
// 迁移期间保留原 run-frontend-tests.mts runner 作为兼容入口；vitest 为正式门禁。
export default defineConfig({
  plugins: [
    solid({ include: SOLID_WORKBENCH_FILES, hot: false }),
  ],
  test: {
    // #220：前端计算核的 wasm 产物是测试前置。挂 globalSetup 而不是某个 npm script，
    // 是为了覆盖所有入口（watch、编辑器集成）；build-wasm 以源码哈希做戳，未变时
    // 只读几个文件。缺 wasm 工具链时**直接失败**，不静默跳过——跳过等于弱化 parity 门禁。
    globalSetup: ['scripts/vitest-wasm-setup.mts'],
    projects: (['node', 'node-shared', 'jsdom-mock', 'jsdom-shared', 'solid-dom'] as const).map(name => ({
      plugins: [
        solid({ include: SOLID_WORKBENCH_FILES, hot: false }),
      ],
      test: {
        name,
        include: testFiles.filter(file => testGroup(file) === name),
        environment: name.startsWith('node') ? 'node' : 'jsdom',
        setupFiles: ['vitest.setup.ts'],
        // Node suites include source-contract tests that intentionally replace
        // module mocks; keep their module registry per file.
        // Node pure logic suites have no DOM lifecycle and are safe to share;
        // DOM suites retain file isolation because async UI effects can outlive
        // a test file even after cleanup.
        isolate: name !== 'node-shared',
        pool: 'forks',
        testTimeout: 30_000,
      },
    })),
    // P91 C2 §7：全局 60s 收紧为 30s（node 纯逻辑/jsdom 组件共用一档；esbuild/dist
    // 重型 integration 文件内用 vi.setConfig 个别放宽到 60s）。retry 已退役——
    // 出口判据：无 retry 连续 5 轮全量全绿。
    testTimeout: 30_000,
    pool: 'forks',
    maxWorkers,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/demo/chatMockData.ts'],
      reporter: ['text', 'json-summary'],
      // #228 批次F ratchet 语义（只升不降）：阈值 = 上次全量实测基线向下取整再留
      // 1 个百分点余量——防回退，不卡偶发抖动。下次实测（全量绿）高于当前阈值后，
      // 按同一公式上调；任何情况下不得下调。
      // 当前基线：2026-09-22 实测（622 文件 / 4670 用例全量 + coverage）
      // statements 80.48 / branches 73.10 / functions 80.95 / lines 84.12 → 79/72/79/83。
      // 前值 58/44/59/61 是 ISSUE-20 W4 的旧基线（当时实测 60.89/46.73/61.32/63.22），
      // 已随覆盖增长 ratchet 上调。
      thresholds: {
        statements: 79,
        branches: 72,
        functions: 79,
        lines: 83,
      },
    },
  },
})
