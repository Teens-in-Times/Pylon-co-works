/** 呈现档案的 chat 标量备料。独立手工真值，尚不进入生产候选。 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_PROFILE_CHAT: readonly ZonePresetEntry[] = [
  {
    id: 'builtin.presentation.modern-gui', mode: 'gui', zone: 'chat', axis: 'style',
    label: '现代工作台', origin: 'factory', source: { profileId: 'builtin.presentation.modern-gui' },
    values: {
      msgStyle: 'bubble', messageLayout: 'bubble', chatFont: 'system', msgFont: 'system',
      msgLineHeight: 1.65, messageUserBg: 'rgba(59,130,246,0.14)', messageAssistantBg: 'rgba(148,163,184,0.10)',
      messageReasoningBg: 'rgba(99,102,241,0.07)', messageBorderColor: 'rgba(99,102,241,0.20)', messageRadius: 16,
      assistantDot: true, assistantDotGlyph: '◆', toolIndicator: '◆', toolIndicatorGlow: 3,
      toolConnectorMode: 'none', spinnerFramePreset: 'orbit', spinnerVerbSet: 'analysis',
    },
  },
  {
    id: 'builtin.presentation.terminal-classic', mode: 'terminal', zone: 'chat', axis: 'style',
    label: '终端经典', origin: 'factory', source: { profileId: 'builtin.presentation.terminal-classic' },
    values: {
      msgStyle: 'terminal', messageLayout: 'classic', chatFont: 'mono', msgFont: 'system',
      msgLineHeight: 1.55, assistantDot: false, toolIndicator: '●', toolIndicatorRun: 'circle',
      toolIndicatorOk: 'circle', toolIndicatorErr: 'circle', toolIndicatorGlow: 0,
      toolConnectorMode: 'none', spinnerFramePreset: 'ascii-line', spinnerVerbSet: 'engineering',
    },
  },
  {
    id: 'builtin.presentation.terminal-modern', mode: 'terminal', zone: 'chat', axis: 'style',
    label: '现代终端', origin: 'factory', source: { profileId: 'builtin.presentation.terminal-modern' },
    values: {
      msgStyle: 'bubble', messageLayout: 'classic', chatFont: 'mono', msgFont: 'mono',
      msgLineHeight: 1.65, messageUserBg: 'rgba(59,130,246,0.14)', messageAssistantBg: 'rgba(127,127,127,0.08)',
      messageReasoningBg: 'rgba(59,130,246,0.05)', messageBorderColor: 'rgba(59,130,246,0.28)', messageRadius: 8,
      assistantDot: true, assistantDotGlyph: '◆', toolIndicator: '◆', toolIndicatorGlow: 5,
      toolConnectorMode: 'follow', toolConnectorStyle: 'pulse', toolConnectorWidth: 2,
      spinnerFramePreset: 'scan', spinnerVerbSet: 'analysis',
    },
  },
  {
    id: 'builtin.presentation.paper-low-contrast', mode: 'terminal', zone: 'chat', axis: 'style',
    label: '低对比纸张', origin: 'factory', source: { profileId: 'builtin.presentation.paper-low-contrast' },
    values: {
      msgStyle: 'bubble', messageLayout: 'claude', chatFont: 'serif', msgFont: 'serif',
      msgLineHeight: 1.7, messageUserBg: 'rgba(163,128,72,0.12)', messageAssistantBg: 'rgba(163,128,72,0.05)',
      messageReasoningBg: 'rgba(163,128,72,0.035)', messageBorderColor: 'rgba(128,102,63,0.22)', messageRadius: 4,
      assistantDot: true, assistantDotGlyph: '●', toolIndicator: '▶', toolIndicatorGlow: 2,
      toolConnectorMode: 'follow', toolConnectorStyle: 'solid', spinnerFramePreset: 'braille', spinnerVerbSet: 'zh',
    },
  },
  {
    id: 'builtin.presentation.console-glass', mode: 'terminal', zone: 'chat', axis: 'style',
    label: '玻璃控制台', origin: 'factory', source: { profileId: 'builtin.presentation.console-glass' },
    values: {
      msgStyle: 'bubble', messageLayout: 'bubble', chatFont: 'system', msgFont: 'system',
      msgLineHeight: 1.75, messageUserBg: 'rgba(99,102,241,0.16)', messageAssistantBg: 'rgba(148,163,184,0.12)',
      messageReasoningBg: 'rgba(99,102,241,0.07)', messageBorderColor: 'rgba(148,163,184,0.28)', messageRadius: 18,
      assistantDot: true, assistantDotGlyph: '✦', toolIndicator: '✦', toolIndicatorGlow: 3,
      toolConnectorMode: 'follow', toolConnectorStyle: 'solid', spinnerFramePreset: 'orbit', spinnerVerbSet: 'zh',
    },
  },
  {
    id: 'builtin.presentation.agent-command', mode: 'gui', zone: 'chat', axis: 'style',
    label: 'Agent 指挥台', origin: 'factory', source: { profileId: 'builtin.presentation.agent-command' },
    values: {
      msgStyle: 'bubble', messageLayout: 'bubble', chatFont: 'system', msgFont: 'system', msgLineHeight: 1.62,
      messageUserBg: 'rgba(59,130,246,0.12)', messageAssistantBg: 'rgba(148,163,184,0.08)',
      messageReasoningBg: 'rgba(99,102,241,0.06)', messageBorderColor: 'rgba(99,102,241,0.20)', messageRadius: 12,
      assistantDot: true, toolConnectorMode: 'follow', toolConnectorStyle: 'solid',
      assistantDotGlyph: '◆', toolIndicator: '◆', toolIndicatorGlow: 3,
      spinnerFramePreset: 'scan', spinnerVerbSet: 'engineering',
    },
  },
  {
    id: 'builtin.presentation.agent-map', mode: 'gui', zone: 'chat', axis: 'style',
    label: 'Agent 关系图', origin: 'factory', source: { profileId: 'builtin.presentation.agent-map' },
    values: {
      msgStyle: 'bubble', messageLayout: 'bubble', chatFont: 'system', msgFont: 'system', msgLineHeight: 1.62,
      messageUserBg: 'rgba(59,130,246,0.12)', messageAssistantBg: 'rgba(148,163,184,0.08)',
      messageReasoningBg: 'rgba(99,102,241,0.06)', messageBorderColor: 'rgba(99,102,241,0.20)', messageRadius: 12,
      assistantDot: true, toolConnectorMode: 'follow', toolConnectorStyle: 'solid',
      assistantDotGlyph: '✦', toolIndicator: '✦', toolIndicatorGlow: 2,
      spinnerFramePreset: 'orbit', spinnerVerbSet: 'analysis',
    },
  },
  {
    id: 'builtin.presentation.focus-flow', mode: 'gui', zone: 'chat', axis: 'style',
    label: '专注流程', origin: 'factory', source: { profileId: 'builtin.presentation.focus-flow' },
    values: {
      msgStyle: 'bubble', messageLayout: 'claude', chatFont: 'system', msgFont: 'system', msgLineHeight: 1.62,
      messageUserBg: 'rgba(59,130,246,0.12)', messageAssistantBg: 'rgba(148,163,184,0.08)',
      messageReasoningBg: 'rgba(99,102,241,0.06)', messageBorderColor: 'rgba(99,102,241,0.20)', messageRadius: 6,
      assistantDot: true, toolConnectorMode: 'follow', toolConnectorStyle: 'solid',
      assistantDotGlyph: '●', toolIndicator: '▶', toolIndicatorGlow: 0,
      spinnerFramePreset: 'braille', spinnerVerbSet: 'zh',
    },
  },
  {
    id: 'builtin.presentation.tactical-blue', mode: 'tactical', zone: 'chat', axis: 'style',
    label: '蓝调战术 · 夜航', origin: 'factory', source: { profileId: 'builtin.presentation.tactical-blue' },
    values: {
      msgStyle: 'bubble', messageLayout: 'bubble', chatFont: 'system', msgFont: 'system', msgLineHeight: 1.65,
      messageUserBg: 'rgba(32,112,255,0.15)', messageAssistantBg: 'rgba(12,23,42,0.8)',
      messageReasoningBg: 'rgba(73,212,245,0.06)', messageBorderColor: 'rgba(130,185,235,0.25)', messageRadius: 3,
      assistantDot: true, toolConnectorMode: 'follow', toolConnectorStyle: 'solid',
      assistantDotGlyph: '◆', toolIndicator: '◆', toolIndicatorGlow: 0,
      spinnerFramePreset: 'ascii-line', spinnerVerbSet: 'engineering',
    },
  },
]
