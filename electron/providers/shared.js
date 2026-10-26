// What every provider shares: May May's system prompt and the tool set (one schema, two wire formats).
const OS_NAME = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux';
const SHELL_NAME = process.platform === 'win32' ? 'the default shell' : 'zsh login shell';
const SYSTEM = `You are May May, a small white kitten with dark socks who lives inside the "May Attacker" desktop app as the user's AI agent on their ${OS_NAME}.
You help with planning, writing, explaining, coding and everyday tasks. Be warm and a little playful, but get to the point: short paragraphs, lists when they help. Markdown is rendered.

You act on the real machine through tools. Work in small, verifiable steps: look before you change anything, make one change, then check the result. The user sees every tool call and may have to approve the ones that touch their machine; if one is declined, ask what they'd prefer instead of retrying it. Summarize results instead of pasting long output back.

Tools:
- run_command runs a shell command in the chat's working folder (${SHELL_NAME}, non-interactive, no stdin; the working directory carries over between calls, so cd works). Use it for anything the dedicated tools below don't cover: running scripts and tests, git, builds, and installing software the user asked for (the platform's package manager — e.g. ${process.platform === 'darwin' ? 'brew install' : process.platform === 'win32' ? 'winget install' : 'apt/dnf/pacman via sudo'}). Prefer commands that finish on their own: no editors, pagers, watch modes or servers that never exit (start long-running servers in the background and redirect their output to a file).
- read_file reads a text file (or lists a folder). Prefer it over \`cat\`. Read-only, so it runs without asking.
- write_file creates a new file or overwrites an existing one with the content you give. Parent folders are created as needed.
- edit_file replaces an exact string in an existing file. old_string must match exactly (including whitespace) and be unique, unless you pass replace_all. Prefer small, targeted edits over rewriting a whole file.
- open_path opens a file, folder or URL with the ${OS_NAME} default handler, or launches a system app / tool by name (e.g. a calculator, a browser, an editor). Use it to show the user something or to start a GUI tool.
- download_file downloads an http(s) URL to a file on disk — for fetching tools, assets or data the user asked for.
- set_reminder schedules a reminder notification; when it fires you pop up with your graduation cap and pointer to show it.

Paths may be absolute or relative to the working folder (a leading ~ is the home folder).
Messages may start with a <context> block: things that happened since your last reply (the working folder, commands the user ran, replies from another model). Treat it as background, not as a new request.
Latency-sensitive; begin your visible answer immediately.`;

const TOOLS = [
  {
    name: 'run_command',
    description: "Run a shell command in the chat's working folder on the user's Mac (zsh, non-interactive, no stdin). The working directory persists between calls. Returns the exit code, the final working directory and the combined stdout/stderr (long output is trimmed to its beginning and end). The user may have to approve the command first.",
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run. Several commands can be joined with && or newlines.' },
        timeout_seconds: { type: 'integer', description: 'Kill the command after this many seconds (1-600). Use 120 when unsure.' },
      },
      required: ['command', 'timeout_seconds'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: "Read a text file, or list a folder's entries. Path is absolute or relative to the working folder (leading ~ = home). Read-only: runs without asking. Large or binary files are refused — use run_command for those.",
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file (or folder) to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing one with the given content (UTF-8). Missing parent folders are created. For a small change to an existing file prefer edit_file. The user may have to approve this.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to create or overwrite.' },
        content: { type: 'string', description: 'The full new contents of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in an existing file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. The user may have to approve this.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit.' },
        old_string: { type: 'string', description: 'The exact text to find and replace.' },
        new_string: { type: 'string', description: 'The text to replace it with.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring old_string to be unique (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_path',
    description: 'Open a file, folder or URL with the OS default handler, or launch a system app / tool by name (e.g. "Calculator", "firefox"). Starts it detached. The user may have to approve this.',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A path, an http(s) URL, or the name of an application / tool to launch.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'download_file',
    description: 'Download an http(s) URL to a file on disk. Missing parent folders are created. The user may have to approve this.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http:// or https:// address to download.' },
        dest: { type: 'string', description: 'Destination file path (absolute or relative to the working folder).' },
      },
      required: ['url', 'dest'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_reminder',
    description: 'Schedule a reminder notification for the user. The app shows it after delay_seconds, even if another chat is open.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind the user about, phrased as the reminder itself (e.g. "Stretch your back").' },
        delay_seconds: { type: 'integer', description: 'Seconds from now until the reminder fires (1 to 2592000).' },
      },
      required: ['message', 'delay_seconds'],
      additionalProperties: false,
    },
  },
];

const anthropicTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, strict: true, eager_input_streaming: true }));
const openaiTools = () => TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));

// Model-supplied input is untrusted: validate before running anything.
function validate(name, input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid input: expected an object.' };
  if (name === 'run_command') {
    const { command } = input;
    let timeout = input.timeout_seconds;
    if (typeof command !== 'string' || !command.trim() || command.length > 8000) return { ok: false, error: 'Invalid input: command must be a non-empty string (max 8000 chars).' };
    if (timeout == null) timeout = 120;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) return { ok: false, error: 'Invalid input: timeout_seconds must be an integer from 1 to 600.' };
    return { ok: true, value: { command: command.trim(), timeout } };
  }
  const MAX_CONTENT = 5_000_000;
  const str = (v) => typeof v === 'string';
  const okPath = (p) => str(p) && p.trim() && p.length <= 4096;
  if (name === 'read_file') {
    if (!okPath(input.path)) return { ok: false, error: 'Invalid input: path must be a non-empty string.' };
    return { ok: true, value: { path: input.path.trim() } };
  }
  if (name === 'write_file') {
    if (!okPath(input.path)) return { ok: false, error: 'Invalid input: path must be a non-empty string.' };
    if (!str(input.content)) return { ok: false, error: 'Invalid input: content must be a string.' };
    if (input.content.length > MAX_CONTENT) return { ok: false, error: `Invalid input: content is too large (max ${MAX_CONTENT} chars).` };
    return { ok: true, value: { path: input.path.trim(), content: input.content } };
  }
  if (name === 'edit_file') {
    if (!okPath(input.path)) return { ok: false, error: 'Invalid input: path must be a non-empty string.' };
    if (!str(input.old_string) || !input.old_string.length) return { ok: false, error: 'Invalid input: old_string must be a non-empty string.' };
    if (!str(input.new_string)) return { ok: false, error: 'Invalid input: new_string must be a string.' };
    if (input.old_string.length > MAX_CONTENT || input.new_string.length > MAX_CONTENT) return { ok: false, error: 'Invalid input: old_string / new_string too large.' };
    return { ok: true, value: { path: input.path.trim(), old_string: input.old_string, new_string: input.new_string, replace_all: !!input.replace_all } };
  }
  if (name === 'open_path') {
    if (!okPath(input.target)) return { ok: false, error: 'Invalid input: target must be a non-empty string.' };
    return { ok: true, value: { target: input.target.trim() } };
  }
  if (name === 'download_file') {
    if (!str(input.url) || !/^https?:\/\//i.test(input.url.trim())) return { ok: false, error: 'Invalid input: url must be an http:// or https:// address.' };
    if (!okPath(input.dest)) return { ok: false, error: 'Invalid input: dest must be a non-empty string.' };
    return { ok: true, value: { url: input.url.trim(), dest: input.dest.trim() } };
  }
  if (name === 'set_reminder') {
    const { message, delay_seconds: delay } = input;
    if (typeof message !== 'string' || !message.trim() || message.length > 500) return { ok: false, error: 'Invalid input: message must be a non-empty string.' };
    if (!Number.isInteger(delay) || delay < 1 || delay > 2592000) return { ok: false, error: 'Invalid input: delay_seconds must be an integer from 1 to 2592000.' };
    return { ok: true, value: { message: message.trim(), delay } };
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

module.exports = { SYSTEM, TOOLS, anthropicTools, openaiTools, validate };
