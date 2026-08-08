#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { remote } from 'webdriverio'

const MODEL = 'gpt-5.2'
const TEXT_PROMPT = 'E2E_TEXT_TURN'
const SECOND_PROMPT = 'E2E_MULTI_SECOND'
const QUEUE_FIRST_PROMPT = 'E2E_QUEUE_FIRST'
const QUEUE_SECOND_PROMPT = 'E2E_QUEUE_SECOND'
const RENAMED_CHAT = 'Linux E2E chat'
const SCHEDULE_NAME = 'Linux E2E schedule'

function responseEvent(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
}

function completedResponse(sequence, model, text) {
  const messageId = `msg_e2e_${sequence}`
  const item = {
    type: 'message',
    id: messageId,
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return { messageId, item, model }
}

async function startMockProvider() {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname.replace(/\/$/, '')
    if (request.method === 'GET' && (requestPath === '/models' || requestPath === '/v1/models')) {
      const body = JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'e2e' }] })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (request.method !== 'POST' || (requestPath !== '/responses' && requestPath !== '/v1/responses')) {
      response.writeHead(404).end()
      return
    }

    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const sequence = requests.push(body) - 1
    const serialized = JSON.stringify(body)
    const text = serialized.includes(QUEUE_SECOND_PROMPT)
      ? 'E2E_QUEUE_SECOND_OK'
      : serialized.includes(QUEUE_FIRST_PROMPT)
        ? 'E2E_QUEUE_FIRST_OK'
        : serialized.includes(SECOND_PROMPT)
          ? 'E2E_MULTI_OK'
      : serialized.includes(TEXT_PROMPT) ? 'E2E_TEXT_OK' : 'E2E_MOCK_OK'
    const result = completedResponse(sequence, body.model || MODEL, text)

    if (serialized.includes(QUEUE_FIRST_PROMPT) && !serialized.includes(QUEUE_SECOND_PROMPT)) {
      await delay(1_500)
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    })
    responseEvent(response, 'response.output_item.added', {
      output_index: 0,
      item: {
        type: 'message',
        id: result.messageId,
        role: 'assistant',
        status: 'in_progress',
        phase: 'final_answer',
        content: [],
      },
    })
    responseEvent(response, 'response.output_text.delta', {
      item_id: result.messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    })
    responseEvent(response, 'response.output_text.done', {
      item_id: result.messageId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    })
    responseEvent(response, 'response.output_item.done', { output_index: 0, item: result.item })
    responseEvent(response, 'response.completed', {
      response: {
        id: `resp_e2e_${sequence}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: result.model,
        output: [result.item],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function prepareHermesState(root, providerUrl) {
  const hermesState = path.join(root, 'hermes')
  const isolatedUser = path.join(root, 'user')
  for (const directory of [
    hermesState,
    isolatedUser,
    path.join(hermesState, 'cron'),
    path.join(hermesState, 'memories'),
    path.join(hermesState, 'skills'),
    path.join(hermesState, 'cache'),
    path.join(hermesState, 'images'),
  ]) fs.mkdirSync(directory, { recursive: true })

  fs.writeFileSync(path.join(hermesState, 'config.yaml'), `model:
  default: ${MODEL}
  provider: openai-codex
  base_url: ${providerUrl}
agent:
  max_turns: 8
  api_max_retries: 1
  reasoning_effort: low
  default_personality: helpful
  personalities:
    helpful: You are a helpful assistant.
compression:
  enabled: false
memory:
  memory_enabled: false
  user_profile_enabled: false
auxiliary:
  title_generation:
    enabled: false
  background_review:
    enabled: false
streaming:
  enabled: true
display:
  show_reasoning: false
  streaming: true
stt:
  enabled: false
approvals:
  mode: 'off'
platform_toolsets:
  cli:
    - file
_config_version: 33
`)
  fs.writeFileSync(path.join(hermesState, '.env'), `HERMES_CODEX_BASE_URL=${providerUrl}\n`)
  fs.writeFileSync(path.join(hermesState, 'auth.json'), JSON.stringify({
    version: 1,
    active_provider: 'openai-codex',
    providers: {
      'openai-codex': {
        tokens: { access_token: 'e2e-access-fixture', refresh_token: 'e2e-refresh-fixture' },
        last_refresh: '2026-07-23T00:00:00Z',
        auth_mode: 'chatgpt',
      },
    },
    credential_pool: {
      'openai-codex': [{
        id: 'e2e-mock-codex',
        label: 'E2E mock provider',
        auth_type: 'oauth',
        priority: 0,
        source: 'manual:device_code',
        access_token: 'e2e-access-fixture',
        refresh_token: 'e2e-refresh-fixture',
        base_url: providerUrl,
        last_refresh: '2026-07-23T00:00:00Z',
      }],
    },
  }, null, 2))
  return { hermesState, isolatedUser }
}

async function waitForDriver(port, process) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`tauri-driver exited with code ${process.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      if (response.ok) return
    } catch {
      // Driver still starting.
    }
    await delay(100)
  }
  throw new Error('tauri-driver did not become ready')
}

async function waitForText(browser, text, timeout = 60_000) {
  await browser.waitUntil(async () => (await browser.$('body').getText()).includes(text), {
    timeout,
    timeoutMsg: `Workspace did not show ${JSON.stringify(text)}`,
  })
}

async function selectWorkspaceWindow(browser) {
  await browser.waitUntil(async () => (await browser.getWindowHandles()).length >= 2, {
    timeout: 30_000,
    timeoutMsg: 'Tauri did not expose workspace WebView window',
  })
  for (const handle of await browser.getWindowHandles()) {
    await browser.switchToWindow(handle)
    if (await browser.$('.workspace-shell').isExisting()) return
  }
  throw new Error('No Tauri WebView window contains workspace UI')
}

async function chatOption(browser, label) {
  const details = await browser.$('.workspace-chat-actions details')
  if (!(await details.getAttribute('open'))) await details.$('summary').click()
  const button = await browser.$(`//div[contains(@class,"workspace-chat-actions")]//button[normalize-space(.)=${JSON.stringify(label)}]`)
  await button.waitForDisplayed({ timeout: 10_000 })
  await browser.waitUntil(() => button.isEnabled(), {
    timeout: 10_000,
    timeoutMsg: `Chat option ${JSON.stringify(label)} remained disabled`,
  })
  return button
}

async function startVirtualDisplay(environment) {
  if (environment.DISPLAY || environment.WAYLAND_DISPLAY) return undefined
  const executable = '/usr/bin/Xvfb'
  if (!fs.existsSync(executable)) {
    throw new Error('Headless Linux E2E requires Xvfb (expected /usr/bin/Xvfb)')
  }
  const displayNumber = Array.from({ length: 110 }, (_, index) => index + 90)
    .find(candidate => !fs.existsSync(`/tmp/.X11-unix/X${candidate}`))
  if (!displayNumber) throw new Error('No unused X11 display number is available')
  const process = spawn(executable, [
    `:${displayNumber}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp',
  ], { stdio: 'ignore' })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Xvfb exited with code ${process.exitCode}`)
    if (fs.existsSync(`/tmp/.X11-unix/X${displayNumber}`)) {
      return { process, display: `:${displayNumber}` }
    }
    await delay(50)
  }
  process.kill('SIGTERM')
  throw new Error('Xvfb did not become ready')
}

async function run() {
  if (process.platform !== 'linux') throw new Error('Linux E2E test must run on Linux')
  const repository = path.resolve(import.meta.dirname, '..')
  const application = path.join(repository, 'src-tauri', 'target', 'release', 'ask-hermes')
  const hermesBinary = process.env.HERMES_AGENT_BINARY
    || path.join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes')
  const tauriDriver = process.env.TAURI_DRIVER
    || path.join(os.homedir(), '.cargo', 'bin', 'tauri-driver')
  for (const [label, candidate] of Object.entries({ application, hermesBinary, tauriDriver })) {
    if (!fs.existsSync(candidate)) throw new Error(`${label} missing: ${candidate}`)
  }

  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-hermes-linux-e2e-'))
  const provider = await startMockProvider()
  const state = prepareHermesState(isolationRoot, provider.url)
  const driverPort = 4444
  const virtualDisplay = await startVirtualDisplay(process.env)
  const childEnvironment = {
    ...process.env,
    ...(virtualDisplay ? { DISPLAY: virtualDisplay.display } : {}),
    XDG_CONFIG_HOME: path.join(state.isolatedUser, 'config'),
    XDG_DATA_HOME: path.join(state.isolatedUser, 'data'),
    XDG_CACHE_HOME: path.join(state.isolatedUser, 'cache'),
    HERMES_HOME: state.hermesState,
    HERMES_AGENT_BINARY: hermesBinary,
    HERMES_CODEX_BASE_URL: provider.url,
    ASK_HERMES_E2E_OPEN_WORKSPACE: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    NO_COLOR: '1',
  }
  const driver = spawn(tauriDriver, [
    '--port', String(driverPort),
    '--native-driver', '/usr/bin/WebKitWebDriver',
  ], { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
  const driverExit = new Promise(resolve => driver.once('exit', resolve))
  let driverLog = ''
  let failureDetails = ''
  let failed = false
  driver.stdout.on('data', chunk => { driverLog += chunk })
  driver.stderr.on('data', chunk => { driverLog += chunk })
  let browser
  try {
    await waitForDriver(driverPort, driver)
    browser = await remote({
      hostname: '127.0.0.1',
      port: driverPort,
      logLevel: 'error',
      capabilities: {
        'tauri:options': { application },
      },
    })

    await selectWorkspaceWindow(browser)
    const workspace = await browser.$('.workspace-shell')
    await workspace.waitForDisplayed({ timeout: 30_000 })
    const newChat = await browser.$('.workspace-new-chat')
    await browser.waitUntil(async () => await newChat.isEnabled(), {
      timeout: 60_000,
      timeoutMsg: 'Workspace never connected to real Hermes Agent',
    })
    await newChat.click()

    const composer = await browser.$('.workspace-composer textarea')
    await composer.waitForEnabled({ timeout: 30_000 })
    await composer.setValue(TEXT_PROMPT)
    await browser.$('.workspace-send').click()
    await waitForText(browser, 'E2E_TEXT_OK', 45_000)
    const usage = await browser.$('.workspace-usage')
    await usage.waitForDisplayed({ timeout: 15_000 })
    assert((await usage.getText()).includes('16 tokens'), 'live Hermes token usage must be visible')

    await composer.setValue(SECOND_PROMPT)
    await browser.$('.workspace-send').click()
    await waitForText(browser, 'E2E_MULTI_OK')

    await composer.setValue(QUEUE_FIRST_PROMPT)
    await browser.$('.workspace-send').click()
    await browser.$('.workspace-chat-actions .danger').waitForDisplayed({ timeout: 15_000 })
    await composer.setValue(QUEUE_SECOND_PROMPT)
    await browser.$('.workspace-send').click()
    const queue = await browser.$('.workspace-queue')
    await queue.waitForDisplayed({ timeout: 10_000 })
    assert.equal(await queue.$('textarea').getValue(), QUEUE_SECOND_PROMPT, 'follow-up must appear in visible queue')
    await waitForText(browser, 'E2E_QUEUE_FIRST_OK')
    await waitForText(browser, 'E2E_QUEUE_SECOND_OK')
    await queue.waitForExist({ reverse: true, timeout: 30_000 })
    await composer.click()
    await browser.keys('ArrowUp')
    await browser.waitUntil(async () => (await composer.getValue()) === QUEUE_SECOND_PROMPT, {
      timeout: 10_000,
      timeoutMsg: 'ArrowUp did not recall the latest sent prompt',
    })
    await browser.keys('ArrowDown')
    await browser.waitUntil(async () => (await composer.getValue()) === '', {
      timeout: 10_000,
      timeoutMsg: 'ArrowDown did not restore the empty composer draft',
    })

    await (await chatOption(browser, 'Pin')).click()
    await browser.waitUntil(async () => (await chatOption(browser, 'Unpin')).isEnabled(), {
      timeout: 10_000,
      timeoutMsg: 'Pin action did not update workspace UI',
    })
    assert(/pinned/i.test(await browser.$('.workspace-nav').getText()), 'pinned section must be visible')

    await (await chatOption(browser, 'Rename')).click()
    await browser.waitUntil(async () => {
      try {
        await browser.getAlertText()
        return true
      } catch {
        return false
      }
    }, { timeout: 5_000, timeoutMsg: 'Rename prompt did not open' })
    await browser.sendAlertText(RENAMED_CHAT)
    await browser.acceptAlert()
    await browser.waitUntil(async () => (await browser.$('.workspace-chat-header h1').getText()) === RENAMED_CHAT, {
      timeout: 15_000,
      timeoutMsg: 'Renamed title did not appear',
    })

    await (await chatOption(browser, 'Archive')).click()
    await browser.$('.workspace-chat').waitForExist({ reverse: true, timeout: 15_000 })
    const archivedButton = await browser.$('//footer[contains(@class,"workspace-sidebar-footer")]//button[contains(.,"Archived chats")]')
    await archivedButton.click()
    const archivedRow = await browser.$(`//button[contains(@class,"workspace-session-row") and contains(.,${JSON.stringify(RENAMED_CHAT)})]`)
    await archivedRow.waitForClickable({ timeout: 15_000 })
    await archivedRow.click()
    await (await chatOption(browser, 'Restore')).click()
    await chatOption(browser, 'Archive')

    const primaryActions = await browser.$$('.workspace-primary-actions button')
    await primaryActions[1].click()
    const search = await browser.$('.workspace-search-form input[placeholder="Search messages"]')
    await search.setValue(TEXT_PROMPT)
    await browser.$('.workspace-search-form button[type="submit"]').click()
    const result = await browser.$('.workspace-search-results button')
    await result.waitForClickable({ timeout: 15_000 })
    assert((await result.getText()).includes(TEXT_PROMPT), 'search result must expose matching message')
    await result.click()
    await waitForText(browser, 'E2E_TEXT_OK')
    assert((await browser.$('body').getText()).includes(TEXT_PROMPT), 'user prompt must remain in transcript')

    const schedulesButton = await browser.$('//footer[contains(@class,"workspace-sidebar-footer")]//button[contains(.,"Schedules")]')
    await schedulesButton.click()
    const addSchedule = await browser.$('.workspace-schedules-list > header button.primary')
    await addSchedule.waitForDisplayed({ timeout: 15_000 })
    assert(await addSchedule.isEnabled(), 'real Hermes gateway must expose schedule capability')
    await addSchedule.click()
    const scheduleInputs = await browser.$$('.workspace-schedule-editor form > label input')
    await scheduleInputs[0].setValue(SCHEDULE_NAME)
    await browser.$('.workspace-schedule-editor textarea').setValue('E2E scheduled prompt')
    await scheduleInputs[1].setValue('0 0 * * *')
    await browser.$('.workspace-schedule-editor button[type="submit"]').click()
    await browser.waitUntil(async () => (await browser.$('.workspace-schedule-detail h1').getText()) === SCHEDULE_NAME, {
      timeout: 15_000,
      timeoutMsg: 'Created schedule did not open',
    })
    const pause = await browser.$('//section[contains(@class,"workspace-schedule-detail")]//button[contains(.,"Pause")]')
    await pause.click()
    const resume = await browser.$('//section[contains(@class,"workspace-schedule-detail")]//button[contains(.,"Resume")]')
    await resume.waitForDisplayed({ timeout: 15_000 })
    await resume.click()
    await pause.waitForDisplayed({ timeout: 15_000 })
    await browser.$('.workspace-schedule-detail header .danger').click()
    await browser.waitUntil(async () => {
      try {
        await browser.getAlertText()
        return true
      } catch {
        return false
      }
    }, { timeout: 5_000, timeoutMsg: 'Delete schedule confirmation did not open' })
    await browser.acceptAlert()
    await browser.$('.workspace-schedule-detail').waitForExist({ reverse: true, timeout: 15_000 })

    assert.equal(provider.requests.length, 4, 'real Hermes Agent must call mock provider for four turns')
    assert(provider.requests.every(request => request.model === MODEL), 'all turns must use configured mock model')
    console.log('Linux workspace E2E passed: chat, streaming, usage, queue, input history, pin, rename, archive/restore, search, schedules; real Tauri UI, WebDriver, Hermes Agent, mocked provider')
  } catch (error) {
    failed = true
    const browserLogs = browser && typeof browser.getLogs === 'function'
      ? await browser.getLogs('browser').catch(reason => [{ level: 'ERROR', message: String(reason) }])
      : []
    const bodyText = browser ? await browser.$('body').getText().catch(() => '') : ''
    const workspaceState = browser ? await browser.execute(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke
      if (!invoke) return { error: 'Tauri invoke bridge unavailable' }
      try {
        const scope = await invoke('get_hermes_instance_scope')
        const refresh = await invoke('workspace_refresh', { request: scope })
        const session = refresh.sessions?.[0]
        const page = session
          ? await invoke('workspace_list_messages', {
            request: { ...scope, profileId: session.profileId, sessionId: session.id, limit: 50 },
          })
          : undefined
        const transcript = document.querySelector('.workspace-transcript')
        const virtualList = document.querySelector('.workspace-message-virtual-list')
        const virtualWindow = document.querySelector('.workspace-message-virtual-window')
        const cards = [...document.querySelectorAll('[data-message-id]')].map(element => ({
          id: element.dataset.messageId,
          text: element.textContent,
          height: element.getBoundingClientRect().height,
        }))
        return {
          scope,
          refresh,
          page,
          dom: {
            transcript: transcript ? {
              scrollTop: transcript.scrollTop,
              scrollHeight: transcript.scrollHeight,
              clientHeight: transcript.clientHeight,
            } : undefined,
            virtualListHeight: virtualList?.style.height,
            virtualWindowTransform: virtualWindow?.style.transform,
            cards,
          },
        }
      } catch (reason) {
        return { error: String(reason) }
      }
    }).catch(reason => ({ error: String(reason) })) : undefined
    const logDirectory = path.join(state.hermesState, 'logs')
    const logs = fs.existsSync(logDirectory)
      ? fs.readdirSync(logDirectory).flatMap(name => {
        const file = path.join(logDirectory, name)
        return fs.statSync(file).isFile() ? [`--- ${name} ---\n${fs.readFileSync(file, 'utf8').slice(-12_000)}`] : []
      }).join('\n')
      : ''
    failureDetails = `${error instanceof Error ? error.stack : error}

visible workspace:
${bodyText}

workspace command state:
${JSON.stringify(workspaceState, null, 2)}

mock provider requests: ${provider.requests.length}

browser logs:
${JSON.stringify(browserLogs, null, 2)}

Hermes logs:
${logs}

tauri-driver output:
${driverLog}

isolated state retained at: ${isolationRoot}`
  } finally {
    if (browser) await browser.deleteSession().catch(() => undefined)
    if (driver.exitCode === null) driver.kill('SIGTERM')
    await Promise.race([driverExit, delay(3_000)])
    if (virtualDisplay?.process.exitCode === null) virtualDisplay.process.kill('SIGTERM')
    await provider.close().catch(() => undefined)
    if (!failed) {
      fs.rmSync(isolationRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
  if (failed) throw new Error(failureDetails)
}

await run()
