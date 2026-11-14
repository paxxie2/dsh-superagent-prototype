/** Types for scripts/check-deployment.mjs, which has no build step. */

export interface VendoredRuntimePackage {
  name: string
  version: string | undefined
}

export interface DeploymentProblem {
  code: string
  detail: string
}

export interface DeploymentClassification {
  ok: boolean
  bundleDir: string
  profilesDir: string
  profileDir: string | undefined
  layer: 'linked' | 'profile' | undefined
  vendored: VendoredRuntimePackage[]
  imported: string[]
  peers: string[]
  problems: DeploymentProblem[]
}

export interface ClassifyOptions {
  dshHome?: string
  profile?: string
  bundle?: string
}

export const BUNDLE_NAME: string

export function classifyDeployment(options: ClassifyOptions): DeploymentClassification

export function vendoredRuntimePackages(bundleDir: string): VendoredRuntimePackage[]

export function importedRuntimePackages(bundleDir: string): string[]
