/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { stopBackground, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** One row of rc.3's recursive subagent listing: a reachable descendant, or a branch whose catalog could not be read. */
type Row =
  | { kind: 'child'; id: string; parentId: string; depth: number }
  | { kind: 'diagnostic'; id: string; parentId: string; depth: number; reason: 'corrupt' | 'unavailable' | 'unsupported' }

type Worker = Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
type Child = { id: string; status: string }

/** The idle worker agent of `worker-t1`, whose turn a stop finalizes by cancelling it. */
function worker(id = 'worker-t1', status = 'idle'): Worker {
  return { id, status, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {}, cancel: vi.fn() } as unknown as Worker
}

/**
 * A context with DSH's job registry and an rc.3 subagents service, plus the old calls a pre-rc.3 service still offers, as
 * spies: the service a test does not shape lists no descendants, interrupts by ending the child, and never drains.
 */
function setup(options: {
  waitForTreeWork?: (agent: Agent) => Promise<boolean>
  listDescendants?: (root: string) => Promise<readonly Row[]>
  interrupt?: (id: string, authority: unknown) => void
  agents?: Record<string, string>
  subagents?: boolean
} = {}) {
  const jobs = jobRegistry()
  const agent = worker()
  const children = new Map<string, Child>(Object.entries(options.agents ?? {}).map(([id, status]) => [id, { id, status }]))
  const get = vi.fn((id: string) => id === agent.id ? agent : children.get(id))
  const subagents = {
    waitForTreeWork: vi.fn(options.waitForTreeWork ?? (async () => false)),
    listDescendants: vi.fn(options.listDescendants ?? (async () => [])),
    interrupt: vi.fn(options.interrupt ?? ((id: string) => { const child = children.get(id); if (child) child.status = 'idle' })),
    waitForChildren: vi.fn(async () => false),
    listChildren: vi.fn(async () => []),
    drainChildren: vi.fn(async () => {}),
    drainDescendants: vi.fn(async () => {}),
  }
  const services: Record<string, unknown> = { jobs: jobs.service }
  if (options.subagents !== false) services.subagents = subagents
  const ctx = { get: (name: string) => services[name], agents: { get } } as unknown as Context
  return { ctx, agent, jobs, subagents, children, get }
}

/** The failure a stop threw, for inspecting its cleanup failures. */
async function thrown(stop: Promise<void>) { return await stop.then(() => undefined, (error: unknown) => error) }

/** The cleanup failures an AggregateError reports, as text. */
function failuresOf(error: unknown): string { return error instanceof AggregateError ? error.errors.map(String).join(' | ') : String(error) }

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup({ waitForTreeWork: async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); agent.status = 'running'
    return false
  } })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup({ waitForTreeWork: () => { joining(); return new Promise(() => {}) } })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup({ waitForTreeWork: async () => false })
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup({ waitForTreeWork: () => new Promise(() => {}) })
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForTreeWork).toHaveBeenCalledTimes(1)
  expect(subagents.waitForChildren).not.toHaveBeenCalled()
})

it('is quiet once the joined tree work ended with the worker idle and no shell jobs', async () => {
  let joins = 0
  const { ctx, agent, subagents } = setup({ waitForTreeWork: async () => ++joins === 1 })
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  // The join said work was joined, so the look ended by rechecking the worker's idle and looking again.
  expect(subagents.waitForTreeWork).toHaveBeenCalledTimes(2)
})

it('waits only for its shell jobs when the profile has no subagents service', async () => {
  const { ctx, agent, jobs } = setup({ subagents: false })
  const id = jobs.run('worker-t1')
  const quiet = untilQuiet(ctx, agent, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { ctx, agent } = setup({ agents: { 'child-1': 'running' }, interrupt: () => {} })
  let failure: unknown, stopped = false
  try {
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true }, (error: unknown) => { stopped = true; failure = error })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(failuresOf(failure)).toContain('child-1')
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('interrupts only the children the catalog lists as live, with the worker as their ancestor', async () => {
  const { ctx, agent, subagents, get } = setup({
    agents: { 'child-1': 'running' },
    listDescendants: async () => [
      { kind: 'child', id: 'child-1', parentId: 'worker-t1', depth: 1 },
      { kind: 'child', id: 'child-2', parentId: 'worker-t1', depth: 1 },
    ],
  })
  await stopSubagents(ctx, agent)
  expect(subagents.listDescendants).toHaveBeenCalledWith('worker-t1')
  // The catalog can also list a child that ended; only the one still registered as an Agent is interrupted.
  expect(subagents.interrupt).toHaveBeenCalledTimes(1)
  expect(subagents.interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent })
  expect(get).toHaveBeenCalledWith('child-1')
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('interrupts nested descendants deepest-first, and polls every targeted id', async () => {
  const { ctx, agent, subagents, get } = setup({
    agents: { 'child-a': 'running', 'child-b': 'running', 'child-c': 'running' },
    listDescendants: async () => [
      { kind: 'child', id: 'child-a', parentId: 'worker-t1', depth: 1 },
      { kind: 'child', id: 'child-b', parentId: 'child-a', depth: 2 },
      { kind: 'child', id: 'child-c', parentId: 'child-b', depth: 3 },
    ],
  })
  await stopSubagents(ctx, agent)
  expect(subagents.interrupt.mock.calls.map(([id]) => id)).toEqual(['child-c', 'child-b', 'child-a'])
  for (const id of ['child-a', 'child-b', 'child-c']) expect(get).toHaveBeenCalledWith(id)
})

it('proves a stop within 10 seconds once its interrupts turned the running children idle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { ctx, agent, children } = setup({
    agents: { 'child-1': 'running' },
    interrupt: id => { setTimeout(() => { children.get(id)!.status = 'idle' }, 1_000) },
  })
  try {
    const stopping = stopSubagents(ctx, agent)
    await vi.advanceTimersByTimeAsync(2_000)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('records each unread branch as a cleanup failure, still interrupting the rest and cancelling the turn', async () => {
  const { ctx, agent, subagents } = setup({
    agents: { 'child-1': 'running' },
    listDescendants: async () => [
      { kind: 'child', id: 'child-1', parentId: 'worker-t1', depth: 1 },
      { kind: 'diagnostic', id: 'child-x', parentId: 'worker-t1', depth: 1, reason: 'corrupt' },
      { kind: 'diagnostic', id: 'child-y', parentId: 'worker-t1', depth: 1, reason: 'unavailable' },
      { kind: 'diagnostic', id: 'child-z', parentId: 'worker-t1', depth: 1, reason: 'unsupported' },
    ],
  })
  const failure = await thrown(stopSubagents(ctx, agent))
  expect(failure).toBeInstanceOf(AggregateError)
  const text = failuresOf(failure)
  for (const [id, reason] of [['child-x', 'corrupt'], ['child-y', 'unavailable'], ['child-z', 'unsupported']]) {
    expect(text).toContain(id)
    expect(text).toContain(reason)
  }
  expect(subagents.interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent })
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('records an unreadable listing as a cleanup failure, and still cancels the turn', async () => {
  for (const failure of [
    Object.assign(new Error('listing subagents requires the session store'), { code: 'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE' }),
    Object.assign(new Error('the root catalog cannot be read'), { name: 'SessionQueryError' }),
  ]) {
    const { ctx, agent } = setup({ listDescendants: async () => { throw failure } })
    const failureOfStop = await thrown(stopSubagents(ctx, agent))
    expect(failureOfStop).toBeInstanceOf(AggregateError)
    expect((failureOfStop as AggregateError).errors).toContain(failure)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  }
})

it('records an interrupt the service refuses as a cleanup failure, and still cancels the turn', async () => {
  const refusal = Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' })
  const { ctx, agent } = setup({ agents: { 'child-1': 'idle' }, interrupt: () => { throw refusal } })
  const failure = await thrown(stopSubagents(ctx, agent))
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toContain(refusal)
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

it('treats a complete listing with no rows as the only normal empty result', async () => {
  const { ctx, agent, subagents } = setup({ listDescendants: async () => [] })
  await stopSubagents(ctx, agent)
  expect(subagents.interrupt).not.toHaveBeenCalled()
  // No child ended, so no end woke the worker to cancel.
  expect(agent.cancel).not.toHaveBeenCalled()
})

it('fails a stop when the subagents service is missing, still cancelling the turn', async () => {
  const { ctx, agent } = setup({ subagents: false })
  const failure = await thrown(stopSubagents(ctx, agent))
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failuresOf(failure)).toContain('subagents service')
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  // A stop of the Session's background work reports it too, alongside its shell jobs.
  await expect(stopBackground(ctx, 'worker-t1', 'the Assignment ended')).rejects.toBeInstanceOf(AggregateError)
})

it('never drains the Session, so it can start another child after a stop', async () => {
  const { ctx, agent, subagents } = setup({ agents: { 'child-1': 'running' } })
  await stopSubagents(ctx, agent)
  expect(subagents.drainChildren).not.toHaveBeenCalled()
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
  // Interrupting keeps the resident child and the tree's admission, so a later child of the same Session can start.
  expect(subagents.interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent })
})
