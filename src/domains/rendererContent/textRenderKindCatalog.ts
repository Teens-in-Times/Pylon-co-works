/**
 * C00：文本族 render kind catalog——message.user/assistant、content.text/markdown/code/ansi。
 *
 * kind 是内容契约（A07 catalog），不等同 renderer 实现；Solid surface 与第三方
 * react 兼容 kind 都是这些 kind 的 Slot。ensureBuiltinTextRenderKinds 幂等注册，
 * 供内置 Suite 组装与设置页 schema 生成消费。
 */
import type { RenderKindDefinition } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type { RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import {
  isNonEmptyContentLocation,
  isOptionalNonNegativeFiniteNumber,
  isValidFileSelection,
} from '../workbench/content/fileContentValidation.ts'
import { isValidMediaContentInput } from '../workbench/content/mediaContentValidation.ts'
import {
  isValidArtifactContentInput,
  isValidDiffContentInput,
  isValidHookSurfaceInput,
  isValidLogContentInput,
  isValidLinkContentInput,
  isValidLspDiagnosticContentInput,
  isValidMcpResourceContentInput,
  isValidMemoryContentInput,
  isValidSearchResultContentInput,
  isValidSkillContentInput,
  isValidTerminalContentInput,
  isJsonValue,
} from '../workbench/content/contentPartSchema.ts'

const FONT_OPTIONS = Object.freeze([
  { value: 'inherit', label: '跟随界面' },
  { value: 'sans', label: '无衬线' },
  { value: 'serif', label: '衬线' },
  { value: 'mono', label: '等宽' },
])

const TEXT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'typography', label: '文本排版', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: FONT_OPTIONS, default: 'inherit', semanticKey: 'message.fontFamily', scope: 'renderer', inheritsFrom: 'theme.chatFont' },
      { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 32, step: 1, unit: 'px', default: 14, semanticKey: 'message.fontSize', scope: 'renderer', inheritsFrom: 'theme.chatFontSize' },
      { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.6, semanticKey: 'message.lineHeight', scope: 'renderer', inheritsFrom: 'theme.chatLineHeight' },
      { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 760 },
    ],
  }],
} satisfies RendererSettingsSchema)

const MARKDOWN_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'typography', label: 'Markdown 排版', layout: 'grid', fields: [
      ...TEXT_SETTINGS.groups[0].fields,
      { key: 'linkStyle', label: '链接样式', type: 'choice', presentation: 'segmented', options: [
        { value: 'underline', label: '下划线' },
        { value: 'plain', label: '简洁' },
      ], default: 'underline' },
    ],
  }],
} satisfies RendererSettingsSchema)

const CODE_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'code', label: '代码块', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: [
        { value: 'mono', label: '等宽' }, { value: 'inherit', label: '跟随界面' },
      ], default: 'mono' },
      { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
      { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.5 },
      { key: 'wrap', label: '换行', type: 'choice', presentation: 'segmented', options: [
        { value: 'soft', label: '自动换行' }, { value: 'none', label: '不换行' },
      ], default: 'soft' },
      { key: 'maxLines', label: '折叠行数', type: 'number', presentation: 'slider+input', min: 20, max: 2000, step: 20, unit: '行', default: 400 },
      { key: 'showLanguage', label: '显示语言', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'showCopyButton', label: '显示复制按钮', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'palette', label: '配色', type: 'choice', presentation: 'select', options: [
        { value: 'auto', label: '跟随主题' }, { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' },
      ], optionTarget: 'kind.content.code.palette', default: 'auto' },
    ],
  }],
} satisfies RendererSettingsSchema)

const ANSI_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [{
    id: 'terminal', label: 'ANSI 输出', layout: 'grid', fields: [
      { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: [
        { value: 'mono', label: '等宽' }, { value: 'inherit', label: '跟随界面' },
      ], default: 'mono' },
      { key: 'wrap', label: '换行', type: 'choice', presentation: 'segmented', options: [
        { value: 'soft', label: '自动换行' }, { value: 'none', label: '不换行' },
      ], default: 'soft' },
      { key: 'maxLines', label: '最大显示行数', type: 'number', presentation: 'slider+input', min: 20, max: 5000, step: 20, unit: '行', default: 800 },
      { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
      { key: 'palette', label: '16 色调色板', type: 'choice', presentation: 'select', options: [
        { value: 'terminal', label: '终端默认' }, { value: 'accessible', label: '高对比度' }, { value: 'dim', label: '柔和' },
      ], optionTarget: 'kind.content.ansi.palette', default: 'terminal' },
    ],
  }],
} satisfies RendererSettingsSchema)

const REASONING_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '推理外观', layout: 'grid', fields: [
        { key: 'foreground', label: '文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'color-mix(in srgb, var(--border) 72%, transparent)' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.6 },
      ],
    },
    {
      id: 'behaviour', label: '推理行为', layout: 'grid', fields: [
        { key: 'defaultCollapsed', label: '完成后默认折叠', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'maxHeight', label: '正文最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 320 },
        { key: 'runningAnimation', label: '思考中动效', type: 'choice', presentation: 'segmented', options: [
          { value: 'pulse', label: '呼吸' }, { value: 'shimmer', label: '流光' }, { value: 'none', label: '关闭' },
        ], default: 'pulse' },
        { key: 'showDuration', label: '完成后显示时长', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const REASONING_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'color-mix(in srgb, var(--border) 72%, transparent)',
  fontSize: 13,
  lineHeight: 1.6,
  defaultCollapsed: true,
  maxHeight: 320,
  runningAnimation: 'pulse',
  showDuration: true,
})

const FILE_CONTENT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '文件与资源外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'iconSize', label: '图标尺寸', type: 'number', presentation: 'slider+input', min: 12, max: 40, step: 1, unit: 'px', default: 18 },
        { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'fileTypePalette', label: '文件类型色板', type: 'choice', presentation: 'segmented', options: [
          { value: 'auto', label: '自动' }, { value: 'neutral', label: '中性' }, { value: 'accent', label: '强调' },
        ], default: 'auto' },
      ],
    },
    {
      id: 'behaviour', label: '文件与资源行为', layout: 'grid', fields: [
        { key: 'pathCollapse', label: '路径折叠', type: 'choice', presentation: 'select', options: [
          { value: 'full', label: '完整' }, { value: 'middle', label: '中间折叠' }, { value: 'basename', label: '仅文件名' },
        ], default: 'middle' },
        { key: 'previewLines', label: '预览行数', type: 'number', presentation: 'slider+input', min: 1, max: 200, step: 1, default: 12 },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 360 },
        { key: 'showAbsolutePath', label: '显示完整来源', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'groupLayout', label: '卡片布局', type: 'choice', presentation: 'segmented', options: [
          { value: 'stack', label: '纵向' }, { value: 'grid', label: '网格' },
        ], default: 'stack' },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const FILE_CONTENT_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)',
  mutedForeground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'var(--border)',
  fontSize: 13,
  iconSize: 18,
  maxWidth: 960,
  maxHeight: 360,
  pathCollapse: 'middle',
  previewLines: 12,
  showAbsolutePath: true,
  showMetadata: true,
  fileTypePalette: 'auto',
  groupLayout: 'stack',
})

const MEDIA_CONTENT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '媒体外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'maxWidth', label: '最大内联宽度', type: 'number', presentation: 'slider+input', min: 160, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'maxHeight', label: '最大内联高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 640 },
        { key: 'fit', label: '适配方式', type: 'choice', presentation: 'segmented', options: [
          { value: 'contain', label: '完整显示' }, { value: 'cover', label: '填满裁切' }, { value: 'original', label: '原始尺寸' },
        ], default: 'contain' },
        { key: 'radius', label: '圆角', type: 'number', presentation: 'slider+input', min: 0, max: 32, step: 1, unit: 'px', default: 8 },
        { key: 'transcriptStyle', label: '转写样式', type: 'choice', presentation: 'select', options: [
          { value: 'panel', label: '独立面板' }, { value: 'plain', label: '纯文本' }, { value: 'compact', label: '紧凑' },
        ], default: 'panel' },
      ],
    },
    {
      id: 'behaviour', label: '媒体行为', layout: 'grid', fields: [
        { key: 'defaultExpanded', label: '默认展开', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showCaption', label: '显示说明', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showDownload', label: '显示下载动作', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'autoplay', label: '自动播放', description: '默认关闭，避免未经用户操作播放媒体。', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'controls', label: '显示播放控件', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const MEDIA_CONTENT_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)',
  mutedForeground: 'var(--text-dim)',
  background: 'transparent',
  borderColor: 'var(--border)',
  maxWidth: 960,
  maxHeight: 640,
  fit: 'contain',
  radius: 8,
  defaultExpanded: true,
  showCaption: true,
  showDownload: true,
  autoplay: false,
  controls: true,
  transcriptStyle: 'panel',
  showMetadata: true,
})

const SEARCH_LINK_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '搜索与链接外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'mutedForeground', label: '次要文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text-dim)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'maxWidth', label: '最大宽度', type: 'number', presentation: 'slider+input', min: 240, max: 1600, step: 20, unit: 'px', default: 960 },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 420 },
        { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' },
        ], default: 'comfortable' },
        { key: 'grouped', label: '分组呈现', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'highlightPalette', label: '高亮配色', type: 'choice', presentation: 'select', options: [
          { value: 'semantic', label: '语义色' }, { value: 'accent', label: '强调色' }, { value: 'neutral', label: '中性色' },
        ], default: 'semantic' },
      ],
    },
    {
      id: 'behaviour', label: '搜索与链接行为', layout: 'grid', fields: [
        { key: 'defaultExpanded', label: '默认展开搜索结果', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'pageSize', label: '每页条目', type: 'number', presentation: 'slider+input', min: 1, max: 100, step: 1, default: 10 },
        { key: 'snippetLines', label: '摘要行数', type: 'number', presentation: 'slider+input', min: 1, max: 20, step: 1, unit: '行', default: 3 },
        { key: 'pathDisplay', label: '来源显示', type: 'choice', presentation: 'segmented', options: [
          { value: 'full', label: '完整' }, { value: 'basename', label: '末段' }, { value: 'hidden', label: '隐藏' },
        ], default: 'full' },
        { key: 'linkOpenMode', label: '链接打开方式', type: 'choice', presentation: 'segmented', options: [
          { value: 'external', label: '外部打开' }, { value: 'copy-first', label: '优先复制' },
        ], default: 'external' },
        { key: 'showStatus', label: '显示 HTTP 状态', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const C15_COMMON_FIELDS = Object.freeze([
  { key: 'categoryPalette', label: '类别配色', type: 'choice', presentation: 'segmented', options: [
    { value: 'semantic', label: '语义色' }, { value: 'accent', label: '强调色' }, { value: 'neutral', label: '中性色' },
  ], default: 'semantic' },
  { key: 'icon', label: '图标', type: 'choice', presentation: 'select', options: [
    { value: 'auto', label: '自动' }, { value: 'memory', label: '记忆' }, { value: 'skill', label: '技能' },
    { value: 'server', label: '服务器' }, { value: 'document', label: '文档' }, { value: 'hook', label: 'Hook' },
  ], default: 'auto' },
  { key: 'metadataFields', label: '元数据字段', type: 'multi-choice', presentation: 'checklist', options: [
    { value: 'identity', label: '身份' }, { value: 'source', label: '来源' }, { value: 'scope', label: '范围' },
    { value: 'version', label: '版本' }, { value: 'mime', label: 'MIME' }, { value: 'server', label: '服务器' },
    { value: 'tool', label: '工具' }, { value: 'status', label: '状态' }, { value: 'owner', label: '所有者' },
  ], default: ['identity', 'source', 'status', 'owner'] },
  { key: 'unknownRawCollapsed', label: '未知字段默认折叠', type: 'boolean', presentation: 'toggle', default: true },
] satisfies RendererSettingsSchema['groups'][number]['fields'])

function c15Settings(extra: RendererSettingsSchema['groups'][number]['fields'] = []): RendererSettingsSchema {
  return Object.freeze({
    schemaVersion: 1,
    groups: [{ id: 'extension-content', label: '扩展内容', layout: 'grid' as const, fields: [...C15_COMMON_FIELDS, ...extra] }],
  })
}

const C15_CONTENT_SETTINGS = c15Settings()
const C15_MCP_SETTINGS = c15Settings([
  { key: 'mcpServerBadge', label: '显示 MCP 服务器徽标', type: 'boolean', presentation: 'toggle', default: true },
])
const C15_ARTIFACT_SETTINGS = c15Settings([
  { key: 'artifactPreviewSize', label: '工件预览高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 320 },
])
const C15_HOOK_SETTINGS = c15Settings([
  { key: 'defaultCollapsed', label: 'Hook 默认折叠', type: 'boolean', presentation: 'toggle', default: true },
  { key: 'showDuration', label: '显示 Hook 耗时', type: 'boolean', presentation: 'toggle', default: true },
])

const C15_DEFAULT_TOKENS = Object.freeze({
  categoryPalette: 'semantic', icon: 'auto', metadataFields: ['identity', 'source', 'status', 'owner'],
  unknownRawCollapsed: true, artifactPreviewSize: 320, mcpServerBadge: true,
  defaultCollapsed: true, showDuration: true,
})

export const TERMINAL_LOG_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'appearance', label: '终端与日志外观', layout: 'grid', fields: [
        { key: 'fontFamily', label: '字体', type: 'choice', presentation: 'select', options: [
          { value: 'mono', label: '等宽' }, { value: 'inherit', label: '跟随界面' },
        ], default: 'mono' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'lineHeight', label: '行高', type: 'number', presentation: 'slider+input', min: 1, max: 2.5, step: 0.1, default: 1.5 },
        { key: 'wrap', label: '换行', type: 'choice', presentation: 'segmented', options: [
          { value: 'none', label: '不换行' }, { value: 'soft', label: '自动换行' },
        ], default: 'none' },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1600, step: 20, unit: 'px', default: 480 },
        { key: 'stdoutColor', label: '标准输出颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'stderrColor', label: '错误输出颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--danger, #e5484d)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [
          { value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' },
        ], default: 'comfortable' },
      ],
    },
    {
      id: 'behaviour', label: '终端与日志行为', layout: 'grid', fields: [
        { key: 'retainedLines', label: '保留行数', type: 'number', presentation: 'slider+input', min: 100, max: 20_000, step: 100, unit: '行', default: 2000 },
        { key: 'timestamps', label: '显示时间戳', type: 'boolean', presentation: 'toggle', default: false },
        { key: 'followTail', label: '自动跟随末尾', description: '仅为当前视图状态，不写入 journal。', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'logLevels', label: '日志级别', type: 'multi-choice', presentation: 'checklist', options: [
          { value: 'trace', label: 'Trace 追踪' }, { value: 'debug', label: 'Debug 调试' }, { value: 'info', label: 'Info 信息' },
          { value: 'warn', label: 'Warn 警告' }, { value: 'error', label: 'Error 错误' }, { value: 'fatal', label: 'Fatal 致命' },
          { value: 'unknown', label: 'Unknown 未知' },
        ], default: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'] },
        { key: 'showCopy', label: '显示复制按钮', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showIdentity', label: '显示进程标识', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

export const TERMINAL_LOG_DEFAULT_TOKENS = Object.freeze({
  fontFamily: 'mono', fontSize: 13, lineHeight: 1.5, wrap: 'none', maxHeight: 480,
  stdoutColor: 'var(--text)', stderrColor: 'var(--danger, #e5484d)', background: 'transparent',
  density: 'comfortable', retainedLines: 2000, timestamps: false, followTail: true,
  logLevels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'],
  showCopy: true, showIdentity: true,
})

const SEARCH_LINK_DEFAULT_TOKENS = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  fontSize: 13, maxWidth: 960, maxHeight: 420, density: 'comfortable', grouped: true, highlightPalette: 'semantic',
  defaultExpanded: false, pageSize: 10, snippetLines: 3, pathDisplay: 'full', linkOpenMode: 'external', showStatus: true,
})

const DIFF_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'presentation', label: 'Diff 呈现', layout: 'grid', fields: [
        { key: 'view', label: '视图', type: 'choice', presentation: 'segmented', options: [
          { value: 'unified', label: '统一' }, { value: 'split', label: '分栏' },
        ], default: 'unified' },
        { key: 'contextLines', label: '上下文行数', type: 'number', presentation: 'slider+input', min: 0, max: 100, step: 1, default: 3 },
        { key: 'lineNumbers', label: '显示行号', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'wordDiff', label: '词级差异', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'wrap', label: '长行换行', type: 'choice', presentation: 'segmented', options: [
          { value: 'none', label: '不换行' }, { value: 'soft', label: '软换行' },
        ], default: 'none' },
        { key: 'defaultExpanded', label: '默认展开', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
    {
      id: 'appearance', label: 'Diff 外观', layout: 'grid', fields: [
        { key: 'foreground', label: '主文字颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--text)' },
        { key: 'background', label: '背景色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'transparent' },
        { key: 'borderColor', label: '边框颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: 'var(--border)' },
        { key: 'addedColor', label: '新增颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: '#4EBA65' },
        { key: 'removedColor', label: '删除颜色', type: 'color', presentation: 'palette+picker', alpha: true, default: '#FF6B80' },
        { key: 'fontSize', label: '字号', type: 'number', presentation: 'slider+input', min: 10, max: 28, step: 1, unit: 'px', default: 13 },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1600, step: 20, unit: 'px', default: 320 },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showRaw', label: '允许查看 Raw 审计信息', type: 'boolean', presentation: 'toggle', default: false },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const DIFF_DEFAULT_TOKENS = Object.freeze({
  view: 'unified', contextLines: 3, lineNumbers: true, wordDiff: true, wrap: 'none', defaultExpanded: true,
  foreground: 'var(--text)', background: 'transparent', borderColor: 'var(--border)',
  addedColor: '#4EBA65', removedColor: '#FF6B80', fontSize: 13, maxHeight: 320,
  showMetadata: true, showRaw: false,
})

const LSP_SETTINGS = Object.freeze({
  schemaVersion: 1,
  groups: [
    {
      id: 'presentation', label: 'LSP 诊断呈现', layout: 'grid', fields: [
        { key: 'severityPalette', label: '严重级别配色', type: 'choice', presentation: 'select', options: [
          { value: 'semantic', label: '语义色' }, { value: 'accent', label: '强调色' }, { value: 'neutral', label: '中性色' },
        ], default: 'semantic' },
        { key: 'maxHeight', label: '最大高度', type: 'number', presentation: 'slider+input', min: 80, max: 1200, step: 20, unit: 'px', default: 360 },
        { key: 'showSource', label: '显示来源', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showCode', label: '显示诊断码', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showRelated', label: '显示关联位置', type: 'boolean', presentation: 'toggle', default: true },
        { key: 'showMetadata', label: '显示 metadata', type: 'boolean', presentation: 'toggle', default: true },
      ],
    },
  ],
} satisfies RendererSettingsSchema)

const LSP_DEFAULT_TOKENS = Object.freeze({
  severityPalette: 'semantic', maxHeight: 360, showSource: true, showCode: true, showRelated: true, showMetadata: true,
})

function textPayload(input: unknown): input is { readonly text: string } {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && typeof (input as Record<string, unknown>).text === 'string'
}

const STRUCTURED_CONTENT_KIND_IDS = Object.freeze([
  'content.location', 'content.progress', 'content.list', 'content.key-value',
  'content.json', 'content.tool-use', 'content.tool-result',
] as const)

function structuredContentFixture(id: (typeof STRUCTURED_CONTENT_KIND_IDS)[number]): Readonly<Record<string, unknown>> {
  const kind = id.slice('content.'.length)
  if (id === 'content.location') return Object.freeze({ kind, path: '/fixture/src/app.ts', line: 12, column: 4 })
  if (id === 'content.progress') return Object.freeze({ kind, current: 2, total: 5, message: 'fixture progress' })
  if (id === 'content.list') return Object.freeze({ kind, title: 'Fixture list', items: ['one', 'two'] })
  if (id === 'content.key-value') return Object.freeze({ kind, entries: { model: 'fixture', retries: 2 } })
  if (id === 'content.json') return Object.freeze({ kind, value: { ok: true } })
  if (id === 'content.tool-use') return Object.freeze({ kind, name: 'FixtureTool', input: { path: '/fixture/input' } })
  return Object.freeze({ kind, status: 'completed', parts: [{ kind: 'text', text: 'fixture result' }] })
}

function structuredContentInput(id: (typeof STRUCTURED_CONTENT_KIND_IDS)[number], input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !isJsonValue(input)) return false
  const kind = (input as Record<string, unknown>).kind
  return kind === undefined || kind === id || kind === id.slice('content.'.length)
}

const messageRoleKind = (id: 'message.user' | 'message.assistant'): RenderKindDefinition => ({
  id,
  category: 'message',
  // role framing 失败时降级为通用文本（内容仍可见）；catalog 禁止 fallback 环，
  // 不能与对侧 role 互指。
  fallbackKind: 'content.text',
  priority: 100,
  fixture: { role: id === 'message.user' ? 'user' : 'assistant', parts: [{ kind: 'text', text: `fixture ${id}` }] },
  defaultTokens: {},
  settingsSchemaVersion: 1,
  validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
    && (input as Record<string, unknown>).role === (id === 'message.user' ? 'user' : 'assistant'),
})

export const BUILTIN_TEXT_RENDER_KINDS: readonly RenderKindDefinition[] = [
  messageRoleKind('message.user'),
  messageRoleKind('message.assistant'),
  {
    id: 'content.text',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'fixture content.text' },
    defaultTokens: { fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6, maxWidth: 760 },
    settingsSchemaVersion: 1,
    settings: TEXT_SETTINGS,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.markdown',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '# fixture markdown\n\n- item **bold**' },
    defaultTokens: { fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6, maxWidth: 760, linkStyle: 'underline' },
    settingsSchemaVersion: 1,
    settings: MARKDOWN_SETTINGS,
    // 非空 text；流式起点的空串由组件层处理，不进入 kind 校验
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'fixture reasoning delta', state: 'running' },
    defaultTokens: REASONING_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: REASONING_SETTINGS,
    // C01：state ∈ running|complete|missing；redacted 走独立 kind
    validateInput: input => textPayload(input)
      && ['running', 'complete', 'missing'].includes(String((input as Record<string, unknown>).state))
      && ((input as Record<string, unknown>).durationMs === undefined
        || (typeof (input as Record<string, unknown>).durationMs === 'number'
          && Number.isFinite((input as Record<string, unknown>).durationMs)
          && Number((input as Record<string, unknown>).durationMs) >= 0)),
  },
  {
    id: 'content.redacted-reasoning',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { reason: 'provider_redacted' },
    defaultTokens: REASONING_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: REASONING_SETTINGS,
    // C01：redacted 只携带原因，不携带内容——validateInput 拒绝带正文的输入
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && typeof (input as Record<string, unknown>).reason === 'string'
      && typeof (input as Record<string, unknown>).text === 'undefined',
  },
  {
    id: 'content.file-reference',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/report.md', displayName: 'report.md' },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    // C02：path 必须非空；Windows/URI 形态不在此层互转
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).path)
      && isOptionalNonNegativeFiniteNumber((input as Record<string, unknown>).size),
  },
  {
    id: 'content.file-selection',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/main.ts', selection: { start: { line: 1 }, end: { line: 4 } }, language: 'ts' },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).path)
      && isValidFileSelection((input as Record<string, unknown>).selection),
  },
  {
    id: 'content.document',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { title: 'fixture-spec.md', mimeType: 'text/markdown', text: '# Fixture document' },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    // C02：document 是 renderer semantic kind；当前 provider SOURCE-ONLY 附件不在此层补造。
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && ['path', 'uri', 'text'].some(key => isNonEmptyContentLocation((input as Record<string, unknown>)[key]))
      && typeof (input as Record<string, unknown>).blob === 'undefined',
  },
  {
    id: 'content.resource',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { uri: 'file:///fixture/spec.pdf', mimeType: 'application/pdf', hasBlob: true },
    defaultTokens: FILE_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: FILE_CONTENT_SETTINGS,
    validateInput: input => typeof input === 'object' && input !== null && !Array.isArray(input)
      && isNonEmptyContentLocation((input as Record<string, unknown>).uri)
      && typeof (input as Record<string, unknown>).blob === 'undefined',
  },
  {
    id: 'content.terminal',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { command: 'fixture-cmd', streams: [{ stream: 'stdout', text: 'fixture output', ordinal: 0 }], status: 'completed' },
    defaultTokens: TERMINAL_LOG_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: TERMINAL_LOG_SETTINGS,
    // C07：streams 分条不合并；env secret-like 脱敏在 normalizer 层完成
    validateInput: isValidTerminalContentInput,
  },
  {
    id: 'content.log',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { source: 'fixture-worker', entries: [{ level: 'info', text: 'fixture log entry' }] },
    defaultTokens: TERMINAL_LOG_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: TERMINAL_LOG_SETTINGS,
    validateInput: isValidLogContentInput,
  },
  {
    id: 'content.memory',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { kind: 'memory', memoryId: 'fixture-memory', title: 'Fixture memory', source: 'hermes', status: 'recalled' },
    validateInput: isValidMemoryContentInput,
    defaultTokens: C15_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: C15_CONTENT_SETTINGS,
    // C15：memory/skill 只承载安全 metadata/引用/摘要（validator 在 contentPartSchema）
  },
  {
    id: 'content.skill',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { kind: 'skill', skillId: 'fixture-skill', title: 'Fixture skill', source: 'hermes', status: 'available' },
    validateInput: isValidSkillContentInput,
    defaultTokens: C15_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: C15_CONTENT_SETTINGS,
  },
  {
    id: 'content.mcp-resource',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { kind: 'mcp-resource', server: 'fixture-mcp', resourceUri: 'file:///fixture.md', mimeType: 'text/markdown' },
    validateInput: isValidMcpResourceContentInput,
    defaultTokens: C15_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: C15_MCP_SETTINGS,
  },
  {
    id: 'content.artifact',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { kind: 'artifact', artifactId: 'fixture-artifact', title: 'Fixture artifact', uri: 'file:///fixture-artifact.bin', version: 1 },
    validateInput: isValidArtifactContentInput,
    defaultTokens: C15_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: C15_ARTIFACT_SETTINGS,
  },
  {
    id: 'system.hook',
    category: 'system',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { phase: 'turn.completed', owner: { pluginId: 'fixture.audit', handlerId: 'after-turn' }, status: 'continued', durationMs: 12 },
    validateInput: isValidHookSurfaceInput,
    defaultTokens: C15_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: C15_HOOK_SETTINGS,
  },
  {
    id: 'content.diff',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { path: '/fixture/a.ts', status: 'modified', oldText: 'a\n', newText: 'b\n' },
    defaultTokens: DIFF_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: DIFF_SETTINGS,
    validateInput: isValidDiffContentInput,
  },
  {
    id: 'diagnostic.lsp',
    category: 'diagnostic',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { severity: 'error', code: 'TS1', source: 'typescript', message: 'fixture lsp diagnostic', path: '/fixture/a.ts' },
    defaultTokens: LSP_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: LSP_SETTINGS,
    validateInput: isValidLspDiagnosticContentInput,
  },
  {
    id: 'content.search-result',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { query: 'fixture query', total: 1, results: [{ source: '/fixture/a.ts', rank: 1, snippet: 'fixture snippet' }] },
    defaultTokens: SEARCH_LINK_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: SEARCH_LINK_SETTINGS,
    validateInput: isValidSearchResultContentInput,
  },
  {
    id: 'content.link',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { url: 'https://fixture.example.com/guide', title: 'fixture link' },
    defaultTokens: SEARCH_LINK_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: SEARCH_LINK_SETTINGS,
    validateInput: isValidLinkContentInput,
  },
  ...STRUCTURED_CONTENT_KIND_IDS.map(id => ({
    id,
    category: 'content' as const,
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: structuredContentFixture(id),
    defaultTokens: { maxHeight: 420, defaultCollapsed: false },
    settingsSchemaVersion: 1,
    validateInput: (input: unknown) => structuredContentInput(id, input),
  } satisfies RenderKindDefinition)),
  ...(['image', 'audio', 'video'] as const).map(kind => ({
    id: `content.${kind}`,
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: kind === 'image'
      ? { source: 'https://fixture.example.com/pic.png', mimeType: 'image/png', alt: 'fixture image' }
      : { source: `https://fixture.example.com/clip.${kind === 'audio' ? 'wav' : 'mp4'}`, mimeType: `${kind}/${kind === 'audio' ? 'wav' : 'mp4'}` },
    defaultTokens: MEDIA_CONTENT_DEFAULT_TOKENS,
    settingsSchemaVersion: 1,
    settings: MEDIA_CONTENT_SETTINGS,
    // C03：单一 canonical source；path/base64/blob 必须显式 sourceKind。
    validateInput: (input: unknown) => isValidMediaContentInput(input, kind),
  })),
  {
    id: 'content.code',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: 'const answer = 42\n', language: 'ts' },
    defaultTokens: { fontFamily: 'mono', fontSize: 13, lineHeight: 1.5, wrap: 'soft', maxLines: 400, showLanguage: true, showCopyButton: true, palette: 'auto' },
    settingsSchemaVersion: 1,
    settings: CODE_SETTINGS,
    validateInput: input => textPayload(input) && input.text.length > 0,
  },
  {
    id: 'content.ansi',
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 100,
    fixture: { text: '\u001b[32mok\u001b[0m' },
    defaultTokens: { fontFamily: 'mono', wrap: 'soft', maxLines: 800, background: 'transparent', palette: 'terminal' },
    settingsSchemaVersion: 1,
    settings: ANSI_SETTINGS,
    validateInput: input => textPayload(input),
  },
]

let ensured = false

/**
 * 幂等把六个 kind 注册进当前 RendererRegistry 单例的 catalog。
 * 独立于任何 renderer/suite 注册——kind 先于实现存在，Slot 后挂。
 * message.user/assistant 互为 fallback，经 shadow transaction 原子提交，
 * 不出现"前者已注册、后备未注册"的中间态。
 */
export async function ensureBuiltinTextRenderKinds(): Promise<void> {
  if (ensured) return
  const { getRendererRegistry } = await import('../../plugin-runtime/runtimeServices.ts')
  const registry = getRendererRegistry()
  const owner = (await import('../../plugin-runtime/pluginIdentity.ts')).createPluginIdentity('core.renderer.text-kinds', 'builtin')
  const existing = new Set(registry.snapshot().renderKinds.map(entry => entry.value.id))
  const pending = BUILTIN_TEXT_RENDER_KINDS.filter(definition => !existing.has(definition.id))
  if (pending.length > 0) {
    const transaction = registry.beginShadowTransaction(owner, owner.key)
    try {
      for (const definition of pending) transaction.registerRenderKind(definition)
      transaction.validate()
      transaction.commit()
    } catch (error) {
      transaction.rollback()
      throw error
    }
  }
  ensured = true
}
