/**
 * OpenMemory Claude Connector
 *
 * MCP (Model Context Protocol) connector for Claude.ai web integration.
 * Provides SSE transport and OAuth 2.0 authentication support.
 *
 * @see https://modelcontextprotocol.io/docs/concepts/transports#server-sent-events-sse
 */

import type { IncomingMessage, ServerResponse } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import crypto from "crypto";
import { env } from "../core/cfg";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    sector_configs,
} from "../memory/hsg";
import { q, all_async, memories_table } from "../core/db";
import { getEmbeddingInfo } from "../memory/embed";
import { j, p } from "../utils";
import type { sector_type, mem_row } from "../core/types";
import { update_user_summary } from "../memory/user_summary";

// ============================================
// Types & Constants
// ============================================

interface OAuthToken {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    created_at: number;
}

interface OAuthClient {
    client_id: string;
    client_secret?: string;
    redirect_uris: string[];
    name: string;
    created_at: number;
}

interface AuthorizationCode {
    code: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge?: string;
    code_challenge_method?: string;
    expires_at: number;
    user_id?: string;
}

const CONNECTOR_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";

const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

// In-memory stores (for production, use a proper database)
const oauth_tokens = new Map<string, OAuthToken>();
const oauth_clients = new Map<string, OAuthClient>();
const auth_codes = new Map<string, AuthorizationCode>();
const sse_sessions = new Map<string, { transport: SSEServerTransport; created_at: number }>();

// ============================================
// Helper Functions
// ============================================

const trunc = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

const build_mem_snap = (row: mem_row) => ({
    id: row.id,
    primary_sector: row.primary_sector,
    salience: Number(row.salience.toFixed(3)),
    last_seen_at: row.last_seen_at,
    user_id: row.user_id,
    content_preview: trunc(row.content, 240),
});

const fmt_matches = (matches: Awaited<ReturnType<typeof hsg_query>>) =>
    matches
        .map((m: any, idx: any) => {
            const prev = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
            return `${idx + 1}. [${m.primary_sector}] score=${m.score.toFixed(3)} salience=${m.salience.toFixed(3)} id=${m.id}\n${prev}`;
        })
        .join("\n\n");

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

const generate_token = () => crypto.randomBytes(32).toString("hex");
const generate_code = () => crypto.randomBytes(16).toString("hex");

// ============================================
// OAuth 2.0 Implementation
// ============================================

/**
 * Register a new OAuth client (for setup purposes)
 */
export function register_oauth_client(
    client_id: string,
    name: string,
    redirect_uris: string[],
    client_secret?: string
): OAuthClient {
    const client: OAuthClient = {
        client_id,
        client_secret,
        redirect_uris,
        name,
        created_at: Date.now(),
    };
    oauth_clients.set(client_id, client);
    console.log(`[CLAUDE-MCP] Registered OAuth client: ${name} (${client_id})`);
    return client;
}

/**
 * Validate OAuth client
 */
function validate_client(client_id: string, redirect_uri?: string): OAuthClient | null {
    const client = oauth_clients.get(client_id);
    if (!client) return null;
    if (redirect_uri && !client.redirect_uris.includes(redirect_uri)) return null;
    return client;
}

/**
 * Verify PKCE code challenge
 */
function verify_pkce(code_verifier: string, code_challenge: string, method: string): boolean {
    if (method === "plain") {
        return code_verifier === code_challenge;
    }
    if (method === "S256") {
        const hash = crypto.createHash("sha256").update(code_verifier).digest();
        const computed = hash.toString("base64url");
        return computed === code_challenge;
    }
    return false;
}

/**
 * Validate access token from request
 */
function extract_and_validate_token(req: IncomingMessage): OAuthToken | null {
    const auth_header = req.headers["authorization"];
    if (!auth_header?.startsWith("Bearer ")) return null;

    const token_value = auth_header.slice(7);

    // First check OAuth tokens
    const oauth_token = oauth_tokens.get(token_value);
    if (oauth_token) {
        // Check expiration
        const now = Date.now();
        if (now > oauth_token.created_at + oauth_token.expires_in * 1000) {
            oauth_tokens.delete(token_value);
            return null;
        }
        return oauth_token;
    }

    // Fall back to API key authentication
    if (env.api_key && token_value === env.api_key) {
        return {
            access_token: token_value,
            token_type: "Bearer",
            expires_in: 86400,
            scope: "memory:read memory:write",
            created_at: Date.now(),
        };
    }

    return null;
}

// ============================================
// MCP Server Factory
// ============================================

/**
 * Create an MCP server instance with OpenMemory tools for Claude
 */
export function create_claude_mcp_server() {
    const srv = new McpServer(
        {
            name: "openmemory-claude",
            version: CONNECTOR_VERSION,
        },
        {
            capabilities: {
                tools: {},
                resources: {},
                logging: {},
                prompts: {},
            }
        }
    );

    // ========== TOOLS ==========

    srv.tool(
        "memory_search",
        "Search through your memories using natural language. Returns relevant memories based on semantic similarity.",
        {
            query: z
                .string()
                .min(1, "query text is required")
                .describe("What you're looking for - a question, topic, or description"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(20)
                .default(5)
                .describe("Maximum number of memories to return (1-20)"),
            sector: sec_enum
                .optional()
                .describe("Filter by memory type: episodic (events), semantic (facts), procedural (how-to), emotional (feelings), reflective (insights)"),
        },
        async ({ query, limit, sector }) => {
            const flt = sector ? { sectors: [sector as sector_type] } : undefined;
            const matches = await hsg_query(query, limit ?? 5, flt);

            if (!matches.length) {
                return {
                    content: [{
                        type: "text",
                        text: "No memories found matching your query. Try a different search term or store some memories first."
                    }],
                };
            }

            const results = matches.map((m: any, idx: number) => ({
                rank: idx + 1,
                id: m.id,
                content: m.content,
                type: m.primary_sector,
                relevance: Number(m.score.toFixed(3)),
                strength: Number(m.salience.toFixed(3)),
                last_accessed: m.last_seen_at,
            }));

            const summary = matches
                .map((m: any, idx: number) =>
                    `${idx + 1}. [${m.primary_sector}] (relevance: ${(m.score * 100).toFixed(0)}%)\n   ${trunc(m.content, 150)}`
                )
                .join("\n\n");

            return {
                content: [
                    { type: "text", text: `Found ${matches.length} relevant memories:\n\n${summary}` },
                    { type: "text", text: JSON.stringify({ query, results }, null, 2) },
                ],
            };
        }
    );

    srv.tool(
        "memory_store",
        "Store a new memory. The system will automatically categorize it into the appropriate type (episodic, semantic, procedural, emotional, or reflective).",
        {
            content: z
                .string()
                .min(1)
                .describe("The memory content to store - can be a fact, experience, feeling, or insight"),
            tags: z
                .array(z.string())
                .optional()
                .describe("Optional tags for organization (e.g., ['work', 'project-x'])"),
            context: z
                .record(z.any())
                .optional()
                .describe("Optional context metadata (e.g., source, date, related items)"),
        },
        async ({ content, tags, context }) => {
            const res = await add_hsg_memory(content, j(tags || []), context);

            const sector_descriptions: Record<string, string> = {
                episodic: "experience/event",
                semantic: "fact/knowledge",
                procedural: "process/how-to",
                emotional: "feeling/sentiment",
                reflective: "insight/reflection",
            };

            return {
                content: [
                    {
                        type: "text",
                        text: `✓ Memory stored successfully!\n\nID: ${res.id}\nType: ${res.primary_sector} (${sector_descriptions[res.primary_sector]})\nStored in sectors: ${res.sectors.join(", ")}`
                    },
                    {
                        type: "text",
                        text: JSON.stringify({
                            id: res.id,
                            primary_sector: res.primary_sector,
                            sectors: res.sectors,
                        }, null, 2)
                    },
                ],
            };
        }
    );

    srv.tool(
        "memory_recall",
        "Get the details of a specific memory by its ID",
        {
            id: z.string().min(1).describe("The memory ID to retrieve"),
        },
        async ({ id }) => {
            const mem = await q.get_mem.get(id);
            if (!mem) {
                return {
                    content: [{ type: "text", text: `Memory with ID "${id}" not found.` }],
                };
            }

            const details = {
                id: mem.id,
                content: mem.content,
                type: mem.primary_sector,
                strength: Number(mem.salience.toFixed(3)),
                created: mem.created_at,
                last_accessed: mem.last_seen_at,
                tags: p(mem.tags || "[]"),
                metadata: p(mem.meta || "{}"),
            };

            return {
                content: [
                    { type: "text", text: `Memory: ${mem.content}\n\nType: ${mem.primary_sector}\nStrength: ${(mem.salience * 100).toFixed(0)}%\nCreated: ${mem.created_at}` },
                    { type: "text", text: JSON.stringify(details, null, 2) },
                ],
            };
        }
    );

    srv.tool(
        "memory_reinforce",
        "Strengthen a memory to make it more prominent in future searches",
        {
            id: z.string().min(1).describe("The memory ID to reinforce"),
            amount: z
                .number()
                .min(0.01)
                .max(0.5)
                .default(0.1)
                .describe("How much to strengthen the memory (0.01-0.5)"),
        },
        async ({ id, amount }) => {
            await reinforce_memory(id, amount);
            return {
                content: [
                    { type: "text", text: `✓ Memory ${id} has been reinforced by ${(amount * 100).toFixed(0)}%` },
                ],
            };
        }
    );

    srv.tool(
        "memory_list",
        "List recent memories, optionally filtered by type",
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("Number of memories to list"),
            type: sec_enum
                .optional()
                .describe("Filter by memory type"),
        },
        async ({ limit, type }) => {
            const rows = type
                ? await q.all_mem_by_sector.all(type, limit ?? 10, 0)
                : await q.all_mem.all(limit ?? 10, 0);

            if (!rows.length) {
                return {
                    content: [{ type: "text", text: "No memories stored yet. Use memory_store to add your first memory!" }],
                };
            }

            const items = rows.map((row) => ({
                ...build_mem_snap(row),
                tags: p(row.tags || "[]") as string[],
            }));

            const list = items
                .map((item, idx) =>
                    `${idx + 1}. [${item.primary_sector}] (strength: ${(item.salience * 100).toFixed(0)}%)\n   ${item.content_preview}`
                )
                .join("\n\n");

            return {
                content: [
                    { type: "text", text: `Recent memories:\n\n${list}` },
                    { type: "text", text: JSON.stringify({ items }, null, 2) },
                ],
            };
        }
    );

    // ========== RESOURCES ==========

    srv.resource(
        "memory-stats",
        "openmemory://stats",
        {
            mimeType: "application/json",
            description: "Current memory system statistics and health",
        },
        async () => {
            const stats = await all_async(
                `SELECT primary_sector as sector, count(*) as count, avg(salience) as avg_salience FROM ${memories_table} GROUP BY primary_sector`
            );

            const total = (stats as any[]).reduce((sum, s) => sum + (s.count || 0), 0);

            const payload = {
                total_memories: total,
                by_sector: stats,
                embeddings: getEmbeddingInfo(),
                server: {
                    version: CONNECTOR_VERSION,
                    protocol: MCP_PROTOCOL_VERSION,
                    connector: "claude-web"
                },
            };

            return {
                contents: [
                    {
                        uri: "openmemory://stats",
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }
    );

    srv.resource(
        "memory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description: "OpenMemory configuration and sector definitions",
        },
        async () => {
            const payload = {
                sectors: sector_configs,
                available_tools: [
                    "memory_search",
                    "memory_store",
                    "memory_recall",
                    "memory_reinforce",
                    "memory_list",
                ],
                resources: [
                    "memory-stats",
                    "memory-config",
                ],
            };

            return {
                contents: [
                    {
                        uri: "openmemory://config",
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }
    );

    // ========== PROMPTS ==========

    srv.prompt(
        "summarize-memories",
        "Create a summary of memories on a specific topic",
        {
            topic: z.string().describe("The topic to summarize memories about"),
        },
        async ({ topic }: { topic: string }) => {
            return {
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Please search my memories for "${topic}" and create a comprehensive summary of what I know about this topic. Include key facts, experiences, and any insights I've stored.`,
                        },
                    },
                ],
            };
        }
    );

    srv.prompt(
        "reflect-on-day",
        "Reflect on memories from today",
        {},
        async () => {
            return {
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: `Please list my recent memories from today and help me reflect on them. What patterns do you notice? What insights can you draw?`,
                        },
                    },
                ],
            };
        }
    );

    srv.server.oninitialized = () => {
        console.error("[CLAUDE-MCP] Initialized with client:", srv.server.getClientVersion());
    };

    return srv;
}

// ============================================
// HTTP Request Handlers
// ============================================

const set_cors_headers = (res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
};

const send_json = (res: ServerResponse, data: any, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    set_cors_headers(res);
    res.end(JSON.stringify(data));
};

const send_error = (res: ServerResponse, error: string, status = 400) => {
    send_json(res, { error }, status);
};

const parse_body = async (req: IncomingMessage): Promise<any> => {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
};

// ============================================
// Route Registration
// ============================================

/**
 * Register Claude connector routes on an Express-like app
 */
export function claude_connector(app: any) {
    // Register a default OAuth client for development
    if (!oauth_clients.has("claude-web")) {
        register_oauth_client(
            "claude-web",
            "Claude Web Client",
            ["https://claude.ai/oauth/callback", "http://localhost:3000/oauth/callback"]
        );
    }

    // Create MCP server and transports
    const mcp_server = create_claude_mcp_server();

    // Streamable HTTP transport for POST /claude/mcp
    const http_transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
    });

    const server_ready = mcp_server.connect(http_transport).then(() => {
        console.log("[CLAUDE-MCP] Server initialized");
    }).catch((err) => {
        console.error("[CLAUDE-MCP] Failed to initialize:", err);
    });

    // ========== Well-Known Manifest ==========

    const base_url = env.public_url || `http://localhost:${env.port}`;

    app.get("/.well-known/mcp.json", (_req: any, res: any) => {
        const manifest = {
            schema_version: "1.0",
            name: "OpenMemory",
            description: "Persistent memory system for AI assistants. Store, search, and recall information across conversations.",
            homepage: "https://github.com/CaviraOSS/OpenMemory",
            authentication: {
                type: "oauth2",
                authorization_url: `${base_url}/claude/oauth/authorize`,
                token_url: `${base_url}/claude/oauth/token`,
                scopes: {
                    "memory:read": "Read memories",
                    "memory:write": "Store and modify memories",
                },
            },
            endpoints: {
                mcp: `${base_url}/claude/mcp`,
                sse: `${base_url}/claude/sse`,
            },
            tools: [
                {
                    name: "memory_search",
                    description: "Search through memories using natural language",
                },
                {
                    name: "memory_store",
                    description: "Store a new memory with automatic categorization",
                },
                {
                    name: "memory_recall",
                    description: "Retrieve a specific memory by ID",
                },
                {
                    name: "memory_reinforce",
                    description: "Strengthen a memory for better recall",
                },
                {
                    name: "memory_list",
                    description: "List recent memories",
                },
            ],
            resources: [
                {
                    name: "memory-stats",
                    uri: "openmemory://stats",
                    description: "Memory system statistics",
                },
                {
                    name: "memory-config",
                    uri: "openmemory://config",
                    description: "System configuration",
                },
            ],
        };
        send_json(res, manifest);
    });

    // ========== OAuth 2.0 Endpoints ==========

    // Authorization endpoint
    app.get("/claude/oauth/authorize", async (req: any, res: any) => {
        const {
            client_id,
            redirect_uri,
            response_type,
            scope,
            state,
            code_challenge,
            code_challenge_method,
        } = req.query;

        // Validate client
        const client = validate_client(client_id, redirect_uri);
        if (!client) {
            return send_error(res, "Invalid client_id or redirect_uri", 400);
        }

        if (response_type !== "code") {
            return send_error(res, "Only response_type=code is supported", 400);
        }

        // For simplicity, auto-approve (in production, show a consent screen)
        const code = generate_code();
        auth_codes.set(code, {
            code,
            client_id,
            redirect_uri,
            scope: scope || "memory:read memory:write",
            code_challenge,
            code_challenge_method: code_challenge_method || "S256",
            expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
        });

        const redirect_url = new URL(redirect_uri);
        redirect_url.searchParams.set("code", code);
        if (state) redirect_url.searchParams.set("state", state);

        res.statusCode = 302;
        res.setHeader("Location", redirect_url.toString());
        res.end();
    });

    // Token endpoint
    app.post("/claude/oauth/token", async (req: any, res: any) => {
        try {
            const body = await parse_body(req);
            const {
                grant_type,
                code,
                redirect_uri,
                client_id,
                code_verifier,
                refresh_token,
            } = body;

            if (grant_type === "authorization_code") {
                // Validate authorization code
                const auth_code = auth_codes.get(code);
                if (!auth_code || auth_code.expires_at < Date.now()) {
                    auth_codes.delete(code);
                    return send_error(res, "Invalid or expired authorization code", 400);
                }

                if (auth_code.client_id !== client_id || auth_code.redirect_uri !== redirect_uri) {
                    return send_error(res, "Client mismatch", 400);
                }

                // Verify PKCE if present
                if (auth_code.code_challenge && code_verifier) {
                    if (!verify_pkce(code_verifier, auth_code.code_challenge, auth_code.code_challenge_method || "S256")) {
                        return send_error(res, "Invalid code_verifier", 400);
                    }
                }

                // Generate tokens
                const access_token = generate_token();
                const token: OAuthToken = {
                    access_token,
                    token_type: "Bearer",
                    expires_in: 3600, // 1 hour
                    scope: auth_code.scope,
                    created_at: Date.now(),
                };
                oauth_tokens.set(access_token, token);
                auth_codes.delete(code);

                return send_json(res, {
                    access_token,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: auth_code.scope,
                });
            }

            if (grant_type === "refresh_token") {
                // For now, just issue a new token
                const access_token = generate_token();
                const token: OAuthToken = {
                    access_token,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "memory:read memory:write",
                    created_at: Date.now(),
                };
                oauth_tokens.set(access_token, token);

                return send_json(res, {
                    access_token,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "memory:read memory:write",
                });
            }

            return send_error(res, "Unsupported grant_type", 400);
        } catch (err) {
            return send_error(res, "Invalid request", 400);
        }
    });

    // ========== SSE Endpoint (for Claude.ai) ==========

    app.get("/claude/sse", async (req: any, res: any) => {
        // Validate token
        const token = extract_and_validate_token(req);
        if (!token && env.api_key) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Authentication required" }));
            return;
        }

        // Set SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        set_cors_headers(res);
        res.flushHeaders();

        // Create SSE transport for this session
        const session_id = crypto.randomUUID();
        const sse_transport = new SSEServerTransport("/claude/messages", res);

        // Create a new MCP server for this session
        const session_server = create_claude_mcp_server();

        try {
            await session_server.connect(sse_transport);
            sse_sessions.set(session_id, {
                transport: sse_transport,
                created_at: Date.now()
            });

            console.log(`[CLAUDE-MCP] SSE session started: ${session_id}`);

            // Handle disconnect
            req.on("close", () => {
                sse_sessions.delete(session_id);
                console.log(`[CLAUDE-MCP] SSE session closed: ${session_id}`);
            });
        } catch (err) {
            console.error("[CLAUDE-MCP] SSE connection failed:", err);
            res.end();
        }
    });

    // SSE message endpoint
    app.post("/claude/messages", async (req: any, res: any) => {
        const session_id = req.headers["mcp-session-id"];
        const session = session_id ? sse_sessions.get(session_id) : null;

        if (!session) {
            return send_error(res, "Invalid or expired session", 400);
        }

        try {
            const body = await parse_body(req);
            await session.transport.handlePostMessage(req, res, body);
        } catch (err) {
            console.error("[CLAUDE-MCP] Message handling failed:", err);
            send_error(res, "Failed to process message", 500);
        }
    });

    // ========== Streamable HTTP Endpoint ==========

    app.post("/claude/mcp", async (req: any, res: any) => {
        // Validate token (optional if no API key configured)
        const token = extract_and_validate_token(req);
        if (!token && env.api_key) {
            return send_error(res, "Authentication required", 401);
        }

        try {
            await server_ready;
            const body = await parse_body(req);
            set_cors_headers(res);
            await http_transport.handleRequest(req, res, body);
        } catch (err) {
            console.error("[CLAUDE-MCP] Request failed:", err);
            if (!res.headersSent) {
                send_error(res, "Internal server error", 500);
            }
        }
    });

    app.options("/claude/mcp", (_req: any, res: any) => {
        res.statusCode = 204;
        set_cors_headers(res);
        res.end();
    });

    app.options("/claude/sse", (_req: any, res: any) => {
        res.statusCode = 204;
        set_cors_headers(res);
        res.end();
    });

    app.options("/claude/messages", (_req: any, res: any) => {
        res.statusCode = 204;
        set_cors_headers(res);
        res.end();
    });

    // ========== Health Check ==========

    app.get("/claude/health", (_req: any, res: any) => {
        send_json(res, {
            status: "ok",
            connector: "claude-web",
            version: CONNECTOR_VERSION,
            protocol: MCP_PROTOCOL_VERSION,
            active_sessions: sse_sessions.size,
        });
    });

    console.log("[CLAUDE-MCP] Claude connector routes registered");
    console.log(`[CLAUDE-MCP] MCP endpoint: ${base_url}/claude/mcp`);
    console.log(`[CLAUDE-MCP] SSE endpoint: ${base_url}/claude/sse`);
    console.log(`[CLAUDE-MCP] Manifest: ${base_url}/.well-known/mcp.json`);
}

// Cleanup old sessions periodically
setInterval(() => {
    const now = Date.now();
    const max_age = 30 * 60 * 1000; // 30 minutes

    for (const [id, session] of sse_sessions.entries()) {
        if (now - session.created_at > max_age) {
            sse_sessions.delete(id);
            console.log(`[CLAUDE-MCP] Cleaned up stale session: ${id}`);
        }
    }

    // Cleanup expired tokens
    for (const [token, data] of oauth_tokens.entries()) {
        if (now > data.created_at + data.expires_in * 1000) {
            oauth_tokens.delete(token);
        }
    }

    // Cleanup expired auth codes
    for (const [code, data] of auth_codes.entries()) {
        if (now > data.expires_at) {
            auth_codes.delete(code);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes
