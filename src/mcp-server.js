import crypto from 'crypto';
import { logger } from './utils/logger.js';

// Simple in-memory session store
const mcpSessions = new Map();

/**
 * Perform the actual proxy search using local fetch
 * (Since this runs inside the proxy, it just loops back to the local proxy endpoint)
 */
async function callProxyLocal(query, port) {
    const payload = {
        model: 'gemini-3.1-flash-lite',
        system: 'You are a concise search assistant. Return ONLY factual results in 2-3 sentences with source URLs. No code, no filler.',
        messages: [{ role: 'user', content: query }],
        max_tokens: 512,
        thinking: { budget_tokens: 1 },
        tools: [{ name: 'google_search', input_schema: { type: 'object' } }]
    };

    try {
        const response = await fetch(`http://localhost:${port}/v1/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': 'mcp-internal',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            return `Error: Proxy returned status ${response.status} - ${text}`;
        }

        const data = await response.json();
        const contentBlocks = data.content || [];
        const textParts = contentBlocks
            .filter(block => block.type === 'text')
            .map(block => block.text);

        return textParts.length > 0 ? textParts.join('') : 'No results found.';
    } catch (error) {
        return `Search failed: ${error.message}`;
    }
}

/**
 * Handle a JSON-RPC request for MCP
 */
async function handleMCPRequest(request, port) {
    const method = request.method;
    const params = request.params || {};
    const reqId = request.id;

    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'Antigravity Search (SSE)', version: '1.0.0' }
            }
        };
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
                tools: [{
                    name: 'search',
                    description: 'Performs a web search via Gemini Google Search grounding through the Antigravity Proxy.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'The search query' }
                        },
                        required: ['query']
                    }
                }]
            }
        };
    }

    if (method === 'tools/call') {
        const toolName = params.name;
        const args = params.arguments || {};

        if (toolName === 'search') {
            const query = args.query;
            if (!query) {
                return {
                    jsonrpc: '2.0',
                    id: reqId,
                    result: { content: [{ type: 'text', text: "Error: Missing required parameter 'query'" }] }
                };
            }

            const resultText = await callProxyLocal(query, port);
            return {
                jsonrpc: '2.0',
                id: reqId,
                result: { content: [{ type: 'text', text: resultText }] }
            };
        }

        return {
            jsonrpc: '2.0',
            id: reqId,
            error: { code: -32601, message: `Tool not found: ${toolName}` }
        };
    }

    return null;
}

/**
 * Attach MCP SSE routes to an Express app
 */
export function attachMCPServer(app, port) {
    // 1. SSE Connection Endpoint
    app.get('/mcp/sse', (req, res) => {
        const sessionId = crypto.randomUUID();

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // Prevent buffering
        res.flushHeaders();

        // Store response object for this session
        mcpSessions.set(sessionId, res);

        // Send standard SSE connection event
        res.write(`event: endpoint\n`);
        res.write(`data: /mcp/messages?sessionId=${sessionId}\n\n`);

        req.on('close', () => {
            logger.debug(`[MCP] SSE session closed: ${sessionId}`);
            mcpSessions.delete(sessionId);
        });

        logger.debug(`[MCP] SSE session established: ${sessionId}`);
    });

    // 2. Message POST Endpoint
    app.post('/mcp/messages', async (req, res) => {
        const sessionId = req.query.sessionId;
        if (!sessionId || !mcpSessions.has(sessionId)) {
            return res.status(404).send('Session not found');
        }

        const sseRes = mcpSessions.get(sessionId);
        const rpcRequest = req.body;

        logger.debug(`[MCP] Received request on session ${sessionId}: ${rpcRequest.method}`);

        // We can immediately ACK the HTTP request
        res.status(202).send('Accepted');

        try {
            const response = await handleMCPRequest(rpcRequest, port);
            if (response) {
                // Send JSON-RPC response as a 'message' event back over SSE
                sseRes.write(`event: message\n`);
                sseRes.write(`data: ${JSON.stringify(response)}\n\n`);
            }
        } catch (e) {
            logger.error(`[MCP] Error handling request: ${e.message}`);
            const errorResponse = {
                jsonrpc: '2.0',
                id: rpcRequest.id,
                error: { code: -32603, message: e.message }
            };
            sseRes.write(`event: message\n`);
            sseRes.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
        }
    });
}