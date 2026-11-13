import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Ticket } from '../core/index.ts'

const exec = promisify(execFile)
const sha = /^[0-9a-f]{40}$/
type Event = { type: string; data?: any }
type Config = { stateDir?: string; requireSessionBinding?: boolean }
type Entry = { options: { id?: string; name?: string }; disabled?: boolean; fiber?: { uid: unknown; effectiveConfig?: Config; config?: Config } }

/** Read the mounted consumer's effective configuration, not a separate writer switch. */
export function bindingConsumer(ctx: Context): Config | undefined {
  const loader = ctx.get('loader') as { entries(): Iterable<Entry> } | undefined
  if (!loader) throw new Error('B2: live Loader configuration unavailable')
  const entries = [...loader.entries()].filter(e => e.options.id === 'hephi' && !e.disabled && e.fiber?.uid != null)
  if (!entries.length) return undefined
  if (entries.length !== 1) throw new Error('B2: ambiguous HEPHI configuration')
  // Host B's pinned Cordis exposes validated `config`; newer Cordis calls it `effectiveConfig`.
  // Neither is the raw Loader entry options, whose expressions may not have been resolved.
  const config = entries[0]!.fiber!.effectiveConfig ?? entries[0]!.fiber!.config
  if (!config || typeof config !== 'object') throw new Error('B2: unavailable HEPHI effective configuration')
  return config
}

export type BindingInput = {
  config: Config; ticket: Ticket; sessionId: string; prNumber?: number; events: () => Promise<Event[]>;
  readPull?: (repository: string, number: number) => Promise<{ number: number; headRefOid: string }>;
  persist?: (path: string, body: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** All evidence is collected and checked before the single atomic publication. */
export async function writeBindingRecord(input: BindingInput): Promise<string | undefined> {
  const env = input.env ?? process.env
  const stateDir = input.config.stateDir?.trim() || env.HEPHI_STATE_DIR?.trim() || join(homedir(), '.dsh-superagent')
  if (!/^[\w-]+$/.test(input.ticket.id)) throw new Error('B2: unsafe ticket id')
  let contract: any
  try { contract = JSON.parse(await readFile(join(stateDir, 'hephi', input.ticket.id, 'activation.json'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!contract.enabled) return undefined
  const required = (input.config.requireSessionBinding ?? env.HEPHI_REQUIRE_SESSION_BINDING === '1') || contract.evidence?.requireSessionBinding === true
  if (!required) return undefined
  if (contract.ticketId !== input.ticket.id || !sha.test(contract.baseSha) || typeof contract.repository !== 'string'
    || !Number.isSafeInteger(contract.issueNumber) || contract.issueNumber < 1 || !input.sessionId) throw new Error('B2: incomplete activation identity')
  const owned = (input.ticket.follows ?? []).filter(f => f.own && !f.closed && /^github:\d+$/.test(f.thread)).map(f => Number(f.thread.slice(7)))
  const prNumber = input.prNumber ?? (owned.length === 1 ? owned[0] : undefined)
  if (!Number.isSafeInteger(prNumber) || prNumber! < 1) throw new Error('B2: no unambiguous real PR number')
  const readPull = input.readPull ?? (async (repository, number) => {
    const result = await exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'number,headRefOid'], { timeout: 30_000 })
    return JSON.parse(result.stdout)
  })
  const pull = await readPull(contract.repository, prNumber!)
  if (pull.number !== prNumber || !sha.test(pull.headRefOid)) throw new Error('B2: GitHub PR HEAD unavailable')
  const checks = join(stateDir, 'hephi', input.ticket.id, 'checks')
  const runs: any[] = []
  for (const dir of await readdir(checks, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const run = JSON.parse(await readFile(join(checks, dir.name, 'run.json'), 'utf8'))
    if (run.version === 3 && run.ticketId === input.ticket.id && run.sessionId === input.sessionId
      && run.contractHash === contract.contractHash && run.status === 'passed' && run.phase === undefined
      && contract.verification?.checks?.some((c: any) => c.id === run.checkId && c.required !== false)
      && run.after?.headCommit === pull.headRefOid && run.before?.headCommit === pull.headRefOid
      && run.after?.baseCommit === contract.baseSha && run.before?.baseCommit === contract.baseSha) runs.push(run)
  }
  runs.sort((a, b) => b.sequence - a.sequence)
  const run = runs[0]
  if (!run || typeof run.innerCallId !== 'string' || !run.innerCallId || !run.finishedAt || run.exitCode !== 0) throw new Error('B2: no passing native check for this Session and PR HEAD')
  const events = await input.events()
  const calls = events.filter(e => ['tool/internal-call', 'tool/call'].includes(e.type) && e.data?.callId === run.innerCallId)
  const results = events.filter(e => ['tool/internal-result', 'tool/result'].includes(e.type) && e.data?.callId === run.innerCallId)
  if (calls.length !== 1 || calls[0]!.data?.name !== 'bash' || results.length !== 1) throw new Error('B2: native check call/result unavailable or ambiguous')
  if (calls[0]!.type === 'tool/internal-call' && (calls[0]!.data.rootCallId ?? calls[0]!.data.parentCallId) !== run.callId) throw new Error('B2: native check root differs from run')
  const outcome = results[0]!.data?.outcome
  const value = outcome?.value
  if (outcome?.isError !== false || !value || value.timedOut === true || value.aborted === true || value.signal != null) throw new Error('B2: native check did not finish successfully')
  let execution: object
  if (value.kind === 'foreground' && value.exitCode === run.exitCode && run.jobId === undefined) {
    execution = { kind: value.kind, exitCode: run.exitCode, toolCallId: run.innerCallId, terminalStatus: run.status, finishedAt: run.finishedAt }
  } else if (['background', 'promoted'].includes(value.kind) && typeof run.jobId === 'string' && run.jobId && value.jobId === run.jobId) {
    execution = { kind: value.kind, jobId: run.jobId, toolCallId: run.innerCallId, terminalStatus: run.status, finishedAt: run.finishedAt }
  } else throw new Error('B2: native result kind/exit/job disagrees with check run')
  const record = { version: 1, producedAt: new Date().toISOString(), producer: 'dsh-superagent',
    ticket: { id: input.ticket.id, repository: contract.repository, issue: contract.issueNumber }, session: { id: input.sessionId },
    execution, finalCommit: { sha: pull.headRefOid, baseSha: contract.baseSha, prNumber } }
  // Mirror the hephi consumer's source rule exactly: an explicitly configured location that
  // is an existing directory resolves to `<dir>/<ticket>.json`; otherwise it is a file path.
  const configured = env.DSH_BINDING_RECORD?.trim()
  let path: string
  if (configured) {
    const resolved = resolve(configured)
    let isDirectory = false
    try { isDirectory = (await stat(resolved)).isDirectory() } catch { isDirectory = false }
    path = isDirectory ? join(resolved, `${input.ticket.id}.json`) : resolved
  } else path = join(stateDir, 'binding', `${input.ticket.id}.json`)
  await (input.persist ?? (async (file, body) => {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, body, { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  }))(path, `${JSON.stringify(record, null, 2)}\n`)
  return path
}

/** Installed after async Worker decoration, ahead of HEPHI's synchronous created hook. */
export function installBindingWriter(ctx: Context, agent: Agent, ticket: () => Ticket | undefined): () => void {
  return agent.ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name !== 'orchestrator_report' || (execution.arguments as { state?: string })?.state !== 'ready') return next()
    try {
      const config = bindingConsumer(ctx)
      if (config) {
        const current = ticket()
        if (!current || current.ended) throw new Error('B2: Ticket unavailable or ended')
        await writeBindingRecord({ config, ticket: current, sessionId: String(agent.session.header.id),
          prNumber: (execution.arguments as { pr_number?: number }).pr_number,
          events: async () => {
            const query = ctx.get('sessionQuery') as { readSession(id: string): Promise<{ events: Event[] }> } | undefined
            if (!query) throw new Error('B2: native Session query unavailable')
            return (await query.readSession(String(agent.session.header.id))).events
          } })
      }
    } catch (error) { return { kind: 'deny' as const, reason: `B2 binding writer failed: ${error instanceof Error ? error.message : String(error)}` } }
    return next()
  }, { prepend: true })
}
