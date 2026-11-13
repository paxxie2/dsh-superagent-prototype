/**
 * T12: prepare success marker — a workspace counts as prepared only after the prepare command and
 * verifyDirectory succeeded, recorded outside the workspace under
 * `<stateDir>/prepare-markers/<ticketId>.json`. An existing directory alone is not enough.
 *
 * The harness here is deliberately minimal (DshExecutor + host/store/subprocess/sessions stubs):
 * these cases assert the launch/prepare behavior only, not Runtime wiring.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Assignment, Ticket } from '../src/core/index.ts'
import { DshExecutor, workerSessionId } from '../src/executor/dsh.ts'
import type { ExecutorHost } from '../src/executor/dsh.ts'

const cleanup: string[] = []
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }) })

type PrepareResult = { exitCode: number; stdout?: string; stderr?: string }
type SpawnRequest = { argv: string[]; cwd: string; env?: Record<string, string> }
type Behavior = (request: SpawnRequest) => PrepareResult

/** The DSH subprocess service as `runAsWorker` uses it: a spawn handle with done + collected output readers. */
function subprocessStub(behavior: Behavior) {
  const calls: SpawnRequest[] = []
  const spawn = vi.fn((request: SpawnRequest) => {
    calls.push(request)
    const result = behavior(request)
    return {
      done: Promise.resolve({ exitCode: result.exitCode }),
      collected: {
        stdout: { readFrom: () => ({ text: result.stdout ?? '' }) },
        stderr: { readFrom: () => ({ text: result.stderr ?? '' }) },
      },
    }
  })
  return { calls, spawn }
}

type Harness = {
  host: ExecutorHost
  ticket: Ticket
  stateDir: string
  workspace: string
  calls: SpawnRequest[]
  behavior: { prepare?: PrepareResult; verify?: PrepareResult }
  launch(): Promise<void>
  markerPath(): string
  marker(): { ticketId: string; directory: string; verifiedAt: string } | undefined
  sessions: { ensure: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; relay: ReturnType<typeof vi.fn> }
  engine: { assignmentStarted: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn> }
}

function assignment(over: Partial<Assignment> = {}): Assignment {
  return { id: 'a1', state: 'pending', createdAt: '2026-01-01T00:00:00.000Z', ...over }
}

function ticketOf(id: string, workspace: string, over: Partial<Ticket> = {}): Ticket {
  return {
    id, title: 'Fix the margin', decisionId: '', channels: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
    assignments: [assignment()],
    origin: { triggerId: '', triggerIds: [] },
    execution: { name: 'fix-margin', directory: workspace, assignment: 'Fix the margin.' },
    ...over,
  }
}

/**
 * Minimal DshExecutor host: one pending assignment, a stub subprocess (prepare `sh -c` and the
 * verifyDirectory `git config`), stub sessions/engine/effects that record calls and allow the
 * launch effect handler to be invoked directly.
 */
function harness(options: { prepare?: string; prepareResult?: PrepareResult; verifyResult?: PrepareResult; ticket?: Partial<Ticket> } = {}): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), 't12-prepare-'))
  cleanup.push(stateDir)
  const workspace = join(stateDir, 'workspaces', 'fix-margin-t1')
  const ticket = ticketOf('t1', workspace, options.ticket)
  const behavior: { prepare?: PrepareResult; verify?: PrepareResult } = { prepare: options.prepareResult, verify: options.verifyResult }
  const subprocess = subprocessStub(request => {
    if (request.argv[0] === 'sh') return behavior.prepare ?? { exitCode: 0 }
    // verifyDirectory: exit 0 with no config keys means the directory is acceptable.
    return behavior.verify ?? { exitCode: 0, stdout: '' }
  })
  const handlers = new Map<string, (payload: unknown) => Promise<void>>()
  const effects = {
    enqueue: vi.fn(),
    handle: vi.fn((kind: string, run: (payload: unknown) => Promise<void>) => { handlers.set(kind, run) }),
  }
  const agent = { id: workerSessionId(ticket.id), status: 'idle', inbox: { remove: vi.fn() }, cancel: vi.fn(), inject: vi.fn(), whenIdle: async () => {} }
  const sessions = {
    ensure: vi.fn(async () => agent), prompt: vi.fn(async () => {}), promptedId: vi.fn((id: string) => id),
    relay: vi.fn(), holds: vi.fn(async () => false),
  }
  const engine = {
    assignmentStarted: vi.fn(), inputsDelivered: vi.fn(), inputsRead: vi.fn(), turnEnded: vi.fn(),
    deliveryFailed: vi.fn(), assignmentInterrupted: vi.fn(),
    report: vi.fn((_ticketId: string, report: unknown) => ({ ...ticket, assignments: ticket.assignments.map(item => ({ ...item, report })) })),
  }
  const store = {
    tickets: { get: (id: string) => id === ticket.id ? ticket : undefined, open: () => [ticket], active: () => [ticket], list: () => [ticket],
      save: vi.fn() },
    triggers: { get: vi.fn(() => undefined) },
    set: vi.fn(), settings: () => ({ executor: { prepare: options.prepare ?? '', maxWorkers: 1 } }),
    atomic: (work: () => unknown) => work(), afterCommit: (work: () => unknown) => work(),
  }
  const host = {
    context: { subprocess } as unknown as Context,
    engine, store, effects,
    health: { get: () => ({ state: 'ready', detail: '', at: '' }), set: vi.fn() },
    machine: { stateDir },
    lifetime: new AbortController().signal,
    sessions,
    closing: () => false,
    paused: () => false,
    environment: () => [],
    repliedTo: () => undefined,
  } as unknown as ExecutorHost
  new DshExecutor(host)
  const markerPath = () => join(stateDir, 'prepare-markers', `${ticket.id}.json`)
  return {
    host, ticket, stateDir, workspace, calls: subprocess.calls, behavior, sessions, engine,
    markerPath,
    marker: () => existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), 'utf8')) : undefined,
    launch: async () => {
      const handler = handlers.get('launch')
      if (!handler) throw new Error('the launch effect handler was not registered')
      await handler({ ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id })
    },
  }
}

const shCalls = (h: Harness) => h.calls.filter(call => call.argv[0] === 'sh')

describe('T12 prepare success marker (AT-10..AT-14)', () => {
  it('AT-10: a successful prepare writes the marker outside the workspace and starts the worker', async () => {
    const h = harness({ prepare: 'true' })
    await h.launch()
    expect(h.engine.assignmentStarted).toHaveBeenCalledWith('t1', 'a1')
    expect(h.sessions.ensure).toHaveBeenCalledWith(workerSessionId('t1'), h.workspace, 'Fix the margin', 'worker')
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.marker()!.directory).toBe(h.workspace)
    // The marker lives outside the workspace.
    expect(h.markerPath().startsWith(h.workspace)).toBe(false)
    expect(shCalls(h)).toHaveLength(1)
    expect(shCalls(h)[0]!.argv).toEqual(['sh', '-c', 'true'])
    expect(shCalls(h)[0]!.cwd).toBe(dirname(h.workspace))
  })

  it('AT-11: a failed prepare leaves a directory without a marker, and a retry prepares again', async () => {
    const h = harness({ prepare: 'make', prepareResult: { exitCode: 1, stderr: 'make: missing dependency' } })
    mkdirSync(h.workspace, { recursive: true })
    writeFileSync(join(h.workspace, 'partial.txt'), 'left behind\n')
    await h.launch()
    expect(h.engine.report).toHaveBeenCalledWith('t1', expect.objectContaining({ state: 'failed' }))
    expect(h.marker()).toBeUndefined()
    expect(h.sessions.ensure).not.toHaveBeenCalled()
    // The non-empty directory the failed prepare left is kept, as before.
    expect(existsSync(join(h.workspace, 'partial.txt'))).toBe(true)
    // A retry does not trust the leftover directory: prepare runs again, with the marker written after success.
    h.behavior.prepare = { exitCode: 0 }
    await h.launch()
    expect(shCalls(h)).toHaveLength(2)
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledTimes(1)
  })

  it('AT-12: an ordinary ticket without any prepare command also gets the marker and starts', async () => {
    const h = harness({ prepare: '' })
    await h.launch()
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledWith(workerSessionId('t1'), h.workspace, 'Fix the margin', 'worker')
    // No prepare command was run; verifyDirectory still ran through the subprocess.
    expect(shCalls(h)).toHaveLength(0)
    expect(h.calls.every(call => call.argv[0] === 'git')).toBe(true)
  })

  it('AT-13: a marker for another directory or a deleted workspace is not prepared (prepare runs again)', async () => {
    const h = harness({ prepare: 'true' })
    // Marker exists, but for a different workspace directory.
    mkdirSync(dirname(h.markerPath()), { recursive: true })
    writeFileSync(h.markerPath(), JSON.stringify({ ticketId: 't1', directory: '/somewhere/else', verifiedAt: '2020-01-01T00:00:00.000Z' }))
    mkdirSync(h.workspace, { recursive: true })
    await h.launch()
    expect(shCalls(h)).toHaveLength(1)
    expect(h.marker()!.directory).toBe(h.workspace)
    expect(h.marker()!.verifiedAt).not.toBe('2020-01-01T00:00:00.000Z')

    // A valid marker for this directory, but the workspace was deleted: prepare again, do not start as prepared.
    const second = harness({ prepare: 'true' })
    second.behavior.prepare = { exitCode: 0 }
    mkdirSync(dirname(second.markerPath()), { recursive: true })
    writeFileSync(second.markerPath(), JSON.stringify({ ticketId: 't1', directory: second.workspace, verifiedAt: '2020-01-01T00:00:00.000Z' }))
    await second.launch()
    expect(shCalls(second)).toHaveLength(1)
    expect(second.sessions.ensure).toHaveBeenCalledTimes(1)
    expect(second.marker()!.verifiedAt).not.toBe('2020-01-01T00:00:00.000Z')

    // Migration fallback: a marker-less workspace of a ticket that already has assignment history
    // is accepted under the old behavior and its marker is backwritten (no prepare command runs).
    const legacy = harness({ prepare: 'true', ticket: {
      assignments: [assignment({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z' }), assignment({ id: 'a2' })],
    } })
    mkdirSync(legacy.workspace, { recursive: true })
    await legacy.launch()
    expect(shCalls(legacy)).toHaveLength(0)
    expect(legacy.marker()).toEqual({ ticketId: 't1', directory: legacy.workspace, verifiedAt: expect.any(String) })
    expect(legacy.sessions.ensure).toHaveBeenCalledTimes(1)
  })

  it('AT-14: an interrupted marker write leaves no trusted half marker (partial file and temporary file are not success)', async () => {
    const h = harness({ prepare: 'true' })
    mkdirSync(dirname(h.markerPath()), { recursive: true })
    // Half-written marker (as if the process died before rename) and a leftover temporary file.
    writeFileSync(h.markerPath(), '{"ticketId":"t1","directory":')
    writeFileSync(`${h.markerPath()}.999.123.tmp`, '{"ticketId":"t1","directory":')
    await h.launch()
    // The half marker was not treated as prepared: the prepare command ran and a complete marker replaced it.
    expect(shCalls(h)).toHaveLength(1)
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledTimes(1)
    // The interrupted temporary file never becomes the marker: only the complete `t1.json` target is read.
    expect(readdirSync(dirname(h.markerPath()))).toContain('t1.json')
    expect(h.marker()!.verifiedAt).not.toBe('2020-01-01T00:00:00.000Z')
  })
})

describe('W5 legacy acceptance must not skip a half-finished HEPHI preparation', () => {
  /** Writes the ticket's HEPHI state directory with `activation.intent`, and optionally `activation.json`. */
  function hephiState(h: Harness, withContract: boolean): string {
    const directory = join(h.stateDir, 'hephi', h.ticket.id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'activation.intent'), `${h.ticket.id}\n`)
    if (withContract) writeFileSync(join(directory, 'activation.json'), `{"ticketId":"${h.ticket.id}"}\n`)
    return directory
  }

  it('W5-1: legacy workspace + assignment history + intent without activation.json re-runs prepare (no silent marker)', async () => {
    const h = harness({ prepare: 'true', ticket: {
      assignments: [assignment({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z' }), assignment({ id: 'a2' })],
    } })
    mkdirSync(h.workspace, { recursive: true })
    hephiState(h, false)
    await h.launch()
    // Prepare ran instead of backwriting a marker over the half-prepared workspace.
    expect(shCalls(h)).toHaveLength(1)
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledTimes(1)
  })

  it('W5-2: a failed re-prepare surfaces as a failed launch, not a silently accepted workspace', async () => {
    const h = harness({ prepare: 'true', prepareResult: { exitCode: 1, stderr: 'prepare: activation contract not written' }, ticket: {
      assignments: [assignment({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z' }), assignment({ id: 'a2' })],
    } })
    mkdirSync(h.workspace, { recursive: true })
    hephiState(h, false)
    await h.launch()
    expect(shCalls(h)).toHaveLength(1)
    expect(h.engine.report).toHaveBeenCalledWith('t1', expect.objectContaining({ state: 'failed' }))
    expect(h.marker()).toBeUndefined()
    expect(h.sessions.ensure).not.toHaveBeenCalled()
  })

  it('W5-3: legacy workspace whose activation.json exists keeps the old backwrite behavior (no prepare)', async () => {
    const h = harness({ prepare: 'true', ticket: {
      assignments: [assignment({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z' }), assignment({ id: 'a2' })],
    } })
    mkdirSync(h.workspace, { recursive: true })
    hephiState(h, true)
    await h.launch()
    expect(shCalls(h)).toHaveLength(0)
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledTimes(1)
  })

  it('W5-4: a ticket with no HEPHI intent at all is unaffected (legacy backwrite still applies)', async () => {
    const h = harness({ prepare: 'true', ticket: {
      assignments: [assignment({ state: 'ended', endedAt: '2026-01-01T00:00:00.000Z' }), assignment({ id: 'a2' })],
    } })
    mkdirSync(h.workspace, { recursive: true })
    await h.launch()
    expect(shCalls(h)).toHaveLength(0)
    expect(h.marker()).toEqual({ ticketId: 't1', directory: h.workspace, verifiedAt: expect.any(String) })
    expect(h.sessions.ensure).toHaveBeenCalledTimes(1)
  })
})
