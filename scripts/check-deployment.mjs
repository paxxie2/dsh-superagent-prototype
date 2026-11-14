#!/usr/bin/env node
/**
 * Check that a deployed dsh-superagent bundle is installed where DSH resolves
 * the driver's `@deepseek-ai/*` imports to the installation's own copies.
 *
 * Why this matters: DSH resolves bare imports of profile plugins against the
 * profile's node_modules first. A bundle placed *inside* `$DSH_HOME/profiles`
 * that carries its own `node_modules/@deepseek-ai/*` therefore loads private
 * copies of runtime packages (for example `@deepseek-ai/dsh-scope`). Those
 * copies keep module-private state — `scopeParentOf` is a WeakMap in that
 * module — so the driver sees a scope chain that the Host never bound:
 * `workOnly` then filters out every preset work tool (bash, read, subagent,
 * …) and a Worker Session starts with only the globally registered tools,
 * while the Host's own Sessions keep working. A bundle linked from *outside*
 * the profiles tree is resolved through DSH's "linked" interception layer,
 * which routes its runtime imports to the installation copies.
 *
 * Usage:
 *   node scripts/check-deployment.mjs --profile desktop
 *   node scripts/check-deployment.mjs --profile desktop --bundle <candidate-dir>
 *   node scripts/check-deployment.mjs --self-test
 *
 * Exit codes: 0 deployment layout is safe, 1 layout would shadow runtime
 * packages (or is otherwise unsafe), 2 usage error.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bundle package name the profile links; DSH reads its `dsh.bundle.patch`. */
export const BUNDLE_NAME = 'dsh-superagent'

const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Real path, or the resolved path when the target is missing (so a missing bundle is reported, not thrown). */
function realOrResolved(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Version of an installed package directory, or undefined when its manifest is unreadable. */
function packageVersion(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Packages under `bundleDir/node_modules/@deepseek-ai`, which makes the bundle carry runtime copies. */
export function vendoredRuntimePackages(bundleDir) {
  const root = join(bundleDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    found.push({ name: '@deepseek-ai/' + entry, version: packageVersion(dir) })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/** Bare `@deepseek-ai/*` package names imported by the bundle's shipped modules. */
export function importedRuntimePackages(bundleDir) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(path)
    }
  }
  walk(join(bundleDir, 'lib'))
  const imported = new Set()
  const pattern = /(?:^|[^\w$])(?:import|export)\s*(?:\(?\s*)(?:[^'"()]*?\sfrom\s*)?["'](@deepseek-ai\/[^"']+)["']/g
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) imported.add(match[1])
    for (const match of text.matchAll(/import\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/g)) imported.add(match[1])
  }
  return [...imported].sort()
}

/** Where Node resolves a bare package from the bundle's entry file, or the error code. */
function nativeResolution(bundleDir, name) {
  const main = join(bundleDir, 'lib', 'index.js')
  try {
    const resolved = createRequire(main).resolve(name)
    return { resolved, version: packageVersion(dirname(dirname(resolved))) }
  } catch (error) {
    return { error: error.code === undefined ? String(error.message) : error.code }
  }
}

/**
 * Classify one deployment.
 *
 * The two layouts DSH accepts:
 * - linked: the bundle's real path is outside the profiles tree; DSH routes its
 *   runtime imports to the installation copies, and the bundle must declare
 *   each imported runtime package as a peer so that routing is selected.
 * - profile-local: the bundle's real path is inside the profiles tree; it must
 *   not carry `node_modules/@deepseek-ai` copies, or those copies win.
 *
 * @param options - dshHome (Harness home), profile (profile name), bundle (candidate directory).
 * @returns classification with `ok` and every problem found.
 */
export function classifyDeployment(options) {
  const dshHome = realOrResolved(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profilesDir = join(dshHome, 'profiles')
  const profileDir = options.profile === undefined ? undefined : join(profilesDir, options.profile)
  const target = options.bundle ?? (profileDir === undefined ? undefined : join(profileDir, 'node_modules', BUNDLE_NAME))
  if (target === undefined) throw new Error('classifyDeployment: pass a profile name or a bundle directory')
  const bundleDir = realOrResolved(target)
  const problems = []

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
  } catch (error) {
    return { ok: false, bundleDir, profilesDir, profileDir, layer: undefined, problems: [{ code: 'bundle-unreadable', detail: `${bundleDir}/package.json: ${String(error.message)}` }] }
  }
  const underProfilesTree = within(realOrResolved(bundleDir), realOrResolved(profilesDir))
  const linked = !underProfilesTree
  const vendored = vendoredRuntimePackages(bundleDir)
  const imported = importedRuntimePackages(bundleDir)
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))

  if (linked) {
    const missingPeers = imported.filter((name) => !peers.has(name))
    if (missingPeers.length > 0) problems.push({
      code: 'missing-peer-declarations',
      detail: `a linked bundle is intercepted to the installation copies only for declared peers; declare ${missingPeers.join(', ')} in peerDependencies`
    })
  } else if (vendored.length > 0) {
    const shadows = vendored.filter((entry) => imported.includes(entry.name)).map((entry) => {
      const native = nativeResolution(bundleDir, entry.name)
      const version = entry.version === undefined ? '' : ` ${entry.version}`
      const resolvedPath = native.resolved === undefined ? native.error : native.resolved
      return `${entry.name}${version} resolves natively to ${resolvedPath}`
    })
    problems.push({
      code: 'vendored-runtime-packages-under-profiles-tree',
      detail: `the bundle's real path ${bundleDir} is inside ${profilesDir}, so DSH treats it as profile-owned and resolves its runtime imports natively: ${shadows.join('; ')}`
    })
  }

  return {
    ok: problems.length === 0,
    bundleDir,
    profilesDir,
    profileDir,
    layer: linked ? 'linked' : 'profile',
    vendored,
    imported,
    peers: [...peers].sort(),
    problems
  }
}

/** Fixture helpers for --self-test; each case writes one synthetic deployment and expects a pass or fail. */
function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-deploy-check-'))
  const write = (path, content) => {
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const bundle = (dir, peers) => {
    write(join(dir, 'package.json'), JSON.stringify({ name: BUNDLE_NAME, version: '0.1.0', peerDependencies: peers }))
    write(join(dir, 'lib', 'index.js'), 'import { scopeParentOf } from "@deepseek-ai/dsh-scope"\nexport default scopeParentOf\n')
  }
  const vendor = (dir, version) => {
    write(join(dir, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-scope', version }))
    write(join(dir, 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'), 'export const scopeParentOf = () => undefined\n')
  }
  const linkedHome = join(base, 'linked-home')
  const linkedBundle = join(base, 'linked-bundle')
  bundle(linkedBundle, { '@deepseek-ai/dsh-scope': '^0.2.1-alpha.2' })
  vendor(linkedBundle, '0.2.1-alpha.2')
  mkdirSync(join(linkedHome, 'profiles', 'test', 'node_modules'), { recursive: true })
  cpSync(join(linkedBundle, 'package.json'), join(linkedHome, 'profiles', 'test', 'package.json'))
  writeFileSync(join(linkedHome, 'profiles', 'test', 'node_modules', BUNDLE_NAME), '')

  const profileLocalHome = join(base, 'profile-local-home')
  const profileLocalBundle = join(profileLocalHome, 'profiles', 'test', 'releases', 'a')
  bundle(profileLocalBundle, { '@deepseek-ai/dsh-scope': '^0.2.1-alpha.2' })
  vendor(profileLocalBundle, '0.2.1-alpha.2')

  const cleanLocalHome = join(base, 'clean-local-home')
  const cleanLocalBundle = join(cleanLocalHome, 'profiles', 'test', 'releases', 'a')
  bundle(cleanLocalBundle, { '@deepseek-ai/dsh-scope': '^0.2.1-alpha.2' })

  const noPeersBundle = join(base, 'no-peers-bundle')
  bundle(noPeersBundle, {})

  const cases = [
    ['linked bundle outside the profiles tree', { dshHome: linkedHome, bundle: linkedBundle }, true, undefined],
    ['bundle inside the profiles tree that vendors runtime packages', { dshHome: profileLocalHome, bundle: profileLocalBundle }, false, 'vendored-runtime-packages-under-profiles-tree'],
    ['bundle inside the profiles tree without vendored runtime packages', { dshHome: cleanLocalHome, bundle: cleanLocalBundle }, true, undefined],
    ['linked bundle that does not declare its runtime imports as peers', { dshHome: linkedHome, bundle: noPeersBundle }, false, 'missing-peer-declarations']
  ]
  let failed = 0
  for (const [label, options, expectOk, expectCode] of cases) {
    const result = classifyDeployment(options)
    const code = result.problems[0]?.code
    const passed = result.ok === expectOk && (expectOk || code === expectCode)
    if (!passed) failed++
    process.stdout.write(`${passed ? 'ok  ' : 'FAIL'} ${label}${passed ? '' : ` -> ok=${result.ok} code=${code}`}\n`)
  }
  process.stdout.write(failed === 0 ? `self-test: 4/4 passed (${base})\n` : `self-test: ${failed} failed (${base})\n`)
  return failed === 0 ? 0 : 1
}

/** Parse `--flag value` pairs and bare `--flag`s. */
function parseArgs(argv) {
  const options = { selfTest: false, json: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--self-test') options.selfTest = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dsh-home' || arg === '--profile' || arg === '--bundle') options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const USAGE = `usage: node scripts/check-deployment.mjs [--profile <name>] [--dsh-home <dir>] [--bundle <dir>] [--json]

Checks that the deployed ${BUNDLE_NAME} bundle does not shadow the Host's
@deepseek-ai/* runtime packages. Run it before restarting the profile.
Exit 0 safe, 1 unsafe, 2 usage error.`

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (options.selfTest) return selfTest()
  let result
  try {
    result = classifyDeployment(options)
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n\n${USAGE}\n`)
    return 2
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.ok ? 0 : 1
  }
  const lines = [
    `bundle:      ${result.bundleDir}`,
    `profiles:    ${result.profilesDir}`,
    `layer:       ${result.layer ?? 'unreadable'}`,
    result.vendored.length === 0 ? 'vendored:    none' : `vendored:    ${result.vendored.map((entry) => entry.name + (entry.version === undefined ? '' : '@' + entry.version)).join(', ')}`,
    `layer rule:  ${result.layer === 'linked' ? 'outside the profiles tree -> runtime imports are intercepted to the installation copies' : 'inside the profiles tree -> local node_modules win over the installation copies'}`
  ]
  for (const problem of result.problems) lines.push(`PROBLEM ${problem.code}: ${problem.detail}`)
  lines.push(result.ok ? 'RESULT: safe to deploy' : 'RESULT: unsafe deployment layout')
  process.stdout.write(lines.join('\n') + '\n')
  return result.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
