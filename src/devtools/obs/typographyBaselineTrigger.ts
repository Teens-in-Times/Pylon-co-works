/**
 * CSS-01：DEV-only typography computed style 基线控制台钩子（隔离生产路径）。
 *
 * 仅在 DEV 构建经 main.tsx 动态 import 挂载（生产 `import.meta.env.DEV` 恒 false，分支
 * tree-shake，零暴露）。
 *
 * 用法（DevTools Console，DEV 构建）：
 *   await window.__pylonTypographyBaseline()              // 采集当前 preset + DOM computed style 基线
 *   await window.__pylonTypographyBaseline('after-css02') // 自定义阶段标注
 *
 * 数据源：实际主题 preset 的 `--chat-font-size`（读 `.app` computed style，reflect 当前
 * applied preset）+ 当前 Chat 根 DOM 内 .term/.term-assistant/h1-h6 的 computed style。
 * 只读取证：不修改样式、不触发重排写入；对 DOM 仅一次 query + getComputedStyle。
 */

import { captureComputedStyleBaseline, buildTypographyBaselineArtifact, type TypographyBaselineArtifact } from '../../domains/theme/typographyBaseline.ts'
import { THEME_FIELD_DEFS } from '../../domains/theme/themeFieldDefs.ts'

export interface Css01ConsoleApi {
  __pylonTypographyBaseline: (phase?: string) => Promise<TypographyBaselineArtifact>
}

export function installCss01DevTrigger(): void {
  if (typeof window === 'undefined') return
  if (typeof document === 'undefined') return
  const win = window as unknown as { __pylonTypographyBaseline?: Css01ConsoleApi['__pylonTypographyBaseline'] }
  if (win.__pylonTypographyBaseline) return // 防重入

  win.__pylonTypographyBaseline = async (phase = 'manual'): Promise<TypographyBaselineArtifact> => {
    // 当前 applied preset 的聊天字号：`.app` 内联 style 注入 --chat-font-size=NNpx（App.tsx cssVars）。
    const app = document.querySelector('.app')
    let chatFontSize: number = THEME_FIELD_DEFS.chatFontSize.default // preset 默认（def 单一真值表，CR-312 消化）
    if (app) {
      const raw = window.getComputedStyle(app).getPropertyValue('--chat-font-size').trim()
      const parsed = parseFloat(raw)
      if (Number.isFinite(parsed)) chatFontSize = parsed
    }
    const scope = document.querySelector('.chat-view') ?? document
    const measurement = captureComputedStyleBaseline(scope)
    return buildTypographyBaselineArtifact({ phase, theme: { chatFontSize }, measurement })
  }
}
