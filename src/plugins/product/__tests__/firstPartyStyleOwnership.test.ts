import { describe, expect, it } from 'vitest'
import { FIRST_PARTY_STYLE_OWNERSHIP, listFirstPartyStylesByOwner } from '../firstPartyStyleOwnership.ts'

describe('first-party CSS ownership', () => {
  it('每个资产只有一个 owner 和至少一个唯一 importer', () => {
    const paths = FIRST_PARTY_STYLE_OWNERSHIP.map(item => item.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const item of FIRST_PARTY_STYLE_OWNERSHIP) {
      expect(item.importers.length, item.path).toBeGreaterThan(0)
      expect(new Set(item.importers).size, item.path).toBe(item.importers.length)
      expect(item.importers.every(path => path.startsWith('src/')), item.path).toBe(true)
    }
  })

  it('Kernel 只持有跨 Application 基线', () => {
    expect(listFirstPartyStylesByOwner('kernel').map(item => item.path).sort()).toEqual([
      'src/index.css', 'src/styles/tailwind.css',
    ])
    expect(listFirstPartyStylesByOwner('kernel').every(item => item.lifecycle === 'kernel-static')).toBe(true)
  })

  it('产品样式归插件生命周期，每包至多一个自适应资产', () => {
    const productStyles = FIRST_PARTY_STYLE_OWNERSHIP.filter(item => item.owner.startsWith('builtin.'))
    for (const item of productStyles) {
      expect(['plugin-scope', 'adaptive', 'shared'], item.path).toContain(item.lifecycle)
      expect(item.path, item.owner).toContain(`/packages/${item.owner}/`)
    }
    const adaptiveOwners = productStyles.filter(item => item.lifecycle === 'adaptive').map(item => item.owner)
    expect(new Set(adaptiveOwners).size).toBe(adaptiveOwners.length)
  })
})
