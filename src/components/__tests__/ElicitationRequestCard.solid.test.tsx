// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  collectElicitationValues,
  parseElicitationFields,
} from '../elicitationSchema.ts'

/**
 * #316：elicitation form 卡的 schema 解析与值收集纯函数测试（纯函数住
 * elicitationSchema.ts，测试直连原模块；断言集原样保留）。
 *
 * 官方契约：requestedSchema 是受限 JSON Schema（扁平 properties 原语
 * string/number/boolean/enum + default + required）；超出原语子集 → 降级
 * unsupported（不猜测语义、不静默丢字段）。
 */

describe('parseElicitationFields（受限 schema 解析）', () => {
  it('解析 string/number/boolean/enum + default 预填 + required 标记', () => {
    const parsed = parseElicitationFields({
      type: 'object',
      properties: {
        name: { type: 'string', description: '用户名', default: '微栖' },
        age: { type: 'number' },
        subscribe: { type: 'boolean', default: true },
        plan: { type: 'string', enum: ['free', 'pro'] },
      },
      required: ['name'],
    })
    expect(parsed.unsupported).toBe(false)
    expect(parsed.fields.map(field => field.name)).toEqual(['name', 'age', 'subscribe', 'plan'])
    expect(parsed.fields[0]).toMatchObject({ type: 'string', defaultValue: '微栖', required: true })
    expect(parsed.fields[2]).toMatchObject({ type: 'boolean', defaultValue: true })
    expect(parsed.fields[3]).toMatchObject({ type: 'enum', enumValues: ['free', 'pro'], defaultValue: 'free' })
  })

  it('object/array/无 type 属性 → unsupported 降级', () => {
    expect(parseElicitationFields({
      type: 'object',
      properties: { nested: { type: 'object' } },
    }).unsupported).toBe(true)
    expect(parseElicitationFields({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } } },
    }).unsupported).toBe(true)
    expect(parseElicitationFields({
      type: 'object',
      properties: { mystery: { description: '没有 type' } },
    }).unsupported).toBe(true)
    expect(parseElicitationFields('not-an-object').unsupported).toBe(true)
  })
})

describe('collectElicitationValues（必填校验 + 类型收集）', () => {
  const fields = parseElicitationFields({
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      subscribe: { type: 'boolean' },
    },
    required: ['name'],
  }).fields

  it('number 字段转数、boolean 原样、string 透传', () => {
    const values = collectElicitationValues(fields, { name: '栖', age: '42', subscribe: true })
    expect(values).toEqual({ name: '栖', age: 42, subscribe: true })
  })

  it('required 缺失 → null（卡片提示，不猜测语义）', () => {
    expect(collectElicitationValues(fields, { name: '  ', age: '1', subscribe: false })).toBeNull()
  })

  it('number 格式错误 → null', () => {
    expect(collectElicitationValues(fields, { name: 'a', age: 'x.y', subscribe: false })).toBeNull()
  })

  it('可选字段留空 → 不进 values（缺省即省略键）', () => {
    const values = collectElicitationValues(fields, { name: 'a', age: '', subscribe: false })
    expect(values).toEqual({ name: 'a', subscribe: false })
  })
})
