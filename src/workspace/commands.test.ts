import { describe, expectTypeOf, it } from 'vitest'
import type { InstanceScope, WorkspaceCommands } from './commands'
import type { GatewayFileData, SessionClientState } from './types'

type RequestOf<Name extends keyof WorkspaceCommands> = Parameters<WorkspaceCommands[Name]>[0]

describe('workspace command instance scoping', () => {
  it('requires active instance identity on every gateway mutation', () => {
    expectTypeOf<RequestOf<'createSession'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'resolveHandoffDestination'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'setSessionYolo'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'sessionAction'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'branchSession'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'sendTurn'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'executeSlash'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'steerTurn'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'stopTurn'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'retryMessage'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'editMessage'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'undo'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'submitInteraction'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'uploadAttachment'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'readGatewayFile'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'captureScreen'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'transcribeVoice'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'saveSchedule'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'scheduleAction'>>().toMatchTypeOf<InstanceScope>()
  })

  it('requires active instance identity on every gateway read', () => {
    expectTypeOf<RequestOf<'bootstrap'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'refresh'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'reconnect'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'profileOptions'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'resolveSessionProfile'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'sessionSummary'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'listSessions'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'messages'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'search'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'resolveSearchHit'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'listSchedules'>>().toMatchTypeOf<InstanceScope>()
    expectTypeOf<RequestOf<'scheduleRuns'>>().toMatchTypeOf<InstanceScope>()
  })

  it('returns backend-corrected state from recovery sync', () => {
    expectTypeOf<ReturnType<WorkspaceCommands['syncClientState']>>()
      .toEqualTypeOf<Promise<SessionClientState>>()
  })

  it('returns gateway bytes only through the scoped file command', () => {
    expectTypeOf<ReturnType<WorkspaceCommands['readGatewayFile']>>()
      .toEqualTypeOf<Promise<GatewayFileData>>()
  })
})
