import { describe, expect, it } from 'vitest'
import { createGatewayMock } from '../gatewayMock.ts'

const INPUT = { id: 'qq-work', platform: 'qq', label: '工作助手', enabled: true, autoStart: false }

describe('browser Gateway instance model', () => {
  it('returns supported platform fields while preserving unavailable platforms', () => {
    const mock = createGatewayMock()
    expect(mock.catalog().find(item => item.platform === 'qq')?.credentialFields).toHaveLength(2)
    expect(mock.catalog().find(item => item.platform === 'wechat')?.availability).toBe('notInstalled')
    expect(() => mock.create({ ...INPUT, platform: 'wechat' })).toThrow('平台不可用')
    expect(mock.instances()).toEqual([])
  })

  it('supports create, read, update and remove with independent snapshots', () => {
    const mock = createGatewayMock()
    const created = mock.create(INPUT)
    expect(mock.instances()).toEqual([created])
    created.label = 'changed by caller'
    expect(mock.instances()[0]?.label).toBe('工作助手')
    expect(() => mock.create(INPUT)).toThrow('已存在')
    mock.update(INPUT.id, { label: '新名称', autoStart: true })
    expect(mock.instances()[0]).toMatchObject({ label: '新名称', autoStart: true })
    mock.remove(INPUT.id)
    expect(mock.instances()).toEqual([])
    expect(() => mock.stop(INPUT.id)).toThrow('不存在')
  })

  it('stores credential status only and explains unavailable browser connections', () => {
    const mock = createGatewayMock()
    mock.create(INPUT)
    expect(() => mock.start(INPUT.id)).toThrow('先配置凭据')
    mock.setCredentials(INPUT.id, 'app:private-credential')
    expect(mock.instances()[0]?.credentialStatus).toBe('configured')
    expect(JSON.stringify(mock.instances())).not.toContain('private-credential')
    expect(mock.start(INPUT.id)).toMatchObject({ status: 'error', lastError: expect.stringContaining('浏览器预览') })
    expect(() => mock.remove(INPUT.id)).toThrow('先停止')
    expect(mock.stop(INPUT.id).status).toBe('stopped')
    expect(mock.restart(INPUT.id).status).toBe('error')
  })
})
