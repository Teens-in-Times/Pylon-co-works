/** @jsxImportSource solid-js */
import { createMemo, createSignal, Show, type JSX } from 'solid-js'

import { DEFAULT_INPUT_PREDICTION_SETTINGS, type InputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettings.ts'
import { cachedInputPredictionSettings } from '../../domains/inputPrediction/inputPredictionSettingsCache.ts'
import { persistInputPredictionSettings } from '../../infrastructure/persistence/inputPredictionSettingsRepository.ts'
import { createStandalonePredictionProvider } from '../../infrastructure/prediction/predictionStandalone.ts'


function Field(props: { label: string; children: JSX.Element; hint?: string }) {
  return <label class="sess-field"><span>{props.label}</span>{props.children}<Show when={props.hint}><small>{props.hint}</small></Show></label>
}

/** #515：InputPredictionSettingsPanel 的 Solid 实体（原 .tsx 为 React 薄桥）。 */
export default function InputPredictionSettingsPanel() {
  const [settings, setSettings] = createSignal<InputPredictionSettings>(cachedInputPredictionSettings())
  const [status, setStatus] = createSignal('')
  const update = <K extends keyof InputPredictionSettings>(key: K, value: InputPredictionSettings[K]) => {
    setSettings(previous => {
      const next = { ...previous, [key]: value }
      persistInputPredictionSettings(next)
      return next
    })
    setStatus('已保存')
  }
  const reset = () => { persistInputPredictionSettings(DEFAULT_INPUT_PREDICTION_SETTINGS); setSettings({ ...DEFAULT_INPUT_PREDICTION_SETTINGS }); setStatus('已恢复默认') }
  const test = async () => {
    setStatus('测试中…')
    try {
      const value = await createStandalonePredictionProvider().predict({ sessionId: 'settings-test', draft: '', history: [], messages: [], signal: new AbortController().signal })
      setStatus(value ? `连接成功：${value}` : '未返回预测（请检查地址、密钥和模型）')
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
  }
  const configured = createMemo(() => Boolean(settings().enabled && settings().baseUrl && settings().apiKey && settings().model))
  return <div class="input-prediction-settings settings-surface">
    <div class="agent-settings-heading"><div><h3>输入预测服务</h3><p>独立于 ACP Agent 的 OpenAI 兼容 Chat Completions 服务。配置后，输入栏会按低频策略请求下一句预测。</p></div></div>
    <div class="set-hint">密钥仅用于请求该服务，保存在本机设置中；不开启或配置不完整时不会发起网络请求。</div>
    <div class="set-hint">Agent 自带预测（如 Peri）优先于本服务：它在场时不会发起这里的网络请求，预测直接显示在输入框（Tab 接受、退格或改输入即拒绝）。</div>
    <section class="set-group"><div class="set-group-title">连接</div>
      <Field label="预测来源"><select class="set-select" value={settings().mode} onChange={event => update('mode', event.currentTarget.value as InputPredictionSettings['mode'])}><option value="auto">自动（优先 Agent 原生，其次 ACP Fork）</option><option value="fork">仅 ACP Fork（不请求独立模型）</option><option value="standalone">仅独立模型（忽略 Agent 原生）</option><option value="off">关闭预测</option></select></Field>
      <Field label="启用独立服务"><input type="checkbox" checked={settings().enabled} onChange={event => update('enabled', event.currentTarget.checked)} /></Field>
      <Field label="基础地址（Base URL）" hint="例如 https://api.openai.com/v1 或本地 sidecar 地址"><input class="set-input set-input-wide" value={settings().baseUrl} onInput={event => update('baseUrl', event.currentTarget.value)} placeholder="https://api.openai.com/v1" /></Field>
      <Field label="密钥（API Key）"><input class="set-input set-input-wide" type="password" value={settings().apiKey} onInput={event => update('apiKey', event.currentTarget.value)} placeholder="sk-…" autocomplete="off" /></Field>
      <Field label="模型"><input class="set-input set-input-wide" value={settings().model} onInput={event => update('model', event.currentTarget.value)} placeholder="gpt-4o-mini" /></Field>
      <Field label="端点路径（Endpoint）" hint="兼容大多数 OpenAI API 网关"><input class="set-input set-input-wide" value={settings().endpointPath} onInput={event => update('endpointPath', event.currentTarget.value)} /></Field>
    </section>
    <section class="set-group"><div class="set-group-title">生成参数</div>
      <Field label="推理等级"><select class="set-select" value={settings().reasoningEffort} onChange={event => update('reasoningEffort', event.currentTarget.value as InputPredictionSettings['reasoningEffort'])}><option value="none">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option></select></Field>
      <Field label="采样温度（Temperature）"><input class="set-num" type="number" min="0" max="2" step="0.05" value={settings().temperature} onInput={event => update('temperature', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="核采样（Top P）"><input class="set-num" type="number" min="0" max="1" step="0.05" value={settings().topP} onInput={event => update('topP', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="最大输出 Token"><input class="set-num" type="number" min="1" max="4096" step="1" value={settings().maxTokens} onInput={event => update('maxTokens', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="频率惩罚"><input class="set-num" type="number" min="-2" max="2" step="0.1" value={settings().frequencyPenalty} onInput={event => update('frequencyPenalty', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="存在惩罚"><input class="set-num" type="number" min="-2" max="2" step="0.1" value={settings().presencePenalty} onInput={event => update('presencePenalty', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="随机种子（Seed）" hint="留空表示由服务端随机"><input class="set-num" type="number" value={settings().seed ?? ''} onInput={event => update('seed', event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber)} /></Field>
      <Field label="停止序列" hint="多个值用逗号分隔"><input class="set-input set-input-wide" value={settings().stop} onInput={event => update('stop', event.currentTarget.value)} placeholder="\n, END" /></Field>
    </section>
    <section class="set-group"><div class="set-group-title">上下文与请求</div>
      <Field label="发送历史消息"><input type="checkbox" checked={settings().includeHistory} onChange={event => update('includeHistory', event.currentTarget.checked)} /></Field>
      <Field label="历史条数"><input class="set-num" type="number" min="1" max="100" value={settings().maxHistoryItems} onInput={event => update('maxHistoryItems', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="历史字符上限"><input class="set-num" type="number" min="100" max="20000" step="100" value={settings().maxHistoryChars} onInput={event => update('maxHistoryChars', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="超时（毫秒）"><input class="set-num" type="number" min="1000" max="60000" step="500" value={settings().timeoutMs} onInput={event => update('timeoutMs', event.currentTarget.valueAsNumber)} /></Field>
      <Field label="系统提示词"><textarea class="set-textarea" rows={3} value={settings().systemPrompt} onInput={event => update('systemPrompt', event.currentTarget.value)} /></Field>
      <Field label="自定义请求头" hint="JSON 对象，例如 {&quot;X-Api-Key&quot;:&quot;…&quot;}"><textarea class="set-textarea" rows={2} value={settings().headersJson} onInput={event => update('headersJson', event.currentTarget.value)} /></Field>
    </section>
    <div class="cwd-settings-footer"><span class="set-hint" role="status">{status() || (configured() ? '配置完整' : '尚未配置完整')}</span><div class="sess-field-actions"><button type="button" class="settings-action" onClick={reset}>恢复默认</button><button type="button" class="settings-action primary" disabled={!configured()} onClick={() => void test()}>测试连接</button></div></div>
  </div>
}
