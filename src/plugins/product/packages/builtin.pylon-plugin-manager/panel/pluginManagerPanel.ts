/**
 * P53 D2 embedded plugin-manager panel (framework-free, plain DOM).
 *
 * Dogfood rule: all data and operations flow through the activation context's
 * `management` API — importing host singletons (pluginCompositionRoot etc.) is
 * forbidden. Styling comes from Tailwind utilities (kernel-level layer,
 * `src/styles/tailwind.css`) whose values are mapped onto host visual semantic
 * tokens via `@theme inline`; no copied host opacity/shadow values, and no
 * semantic class names — tests locate rows via data attributes.
 *
 * Pre-consent state: when `management` is absent the panel renders a consent
 * guide instead of throwing. After the user grants via the host authorization
 * card and the plugin retries activation, the panel becomes functional.
 */
import { PYLON_PLUGIN_API_LATEST, type PluginBootstrapOverview, type PluginManagementApi } from '../../../../../sdk/index.ts'

export interface PluginManagerPanelOptions {
  readonly management?: PluginManagementApi
  /** Directory picker provided by the host UI (the panel never imports tauri dialog). */
  readonly pickDirectory?: () => Promise<string | null>
  /** zip / URL install source pickers (P53 D6 three-source install). */
  readonly pickZipFile?: () => Promise<string | null>
  readonly promptUrl?: () => Promise<string | null>
  readonly onNotice?: (message: string) => void
}

const LOG_LIMIT = 12

/** #116 子项 4b：启动状态枚举 → 展示文案（枚举本身由宿主 API 定义，不在此改）。 */
const BOOTSTRAP_STATE_LABELS: Readonly<Record<PluginBootstrapOverview['state'], string>> = {
  idle: '未启动',
  starting: '启动中',
  ready: '就绪',
  degraded: '降级运行',
  'safe-mode': '安全模式',
}

// ── Tailwind utility 常量（J 施工书 20260914）──────────────────────────
// 值全部经 kernel utilities 层的 @theme inline 引用宿主视觉语义 token。
// 红线：同属性 utility 不跨常量组合（utilities 层内同 specificity，胜负
// 取决于生成顺序），每个按钮变体必须自足完整，不做「基串 + 修饰」拼接。
const PANEL = 'flex flex-col gap-4 text-base leading-[1.6] text-content-text'
const OVERVIEW = 'flex flex-wrap gap-4 rounded-sm bg-surface-panel px-3 py-2.5'
const GROUP = 'flex flex-col gap-3 border-t border-border py-4'
const GROUP_TITLE = 'text-base font-semibold text-content-text'
const LIST = 'flex flex-col gap-1.5'
const ROW = 'flex flex-wrap items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-hover-bg'
const ROW_TITLE = 'min-w-0 break-words font-semibold'
const MUTED_MONO = 'min-w-0 break-all font-mono text-sm text-content-muted'
const MUTED_TEXT = 'text-sm text-content-muted'
const CONSENT_TEXT = 'text-content-muted'
const ACTIONS = 'ml-auto flex flex-wrap gap-2'
const BTN_INVARIANT = 'appearance-none cursor-pointer rounded-sm border bg-transparent px-2.5 py-0.75 text-sm enabled:hover:bg-hover-bg disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const BTN = `${BTN_INVARIANT} border-border text-content-text`
const BTN_PRIMARY = `${BTN_INVARIANT} border-accent text-accent`
const BTN_DANGER = `${BTN_INVARIANT} border-border text-danger`
const HINT = MUTED_TEXT
const LOG_LINE = MUTED_MONO
const CONSENT = 'flex flex-col gap-2 rounded-sm border border-dashed border-border bg-surface-panel p-4'
const CONSENT_TITLE = 'text-md'

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className?: string): HTMLButtonElement {
  const node = el('button', className ?? BTN, label) as HTMLButtonElement
  node.type = 'button'
  return node
}

function groupTitle(text: string): HTMLElement {
  const node = el('div', GROUP_TITLE, text)
  node.dataset.pypmGroupTitle = 'true'
  return node
}

function contributionSummaryLine(fact: {
  contributions: Readonly<Record<string, readonly string[]>>
}): string {
  const parts = Object.entries(fact.contributions).map(([surface, ids]) => `${surface} x${ids.length}`)
  return parts.length > 0 ? parts.join(' · ') : '无注册贡献'
}

export interface PluginManagerPanelHandle {
  readonly root: HTMLElement
  refresh(): void
  dispose(): void
}

export function mountPluginManagerPanel(
  container: HTMLElement,
  options: PluginManagerPanelOptions,
): PluginManagerPanelHandle {
  const root = el('div', PANEL)
  let disposed = false
  const log: string[] = []
  let pending = false
  const operationStatus = el('p', MUTED_TEXT)
  operationStatus.setAttribute('role', 'status')
  operationStatus.setAttribute('aria-live', 'polite')
  const beginOperation = (label: string) => {
    if (pending || disposed) return false
    pending = true
    root.setAttribute('aria-busy', 'true')
    operationStatus.textContent = `${label}中…`
    root.querySelectorAll<HTMLButtonElement>('button').forEach(control => { control.disabled = true })
    return true
  }
  const finishOperation = () => {
    pending = false
    root.setAttribute('aria-busy', 'false')
    render()
  }
  const notice = (message: string) => {
    if (disposed) return
    operationStatus.textContent = message
    log.push(`[${new Date().toLocaleTimeString()}] ${message}`)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
    options.onNotice?.(message)
  }

  const runPickerInstall = async (
    label: string,
    operation: () => Promise<string | undefined>,
  ) => {
    if (!beginOperation(label)) return
    try {
      const outcome = await operation()
      if (outcome !== undefined) notice(`${label}成功`)
      else operationStatus.textContent = '已取消安装'
    } catch (error) {
      notice(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
    }
    finishOperation()
  }

  const runOperation = async (label: string, operation: () => Promise<void>) => {
    if (!beginOperation(label)) return
    try {
      await operation()
      notice(`${label}成功`)
    } catch (error) {
      notice(`${label}失败：${error instanceof Error ? error.message : String(error)}`)
    }
    finishOperation()
  }

  // 贡献清单区块可见性必须跨 render 重建存活（re-render 会重跑 renderManager）
  let contributionVisible = false

  const renderConsentGuide = (parent: HTMLElement) => {
    const guide = el('div', CONSENT)
    guide.dataset.pypmConsent = 'true'
    guide.append(
      el('h3', CONSENT_TITLE, '等待能力授权'),
      el('p', CONSENT_TEXT,
        '本插件声明了 plugin.management 能力。请在宿主「设置 → 插件」页的授权卡中批准后，重试激活本插件。'),
    )
    parent.append(guide)
  }

  const render = () => {
    if (disposed || pending) return
    root.replaceChildren(operationStatus)
    root.dataset.pypmPanel = options.management ? 'manager' : 'consent'
    if (!options.management) {
      renderConsentGuide(root)
      return
    }
    renderManager(root)
  }

  const renderManager = (parent: HTMLElement) => {
    const management = options.management!
    const heading = el('header', 'flex flex-col gap-2 pb-3')
    heading.append(el('h2', 'text-[24px] font-semibold text-content-text', '插件管理'), el('p', MUTED_TEXT, '安装扩展、管理启用状态，让工作台适合你的工作方式。'))
    parent.append(heading)

    const overview = el('div', OVERVIEW)
    overview.setAttribute('aria-label', '插件概览')
    parent.append(overview)

    const userPlugins = el('div', GROUP)
    userPlugins.append(groupTitle('用户插件'))
    const userActions = el('div', ACTIONS)
    const installButton = button('安装/更新包…', BTN_PRIMARY)
    installButton.disabled = !options.pickDirectory
    installButton.addEventListener('click', () => { void runInstall(management) })
    const installZipButton = button('从 zip 安装…')
    installZipButton.disabled = !options.pickZipFile
    installZipButton.addEventListener('click', () => {
      void runPickerInstall('从 zip 安装', async () => {
        if (!options.pickZipFile) return undefined
        const zipPath = await options.pickZipFile()
        if (!zipPath) return undefined
        await management.installOrUpdateFromZip(zipPath)
        return 'ok'
      })
    })
    const installUrlButton = button('从 URL 安装…')
    installUrlButton.disabled = !options.promptUrl
    installUrlButton.addEventListener('click', () => {
      void runPickerInstall('从 URL 安装', async () => {
        if (!options.promptUrl) return undefined
        const url = await options.promptUrl()
        if (!url) return undefined
        await management.installOrUpdateFromUrl(url)
        return 'ok'
      })
    })
    const refreshButton = button('刷新')
    const contributionButton = button('贡献清单')
    contributionButton.addEventListener('click', () => {
      contributionVisible = !contributionVisible
      render()
    })
    userActions.append(installButton, installZipButton, installUrlButton, refreshButton, contributionButton)
    userPlugins.append(userActions)
    const userList = el('div', LIST)
    userPlugins.append(userList)
    parent.append(userPlugins)

    const builtins = el('div', GROUP)
    builtins.append(groupTitle('内置组件'))
    const builtinList = el('div', LIST)
    builtins.append(builtinList)
    parent.append(builtins)

    const advanced = document.createElement('details')
    advanced.className = 'border-t border-border py-3'
    const advancedSummary = el('summary', 'cursor-pointer py-2 text-sm font-semibold text-content-muted focus-visible:outline-2 focus-visible:outline-accent', '运行诊断与高级管理')
    advanced.append(advancedSummary)
    parent.append(advanced)
    const bootstrap = el('div', GROUP)
    bootstrap.append(groupTitle('启动故障'))
    const bootstrapList = el('div', LIST)
    bootstrap.append(bootstrapList)
    advanced.append(bootstrap)

    const diagnostics = el('div', GROUP)
    diagnostics.append(groupTitle('契约诊断'))
    const diagnosticsList = el('div', LIST)
    diagnostics.append(diagnosticsList)
    advanced.append(diagnostics)

    const shadow = el('div', GROUP)
    shadow.append(groupTitle('Shadow Update 诊断'))
    const shadowList = el('div', LIST)
    shadow.append(shadowList)
    advanced.append(shadow)

    // P53 D5：运行时监管（进程）+ 存储配额 + 依赖关系图
    const processes = el('div', GROUP)
    processes.append(groupTitle('插件进程'))
    const processList = el('div', LIST)
    processes.append(processList)
    advanced.append(processes)

    const storage = el('div', GROUP)
    storage.append(groupTitle('存储配额'))
    const storageList = el('div', LIST)
    storage.append(storageList)
    advanced.append(storage)

    const dependencies = el('div', GROUP)
    dependencies.append(groupTitle('依赖与冲突'))
    const dependencyList = el('div', LIST)
    dependencies.append(dependencyList)
    advanced.append(dependencies)

    let contributionsGroup: HTMLElement | undefined
    if (contributionVisible) {
      contributionsGroup = el('div', GROUP)
      contributionsGroup.append(groupTitle('贡献清单'))
      const contributionList = el('div', LIST)
      contributionsGroup.append(contributionList)
      parent.append(contributionsGroup)
      try {
        const facts = management.contributionOverview()
        if (facts.length === 0) {
          contributionList.append(el('p', HINT, '当前无注册贡献。'))
        } else {
          for (const fact of facts) {
            const row = el('div', ROW)
            row.setAttribute('data-contribution-plugin', fact.pluginId)
            row.append(
              el('span', ROW_TITLE, fact.pluginId),
              el('span', HINT, contributionSummaryLine(fact)),
            )
            contributionList.append(row)
          }
        }
      } catch (error) {
        contributionList.append(el('p', HINT, `读取失败：${error instanceof Error ? error.message : String(error)}`))
      }
    }
    const logGroup = el('div', GROUP)
    logGroup.append(groupTitle('操作日志'))
    const logList = el('div', LIST)
    if (log.length === 0) logList.append(el('p', HINT, '暂无操作日志。'))
    for (const line of log) logList.append(el('p', LOG_LINE, line))
    logGroup.append(logList)
    parent.append(logGroup)

    const loadAll = async () => {
      if (disposed) return
      try {
        const installed = await management.listInstalled()
        if (disposed || !parent.contains(userList)) return
        const runtime = management.runtimeOverview()
        const bootstrapState = management.bootstrapOverview()
        const contract = management.contractDiagnostics()

        if (operationStatus.textContent?.startsWith('读取插件状态失败')) operationStatus.textContent = '插件状态已刷新'
        overview.replaceChildren(
          el('span', undefined, `Plugin API ${PYLON_PLUGIN_API_LATEST}`),
          el('span', undefined, `${runtime.activePluginIds.length} 个运行中`),
          el('span', undefined, `${installed.length} 个用户插件`),
        )

        userList.replaceChildren()
        if (installed.length === 0) {
          userList.append(el('p', HINT, '尚无用户插件。'))
        }
        for (const item of installed) {
          const pluginId = item.package.pluginId
          const manifestName = typeof item.package.manifest?.name === 'string'
            ? item.package.manifest.name
            : pluginId
          const row = el('div', ROW)
          row.setAttribute('data-plugin-id', pluginId)
          const toggle = button(item.enabled ? '停用' : '启用')
          toggle.addEventListener('click', () => {
            void runOperation(`停用/启用 ${pluginId}`, () => management.setEnabled(pluginId, !item.enabled))
          })
          const reload = button('重载')
          reload.addEventListener('click', () => {
            void runOperation(`重载 ${pluginId}`, () => management.reload(pluginId))
          })
          const uninstall = button('卸载', BTN_DANGER)
          uninstall.addEventListener('click', () => {
            void runOperation(`卸载 ${pluginId}`, () => management.uninstall(pluginId))
          })
          const actions = el('div', ACTIONS)
          actions.append(toggle, reload, uninstall)
          row.append(
            el('span', ROW_TITLE, manifestName),
            el('span', MUTED_MONO, pluginId),
            el('span', MUTED_TEXT, item.enabled ? '已启用' : '已停用'),
            actions,
          )
          userList.append(row)
        }

        builtinList.replaceChildren()
        // review P1-2：只渲染 builtin 实例（activePluginIds 含用户包，不可直接遍历）
        const builtinActive = runtime.instances.filter(instance => instance.builtin)
        if (builtinActive.length === 0) {
          builtinList.append(el('p', HINT, '当前没有激活的内置组件。'))
        }
        for (const instance of builtinActive) {
          const row = el('div', ROW)
          row.setAttribute('data-builtin-id', instance.pluginId)
          const isActive = instance.status === 'active'
          const toggle = button(isActive ? '停用' : '启用')
          toggle.addEventListener('click', () => {
            void runOperation(
              `${isActive ? '停用' : '启用'} ${instance.pluginId}`,
              () => management.setBuiltinEnabled(instance.pluginId, !isActive),
            )
          })
          row.append(
            el('span', ROW_TITLE, instance.pluginId),
            el('span', MUTED_TEXT, instance.status === 'active' ? '运行中' : instance.status),
            toggle,
          )
          builtinList.append(row)
        }

        bootstrapList.replaceChildren()
        if (bootstrapState.failures.length === 0) {
          // #116 子项 4b：句子已是中文，句尾不能塞内部状态枚举（原为裸插值 state）。
          bootstrapList.append(el('p', HINT, `启动状态：${BOOTSTRAP_STATE_LABELS[bootstrapState.state]}。`))
        }
        for (const failure of bootstrapState.failures) {
          const row = el('div', ROW)
          row.append(
            el('span', MUTED_MONO, failure.pluginId),
            el('span', HINT, `${failure.stage} · ${failure.message}`),
          )
          if (failure.retryable) {
            const retry = button(`重试 ${failure.pluginId}`)
            retry.addEventListener('click', () => {
              void runOperation(`重试 ${failure.pluginId}`, () => management.setBuiltinEnabled(failure.pluginId, true))
            })
            row.append(retry)
          }
          bootstrapList.append(row)
        }
        const safeMode = button('进入安全模式', BTN_DANGER)
        safeMode.addEventListener('click', () => {
          void runOperation('进入安全模式', () => management.enterSafeMode())
        })
        bootstrapList.append(safeMode)

        diagnosticsList.replaceChildren()
        if (contract.diagnostics.length === 0) {
          diagnosticsList.append(el('p', HINT, '当前无契约诊断。'))
        }
        for (const diagnostic of contract.diagnostics) {
          const row = el('div', ROW)
          row.append(
            el('span', MUTED_MONO, diagnostic.pluginId),
            el('span', HINT, `${diagnostic.code} · ${diagnostic.message}`),
          )
          diagnosticsList.append(row)
        }

        shadowList.replaceChildren()
        for (const item of runtime.switches) {
          const row = el('div', ROW)
          row.setAttribute('data-switch-plugin', item.pluginId)
          row.append(
            el('span', MUTED_MONO, item.pluginId),
            el('span', HINT, `声明 ${item.declaredMode} · 实际采用 ${item.adoptedMode}`),
          )
          shadowList.append(row)
        }
        const cleanupFailures = runtime.instances.filter(instance => instance.status === 'cleanup-failed')
        if (runtime.switches.length === 0 && cleanupFailures.length === 0) {
          shadowList.append(el('p', HINT, '本次运行尚无 Shadow Update 诊断。'))
        } else if (cleanupFailures.length > 0) {
          for (const instance of cleanupFailures) {
            const row = el('div', ROW)
            row.setAttribute('data-cleanup-failed', instance.pluginId)
            const retry = button('重试清理')
            retry.addEventListener('click', () => {
              void runOperation(`重试清理 ${instance.pluginId}`, async () => {
                const outcome = await management.retryCleanup(instance.runtimeInstanceId)
                if (!outcome.complete) throw new Error(outcome.message ?? '清理未完成')
              })
            })
            row.append(
              el('span', MUTED_MONO, instance.pluginId),
              el('span', MUTED_TEXT, '清理失败'),
              retry,
            )
            shadowList.append(row)
          }
        }

        processList.replaceChildren()
        try {
          const processes = await management.processOverview()
          if (processes.length === 0) {
            processList.append(el('p', HINT, '当前没有插件附带进程。'))
          }
          for (const process of processes) {
            const row = el('div', ROW)
            row.setAttribute('data-process-id', process.processId)
            const terminate = button('终止/重启')
            terminate.addEventListener('click', () => {
              void runOperation(`终止进程 ${process.pluginId}`, () => management.terminatePluginProcess(process.processId))
            })
            row.append(
              el('span', MUTED_MONO, process.pluginId),
              el('span', MUTED_TEXT, `${process.status}（重启 ${process.restartAttempts} 次）`),
              terminate,
            )
            processList.append(row)
          }
        } catch (error) {
          processList.append(el('p', HINT, `进程读取失败：${error instanceof Error ? error.message : String(error)}`))
        }

        storageList.replaceChildren()
        const usage = management.storageUsage()
        if (usage.length === 0) {
          storageList.append(el('p', HINT, '当前没有插件持久数据。'))
        }
        for (const entry of usage) {
          const row = el('div', ROW)
          row.setAttribute('data-storage-plugin', entry.pluginId)
          const clear = button('清空')
          clear.addEventListener('click', () => {
            void runOperation(`清空存储 ${entry.pluginId}`, async () => {
              management.clearPluginStorage(entry.pluginId)
            })
          })
          row.append(
            el('span', MUTED_MONO, entry.pluginId),
            el('span', MUTED_TEXT, `${entry.usedBytes}/${entry.budgetBytes} 字节 · ${entry.keyCount} 键`),
            clear,
          )
          storageList.append(row)
        }

        dependencyList.replaceChildren()
        try {
          const graph = await management.dependencyGraph()
          if (graph.length === 0) {
            dependencyList.append(el('p', HINT, '当前无依赖声明。'))
          }
          for (const node of graph) {
            const row = el('div', ROW)
            row.setAttribute('data-dependency-node', node.pluginId)
            const relations = [
              ...(node.dependencies.length > 0 ? [`依赖 ${node.dependencies.join(', ')}`] : []),
              ...(node.optionalDependencies.length > 0 ? [`可选 ${node.optionalDependencies.join(', ')}`] : []),
              ...(node.conflicts.length > 0 ? [`冲突 ${node.conflicts.join(', ')}`] : []),
            ]
            row.append(
              el('span', ROW_TITLE, node.pluginId),
              el('span', MUTED_TEXT, node.builtin ? '内置' : '外置'),
              el('span', HINT, relations.length > 0 ? relations.join(' · ') : '无依赖'),
            )
            dependencyList.append(row)
          }
        } catch (error) {
          dependencyList.append(el('p', HINT, `依赖图读取失败：${error instanceof Error ? error.message : String(error)}`))
        }
      } catch (error) {
        // Keep the existing page and expose a retryable failure without recursively loading.
        notice(`读取插件状态失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    refreshButton.addEventListener('click', () => { void loadAll() })

    const runInstall = async (api: PluginManagementApi) => {
      if (!options.pickDirectory) return
      await runPickerInstall('安装/更新', async () => {
        const sourcePath = await options.pickDirectory!()
        if (!sourcePath) return undefined
        await api.installOrUpdate(sourcePath)
        return sourcePath
      })
    }

    void loadAll()
  }

  container.append(root)
  render()

  return {
    root,
    refresh: render,
    dispose() {
      disposed = true
      root.remove()
    },
  }
}
