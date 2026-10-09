# Universal Modder Studio

Universal Modder Studio is a Windows desktop app for planning cross-game mashups and single-game mods, chatting with Codex, and running Universal Modder commands.

## Windows downloads

THIS PROGRAM REQUIRES A CODEX (New chatgpt app, not classic) ACCOUNT FOR IT TO WORK

The `dist` folder contains two Windows downloads: a per-user installer `.exe` and a portable `.zip` with the packaged app. The installer does not require administrator access. Extract the ZIP before running the app. Both formats need the same first-run prerequisites and setup: the app checks for Universal Modder, and if files are missing, choose **Yes** to install the tools and Codex plugin, or **No** to keep using the app without them. The ZIP does not bundle Codex, Universal Modder, uv, Python, or account credentials.

Automatic setup needs the Codex app or CLI installed and signed in with ChatGPT. The app opens Codex's own sign-in window; it does not collect or save passwords. It downloads Universal Modder from the project's GitHub repository and installs its command line with uv. Setup needs an internet connection. Python is managed by uv if it is not already available.

The app keeps its workspace, conversation settings, and downloaded Universal Modder checkout in the current Windows user's app-data folder. Mod projects are created under the app's `workspace` folder. Game install files and saves are outside the workspace. Each person using the app must sign in to their own Codex CLI account; the publisher's account is not included.

## Build on Windows

Install Node.js 22 or later and pnpm, then run:

```powershell
pnpm install
pnpm start
pnpm dist:windows
```

The build creates both Windows downloads in `dist`. Windows code signing is not configured; unsigned downloads can show a SmartScreen prompt. A publisher certificate is required before publishing a signed release.

## Codex sign-in

AI follow-up questions run through the local Codex CLI as short, stateless turns using the signed-in user's account. Prompts and recent local conversation history are sent through Codex to OpenAI for each answer. The app does not access a user's ChatGPT conversation history, provide a separate Studio account system, or embed the publisher's credentials. Users need their own Codex CLI installation and account access.

## Licenses

This app's source is licensed under MIT. Universal Modder is a separate MIT-licensed project by Rehan: <https://github.com/rehan-remade/universal-modder>. Electron and the build dependencies have their own licenses; the packaged build includes the notices provided by those dependencies.
