/**
 * A worker's background work in DSH: the shell jobs its Session owns (`ctx.jobs`) and its subagents (`ctx.subagents`). They
 * keep the worker busy after its turn ended, and they stop with its Assignment. A profile without either service runs none; a
 * stop records a missing subagents service as a cleanup failure, because it cannot see what it would leave running.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** What the Executor uses of DSH's job registry: the jobs a Session can see, their events, a wait for one and a kill. */
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** One row of DSH's recursive subagent listing: a reachable descendant, or a branch whose catalog could not be read. */
type SubagentRow =
  | { readonly kind: 'child'; readonly id: SessionId; readonly parentId: SessionId; readonly depth: number }
  | { readonly kind: 'diagnostic'; readonly id: SessionId; readonly parentId: SessionId; readonly depth: number; readonly reason: string }
/** The authority an interrupt is admitted under: the worker Agent, the exact live ancestor of the child's tree. */
type SubagentAuthority = { readonly kind: 'ancestor'; readonly agent: Agent }
/**
 * What the Executor uses of DSH 0.2.2-rc.3's subagents: joining the work of a worker's tree, listing its descendants, and
 * interrupting one descendant. Each is optional because this fork's pre-rc.3 host fixture still offers the old seam below.
 */
interface Subagents {
  waitForTreeWork?(root: Agent): Promise<boolean>
  listDescendants?(rootSessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentRow[]>
  interrupt?(targetSessionId: SessionId, authority: SubagentAuthority): void
}
/** The seam a pre-rc.3 DSH host still offers, until this fork's host fixture moves to the rc.3 one. */
interface LegacySubagents {
  waitForChildren(parent: Agent): Promise<boolean>
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 10_000
/** How long a stop may take to interrupt the worker's subagents and prove they stopped; it can hold up a shutdown. */
const DRAIN_LIMIT_MS = 10_000
/** How often a stop samples the agents it interrupted while it proves they stopped; rc.3 has no wait for a child. */
const STOP_POLL_MS = 100
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
const COLLECT_WAIT_MS = 10 * 60_000

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
/** The old seam of a service built before rc.3, read only when it offers no recursive listing. */
const legacySubagentsOf = (subagents: Subagents) => subagents as unknown as Partial<LegacySubagents>
const running = (status: string) => status === 'running' || status === 'stopping'
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id))
/** `work`, or false once `signal` aborts or `ms` pass first. */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
export const cancelled = new WeakSet<Agent>()
/** The pending join of each worker's subagents, which DSH cannot cancel, so a later look joins the same one. */
const joins = new WeakMap<Agent, Promise<boolean>>()
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent)
  if (!join) {
    const legacy = legacySubagentsOf(subagents)
    const waiting = typeof subagents.waitForTreeWork === 'function' ? subagents.waitForTreeWork(agent)
      : typeof legacy.waitForChildren === 'function' ? legacy.waitForChildren(agent) : Promise.resolve(false)
    join = waiting.finally(() => { joins.delete(agent) })
    joins.set(agent, join)
  }
  return join
}

/** A job by its id and the first line of its label. */
const named = (job: { id: string; label?: string }) => { const line = job.label?.split('\n')[0]?.trim(); return line ? `${job.id} (${line})` : job.id }
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}

/**
 * Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
 * no waiter on any job, so each job's end still reaches the worker.
 */
function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx)
  if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true; unsubscribe(); signal.removeEventListener('abort', aborted); resolve(value)
    }
    const aborted = () => { done(false) }
    // Only an end can leave no job running; a job's output does not.
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === 'settled' || event.type === 'removed') && !owned(jobs, sessionId, except).length) done(true)
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents. A job's or a
 * subagent's end wakes the worker with its result, which ends this look: the turn it starts ends with an idle of its own,
 * which looks afresh.
 * @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
 * as when the host stops or the look's time is up.
 */
export async function untilQuiet(ctx: Context, agent: Agent, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  for (;;) {
    const subagents = subagentsOf(ctx)
    const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false
    const jobs = await jobsEnd(ctx, agent.id, signal, except)
    if (signal.aborted || agent.status !== 'idle') return false
    if (!children && !jobs) return true
  }
}

/**
 * Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
 * One failure stops none other.
 */
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // The waits start before the kills, so each end counts as collected.
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
 * @returns the job's name and status once it ended; undefined when `signal` aborted first.
 */
export async function collectJob(ctx: Context, sessionId: string, job: { id: string; name: string }, signal: AbortSignal):
  Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx)
  while (jobs && !signal.aborted) {
    const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => undefined)
    if (!view) return undefined
    if (!running(view.status)) return { name: job.name, status: view.status }
  }
  return undefined
}

/** The agents among `ids` that still run or stop, with the statuses that keep them from counting as stopped. */
const stillRunning = (ctx: Context, ids: readonly SessionId[]) => ids.flatMap(id => {
  const agent = ctx.agents.get(id)
  return agent !== undefined && running(agent.status) ? [{ id, status: agent.status }] : []
})

/**
 * Prove within `limitMs` that none of `ids` still runs. rc.3 has no wait for a child to stop, so their Agents are sampled; one
 * that left the registry has ended.
 * @returns the agents that still ran at the limit, which is empty once they stopped.
 */
async function stoppedWithin(ctx: Context, ids: readonly SessionId[], limitMs: number): Promise<{ id: SessionId; status: string }[]> {
  const deadline = Date.now() + limitMs
  for (;;) {
    const stuck = stillRunning(ctx, ids)
    if (!stuck.length || Date.now() >= deadline) return stuck
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, STOP_POLL_MS); timer.unref?.() })
  }
}

/**
 * Interrupt the descendants an rc.3 service lists, deepest first, and prove they stopped. A branch the listing could not read,
 * an interrupt the service refuses, and a target that still runs at the limit are cleanup failures; the descendants it did
 * find are still interrupted.
 * @returns whether a child ended, and may have woken the worker, whose turn the stop then finalizes.
 */
async function stopDescendants(ctx: Context, subagents: Subagents, agent: Agent, failures: unknown[]): Promise<boolean> {
  const list = subagents.listDescendants!.bind(subagents)
  const rows = await list(agent.id)
  for (const row of rows) {
    if (row.kind === 'diagnostic') failures.push(new Error(`The subagent branch ${row.id} is ${row.reason}, so its work cannot be stopped`))
  }
  // The catalog also lists a subagent that ended; only the descendants present as Agents are live enough to interrupt.
  const targets = rows.filter((row): row is Extract<SubagentRow, { kind: 'child' }> => row.kind === 'child')
    .filter(row => ctx.agents.get(row.id) !== undefined)
    .sort((one, other) => other.depth - one.depth)
  if (!targets.length) return failures.length > 0
  const interrupt = subagents.interrupt?.bind(subagents)
  if (!interrupt) {
    failures.push(new Error(`The subagents service cannot interrupt ${targets.map(target => target.id).join(', ')}`))
    return true
  }
  for (const target of targets) try { interrupt(target.id, { kind: 'ancestor', agent }) } catch (error) { failures.push(error) }
  const stuck = await stoppedWithin(ctx, targets.map(target => target.id), DRAIN_LIMIT_MS)
  if (stuck.length) failures.push(new Error(
    `The subagents ${stuck.map(({ id, status }) => `${id} (${status})`).join(', ')} still ran ${DRAIN_LIMIT_MS} ms after their stop`))
  return true
}

/** Release a pre-rc.3 service's live children by id, for a bounded time, as that seam allows. */
async function stopLegacyDescendants(ctx: Context, subagents: Subagents, agent: Agent, failures: unknown[]): Promise<boolean> {
  const legacy = legacySubagentsOf(subagents)
  const list = legacy.listChildren?.bind(subagents), drain = legacy.drainChildren?.bind(subagents)
  if (!list || !drain) {
    failures.push(new Error(`The subagents service cannot list or release the descendants of ${agent.id}`))
    return false
  }
  const live = (await list(agent.id)).map(child => child.id).filter(id => ctx.agents.get(id as SessionId) !== undefined)
  if (!live.length) return false
  try { await until(drain(agent, live), undefined, DRAIN_LIMIT_MS) } catch (error) { failures.push(error) }
  return true
}

/**
 * Stop the worker's subagents, and prove it. rc.3 removed the call that released a child by id, and this Executor never starts
 * the worker's subagents itself, so it holds no activation to dispose: it lists the descendants, interrupts every live one
 * deepest-first under the worker's ancestry, and samples their Agents until none runs within `DRAIN_LIMIT_MS`. A branch the
 * catalog cannot read, a listing that fails, an interrupt that throws, and a target that still runs at the limit are cleanup
 * failures, thrown after the turn their ends may have woken is cancelled, keeping its inbox when `keepInbox`. A service that
 * is missing is a cleanup failure too, but one no child's end could have woken a turn for, so that turn is left as it was.
 * Interrupting keeps the child resident and the Session's admission open, so a later child of the same Session still starts.
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  const failures: unknown[] = []
  let stopping = false
  if (!subagents) {
    // A service that is absent cannot have a child whose end woke the worker, so its turn is left as it was.
    failures.push(new Error(`The subagents service is missing, so the subagents of ${agent.id} cannot be stopped`))
  } else {
    try {
      stopping = typeof subagents.listDescendants === 'function'
        ? await stopDescendants(ctx, subagents, agent, failures)
        : await stopLegacyDescendants(ctx, subagents, agent, failures)
    } catch (error) { failures.push(error); stopping = true }
  }
  // A child that ended is what wakes the worker's turn, which the stop then finalizes; a listing of no rows, or of ended rows
  // only, found no such child, and neither did a service that could not be asked.
  if (stopping) {
    if (agent.status !== 'idle') cancelled.add(agent)
    agent.cancel({ kind: 'user' }, { keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
  if (failures.length) throw new AggregateError(failures, `Stopping the subagents of ${agent.id} failed`)
}

/**
 * Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and stop its subagents (see
 * `stopSubagents`, which records a profile without that service as a cleanup failure). A Session not loaded has no subagent at
 * work. One failure stops nothing else.
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
