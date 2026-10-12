/** 呈现档案的 cc 标量备料。全局 inputBorderColor 不属于此切片，不附加布局。 */
import type { ZonePresetEntry } from '../zonePresetPool.ts'

export const FACTORY_PROFILE_CC: readonly ZonePresetEntry[] = [
  {
    id: 'builtin.presentation.modern-gui', mode: 'gui', zone: 'cc',
    label: '现代工作台', origin: 'factory', source: { profileId: 'builtin.presentation.modern-gui' },
    values: { inputBg: 'rgba(148,163,184,0.10)', inputFocusBorder: 'rgba(99,102,241,0.74)', inputRadius: 20, cliHintMode: 'hidden' },
  },
  {
    id: 'builtin.presentation.terminal-classic', mode: 'terminal', zone: 'cc',
    label: '终端经典', origin: 'factory', source: { profileId: 'builtin.presentation.terminal-classic' },
    values: { inputBg: 'rgba(0,0,0,0.02)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputRadius: 0, cliHintMode: 'compact' },
  },
  {
    id: 'builtin.presentation.terminal-modern', mode: 'terminal', zone: 'cc',
    label: '现代终端', origin: 'factory', source: { profileId: 'builtin.presentation.terminal-modern' },
    values: { inputBg: 'rgba(59,130,246,0.08)', inputFocusBorder: 'rgba(59,130,246,0.82)', inputRadius: 8, cliHintMode: 'full' },
  },
  {
    id: 'builtin.presentation.paper-low-contrast', mode: 'terminal', zone: 'cc',
    label: '低对比纸张', origin: 'factory', source: { profileId: 'builtin.presentation.paper-low-contrast' },
    values: { inputBg: 'rgba(163,128,72,0.06)', inputFocusBorder: 'rgba(128,102,63,0.52)', inputRadius: 4, cliHintMode: 'compact' },
  },
  {
    id: 'builtin.presentation.console-glass', mode: 'terminal', zone: 'cc',
    label: '玻璃控制台', origin: 'factory', source: { profileId: 'builtin.presentation.console-glass' },
    values: { inputBg: 'rgba(148,163,184,0.12)', inputFocusBorder: 'rgba(99,102,241,0.72)', inputRadius: 16, cliHintMode: 'hidden' },
  },
  {
    id: 'builtin.presentation.agent-command', mode: 'gui', zone: 'cc',
    label: 'Agent 指挥台', origin: 'factory', source: { profileId: 'builtin.presentation.agent-command' },
    values: { inputBg: 'rgba(148,163,184,0.09)', inputFocusBorder: 'rgba(99,102,241,0.72)', inputRadius: 12, cliHintMode: 'hidden' },
  },
  {
    id: 'builtin.presentation.agent-map', mode: 'gui', zone: 'cc',
    label: 'Agent 关系图', origin: 'factory', source: { profileId: 'builtin.presentation.agent-map' },
    values: { inputBg: 'rgba(148,163,184,0.09)', inputFocusBorder: 'rgba(99,102,241,0.72)', inputRadius: 12, cliHintMode: 'hidden' },
  },
  {
    id: 'builtin.presentation.focus-flow', mode: 'gui', zone: 'cc',
    label: '专注流程', origin: 'factory', source: { profileId: 'builtin.presentation.focus-flow' },
    values: { inputBg: 'rgba(148,163,184,0.09)', inputFocusBorder: 'rgba(99,102,241,0.72)', inputRadius: 12, cliHintMode: 'hidden' },
  },
  {
    id: 'builtin.presentation.tactical-blue', mode: 'tactical', zone: 'cc',
    label: '蓝调战术 · 夜航', origin: 'factory', source: { profileId: 'builtin.presentation.tactical-blue' },
    values: { inputBg: 'rgba(8,19,37,0.94)', inputFocusBorder: '#63ddff', inputRadius: 3, cliHintMode: 'hidden' },
  },
]
