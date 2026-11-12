/** Keyboard navigation shared by sheet tab strips; owns no state or subscriptions. */
export function navigateTabStrip(event: KeyboardEvent): void {
  const tab = event.target as HTMLElement | null
  if (tab?.getAttribute('role') !== 'tab') return
  const tabs = Array.from(tab.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
  const index = tabs.indexOf(tab)
  if (index < 0) return
  const target = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1
  if (target < 0) return
  event.preventDefault()
  tabs[target].focus()
  tabs[target].click()
}
