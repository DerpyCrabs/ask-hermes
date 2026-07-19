# Ask Hermes

A lightweight Windows tray app for asking your local Hermes agent from anywhere.

![Ask Hermes prompt with a screen capture](docs/prompt-with-capture.png)

Press **Alt+Space**, type a question, paste an image, or capture one or more screen regions. Answers appear in the same window with Markdown support.

![Ask Hermes answer window](docs/answer-window.png)

## Features

- Global **Alt+Space** prompt and persistent tray process
- New or existing Hermes sessions
- Multiple screen captures and clipboard images
- Configurable model, thinking effort, and Windows startup
- Open Hermes Desktop from the answer window

## Requirements

- Windows 10 or 11
- Hermes Agent installed and configured

## Development

```powershell
npm install
npm test
npm run tauri dev
```

Build the NSIS installer with `npm run tauri build`.
