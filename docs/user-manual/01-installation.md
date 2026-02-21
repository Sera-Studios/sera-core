# Installation & Setup

## Prerequisites

- **Node.js** 18 or later
- **npm** 9 or later
- A working installation of the Sera Audit Labs monorepo (for `@sera/types` dependency)

## Install Dependencies

From the sera-core directory:

```bash
cd services/sera-core
npm install
```

This installs runtime dependencies (Express, sql.js, ws) and development dependencies (TypeScript, Vitest).

## Build

Compile TypeScript to JavaScript:

```bash
npm run compile
```

Output goes to the `out/` directory.

For development with automatic recompilation:

```bash
npm run watch
```

## First Run

Start the daemon in the foreground:

```bash
npm run dev
```

Or after building:

```bash
npm start
```

You should see:

```
[sera-core] Client server started on port 9800
[sera-core] REST API: http://localhost:9800/api/health
[sera-core] WebSocket: ws://localhost:9800
[sera-core] Registered audits: 0
[sera-core] MCP server started on port 9877
[sera-core] MCP server: http://localhost:9877/mcp
```

## Directory Structure Created

On first run, sera-core creates the following directory structure:

```
~/.sera/
├── audits/           # Per-audit databases and metadata
├── logs/             # Log files
└── config.json       # (created if you need custom config)
```

## Configuration

Create `~/.sera/config.json` to override defaults:

```json
{
  "ports": {
    "client": 9800,
    "mcp": 9877
  },
  "logging": {
    "level": "info"
  },
  "database": {
    "flushIntervalMs": 30000
  }
}
```

All fields are optional - unspecified values use defaults.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SERA_HOME` | Override the sera home directory (default: `~/.sera`) |

## Verify Installation

Check that sera-core is running:

```bash
curl http://localhost:9800/api/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 5,
  "audits": 0,
  "clients": 0
}
```

## Running Tests

```bash
npm test
```

With coverage:

```bash
npm run test:coverage
```

Watch mode for development:

```bash
npm run test:watch
```

## Global CLI Installation

To use the `sera-core` command globally:

```bash
npm link
```

This makes the `sera-core` command available system-wide (see CLI Reference for usage).
