# Ask Hermes Workspace Specification

## Goal

Add a fast, reliable Chats and Schedules workspace to Ask Hermes. It replaces the useful chat/session portion of Hermes Desktop without reproducing Hermes-wide configuration or coding-project features.

Hermes Gateway HTTP and WebSocket behavior is the contract. The workspace must work with Hermes Agent and compatible implementations.

## Product boundary

The workspace provides behavioral parity with Hermes Desktop's chat/session features, subject to the explicit adaptations and exclusions below. Parity means matching capabilities and semantics, not copying Hermes Desktop's layout or React architecture.

Included:

- Chat creation, continuation, history, streaming, search, rename, pin, branch, archive, restore, and permanent deletion
- Per-session running, queued, stalled, unread, error, and reconnect state
- Concurrent turns in different sessions and profiles
- One active turn per session, with visible editable/reorderable queued prompts that auto-send after settlement
- Stop/cancel, retry, edit/resubmit, steer, undo/rewind, copy, branch-from-message, safe links, code copying, and tool-detail collapsing
- In-chat tool calls, approvals, clarification requests, todos, subagent activity, background-task status, token/context usage, errors, and reconnect recovery
- Files, images, clipboard input, drag-and-drop, file picker, screen captures, URLs, and `@file`/`@folder`/`@url` references
- Remote-safe gateway attachment upload, eager upload state, queued attachments, and per-session drafts
- Inline rendering of images, files, tool output, and artifacts referenced by messages
- Compact per-chat model/provider, reasoning effort, Fast mode, personality, and YOLO/approval controls using choices reported by Hermes
- Existing Ask Hermes push-to-talk transcription
- Native notifications for background completion, approval/clarification requests, and configured schedule results
- Desktop-compatible keyboard behavior where it fits the simplified UI

Excluded:

- Hermes-wide settings and diagnostics UI
- Provider credentials, model catalog editing, and global-default editing
- Capabilities, Messaging, and standalone Artifacts managers
- Messaging configuration and handoff controls
- Projects, worktrees, Git/PR tools, terminal, console, file tree, checkpoints, and right preview rail
- Split panes, session tiles, draggable layouts, and pop-out chat windows
- Profiles creation, deletion, cloning, or configuration
- Skills/tools configuration UI, browser control, memory graph, pets, themes/skins, and JS-plugin-contributed UI
- Continuous voice-conversation mode and automatic text-to-speech replies
- Standalone performance benchmark suite

CLI remains the management surface for excluded Hermes configuration.

## Window model

- Add a separate persistent, resizable workspace window with standard Windows title bar, minimize/maximize, and taskbar presence.
- Keep the existing borderless, always-on-top prompt window.
- Both windows may coexist and observe shared session activity.
- Closing the workspace hides it to tray without stopping turns.
- Tray Quit exits the app; if turns or queued prompts exist, ask for confirmation.
- Login startup remains tray-only. Do not restore workspace open state, but do restore its geometry.
- Support automatic OS light/dark appearance only. No theme system.
- English only; centralize user-facing strings for possible future localization.

## Navigation and layout

Use Ask Hermes's compact visual language rather than cloning Hermes Desktop pixel-for-pixel.

Sidebar structure:

- New chat
- Search
- Profile selector, including All Profiles
- Pinned chats
- Recent chats
- Archived chats
- Schedules

The main pane shows one selected chat or schedule. No multipane layout.

Normal Desktop/workspace and CLI sessions appear at top level. Schedule runs live under schedules and remain searchable. Subagent/background child sessions appear under parent activity rather than recent chats. Messaging-origin sessions may be read and searched when returned by the gateway, but messaging controls stay excluded.

## Profiles

Profiles are in scope because both Hermes Agent and `derp-agent` use profile-specific sessions and schedules.

- Provide a compact profile switcher.
- Isolate chats, schedules, drafts, queues, and connection state by profile.
- Permit concurrent running sessions across profiles.
- Support an All Profiles view that aggregates chats and schedules with profile badges.
- Opening an aggregated item routes to the correct profile connection.
- Creating a chat or schedule requires a concrete profile and defaults to the last active one.
- Do not provide profile CRUD or configuration UI.

## Instances and backend lifecycle

Support named saved connections, with only one active instance at a time:

- **Automatic Hermes:** preserve current behavior and launch installed `hermes-agent` only. Lazily launch a profile-specific Hermes gateway when needed.
- **Existing instance:** connect to a supplied address, whether local or remote. Never launch, restart, or own that process. This is how `derp-agent` is used.
- Token remains optional and may use the current simple storage approach.

Profiles may maintain concurrent connections within one active instance. Do not keep two different instances active. Block instance switching while any current-instance turn is active or any queue is nonempty.

At connection time, detect server version and feature capabilities. Unsupported optional features remain visible but disabled with the exact missing-API reason. Core incompatibility blocks workspace use with actionable server details. Never fall back to reading a local database or filesystem.

## Gateway-only data access

All session listing, history, search, creation, continuation, branching, rename, pinning, archive/restore, deletion, scheduling, and live activity use Hermes Gateway HTTP/WebSocket APIs.

Direct writes to `state.db` are forbidden. Workspace behavior must be identical for local and remote instances.

While connected:

- Use gateway events for live state.
- Use lightweight refresh/polling only where events do not cover authoritative lists.
- Pause background polling while windows are hidden where safe.
- Reflect changes made by CLI or Hermes Desktop automatically.

While disconnected:

- Keep last-loaded data in memory only.
- Show a clear disconnected banner.
- Disable sends and mutations.
- Retry automatically.
- Reload authoritative state after reconnect.
- Do not persist transcript cache.

## Turn and queue semantics

Match Hermes Desktop behavior:

- Different sessions may run concurrently.
- Each session has at most one active gateway turn.
- Additional sends enter a client-side per-session queue.
- Queue entries are visible, editable, reorderable, removable, and may include attachments.
- Queue drains automatically after the active turn settles.
- Stop interrupts only the active turn; queued prompts remain until removed.
- Switching chats or profiles does not lose running state, timer, stream, queue, or draft.
- Reconnect restores server-reported running sessions without opening them.
- Prompt and workspace share per-session activity, queue, and live stream state.

## Prompt and tray integration

Prompt behavior:

- Prompt remains fully usable as a standalone compact chat.
- Add Open in workspace for the active profile/session.
- Handoff preserves live stream, queue, and draft state, then hides prompt.
- Closing either window never cancels work.
- The configurable global prompt shortcut (`Alt+Space` by default) always toggles prompt without affecting workspace.

Tray behavior:

- Open Ask Hermes opens prompt.
- Open workspace opens workspace.
- Open previous chat and configured session shortcuts continue opening compact prompt.
- Tray double-click opens workspace.
- Setting controls whether Hermes Desktop link is replaced by workspace, shown alone, or shown alongside workspace.

## Session lifecycle and search

Match Hermes Desktop lifecycle semantics:

- Archive is the normal reversible removal action.
- Restore is available from Archived.
- Permanent deletion is available only from Archived and requires confirmation.
- Mutations always use gateway APIs.
- Preserve branch ancestry, running/unread indicators, pagination, and pin/rename behavior.

Search is gateway-backed full-text search over titles and message content. It supports selected-profile and All Profiles scope plus active/archived, source, and date filters. Results open the exact message context. Do not build a local transcript index or scan local files.

## Composer and chat controls

Keep composer visually clean. Put most runtime controls in a compact per-chat options menu. A small model/status control may remain visible.

Supported slash surface:

- Chat-local actions such as `/new`, `/branch`, `/title`, `/model`, and `/resume`
- Useful backend commands such as `/agents`, `/background`, `/compress`, `/goal`, `/personality`, `/queue`, `/retry`, `/status`, `/steer`, `/stop`, `/undo`, `/usage`, and `/version`
- Backend-provided skill commands

Exclude commands tied to messaging, profiles configuration, themes, browser management, memory graph, pets, tools configuration, rollback/checkpoints, settings, terminal-only behavior, and JS-plugin UI.

## Schedules

Provide full agent-schedule management through gateway APIs:

- List and search
- Create and edit name, prompt, cron expression, model, and provider
- Pause/resume
- Run now
- Show state, errors, next run, last run, and run history
- Open run sessions
- Delete with confirmation
- Support selected-profile and All Profiles views

Existing script-only or messaging-delivery jobs remain visible and controllable. Preserve unsupported script/delivery fields during edits, but do not expose script or delivery configuration UI.

## Notifications and minimal diagnostics

Notify only when neither relevant window has focus. Supported categories:

- Turn completion
- Approval or clarification required
- Schedule failure
- Schedule completion when enabled

Clicking a notification opens the correct instance, profile, session, schedule, or run. Provide simple category toggles in Ask Hermes settings.

Do not add a diagnostics section. Connection banners may show connection state, reconnect action, backend/version/profile, and Copy error details. Detailed logs remain CLI/filesystem territory.

## Local persistence

Persist only UI state:

- Workspace geometry
- Last instance/profile/session
- Sidebar expansion and selection state
- Per-session drafts
- Queued prompts
- Already-created gateway attachment references
- Notification and tray-link preferences

Key state by instance, profile, and session. Do not persist transcripts or raw attachment bytes.

## Performance guidance

Treat performance as an architectural constraint, not a benchmark suite:

- Warm workspace should appear around 300 ms.
- Local session list should normally become usable within one second.
- Avoid typing or streaming stalls above 50 ms.
- Virtualize long session lists and transcripts.
- Paginate history; never eagerly load every message.
- Pause unnecessary polling while hidden.
- Opening workspace must never launch Hermes Desktop.

Use manual profiling and code review to catch obviously expensive behavior. Do not add slow permanent performance tests.

## Implementation and testing strategy

Implement workspace in this repository using Solid and Tauri. Do not transplant Hermes Desktop's React state/UI architecture. Reuse protocol shapes, behavioral knowledge, and relevant algorithms while building a typed gateway client, per-instance/profile session state machine, and focused Solid views.

Hermes Desktop tests are reference material only. Every parity test must respect this document's explicit adaptations and exclusions.

Testing should include:

- Focused unit tests for protocol mapping, profile/session state, queues, reconnect recovery, lifecycle mutations, schedules, persistence, and capability gating
- Broad end-to-end tests against a fully mocked gateway
- A packaged Windows release startup smoke that verifies native setup remains alive and WebView2 loads bundled frontend rather than the Vite development server
- No dependency on installed Hermes Agent, `derp-agent`, live network services, or user data
- No visual snapshot suite or permanent performance benchmark suite

## Release acceptance

Release requires functional completion of this specification rather than partial UI parity. Internal implementation may proceed in phases, but excluded features must not leak into scope and included chat/session behavior must follow the gateway-backed semantics above.
