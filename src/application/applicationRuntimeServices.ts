import { createApplicationRuntime } from './applicationRuntime.ts'

export const applicationRuntime = createApplicationRuntime()

/** Forces a real Solid child-tree unmount boundary while preserving application state. */
export async function requestApplicationSoftRemount(): Promise<void> {
  const applicationId = applicationRuntime.getSnapshot().activeApplicationId
  if (!applicationId) throw new Error('Application 未挂载，无法 soft-remount')
  applicationRuntime.unmount()
  await new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
  applicationRuntime.mount(applicationId)
}
