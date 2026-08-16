import fs from 'fs';
import path from 'path';
import os from 'os';

// Polyfill for fetch if running on older Node versions (though package.json requires node >=18)
// Fetch is natively available in Node 18+

function getProxyConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const env = config.env || {};
      const baseUrl = env.ANTHROPIC_BASE_URL || config.apiBaseUrl || 'http://localhost:8080';
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || config.apiKey || 'test';
      return { url: `${baseUrl}/v1/messages`, apiKey };
    }
  } catch (e) {
    // Ignore error
  }
  return { url: 'http://localhost:8080/v1/messages', apiKey: 'test' };
}

const { url: PROXY_URL, apiKey: API_KEY } = getProxyConfig();

async function callProxy(query) {
  const payload = {
    model: 'gemini-3-flash',
    system: 'You are a concise search assistant. Return ONLY factual results in 2-3 sentences with source URLs. No code, no filler.',
    messages: [{ role: 'user', content: query }],
    max_tokens: 512,
    thinking: { budget_tokens: 1 },
    tools: [{ name: 'google_search', input_schema: { type: 'object' } }]
  };

  try {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
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

function handleRequest(request) {
  const method = request.method;
  const params = request.params || {};
  const reqId = request.id;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: reqId,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'Antigravity Search',
          version: '1.0.0'
        }
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
          description: 'Performs a web search via Gemini\'s Google Search grounding through the Antigravity Proxy.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query'
              }
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
          result: {
            content: [{
              type: 'text',
              text: 'Error: Missing required parameter \'query\''
            }]
          }
        };
      }

      // Async handling needed
      return callProxy(query).then(result => {
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: {
            content: [{
              type: 'text',
              text: result
            }]
          }
        };
      });
    }

    return {
      jsonrpc: '2.0',
      id: reqId,
      error: {
        code: -32601,
        message: `Tool not found: ${toolName}`
      }
    };
  }

  return null;
}

function writeMessage(response) {
  const body = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(body);
}

// Read JSON-RPC over stdio
let buffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);

    if (!contentLengthMatch) {
      // Invalid protocol, just clear buffer
      buffer = Buffer.alloc(0);
      break;
    }

    const contentLength = parseInt(contentLengthMatch[1], 10);
    const messageStart = headerEnd + 4;

    if (buffer.length < messageStart + contentLength) {
      // Incomplete message
      break;
    }

    const messageBody = buffer.slice(messageStart, messageStart + contentLength).toString('utf8');
    buffer = buffer.slice(messageStart + contentLength);

    try {
      const request = JSON.parse(messageBody);
      const responseOrPromise = handleRequest(request);

      if (responseOrPromise) {
        if (responseOrPromise instanceof Promise) {
          const response = await responseOrPromise;
          writeMessage(response);
        } else {
          writeMessage(responseOrPromise);
        }
      }
    } catch (e) {
      process.stderr.write(`Error processing message: ${e.message}\n`);
    }
  }
});

process.stderr.write("Starting Node.js MCP Server (Content-Length framing)...\n");
