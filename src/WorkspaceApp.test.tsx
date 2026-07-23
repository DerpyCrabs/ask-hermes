// @vitest-environment jsdom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleWorkspaceQuitRequest, MessageCard, workspaceSearchAction } from './WorkspaceApp'
import type { GatewayFileData, WorkspaceCapabilities, WorkspaceMessage } from './workspace/types'

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length) disposers.pop()?.()
  document.body.textContent = ''
})

describe('workspace quit persistence handshake', () => {
  it('flushes before an unconfirmed quit and skips the confirmation dialog', () => {
    const order: string[] = []
    const confirm = vi.fn(() => { order.push('confirm'); return true })
    const quit = vi.fn(async () => { order.push('quit') })

    expect(handleWorkspaceQuitRequest(
      { confirmationRequired: false },
      () => order.push('flush'),
      confirm,
      quit,
    )).toBe(true)

    expect(order).toEqual(['flush', 'quit'])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('flushes before confirmation and does not exit when confirmation is declined', () => {
    const order: string[] = []
    const quit = vi.fn(async () => { order.push('quit') })
    const cancel = vi.fn(async () => { order.push('cancel') })

    expect(handleWorkspaceQuitRequest(
      { confirmationRequired: true },
      () => order.push('flush'),
      () => { order.push('confirm'); return false },
      quit,
      cancel,
    )).toBe(false)

    expect(order).toEqual(['flush', 'confirm', 'cancel'])
    expect(quit).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('workspace capability actions', () => {
  it('disables search and exposes the exact missing-API reason', () => {
    const reason = 'Gateway does not expose GET /api/sessions/search'
    const capabilities = {
      sessionSearch: { supported: false, reason },
    } as WorkspaceCapabilities

    expect(workspaceSearchAction(capabilities, 'needle', false)).toEqual({ disabled: true, reason })
  })
})

function mountMessage(
  message: WorkspaceMessage,
  onInteraction: () => void | Promise<void> = () => undefined,
  gatewayFiles: {
    reason?: string
    read?(path: string): Promise<GatewayFileData>
    open?(path: string, name: string): void | Promise<void>
  } = {},
) {
  const root = document.createElement('div')
  document.body.append(root)
  const openLink = vi.fn()
  disposers.push(render(() => (
    <MessageCard
      message={message}
      disabled={false}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onEdit={() => undefined}
      onBranch={() => undefined}
      onUndo={() => undefined}
      onInteraction={onInteraction}
      onOpenLink={openLink}
      gatewayFileReason={gatewayFiles.reason}
      onReadGatewayFile={gatewayFiles.read}
      onOpenGatewayFile={gatewayFiles.open}
      actionReasons={{}}
    />
  ), root))
  return { root, openLink }
}

describe('rich historical message rendering', () => {
  it('previews and opens gateway-local artifacts and attachment paths through scoped callbacks', async () => {
    const read = vi.fn(async (path: string): Promise<GatewayFileData> => ({
      name: path.split('/').pop() || 'image.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    }))
    const open = vi.fn()
    const { root } = mountMessage({
      id: 'assistant-files',
      sessionId: 'session-1',
      profileId: 'default',
      role: 'assistant',
      content: 'Files ready.',
      createdAt: '2026-07-22T12:00:00Z',
      status: 'complete',
      attachments: [{
        id: 'attachment-image', name: 'attachment.png', mimeType: 'image/png', size: 5,
        state: 'ready', url: '/gateway/attachment.png',
      }],
      artifacts: [{
        id: 'artifact-image', kind: 'image', name: 'artifact.png', value: '/gateway/artifact.png', mimeType: 'image/png',
      }],
    }, undefined, { read, open })

    await vi.waitFor(() => expect(root.querySelectorAll('img')).toHaveLength(2))
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual(['/gateway/artifact.png', '/gateway/attachment.png'])

    root.querySelector<HTMLButtonElement>('.workspace-attachment-reference')!.click()
    root.querySelector<HTMLButtonElement>('.workspace-artifact-reference')!.click()
    expect(open).toHaveBeenCalledWith('/gateway/attachment.png', 'attachment.png')
    expect(open).toHaveBeenCalledWith('/gateway/artifact.png', 'artifact.png')
  })

  it('capability-gates gateway-local file reads with exact reason', async () => {
    const read = vi.fn()
    const { root } = mountMessage({
      id: 'assistant-file-disabled', sessionId: 'session-1', profileId: 'default', role: 'assistant',
      content: '', createdAt: '2026-07-22T12:00:00Z', status: 'complete',
      artifacts: [{ id: 'file', kind: 'file', name: 'report.pdf', value: '/gateway/report.pdf' }],
    }, undefined, { reason: 'Gateway does not expose GET /api/fs/read-data-url', read })

    await Promise.resolve()
    const button = root.querySelector<HTMLButtonElement>('.workspace-artifact-reference')!
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('/api/fs/read-data-url')
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps rich message details compact without rendering token usage', () => {
    const { root } = mountMessage({
      id: 'assistant-1',
      sessionId: 'session-1',
      profileId: 'default',
      role: 'assistant',
      content: 'Report ready.',
      createdAt: '2026-07-22T12:00:00Z',
      status: 'complete',
      attachments: [{
        id: 'file-1', name: 'input.pdf', mimeType: 'application/pdf', size: 12, state: 'ready', reference: 'reports/input.pdf',
      }],
      artifacts: [
        { id: 'a-1', kind: 'file', name: 'report.pdf', value: '/tmp/report.pdf' },
        { id: 'a-2', kind: 'link', name: 'download', value: 'https://example.test/download', url: 'https://example.test/download' },
      ],
      tools: [{
        id: 'tool-1', name: 'write_file', status: 'complete', input: '{\n  "path": "/tmp/report.pdf"\n}', output: '{\n  "written": true\n}',
      }],
      todos: [{ id: 'todo-1', content: 'Build report', status: 'completed', priority: 'high' }],
      reasoning: 'Checked source material.',
      usage: { scope: 'message', inputTokens: 120, outputTokens: 30, totalTokens: 150, contextTokens: 400, contextMaxTokens: 1000 },
    })

    expect(root.querySelector('.workspace-attachment-reference')?.textContent).toContain('input.pdf')
    expect(root.querySelector('.workspace-message-attachments a')).toBeNull()
    expect(root.querySelector('.workspace-tool')?.textContent).toContain('write_file')
    expect(root.querySelector('.workspace-tool')?.textContent).toContain('written')
    expect(root.querySelector('.workspace-todos')?.textContent).toContain('1/1 complete')
    expect(root.querySelector('.workspace-reasoning')?.textContent).toContain('Checked source material.')
    expect(root.querySelector('.workspace-artifacts')?.textContent).toContain('/tmp/report.pdf')
    expect(root.querySelectorAll('.workspace-artifacts a')).toHaveLength(1)
    expect(root.querySelector('.workspace-usage')).toBeNull()
    expect(root.textContent).not.toContain('150 total')
    expect(root.textContent).not.toContain('400 context')
  })

  it('renders recorded and pending historical interactions without dead response controls', () => {
    const { root } = mountMessage({
      id: 'assistant-2',
      sessionId: 'session-1',
      profileId: 'default',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-22T12:00:00Z',
      status: 'complete',
      interactions: [
        { id: 'resolved', kind: 'clarification', title: 'Which format?', resolved: true, response: 'PDF', respondable: false },
        { id: 'pending', kind: 'approval', title: 'Run command?', resolved: false, respondable: false, options: [{ id: 'once', label: 'Approve once' }] },
      ],
    })

    expect(root.textContent).toContain('Which format?')
    expect(root.textContent).toContain('PDF')
    expect(root.textContent).toContain('Historical request')
    expect(root.querySelectorAll('.workspace-interaction button')).toHaveLength(0)
    expect(root.querySelectorAll('.workspace-interaction input')).toHaveLength(0)
  })

  it('submits a live interaction only once while the gateway response is pending', async () => {
    let resolveSubmit!: () => void
    const pending = new Promise<void>(resolve => { resolveSubmit = resolve })
    const onInteraction = vi.fn(() => pending)
    const { root } = mountMessage({
      id: 'assistant-3',
      sessionId: 'session-1',
      profileId: 'default',
      role: 'assistant',
      content: '',
      createdAt: '2026-07-22T12:00:00Z',
      status: 'complete',
      interactions: [{
        id: 'approval',
        kind: 'approval',
        title: 'Run command?',
        resolved: false,
        respondable: true,
        options: [{ id: 'once', label: 'Approve once' }],
      }],
    }, onInteraction)

    const button = root.querySelector<HTMLButtonElement>('.workspace-interaction button')!
    button.click()
    button.click()

    expect(onInteraction).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    resolveSubmit()
    await pending
    await Promise.resolve()
    expect(button.disabled).toBe(true)
  })
})
