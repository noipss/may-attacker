# May Attacker

Desktop AI agent (Electron). May May, the kitten, is a live 3D SDF model rendered as pixel
cells and horizontal scanlines (WebGL2, no sprites, no video) — big on the home page, small in chat.

```bash
npm install
npm start          # open the app
npm run shots      # render frozen frames of the timeline into ./shots (visual QA)
npm test           # terminal runner + offline Claude/DeepSeek tool loops (fake fetch, no key needed)
```

## Chat, models & terminal
"Get to work" opens the chat screen. Each chat uses one model (chip in the chat header):

- **DeepSeek** (default) — OpenAI-compatible API via the official `openai` SDK at
  `https://api.deepseek.com`. Model `deepseek-flash` (the current V4.1 Flash; `deepseek-v4-flash`
  is a legacy alias that DeepSeek routes to it) or `deepseek-v4-pro`. Thinking on/off and effort
  (low / high / max) in Settings; the model's thinking streams into a collapsible block.
- **OpenRouter** — one key, many models/providers via its OpenAI-compatible API (often easier to pay
  with a RU card). Default `deepseek/deepseek-v4-pro` pinned to a provider (e.g. `streamlake/fp8`), or
  leave the pin blank to auto-route to the cheapest. Reasoning on/off + effort; `reasoning_details` are
  preserved across turns so the model keeps its chain of thought and tool calls stay valid.
- **Claude** — `claude-opus-5-5` via `@anthropic-ai/sdk`, streaming, effort `low`, server-side
  refusal fallbacks `"default"`.

Keys: **Settings (⌘,)** stores them encrypted with the macOS keychain (`safeStorage`); env vars
`DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` (or an `ant auth login` profile) also work. Without a key
the app runs in demo mode (try "list the files in this folder" or "remind me in 10 seconds…").
Switching a chat to another model is safe: the new model gets what it missed as a `<context>` block.

**Terminal.** May May has a `run_command` tool: zsh login shell, no stdin, in the chat's working
folder (folder chip in the header; `cd` carries over). Every command appears as a card in the thread
with live output, Stop, exit code and duration. Approval modes (Settings → Terminal): ask every time
(default) / auto-run read-only commands / run everything — risky commands (sudo, `rm -rf /`, force
push, `curl | sh`…) always ask. "Always in this chat" turns on auto-run for one chat (chip to undo).
Shortcuts: ⌘↵ run, ⌘⌫ decline. Type `!command` in the composer to run something yourself; the model
sees the result on its next turn. If a command needs approval in a chat you are not looking at, May
May pops up in her graduation cap with the card.

**Files & system.** Beyond the shell, May May has dedicated tools that touch the machine directly
(no shell, so nothing in a path is interpreted): `read_file` (read a text file or list a folder —
read-only, runs without asking), `write_file` (create or overwrite), `edit_file` (exact-string
replacement, unique match or `replace_all`), `open_path` (open a file, folder or URL with the OS
default handler, or launch a system app / tool by name — `open`/`open -a` on macOS, `xdg-open` or
the binary on Linux, `start` on Windows) and `download_file` (fetch an http(s) URL to disk). Paths
are absolute or relative to the chat's working folder (leading `~` = home). These run through the
same approval flow as the terminal: reads auto-run, writes / edits / opens / downloads ask (unless
"run everything" or "always in this chat"), and writing or downloading into a system location
(`/usr`, `/etc`, `C:\Windows`…) always asks. Each appears as its own card in the thread. Installing
software still goes through `run_command` with the platform's package manager (`brew`, `apt`,
`winget`), so sudo stays behind the risky-command guard.

May May also has `set_reminder`: when a reminder fires — or a reply lands in another chat — she
climbs out from behind the composer in a graduation cap and taps the notification card with her
pointer. Chats live in `userData/may-attacker.json`.

Scripted QA: `electron . --script=steps.json --out=shots --userdata=<tmp>` with steps
`{ "js": "…" } | { "wait": ms } | { "shot": "name" }`; `window.__chat` exposes `send`, `click`,
`notifyTest`, `scroll`, `openChat`, `openSettings`.

## Skills
Reusable named playbooks. Type `/` in the composer for a dropdown (↑/↓, Enter/Tab or click to pick),
or `/name your extra context` to run one directly. A skill is a saved instruction plus an optional
pinned model (DeepSeek / Claude / the chat's current one); picking it switches the chat to that model
and sends the instruction. Manage them in **Settings → Skills** (inline new/edit/delete); four are
seeded on first run (Review changes, Explain this folder, Plan my day, Fix failing tests). Stored in
`userData/may-attacker.json`. Module: `electron/skills.js` (`npm test` covers it).

## Structure
- `main.js`, `preload.js` — window, IPC, turns, approvals, reminders, settings
- `electron/agent.js` (provider choice, credential checks, demo), `electron/providers/{deepseek,openrouter,claude,shared}.js`, `electron/terminal.js`, `electron/files.js` (read/write/edit/open/download), `electron/store.js`
- `src/chat/` — `chat.js` (UI controller), `chatcat.js` (little May May: perches, hops, typing, teacher), `balancecat.js` (60fps coin-playing mascot by the balance, coins scale with credit), `markdown.js`
- `src/index.html`, `src/styles.css`, `src/chat.css` — home layout in the reference's 1440×900 design space, chat layout
- `src/heading.js` — pixel display font traced from the reference (3px grid)
- `src/cat/shaders.js` — raymarched kitten → row edges → scanline composite + line field
- `src/cat/rig.js` — skeleton, leg IK, poses and the timeline
- `src/cat/renderer.js` — WebGL2 passes; `src/app.js` — bubble, button, interactions

## Timeline
0–1.1s assembles from lines → 1.35–3.3s three hops toward the viewer, turning to the button →
3.8–6.2s paw play (3 taps + swipe, the button gets pressed) → 6.2–8.7s licks its paw →
9.2–10.4s sits down → idle (breathing, blinking, ear twitches, tail, head follows the cursor).
Hover the button, click it, or click May May for reactions; the logo replays the intro.
