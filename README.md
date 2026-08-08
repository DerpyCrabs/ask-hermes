# Ask Hermes

A lightweight Windows tray app for asking your local Hermes agent from anywhere.

![Ask Hermes prompt with a screen capture](docs/prompt-with-capture.png)

Press **Alt+Space**, type a question, paste an image, or capture one or more screen regions. Answers appear in the same window with Markdown support.

![Ask Hermes answer window](docs/answer-window.png)

## Features

- Global **Alt+Space** prompt and persistent tray process
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

## Settings file

Ask Hermes stores settings in `%APPDATA%\app.hermes.ask\settings.json`. Existing browser-backed settings migrate automatically when this file is first created.

Use a different settings file for a separate profile:

```powershell
ask-hermes.exe --config C:\path\to\work-settings.json
ask-hermes.exe --config=C:\path\to\work-settings.json
```

Relative paths resolve from the process working directory. A missing custom file starts with defaults instead of importing another profile.

## License

[MIT](LICENSE)
