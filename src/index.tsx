import { render } from 'solid-js/web'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { App } from './App'
import { hydratePersistentSettings } from './settings-config'
import './styles.css'

async function start() {
  try {
    await hydratePersistentSettings()
  } catch (reason) {
    console.error('Could not load persistent settings:', reason)
    const root = document.getElementById('root')!
    root.textContent = `Could not load Ask Hermes settings: ${String(reason)}`
    root.style.cssText = 'padding:20px;font:14px system-ui;color:#b42318;white-space:pre-wrap'
    await getCurrentWindow().show().catch(() => undefined)
    return
  }
  render(() => <App />, document.getElementById('root')!)
}

void start()
