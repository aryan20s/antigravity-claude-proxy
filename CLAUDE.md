# CLAUDE.md

Node.js proxy that exposes an Anthropic-compatible API backed by Google's Cloud Code service, letting Claude Code CLI use Gemini (and Claude) models via Google accounts with multi-account quota management.

Request flow: `Claude Code CLI → Express (server.js) → CloudCode client → Antigravity Cloud Code API`

## Commands

```bash
npm install          # installs deps and builds CSS (prepare hook)
npm start            # port 8080
npm run dev          # watch server files
npm run dev:full     # watch CSS + server files

npm start -- --strategy=sticky       # cache-optimized (default is hybrid)
npm start -- --strategy=round-robin  # load-balanced
npm start -- --fallback              # fall back to alternate model on quota exhaustion
npm start -- --dev-mode              # enables debug logging + dev tools (--debug is a legacy alias)

npm run build:css    # compile Tailwind once
npm run watch:css    # watch CSS

npm run accounts:add                 # add Google account via OAuth
npm run accounts:add -- --no-browser # headless/manual code input
npm run accounts:list
npm run accounts:verify

# Start with developer mode (debug logging + dev tools)
npm start -- --dev-mode

# Start with debug logging (legacy alias, also enables dev mode)
npm start -- --debug

# Development mode (file watching)
npm run dev              # Watch server files only
npm run dev:full         # Watch both CSS and server files (recommended for frontend dev)

# CSS build commands
npm run build:css        # Build CSS once (minified)
npm run watch:css        # Watch CSS files for changes

# Account management
npm run accounts         # Interactive account management
npm run accounts:add     # Add a new Google account via OAuth
npm run accounts:add -- --no-browser  # Add account on headless server (manual code input)
npm run accounts:list    # List configured accounts
npm run accounts:verify  # Verify account tokens are valid

# Run all tests (server must be running on port 8080)
npm test

# Run individual tests
npm run test:signatures    # Thinking signatures
npm run test:multiturn     # Multi-turn with tools
npm run test:streaming     # Streaming SSE events
npm run test:interleaved   # Interleaved thinking
npm run test:images        # Image processing
npm run test:caching       # Prompt caching
npm run test:crossmodel    # Cross-model thinking signatures
npm run test:oauth         # OAuth no-browser mode
npm run test:cache-control # Cache control field stripping
npm run test:websearch     # Web search MCP (Google Search grounding)

# Run strategy unit tests (no server required)
node tests/test-strategies.cjs
```

## Web Search MCP Server

An MCP server that provides Google Search grounding via Gemini through the proxy.

**Setup:** Add to your Claude Code project config (`~/.claude.json` under `projects.<path>.mcpServers`) or your global `~/.claude/settings.json` (under `mcpServers`):

```json
{
  "mcpServers": {
    "antigravity-search": {
      "type": "stdio",
      "command": "acc",
      "args": ["mcp"]
    }
  }
}
```

**How it works:** Sends queries to `gemini-3-flash` through the proxy with a `google_search` tool that activates Google Search grounding, plus a minimal thinking budget (`budget_tokens: 1`) for fast responses. Returns live search results, not training data.

**Google Search Grounding (Proxy-level):**
- Any Anthropic-format request can enable grounding by including a tool named `google_search` or `googleSearchRetrieval`
- The proxy converts these to native Gemini `{ google_search: {} }` entries, separate from `functionDeclarations`
- Grounding cannot be mixed with function declarations in the same request (Cloud Code API limitation)
- Grounding is only supported on Gemini models

## Non-obvious things

**CSS**: Source is `public/css/src/input.css` (Tailwind + `@apply`). Compiled output is `public/css/style.css` — don't edit the compiled file.

**Quota thresholds** are stored as fractions (0–0.99) but displayed as percentages in the UI. Three-tier resolution: per-model > per-account > global.

**`cache_control` stripping**: Claude Code CLI sends `cache_control` on content blocks; Cloud Code API rejects them. Stripped at the start of `convertAnthropicToGoogle()` before any other processing.

**Cross-model thinking signatures**: Claude and Gemini signatures are incompatible. When switching models mid-conversation, mismatched signatures are dropped. Gemini targets: strict (drop unknown). Claude targets: lenient (let Claude validate).

**`CLAUDE_CONFIG_PATH` env var**: Set this when running as a systemd service — `os.homedir()` returns the service user's home, not the real user's.

**`WEBUI_PASSWORD` env var**: Enables password protection on the web UI.

**Native module rebuild**: On Node.js version mismatch, `better-sqlite3` is auto-rebuilt via `npm rebuild`. If reload still fails after rebuild, a server restart is required.

**Dev mode sub-toggles** are client-side only (localStorage in `settings-store.js`): screenshot/redact mode, debug logging, log export, health inspector, placeholder data. No backend involvement.

**`/api/strategy/health`** returns 403 unless dev mode is on.
