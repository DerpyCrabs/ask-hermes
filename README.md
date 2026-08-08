# Ask Hermes

A lightweight Windows and Linux desktop app for asking your local Hermes agent from anywhere.

![Ask Hermes prompt with a screen capture](docs/prompt-with-capture.png)

Press the configurable global shortcut (**Alt+Space** by default), type a question, paste an image, or capture one or more screen regions. Answers appear in the same window with Markdown support.

![Ask Hermes answer window](docs/answer-window.png)

## Features

- Configurable global prompt shortcut (**Alt+Space** by default) and persistent tray process
- Restore the previous in-window chat from the tray
- Assign global hotkeys and tray entries to specific Hermes sessions
- New or existing Hermes sessions
- Multiple screen captures and clipboard images
- Voice input with **Ctrl+Shift+D** or the microphone button
- Automatic end-of-speech detection for both voice providers
- Hermes-native transcription, or optional realtime audio streaming to local Speaches
- Configurable model, thinking effort, and startup behavior
- Open Hermes Desktop from the answer window
- Full Hermes workspace with chats, queues, search, lifecycle actions, and schedules

## Requirements

- Windows 10 or 11, or a Linux desktop with WebKitGTK 4.1
- Hermes Agent installed and configured

On Linux, Ask Hermes looks for Hermes Agent at
`~/.hermes/hermes-agent/venv/bin/hermes`. Set `HERMES_AGENT_BINARY` to use a
different executable. The workspace opens directly at launch on Linux. Windows
keeps the tray-based quick-prompt behavior.

## Voice input

Choose a provider in **Settings → Voice input**:

- **Hermes native** uses the speech-to-text provider configured in Hermes. Recording stops after 1.25 seconds of silence following speech.
- **Speaches realtime** streams audio to the optional native Windows Speaches service and uses `deepdml/faster-whisper-large-v3-turbo-ct2` on CUDA. Enable **Force English** to disable automatic language detection for its transcription. Speaches and its model are installed separately and are not bundled with the Ask Hermes installer.

## Development

```sh
npm install
npm test
npm run tauri dev
```

## Settings file

Ask Hermes stores settings in `%APPDATA%\app.hermes.ask\settings.json`. Existing browser-backed settings migrate automatically when this file is first created.

Use a different settings file for a separate profile:

```powershell
ask-hermes.exe --config C:\path\to\work-settings.json
ask-hermes.exe --config=C:\path\to\work-settings.json
```

Relative paths resolve from the process working directory. A missing custom file starts with defaults instead of importing another profile.

`npm run tauri build` creates an NSIS installer on Windows and a Debian package
on Linux. `npm run build:release` also produces a directly runnable Linux
binary at `src-tauri/target/release/ask-hermes`.

### Linux end-to-end test

The Linux E2E test drives the real release build through WebDriver, starts a
real Hermes Agent in an isolated state directory, and routes its OpenAI
Responses calls to a deterministic local mock provider:

```sh
cargo install tauri-driver --locked
npm run e2e:linux
```

It requires `WebKitWebDriver`. Headless environments also need Xvfb; the test
starts it automatically when no display is configured. On Debian/Ubuntu, the
usual development packages are `libwebkit2gtk-4.1-dev`,
`librsvg2-dev`, `patchelf`, and `xvfb`.

## License

[MIT](LICENSE)
