/** @jsxImportSource solid-js */
import { createSignal, Show, type JSX } from 'solid-js'

import { IS_TAURI } from '../../infrastructure/tauri/env'
import { buildExportPayloadAsync, configFileName, preflightImportPayload } from '../../application/configExportImport'
import { loadRetentionPolicyPayload } from '../../infrastructure/persistence/retentionPolicyRepository'
import { syncImportedRetentionPolicy } from '../../infrastructure/persistence/retentionPolicyRepository'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { reportRuntimeError } from '../../app/runtimeError'
import { selectUserDataRepository } from '../../infrastructure/persistence/userDataRepository'
import { importConfigurationTransaction } from '../../application/transactions/importConfigurationTransaction'


/** #515：ConfigBackupPanel 的 Solid 实体（原 .tsx 为 React 薄桥）。 */
export default function ConfigBackupPanel() {
  const [msg, setMsg] = createSignal<string | null>(null)
  let fileRef: HTMLInputElement | null = null
  const isTauri = IS_TAURI
  const doExport = async () => {
    try {
      // I14-W8：Tauri 模式导出聚合后端 versioned user store（profiles/sessions envelope
      // 权威源）；browser 模式无后端 → 与原 buildExportPayload 等价
      // I13-W6：保留策略后端权威 payload 聚合（Tauri；browser 走 localStorage key）
      const repo = isTauri ? selectUserDataRepository() : null
      const json = await buildExportPayloadAsync(localStorage, repo ? {
        loadProfiles: async () => (await repo.load('profiles'))?.payload ?? null,
        loadSessions: async () => (await repo.load('sessions'))?.payload ?? null,
        loadRetention: async () => {
          const payload = await loadRetentionPolicyPayload()
          return payload ? { payload } : null
        },
      } : undefined)
      const fileName = configFileName()
      if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({ defaultPath: fileName, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (path) {
          const { writeTextFile } = await import('@tauri-apps/plugin-fs')
          await writeTextFile(path, json)
          setMsg('已导出配置')
        }
      } else {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = fileName; a.click()
        URL.revokeObjectURL(url)
        setMsg('已导出配置')
      }
    } catch (cause) { setMsg(`导出失败：${String(cause)}`) }
  }
  const doImport = async (file?: File) => {
    try {
      let json: string | null = null
      if (file) {
        json = await file.text()
      } else if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ multiple: false, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (!selected) return
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        json = await readTextFile(selected as string)
      }
      if (json === null) return
      const result = await importConfigurationTransaction(json, {
        storage: localStorage,
        preflight: preflightImportPayload,
        rehydrate: () => {
          // I14-W6 CR-01：导入后强制本地读回（读取刚写入的 localStorage）+ 写穿后端，
          // 避免 Tauri 模式后端权威读回覆盖导入值（导入静默失效）
          useIdentityStore.getState().hydrateFromLocal()
          useWorkspaceStore.getState().hydrateWorkspaceSheets()
        },
        reportError: (action, error) => reportRuntimeError(action, error),
      })
      // I13-W6 CR-001：仅当导入 payload 确含保留策略 key 时写穿后端权威（防本地残留盲写覆盖）
      if (result.ok) {
        syncImportedRetentionPolicy(localStorage, result.value).catch(error => {
          reportRuntimeError('导入保留策略', error)
        })
      }
      setMsg(result.ok
        ? `已导入 ${result.value.length} 项配置`
        : `导入失败：${result.message}`)
    } catch (cause) { setMsg(`导入失败：${String(cause)}`) }
  }
  return (
    <Group title="配置备份">
      <div class="set-preset-row">
        <button type="button" class="ps-btn sm" onClick={doExport}>导出配置</button>
        <button type="button" class="ps-btn sm" onClick={() => fileRef?.click()}>导入配置</button>
        <input ref={el => { fileRef = el }} type="file" accept="application/json,.json" style={{ display: 'none' }}
          onChange={e => { const file = e.currentTarget.files?.[0]; if (file) void doImport(file); e.currentTarget.value = '' }} />
      </div>
      <Show when={msg()}><div class="set-hint">{msg()}</div></Show>
    </Group>
  )
}

function Group(props: { title: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true)
  return (
    <div class="set-group">
      <button type="button" class="set-group-title" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="set-group-arrow">{open() ? '▾' : '▸'}</span>
        {props.title}
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  )
}
