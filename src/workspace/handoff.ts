import type { WorkspaceHandoffResult, WorkspaceOpenTarget, WorkspaceSnapshot } from './types'

export type InstanceGenerationScope = {
  instanceId: string
  instanceGeneration: number
}

export type PendingHandoffIdentity = InstanceGenerationScope & {
  id: string
  promptGeneration: number
  composerRevision: number
}

export function sameInstanceGeneration(
  left: InstanceGenerationScope,
  right: InstanceGenerationScope,
) {
  return left.instanceId === right.instanceId
    && left.instanceGeneration === right.instanceGeneration
}

export function handoffTargetMatchesSnapshot(
  target: WorkspaceOpenTarget,
  snapshot: Pick<WorkspaceSnapshot, 'instance' | 'instanceGeneration'>,
) {
  return sameInstanceGeneration(target, {
    instanceId: snapshot.instance.id,
    instanceGeneration: snapshot.instanceGeneration,
  })
}

export function handoffResultMatchesPending(
  pending: PendingHandoffIdentity,
  result: WorkspaceHandoffResult,
) {
  return pending.id === result.handoffId && sameInstanceGeneration(pending, result)
}

export function handoffSourceRevisionIsCurrent(
  pending: PendingHandoffIdentity,
  promptGeneration: number,
  composerRevision: number,
) {
  return pending.promptGeneration === promptGeneration
    && pending.composerRevision === composerRevision
}

export function handoffPayloadMatches(
  failed: { prompt: string; captures: Array<{ data_url: string }> },
  prompt: string,
  captures: Array<{ data_url: string }>,
) {
  return failed.prompt === prompt
    && failed.captures.length === captures.length
    && failed.captures.every((capture, index) => capture.data_url === captures[index]?.data_url)
}
