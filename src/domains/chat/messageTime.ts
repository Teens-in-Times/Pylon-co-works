/**
 * 消息时间归一化。真实链路写入的是 `toLocaleTimeString()`（"10:38:05" 或 "10:38:05 PM"），
 * 持久化与夹具里也可能是 ISO 串——分组与展示都要能同时吃这两种格式。
 */

const TIME_OF_DAY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?$/i
/** 只有「时:分」的文本没有日期，用固定基准日承载，只取同日内的相对间隔。 */
const CLOCK_BASE_MS = Date.UTC(2000, 0, 1)

interface ClockText {
  hours: number
  minutes: number
  seconds: number
}

function parseClockText(value: string): ClockText | undefined {
  const match = TIME_OF_DAY.exec(value.trim())
  if (!match) return undefined
  let hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] ?? 0)
  const meridiem = match[4]?.toLowerCase()
  if (meridiem === 'p' && hours < 12) hours += 12
  if (meridiem === 'a' && hours === 12) hours = 0
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined
  return { hours, minutes, seconds }
}

/** `Message.time` → 毫秒时间戳；不可解析返回 undefined。 */
export function parseMessageTime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return parsed
  const clock = parseClockText(value)
  if (!clock) return undefined
  return CLOCK_BASE_MS + ((clock.hours * 60 + clock.minutes) * 60 + clock.seconds) * 1000
}

/** `Message.time` → "HH:MM"（24 小时制）；不可解析返回 undefined，调用方据此隐藏时间。 */
export function formatMessageClock(value: string | undefined): string | undefined {
  if (!value) return undefined
  const clock = parseClockText(value)
  if (clock) {
    return `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}`
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
