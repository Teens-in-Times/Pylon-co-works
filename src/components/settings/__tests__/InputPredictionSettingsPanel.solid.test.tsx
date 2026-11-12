// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import InputPredictionSettingsPanel from '../InputPredictionSettingsPanel.solid.tsx'

const mocks = vi.hoisted(() => ({ predict: vi.fn(), persist: vi.fn() }))
vi.mock('../../../infrastructure/prediction/predictionStandalone.ts', () => ({ createStandalonePredictionProvider: () => ({ predict: mocks.predict }) }))
vi.mock('../../../infrastructure/persistence/inputPredictionSettingsRepository.ts', () => ({ persistInputPredictionSettings: mocks.persist }))
vi.mock('../../../domains/inputPrediction/inputPredictionSettingsCache.ts', async () => {
  const { DEFAULT_INPUT_PREDICTION_SETTINGS } = await import('../../../domains/inputPrediction/inputPredictionSettings.ts')
  return { cachedInputPredictionSettings: () => ({ ...DEFAULT_INPUT_PREDICTION_SETTINGS, enabled: true, baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', model: 'fixture-model' }) }
})

beforeEach(() => { mocks.predict.mockReset(); mocks.persist.mockReset() })
afterEach(cleanup)

describe('prediction connection setup', () => {
  it('starts with connection fields and reveals generation settings on demand', () => {
    render(() => <InputPredictionSettingsPanel />)
    expect(screen.getByLabelText('模型')).toBeInTheDocument()
    expect(screen.queryByLabelText('采样温度（Temperature）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /高级生成参数/ }))
    expect(screen.getByLabelText('采样温度（Temperature）')).toBeInTheDocument()
  })

  it('runs one test at a time and discards a response after connection fields change', async () => {
    let complete!: (value: string) => void
    mocks.predict.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    render(() => <InputPredictionSettingsPanel />)
    const button = screen.getByRole('button', { name: '测试连接' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.predict).toHaveBeenCalledOnce()
    const request = mocks.predict.mock.calls[0][0] as { signal: AbortSignal }
    fireEvent.input(screen.getByLabelText('模型'), { target: { value: 'new-model' } })
    expect(request.signal.aborted).toBe(true)
    complete('old response')
    await Promise.resolve()
    expect(screen.queryByText(/old response/)).toBeNull()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
  })

  it('cancels the connection request on unmount', () => {
    mocks.predict.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(() => <InputPredictionSettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    const request = mocks.predict.mock.calls[0][0] as { signal: AbortSignal }
    unmount()
    expect(request.signal.aborted).toBe(true)
  })
})
