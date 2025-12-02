# Claude.ai Integration Guide

This guide explains how to connect OpenMemory to Claude.ai web to give Claude persistent memory across conversations.

## Architecture

OpenMemory acts as a **Remote MCP Server** that Claude.ai connects to over the internet:

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Claude.ai     │ ──────► │  Internet/ngrok  │ ──────► │  OpenMemory     │
│   (MCP Client)  │         │  (Tunnel/Cloud)  │         │  (Remote MCP    │
│                 │ ◄────── │                  │ ◄────── │   Server)       │
└─────────────────┘         └──────────────────┘         └─────────────────┘
```

**How it works:**
1. You run OpenMemory locally (or deploy to a server)
2. Expose it to the internet (via ngrok, Railway, Render, etc.)
3. Add it to Claude.ai as a "Custom Connector" in Settings
4. Claude.ai connects to your OpenMemory instance via MCP protocol
5. Claude can now store and retrieve memories across conversations

**Requirements:** Claude.ai Pro, Max, Team, or Enterprise plan (custom connectors not available on Free plan)

## Overview

OpenMemory provides a **Model Context Protocol (MCP)** connector that allows Claude.ai to:

- **Store memories** - Save facts, experiences, insights, and more
- **Search memories** - Find relevant information using natural language
- **Recall details** - Retrieve specific memories by ID
- **Reinforce memories** - Strengthen important memories for better recall
- **List memories** - Browse recent memories by type

## Quick Start

### 1. Start OpenMemory Server

```bash
cd backend
npm install
npm run dev
```

The server starts on port 8080 by default. You should see:

```
[CLAUDE-MCP] Claude connector routes registered
[CLAUDE-MCP] MCP endpoint: http://localhost:8080/claude/mcp
[CLAUDE-MCP] SSE endpoint: http://localhost:8080/claude/sse
[CLAUDE-MCP] Manifest: http://localhost:8080/.well-known/mcp.json
```

### 2. Expose to the Internet (Required for Claude.ai)

Claude.ai needs to reach your server over the internet. Options:

**Option A: ngrok (Recommended for testing)**

```bash
ngrok http 8080
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

**Option B: Deploy to Cloud**

Deploy to any cloud provider (Railway, Render, Fly.io, etc.) and set your URL.

### 3. Configure Public URL

Set the public URL in your `.env`:

```env
OM_PUBLIC_URL=https://your-server-url.com
```

### 4. Connect to Claude.ai

1. Go to [claude.ai](https://claude.ai) (requires Pro, Max, Team, or Enterprise plan)
2. Open **Settings** → **Connectors**
3. Click **Add Connector** or **Add MCP Server**
4. Enter your server URL: `https://your-ngrok-url.ngrok.io` (or your deployed URL)
5. Complete OAuth authorization when prompted (or use API key if configured)
6. Select which tools to enable (memory_search, memory_store, etc.)
7. Done! Claude now has access to your memories

**Note:** Claude.ai supports both SSE and Streamable HTTP transports. SSE support may be deprecated in the future, so the Streamable HTTP endpoint (`/claude/mcp`) is recommended.

## Authentication

The connector supports two authentication methods:

### OAuth 2.0 (Recommended for Claude.ai)

OAuth 2.0 with PKCE is automatically handled when connecting from Claude.ai. The flow:

1. Claude.ai discovers endpoints via `/.well-known/mcp.json`
2. User is redirected to authorize access
3. Tokens are exchanged automatically
4. Access tokens expire after 1 hour (configurable)

### API Key (Alternative)

For direct API access, use the `OM_API_KEY`:

```env
OM_API_KEY=your-secret-key
```

Include it in requests:

```bash
curl -X POST http://localhost:8080/claude/mcp \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Available Tools

### memory_search

Search through memories using natural language.

```
Use: "Search my memories for project deadlines"
Parameters:
  - query (required): What you're looking for
  - limit (optional): Max results (1-20, default 5)
  - sector (optional): Filter by type
```

### memory_store

Store a new memory with automatic categorization.

```
Use: "Remember that the project deadline is December 15th"
Parameters:
  - content (required): The memory to store
  - tags (optional): Organization tags
  - context (optional): Additional metadata
```

### memory_recall

Get details of a specific memory.

```
Use: "Show me memory mem_abc123"
Parameters:
  - id (required): Memory ID to retrieve
```

### memory_reinforce

Strengthen a memory for better recall.

```
Use: "Reinforce memory mem_abc123"
Parameters:
  - id (required): Memory ID
  - amount (optional): Strength boost (0.01-0.5)
```

### memory_list

List recent memories.

```
Use: "Show me my recent memories"
Parameters:
  - limit (optional): Number to show (1-50)
  - type (optional): Filter by memory type
```

## Memory Types (Sectors)

OpenMemory automatically categorizes memories into five types:

| Type | Description | Examples |
|------|-------------|----------|
| **Episodic** | Events & experiences | "Had meeting with John yesterday" |
| **Semantic** | Facts & knowledge | "Python uses indentation for blocks" |
| **Procedural** | How-to & processes | "To deploy, run npm build then npm start" |
| **Emotional** | Feelings & sentiment | "I really enjoyed that presentation" |
| **Reflective** | Insights & meta-cognition | "I work better in the morning" |

## Configuration Options

Add these to your `.env` file:

```env
# Enable/disable the Claude connector
OM_CLAUDE_CONNECTOR_ENABLED=true

# OAuth token expiry in seconds (default: 1 hour)
OM_CLAUDE_TOKEN_EXPIRY=3600

# Maximum concurrent SSE sessions
OM_CLAUDE_MAX_SESSIONS=100

# Public URL for OAuth and manifest
OM_PUBLIC_URL=https://your-server.com
```

## Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/mcp.json` | GET | Server manifest for discovery |
| `/claude/mcp` | POST | MCP JSON-RPC endpoint |
| `/claude/sse` | GET | Server-Sent Events stream |
| `/claude/messages` | POST | SSE message handler |
| `/claude/oauth/authorize` | GET | OAuth authorization |
| `/claude/oauth/token` | POST | OAuth token exchange |
| `/claude/health` | GET | Connector health check |

## Using with Claude Desktop

You can also use the connector with Claude Desktop:

**claude_desktop_config.json:**

```json
{
  "mcpServers": {
    "openmemory": {
      "type": "http",
      "url": "http://localhost:8080/claude/mcp"
    }
  }
}
```

Or use the main MCP endpoint:

```json
{
  "mcpServers": {
    "openmemory": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

## Using with Claude Code

Add OpenMemory to Claude Code:

```bash
claude mcp add --transport http openmemory http://localhost:8080/claude/mcp
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "openmemory": {
      "type": "http",
      "url": "http://localhost:8080/claude/mcp"
    }
  }
}
```

## Troubleshooting

### "Authentication required" error

Make sure you're using a valid Bearer token or have completed OAuth authorization.

### SSE connection drops

SSE sessions expire after 30 minutes of inactivity. Reconnect if needed.

### Memories not persisting

Check that the database path is writable:

```env
OM_DB_PATH=./data/openmemory.sqlite
```

### CORS errors

The connector sets permissive CORS headers. If you're behind a proxy, ensure it forwards these headers.

### OAuth redirect fails

Make sure `OM_PUBLIC_URL` matches your actual public URL, including the protocol (https://).

## Security Considerations

1. **Use HTTPS in production** - OAuth tokens are sent in headers
2. **Set a strong API key** - Generate with `openssl rand -base64 32`
3. **Enable rate limiting** - Prevent abuse with `OM_RATE_LIMIT_ENABLED=true`
4. **Secure your database** - SQLite file should not be publicly accessible

## Example Conversations

### Storing Memories

**You:** Remember that my favorite programming language is Rust and I started learning it in 2023.

**Claude:** ✓ I've stored two memories:
1. Your favorite programming language is Rust (semantic - fact)
2. You started learning Rust in 2023 (episodic - event)

### Searching Memories

**You:** What do you know about my programming preferences?

**Claude:** Based on your memories, I found:
1. Your favorite programming language is Rust
2. You started learning it in 2023

### Recalling Context

**You:** Continue helping me with that Rust project from last time.

**Claude:** *searches memories* I found our previous conversation about your Rust project. You were working on a CLI tool for file organization...

## Support

- GitHub Issues: [github.com/CaviraOSS/OpenMemory/issues](https://github.com/CaviraOSS/OpenMemory/issues)
- Documentation: [github.com/CaviraOSS/OpenMemory](https://github.com/CaviraOSS/OpenMemory)
