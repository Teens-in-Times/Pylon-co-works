import { describe, expect, it } from 'vitest'
import { formatMessageClock, parseMessageTime } from '../messageTime.ts'

describe('parseMessageTime', () => {
  it('解析 ISO 串', () => {
    expect(parseMessageTime('2026-10-30T00:00:05.000Z')).toBe(Date.UTC(2026, 9, 30, 0, 0, 5))
  })

  it('解析真实链路的 toLocaleTimeString 形态（含/不含秒与 AM/PM）', () => {
    const a = parseMessageTime('10:00:00')!
    const b = parseMessageTime('10:05:00')!
    expect(b - a).toBe(5 * 60 * 1000)
    expect(parseMessageTime('10:00')!).toBe(a)
    expect(parseMessageTime('10:00:00 PM')).toBe(Date.UTC(2000, 0, 1, 22, 0, 0))
    expect(parseMessageTime('12:00:00 AM')).toBe(Date.UTC(2000, 0, 1, 0, 0, 0))
    expect(parseMessageTime('12:00:00 PM')).toBe(Date.UTC(2000, 0, 1, 12, 0, 0))
  })

  it('不可解析返回 undefined', () => {
    expect(parseMessageTime('t')).toBeUndefined()
    expect(parseMessageTime('')).toBeUndefined()
    expect(parseMessageTime(undefined)).toBeUndefined()
    expect(parseMessageTime('25:00:00')).toBeUndefined()
  })
})

describe('formatMessageClock', () => {
  it('时钟文本归一为 24 小时 HH:MM', () => {
    expect(formatMessageClock('9:05:59')).toBe('09:05')
    expect(formatMessageClock('09:05')).toBe('09:05')
    expect(formatMessageClock('11:30:00 PM')).toBe('23:30')
    expect(formatMessageClock('12:30:00 AM')).toBe('00:30')
  })

  it('不可解析返回 undefined', () => {
    expect(formatMessageClock('t')).toBeUndefined()
    expect(formatMessageClock(undefined)).toBeUndefined()
  })
})
