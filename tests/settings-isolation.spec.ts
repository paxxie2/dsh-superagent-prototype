/** Deterministic lifecycle tests using the existing in-process fake Host fixture; not E2E. */
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined; vi.restoreAllMocks() })

it('rejects forged panel and tool writes for pending/running assignments without mutation', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const before = JSON.stringify(store.settings())
  const revision = store.blockRevision('executor')
  const open = vi.spyOn(store.tickets, 'open')
  const active = vi.spyOn(h.runtime.executor, 'activeCount')
  for (const state of ['pending', 'running']) {
    active.mockReturnValue(state === 'running' ? 1 : 0)
    open.mockReturnValue([{ assignments: [{ state }] }] as never)
    const source = settings.block('source:github')
    expect(await h.api('PUT', 'settings/source:github', { value: source.value, revision: source.revision })).toMatchObject({ status: 409, body: { error: expect.stringContaining('Shared settings are locked') } })
    for (const origin of ['panel', 'tool'] as const) {
      await expect(settings.save('executor', { ...store.settings().executor, maxWorkers: 2 }, revision, origin)).rejects.toThrow('Shared settings are locked')
    }
  }
  expect(JSON.stringify(store.settings())).toBe(before)
  expect(store.blockRevision('executor')).toBe(revision)
})

it.each(['ready', 'blocked', 'failed', 'waiting', undefined])('allows idle workers with persistent running assignment and report %s', async reportState => {
  h = await startRuntime()
  const { settings, store, executor } = h.runtime
  vi.spyOn(executor, 'activeCount').mockReturnValue(0)
  vi.spyOn(store.tickets, 'open').mockReturnValue([{ assignments: [{ state: 'running', report: reportState ? { state: reportState } : undefined }] }] as never)
  const result = await h.api('PUT', 'settings/executor', { value: { ...store.settings().executor, maxWorkers: 2 }, revision: store.blockRevision('executor') })
  expect(result.status).toBe(200)
  await expect(settings.save('executor', { ...store.settings().executor, maxWorkers: 3 }, store.blockRevision('executor'), 'tool')).resolves.toMatchObject({ saved: true })
  expect(store.settings().executor.maxWorkers).toBe(3)
})

it.each(['ready', 'blocked', 'failed', 'waiting', undefined])('rejects executing or settling workers regardless of report %s', async reportState => {
  h = await startRuntime()
  const { settings, store, executor } = h.runtime
  vi.spyOn(executor, 'activeCount').mockReturnValue(1)
  vi.spyOn(store.tickets, 'open').mockReturnValue([{ assignments: [{ state: 'running', report: reportState ? { state: reportState } : undefined }] }] as never)
  const value = { ...store.settings().executor, maxWorkers: 2 }
  const revision = store.blockRevision('executor')
  expect((await h.api('PUT', 'settings/executor', { value, revision })).status).toBe(409)
  await expect(settings.save('executor', value, revision, 'tool')).rejects.toThrow(SettingsConflict)
  expect(store.blockRevision('executor')).toBe(revision)
})

it('preserves idle operator HTTP configuration with X-Orchestrator-Request', async () => {
  h = await startRuntime()
  const { store } = h.runtime
  const revision = store.blockRevision('executor')
  const result = await h.api('PUT', 'settings/executor', { value: { ...store.settings().executor, maxWorkers: 2 }, revision })
  expect(result.status).toBe(200)
  expect(store.settings().executor.maxWorkers).toBe(2)
})

it('rechecks after async validation before saving if an assignment starts meanwhile', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const open = vi.spyOn(store.tickets, 'open').mockReturnValue([])
  const active = vi.spyOn(h.runtime.executor, 'activeCount').mockReturnValue(0)
  let resolve!: (value: unknown) => void
  const barrier = new Promise(settle => { resolve = settle })
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  llm.resolveCallConfig.mockImplementationOnce(() => barrier)
  const previous = JSON.stringify(store.settings())
  const revision = store.blockRevision('executor')
  const model = { provider: 'worker-provider', model: 'worker-model' }
  const save = settings.save('executor', { ...store.settings().executor, model }, revision, 'panel')
  open.mockReturnValue([{ assignments: [{ state: 'running' }] }] as never)
  active.mockReturnValue(1)
  resolve(model)
  await expect(save).rejects.toThrow(SettingsConflict)
  expect(JSON.stringify(store.settings())).toBe(previous)
  expect(store.blockRevision('executor')).toBe(revision)
})

// Explicit in-process unit coverage: this is not an authenticated HTTP capability.
it('allows audited host control-plane updates while preserving the live assignment', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  vi.spyOn(store.tickets, 'open').mockReturnValue([{ assignments: [{ state: 'running' }] }] as never)
  vi.spyOn(h.runtime.executor, 'activeCount').mockReturnValue(1)
  const revision = store.blockRevision('executor')
  const value = { ...store.settings().executor, maxWorkers: 2 }
  const result = await settings.saveHostInternal('executor', value, revision, 'panel')
  expect(result).toMatchObject({ saved: true, restarting: false })
  expect(store.settings().executor.maxWorkers).toBe(2)
  expect(store.settingsHistory()[0]).toMatchObject({ source: 'panel', block: 'executor', hostInternal: true })
  expect(store.tickets.open()[0]!.assignments).toEqual([{ state: 'running' }])
  // Neither a forged body flag nor the historical panel-origin route grants this capability.
  const history = store.settingsHistory()
  const response = await h.api('PUT', 'settings/executor', { value, revision: store.blockRevision('executor'), hostInternal: true })
  expect(response.status).toBe(409)
  expect(store.settingsHistory()).toEqual(history)
})

it('does not let even the internal path change live deployment shell configuration', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  vi.spyOn(store.tickets, 'open').mockReturnValue([{ assignments: [{ state: 'pending' }] }] as never)
  const before = JSON.stringify(store.settings())
  await expect(settings.saveHostInternal('executor', { ...store.settings().executor, prepare: 'echo changed' }, store.blockRevision('executor'), 'panel')).rejects.toThrow(SettingsConflict)
  expect(JSON.stringify(store.settings())).toBe(before)
})
