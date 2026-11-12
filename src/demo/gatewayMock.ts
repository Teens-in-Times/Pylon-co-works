/** Browser-only Gateway model, consumed by mockTauri. Owns in-memory instance
 * snapshots without IO, platform connections, or retained credential values. */
import type { AdapterCatalogItem, AdapterInstance, GatewayInstanceInput, GatewayInstanceUpdate } from '../infrastructure/tauri/gatewayClient.ts'

const CATALOG: AdapterCatalogItem[] = [
  {
    platform: 'qq', label: 'QQ', availability: 'builtIn',
    credentialFields: [
      { key: 'appId', label: 'App ID', secret: false, required: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
    ],
    capabilities: { deliverText: true, deliverEvent: true, ingest: true, maxMessageLen: 4000 },
  },
  {
    platform: 'wechat', label: '微信', availability: 'notInstalled', credentialFields: [],
    capabilities: { deliverText: false, deliverEvent: false, ingest: false, maxMessageLen: 0 },
  },
]

/** Browser-only, in-memory instance model. Credentials are never stored or returned. */
export function createGatewayMock() {
  const instances = new Map<string, AdapterInstance>()
  const get = (id: string): AdapterInstance => {
    const instance = instances.get(id)
    if (!instance) throw new Error(`网关实例不存在：${id}`)
    return instance
  }
  const start = (id: string): AdapterInstance => {
    const instance = get(id)
    if (!instance.enabled) throw new Error('实例未启用')
    if (instance.credentialStatus !== 'configured') throw new Error('请先配置凭据')
    // Browser preview cannot authenticate with a real message platform.
    instance.status = 'error'
    instance.lastError = '浏览器预览无法连接消息平台；请在桌面应用中启动实例。'
    return { ...instance }
  }
  return {
    catalog: (): AdapterCatalogItem[] => structuredClone(CATALOG),
    instances: (): AdapterInstance[] => Array.from(instances.values(), instance => ({ ...instance })),
    create(input: GatewayInstanceInput): AdapterInstance {
      if (!input || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.id)) throw new Error('实例标识只能使用字母、数字、点、横线与下划线')
      if (instances.has(input.id)) throw new Error(`网关实例已存在：${input.id}`)
      if (!CATALOG.some(item => item.platform === input.platform && item.availability === 'builtIn')) throw new Error('平台不可用')
      const instance: AdapterInstance = {
        id: input.id, platform: input.platform, label: input.label || input.id,
        enabled: input.enabled, autoStart: input.autoStart, status: 'stopped', lastError: null,
        credentialStatus: 'missing', credentialRef: null,
      }
      instances.set(instance.id, instance)
      return { ...instance }
    },
    update(id: string, input: GatewayInstanceUpdate): AdapterInstance {
      const instance = get(id)
      if (typeof input.label === 'string') instance.label = input.label
      if (typeof input.enabled === 'boolean') instance.enabled = input.enabled
      if (typeof input.autoStart === 'boolean') instance.autoStart = input.autoStart
      return { ...instance }
    },
    remove(id: string): void {
      const instance = get(id)
      if (instance.status !== 'stopped') throw new Error('请先停止实例')
      instances.delete(id)
    },
    start,
    restart: start,
    stop(id: string): AdapterInstance {
      const instance = get(id)
      instance.status = 'stopped'
      instance.lastError = null
      return { ...instance }
    },
    setCredentials(id: string, secret: string): AdapterInstance {
      const instance = get(id)
      if (!secret.split(':')[0]?.trim() || !secret.slice(secret.indexOf(':') + 1).trim() || !secret.includes(':')) throw new Error('请填写 App ID 和 Client Secret')
      instance.credentialStatus = 'configured'
      instance.credentialRef = `preview:${id}`
      return { ...instance }
    },
  }
}
