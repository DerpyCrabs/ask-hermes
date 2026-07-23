# Ask Hermes

A lightweight Windows tray app for asking your local Hermes agent from anywhere.

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
- Configurable model, thinking effort, and Windows startup
- Open Hermes Desktop from the answer window

## Requirements

- Windows 10 or 11
- Hermes Agent installed and configured

## Voice input

Choose a provider in **Settings → Voice input**:

- **Hermes native** uses the speech-to-text provider configured in Hermes. Recording stops after 1.25 seconds of silence following speech.
- **Speaches realtime** streams audio to the optional native Windows Speaches service and uses `deepdml/faster-whisper-large-v3-turbo-ct2` on CUDA. Enable **Force English** to disable automatic language detection for its transcription. Speaches and its model are installed separately and are not bundled with the Ask Hermes installer.

## Development

```powershell
npm install
npm test
npm run tauri dev
```

Build the NSIS installer with `npm run tauri build`.

## License

[MIT](LICENSE)
