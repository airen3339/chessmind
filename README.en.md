# ChessMind

<sub>[简体中文](README.md) · [English](README.en.md)</sub>

Play chess against large language models.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg)](#download)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db.svg)](https://tauri.app)

---

## Features

- **Compatible APIs**: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, native Gemini API.
- **Four game modes**: play White, play Black, AI vs AI, local two-player.
- **Coach mode**: per game, pick any of chain of thought, own-move explanations, per-move critique, position reads, on-demand guidance and a final review, with its own model. Disable backlog skipping to retain all pending reviews; the final review takes priority and can be retried if it fails.
- **Live reasoning**: shows the model's chain of thought when the provider returns it, with per-move latency, HTTP status and token usage.
- **Position editor**: set up a position before the game or edit it mid-game, with FEN import and export.
- **Multiple profiles**: save several API profiles; in AI vs AI each side can run a different model.
- **Full game control**: takeback, pause, flip board.

## Download

Get either build from [Releases](../../releases); both are identical in features:

| File | Use case |
| --- | --- |
| `ChessMind-1.1.4-win-x64-setup.exe` | One-click installer |
| `ChessMind-1.1.4-win-x64.zip` | Portable archive, unpack and run |

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

Each file ships with a matching `.sha256`:

```powershell
Get-FileHash .\ChessMind-1.1.4-win-x64.zip -Algorithm SHA256
```

**Requirements**: Windows 10 1803+ or Windows 11, with the WebView2 runtime (normally already present).

**First launch**: SmartScreen may block it; click "More info → Run anyway".

Settings live in `%APPDATA%\com.chessmind.app\settings.json`, encrypted with Windows DPAPI so that only the current user can decrypt it.

## Supported APIs

| Format | Endpoint | Reasoning source |
| --- | --- | --- |
| OpenAI Chat Completions | `{base}/chat/completions` | model-dependent |
| OpenAI Responses | `{base}/responses` | reasoning summary |
| Anthropic Messages | `{base}/messages` | thinking |
| Gemini | `{base}/models/{model}:streamGenerateContent` | thought |

### Common setups

| Service | Format | Base URL | Model |
| --- | --- | --- | --- |
| OpenAI | Responses | `https://api.openai.com/v1` | `gpt-5` |
| Anthropic | Anthropic Messages | `https://api.anthropic.com/v1` | `` |
| DeepSeek | Chat Completions | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | Chat Completions | `https://openrouter.ai/api/v1` | any `vendor/model` |
| Ollama | Chat Completions | `http://127.0.0.1:11434/v1` | `qwen3:32b` |

Self-signed gateways can enable "ignore certificate errors"; gateways that need extra auth headers can set custom request headers.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `F` | Flip the board |
| `U` | Take back a move |
| `H` | Ask the coach for guidance (coach mode) |
| `Space` | Pause / resume |
| `1`–`6` | Pick a piece type in the editor |
| `W` / `B` | Switch to White / Black pieces in the editor |
| `Esc` | Leave eraser mode in the editor |
| Right click | Delete a piece in the editor |

## Build from source

The stack is React 19 + TypeScript + Vite, the shell is Tauri 2, and the rules engine is chess.js.

Requires Node.js 20.19+ and Rust 1.90+.

Use the final API endpoint: redirects are rejected to protect API keys. A running game keeps its selected profiles. After repairing that profile's credentials or parameters, use the explicit retry action to reload them for the current game.

```powershell
npm install
npm run tauri dev    # development mode
npm run dist         # build the installer and the portable archive into release/
```

Other scripts:

```powershell
npm run typecheck        # tsc --noEmit
npm run test             # vitest
npm run build            # type check + frontend build
npm run tauri build      # NSIS installer only
```

With the dev server running, visit `http://127.0.0.1:1420/smoke.html` for an end-to-end self-check; `capture.html?state=settings` puts the UI into a specific state for screenshots.

## Making the model play chess

- **Legal move whitelist**: every turn, all legal moves are grouped by piece and listed in both SAN and UCI.
- **Complete position block**: coordinate-labelled ASCII board, FEN, side to move, castling rights, en passant target, halfmove clock, check status.
- **Strict contract plus three-stage parsing**: the model replies with JSON; parsing tries the fields, then UCI coordinates, then SAN tokens; if nothing is legal, the reason and the legal moves are sent again.
- **Race protection**: takeback, pause, end and position edits invalidate in-flight requests immediately, so a stale move never lands on a new position.
- **Optional context**: continuous context lets the model follow through on its own plan and hit the provider's prefix cache; per-move context re-reasons from the current position every time.
- **Coach kept apart from play**: the coach is a separate request sent after the move lands, so it never enters the playing conversation and can never influence the move that was just chosen.

## Credits

- **[LINUX DO](https://linux.do)** — community support

## License

[MIT](LICENSE). Third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); the Cburnett piece set is used under BSD-3-Clause.
