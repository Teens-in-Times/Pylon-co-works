import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css',
  'utf8',
)

describe('input message-rail typography contract', () => {
  // ★ #266 CC-21：输入栏字体独立（--cc-input-font-family 显式解析输出；缺变量时兜底回
  //   旧消息字体链）。原「输入框字体=消息字体链」的期望随定案变更同步到这里。
  it('uses the independent input font chain and shared line-height for every input variant', () => {
    expect(css).toMatch(/\.input-textarea\s*\{[^}]*font-family:var\(--cc-input-font-family,var\(--msg-font,var\(--chat-font,var\(--mono\)\)\)\);/s)
    // A6-5：输入行距为用户可调项（--cc-input-line-height），优先于共享消息行高；回退链保持 main 的 msg/chat 体系
    expect(css).toMatch(/\.input-textarea\s*\{[^}]*line-height:var\(--cc-input-line-height,var\(--msg-line-height,var\(--chat-line-height,1\.35\)\)\);/s)
    expect(css).not.toContain('font-family:var(--msg-font,var(--mono)) !important')
  })

  it('keeps queued-message prose on the independent input font rail', () => {
    expect(css).toMatch(/\.queued-message-editor\s*\{[^}]*font-family:var\(--cc-input-font-family,var\(--msg-font,var\(--chat-font,var\(--mono\)\)\)\);/s)
    // ★ #266 CC-29：原来这里还锁了 composer meta 那段 `font:600 10px …`。该规则是悬空规则
    //   （类名在生产代码里零命中），已随本单删除 ⇒ 断言失去靶子，移出本用例。
    expect(css).not.toMatch(/\.input-textarea[^}]*font-family:var\(--msg-font,var\(--chat-font,var\(--font\)\)\)/s)
  })
})

// 下沉自 scripts/test-style-guards.mts（P91 A2 拆分）：输入栏队列与变体样式守卫。
describe('input queue and variant style guards', () => {
  it('待发送队列必须声明列表样式', () => {
    expect(css).toMatch(/\.queued-message-list/)
  })

  it('命令行形态仍有专属样式，且已删的两个变体族不再回来', () => {
    // ★ #266 刀9：输入形态固定命令行 ⇒ 原 `input-variant-compact` / `input-variant-command`
    //   两族已删除（字段不存在了）。这条守卫的**靶子反转**：原先锁"两族必须有样式"，
    //   现在锁"命令行这一族的 scoped 样式仍在、且那两个变体族不得回摆"。
    expect(css).toMatch(/\.input-bar\.cli-mode/)
    expect(css).not.toMatch(/\.input-bar\.input-variant-compact/)
    expect(css).not.toMatch(/\.input-bar\.input-variant-command/)
  })
})
