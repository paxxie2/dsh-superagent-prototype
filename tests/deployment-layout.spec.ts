/**
 * The deployment-layout contract DSH resolution imposes on the bundle.
 *
 * DSH resolves a profile plugin's bare imports against the profile's
 * node_modules first. A bundle that lives inside `$DSH_HOME/profiles` and
 * carries its own `node_modules/@deepseek-ai/*` therefore loads private copies
 * of runtime packages; module-private state such as `@deepseek-ai/dsh-scope`'s
 * scope WeakMap then disagrees with the Host, `workOnly`'s `scopeParentOf` call
 * sees no preset scope and a Worker Session starts with only the globally
 * registered tools. A bundle linked from outside the profiles tree is resolved
 * through DSH's "linked" interception layer instead, which routes those imports
 * to the installation copies. These tests pin the two accepted layouts and the
 * two rejected ones with synthetic trees; `scripts/check-deployment.mjs` runs
 * the same classification against a real profile.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyDeployment, importedRuntimePackages, vendoredRuntimePackages } from '../scripts/check-deployment.mjs'

const base = mkdtempSync(join(tmpdir(), 'dsh-deployment-layout-'))
const caseDir = (name: string): string => {
  const dir = join(base, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const write = (file: string, content: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}
/** A bundle manifest plus one shipped module that imports the scope package. */
const bundle = (dir: string, peers: Record<string, string> = { '@deepseek-ai/dsh-scope': '^0.2.1-alpha.2' }, source = 'import { scopeParentOf } from "@deepseek-ai/dsh-scope"\nexport default scopeParentOf\n'): string => {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-superagent', version: '0.1.0', peerDependencies: peers }))
  write(join(dir, 'lib', 'index.js'), source)
  return dir
}
/** Vendored runtime package copies, as a development install leaves them. */
const vendor = (dir: string, name: string, version: string): void => {
  write(join(dir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ name, version }))
  write(join(dir, 'node_modules', ...name.split('/'), 'lib', 'index.js'), 'export const scopeParentOf = () => undefined\n')
}

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('deployment layout accepted by DSH resolution', () => {
  it('accepts a bundle linked from outside the profiles tree, even with a development install', () => {
    const home = caseDir('linked-home')
    const dir = bundle(caseDir('linked-bundle'))
    vendor(dir, '@deepseek-ai/dsh-scope', '0.2.1-alpha.2')
    mkdirSync(join(home, 'profiles', 'test'), { recursive: true })
    write(join(home, 'profiles', 'test', 'package.json'), '{"name":"dsh-profile-test","private":true}')
    write(join(home, 'profiles', 'test', 'node_modules', 'dsh-superagent', 'placeholder'), '')

    const result = classifyDeployment({ dshHome: home, bundle: dir })

    expect(result.layer).toBe('linked')
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('accepts a bundle inside the profiles tree when it ships no runtime copies', () => {
    const home = caseDir('clean-home')
    const dir = bundle(join(home, 'profiles', 'test', 'releases', 'a'))

    const result = classifyDeployment({ dshHome: home, bundle: dir })

    expect(result.layer).toBe('profile')
    expect(result.vendored).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('deployment layouts DSH resolution breaks', () => {
  it('rejects a bundle inside the profiles tree that vendors runtime packages', () => {
    const home = caseDir('vendored-home')
    const dir = bundle(join(home, 'profiles', 'test', 'releases', 'a'))
    vendor(dir, '@deepseek-ai/dsh-scope', '0.2.1-alpha.2')

    const result = classifyDeployment({ dshHome: home, bundle: dir })

    expect(result.layer).toBe('profile')
    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.code)).toEqual(['vendored-runtime-packages-under-profiles-tree'])
    expect(result.problems[0]?.detail).toContain('@deepseek-ai/dsh-scope 0.2.1-alpha.2')
    expect(result.problems[0]?.detail).toContain('resolves natively to')
  })

  it('rejects a linked bundle that does not declare an imported runtime package as a peer', () => {
    const home = caseDir('peer-home')
    const dir = bundle(caseDir('peer-bundle'), {})

    const result = classifyDeployment({ dshHome: home, bundle: dir })

    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.code)).toEqual(['missing-peer-declarations'])
    expect(result.problems[0]?.detail).toContain('@deepseek-ai/dsh-scope')
  })
})

describe('bundle inspection', () => {
  it('reads vendored runtime packages with their versions', () => {
    const dir = bundle(caseDir('inspect-bundle'))
    vendor(dir, '@deepseek-ai/dsh-scope', '0.2.1-alpha.2')
    vendor(dir, '@deepseek-ai/dsh-tools', '0.2.1-alpha.2')

    expect(vendoredRuntimePackages(dir)).toEqual([
      { name: '@deepseek-ai/dsh-scope', version: '0.2.1-alpha.2' },
      { name: '@deepseek-ai/dsh-tools', version: '0.2.1-alpha.2' }
    ])
  })

  it('reads static and dynamic runtime imports from shipped modules', () => {
    const dir = bundle(caseDir('imports-bundle'), {}, [
      'import { a } from "@deepseek-ai/dsh-scope"',
      'import type { B } from "@deepseek-ai/dsh-agent"',
      'const tools = await import("@deepseek-ai/dsh-tools")',
      'import { z } from "zod"',
      'export { c } from "@deepseek-ai/dsh-llm"',
      ''
    ].join('\n'))

    expect(importedRuntimePackages(dir)).toEqual([
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-tools'
    ])
  })
})
