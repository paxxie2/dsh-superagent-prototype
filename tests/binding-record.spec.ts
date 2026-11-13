import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Ticket } from '../src/core/index.ts'
import { bindingConsumer, installBindingWriter, writeBindingRecord } from '../src/executor/binding-record.ts'

// Isolated unit fixtures mirror the observed v3 run and Host B internal-result shapes.
const base = 'a8f5feb65e6a487627e66122a0d0943de8b6e1b8'
const head = 'fc94893641d8d26f8f7b6d1a9873ab001e0b3cdd'
const paths: string[] = []
afterEach(async () => {
  for (const path of paths.splice(0)) {
    if (!resolve(path).startsWith(join(resolve(tmpdir()), 'sa-binding-test-'))) throw new Error('unsafe cleanup')
    await rm(path, { recursive: true, force: true })
  }
})
async function fixture(required = true) {
  const stateDir = await mkdtemp(join(tmpdir(), 'sa-binding-test-')); paths.push(stateDir)
  const ticket = { id: 'ticket-1', follows: [{ thread: 'github:2', own: true }] } as Ticket
  const activation = { version: 5, enabled: true, ticketId: ticket.id, repository: 'owner/repo', issueNumber: 1,
    baseSha: base, contractHash: 'sha256:fixture', evidence: { requireSessionBinding: required }, verification: { checks: [{ id: 'identity', required: true }] } }
  const fingerprint = { baseCommit: base, headCommit: head, patchHash: 'sha256:fixture', changedFiles: ['README.md'] }
  const run = { version: 3, runId: 'run-1', sequence: 1, ticketId: ticket.id, sessionId: 'worker-ticket-1', contractHash: activation.contractHash,
    checkId: 'identity', callId: 'outer-check', innerCallId: 'hephi-native', status: 'passed', exitCode: 0,
    before: fingerprint, after: fingerprint, finishedAt: '2026-11-13T02:06:24.928Z' }
  const root = join(stateDir, 'hephi', ticket.id)
  await mkdir(join(root, 'checks', run.runId), { recursive: true })
  await writeFile(join(root, 'activation.json'), JSON.stringify(activation))
  await writeFile(join(root, 'checks', run.runId, 'run.json'), JSON.stringify(run))
  const events = vi.fn(async () => [
    { type: 'tool/internal-call', data: { callId: run.innerCallId, name: 'bash', rootCallId: run.callId } },
    { type: 'tool/internal-result', data: { callId: run.innerCallId, outcome: { isError: false, value: { kind: 'foreground', exitCode: 0 } } } },
  ])
  const input = { config: { stateDir }, ticket, sessionId: run.sessionId, events, env: {}, readPull: vi.fn(async () => ({ number: 2, headRefOid: head })) }
  return { input, root, run }
}
describe('B2 binding writer (isolated fixtures, not E2E)', () => {
  it('publishes consumer shape from a real-shaped native check, not the ready call', async () => {
    const { input } = await fixture()
    const path = await writeBindingRecord(input)
    const record = JSON.parse(await readFile(path!, 'utf8'))
    expect(record).toMatchObject({ version: 1, producer: 'dsh-superagent', ticket: { id: 'ticket-1', repository: 'owner/repo', issue: 1 },
      session: { id: 'worker-ticket-1' }, execution: { kind: 'foreground', exitCode: 0, toolCallId: 'hephi-native', terminalStatus: 'passed' },
      finalCommit: { sha: head, baseSha: base, prNumber: 2 } })
    expect(input.readPull).toHaveBeenCalledWith('owner/repo', 2)
    expect(record.execution).not.toHaveProperty('jobId')
  })
  it('does not query GitHub, read Session or write when binding is off', async () => {
    const { input } = await fixture(false)
    const persist = vi.fn()
    expect(await writeBindingRecord({ ...input, persist })).toBeUndefined()
    expect(input.readPull).not.toHaveBeenCalled(); expect(input.events).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled()
  })
  it('honors host OR contract, including explicit host false over environment', async () => {
    const { input } = await fixture(false)
    expect(await writeBindingRecord({ ...input, config: { ...input.config, requireSessionBinding: true } })).toBeTruthy()
    expect(await writeBindingRecord({ ...input, config: { ...input.config, requireSessionBinding: false }, env: { HEPHI_REQUIRE_SESSION_BINDING: '1' } })).toBeUndefined()
  })
  it('propagates actual write failure without returning success', async () => {
    const { input } = await fixture()
    const path = join(input.config.stateDir, 'binding')
    await writeFile(path, 'not a directory')
    await expect(writeBindingRecord(input)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('not a directory')
  })
  it('never guesses kind from run exitCode or publishes when native evidence is missing', async () => {
    const { input } = await fixture(); const persist = vi.fn()
    await expect(writeBindingRecord({ ...input, events: async () => [], persist })).rejects.toThrow('native check')
    expect(persist).not.toHaveBeenCalled()
  })
  it('rejects stale PR head and wrong-session runs without writing', async () => {
    const { input, root, run } = await fixture(); const persist = vi.fn()
    await expect(writeBindingRecord({ ...input, readPull: async () => ({ number: 2, headRefOid: base }), persist })).rejects.toThrow('no passing')
    await writeFile(join(root, 'checks', run.runId, 'run.json'), JSON.stringify({ ...run, sessionId: 'another-worker' }))
    await expect(writeBindingRecord({ ...input, persist })).rejects.toThrow('no passing')
    expect(persist).not.toHaveBeenCalled()
  })
  it('reads the live effective host config rather than raw profile entries', () => {
    const ctx = { get: () => ({ entries: () => [{ options: { id: 'hephi' }, fiber: { uid: 1, effectiveConfig: { requireSessionBinding: true } } }] }) } as unknown as Context
    expect(bindingConsumer(ctx)?.requireSessionBinding).toBe(true)
  })
  it('reads the pinned Host B Cordis Fiber.config shape without assuming effectiveConfig exists', () => {
    const ctx = { get: () => ({ entries: () => [{ options: { id: 'hephi', config: { requireSessionBinding: false } },
      fiber: { uid: 42, config: { stateDir: '/real/state', requireSessionBinding: true } } }] }) } as unknown as Context
    expect(bindingConsumer(ctx)).toEqual({ stateDir: '/real/state', requireSessionBinding: true })
  })
  it('prepends the writer and fails closed before downstream gate on missing live configuration', async () => {
    let callback: any
    const on = vi.fn((_name, fn, options) => { callback = fn; expect(options).toEqual({ prepend: true }); return () => {} })
    const agent = { ctx: { on } } as unknown as Agent
    installBindingWriter({ get: () => undefined } as unknown as Context, agent, () => undefined)
    const next = vi.fn()
    const denied = await callback({ name: 'orchestrator_report', arguments: { state: 'ready' } }, next)
    expect(denied).toMatchObject({ kind: 'deny' }); expect(next).not.toHaveBeenCalled()
    await callback({ name: 'orchestrator_report', arguments: { state: 'progress' } }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

it('DSH_BINDING_RECORD directory resolves to <dir>/<ticket>.json (consumer parity)', async () => {
  const { input } = await fixture()
  const dir = await mkdtemp(join(tmpdir(), 'sa-binding-test-dir-')); paths.push(dir)
  const written: string[] = []
  const path = await writeBindingRecord({ ...input, env: { DSH_BINDING_RECORD: dir },
    persist: async (file: string, body: string) => { written.push(file); await writeFile(file, body) } })
  expect(path).toBe(join(dir, `${(input.ticket as { id: string }).id}.json`))
  expect(written[0]).toBe(path)
})
