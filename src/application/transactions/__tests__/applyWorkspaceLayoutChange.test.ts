import { describe, expect, it, vi } from 'vitest'
import { applyWorkspaceLayoutChange, type WorkspaceLayoutPorts } from '../applyWorkspaceLayoutChange.ts'

function ports(): WorkspaceLayoutPorts {
  const railState = {
    width: 320, leftRailWidth: 250, leftRailCollapsed: false, collapsed: false,
    setWidth: vi.fn(), setLeftRailWidth: vi.fn(), setLeftRailCollapsed: vi.fn(), setCollapsed: vi.fn(),
  }
  return { rightRail: { getState: () => railState } }
}

describe('applyWorkspaceLayoutChange', () => {
  it('routes all layout semantics to the single rail truth', () => {
    const p = ports()
    expect(applyWorkspaceLayoutChange({ sidebarWidth: 300, rightPanelCollapsed: true }, p)).toEqual({ ok: true })
    expect(p.rightRail.getState().setLeftRailWidth).toHaveBeenCalledWith(300)
    expect(p.rightRail.getState().setCollapsed).toHaveBeenCalledWith(true)
  })

  it('maps right-rail specific fields to their rail actions', () => {
    const p = ports()
    expect(applyWorkspaceLayoutChange({ rightRailWidth: 480, rightRailCollapsed: true }, p)).toEqual({ ok: true })
    expect(p.rightRail.getState().setWidth).toHaveBeenCalledWith(480)
    expect(p.rightRail.getState().setCollapsed).toHaveBeenCalledWith(true)
  })

  it('returns a visible failure when a rail write rejects', () => {
    const p = ports()
    ;(p.rightRail.getState().setLeftRailWidth as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('persist failed') })
    const result = applyWorkspaceLayoutChange({ sidebarWidth: 300 }, p)
    expect(result).toEqual({ ok: false, message: 'persist failed' })
  })
})
