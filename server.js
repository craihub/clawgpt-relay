// ClawGPT Relay Server
// Bridges WebSocket connections between desktop and mobile clients

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

// Channel storage: channelId -> { host: WebSocket, clients: WebSocket[], created: Date }
const channels = new Map();

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      channels: channels.size,
      uptime: process.uptime()
    }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ClawGPT Relay Server');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Generate a random channel ID
function generateChannelId() {
  return crypto.randomBytes(6).toString('base64url');
}

// Clean up stale channels (older than 24 hours with no activity)
function cleanupChannels() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [channelId, channel] of channels) {
    if (now - channel.lastActivity > maxAge) {
      console.log(`[cleanup] Removing stale channel: ${channelId}`);
      if (channel.host && channel.host.readyState === WebSocket.OPEN) {
        channel.host.close();
      }
      channel.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.close();
      });
      channels.delete(channelId);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupChannels, 60 * 60 * 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  
  console.log(`[connect] New connection to ${path}`);
  
  // Parse path: /channel/{channelId}?role=host|client
  const match = path.match(/^\/channel\/([a-zA-Z0-9_-]+)$/);
  const role = url.searchParams.get('role') || 'client';
  
  if (path === '/new') {
    // Host requesting a new channel
    const channelId = generateChannelId();
    channels.set(channelId, {
      host: ws,
      clients: [],
      created: Date.now(),
      lastActivity: Date.now()
    });
    
    ws.channelId = channelId;
    ws.role = 'host';
    
    // Send channel ID to host
    ws.send(JSON.stringify({
      type: 'relay',
      event: 'channel.created',
      channelId: channelId
    }));
    
    console.log(`[channel] Created new channel: ${channelId}`);
    
    ws.on('message', (data) => handleHostMessage(ws, channelId, data));
    ws.on('close', () => handleHostDisconnect(channelId));
    
  } else if (match) {
    // Client or host joining existing channel
    const channelId = match[1];
    const channel = channels.get(channelId);
    
    if (!channel) {
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'error',
        error: 'Channel not found'
      }));
      ws.close();
      return;
    }
    
    channel.lastActivity = Date.now();
    
    if (role === 'host') {
      // Host reconnecting
      if (channel.host && channel.host.readyState === WebSocket.OPEN) {
        channel.host.close();
      }
      channel.host = ws;
      ws.channelId = channelId;
      ws.role = 'host';
      
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'channel.joined',
        channelId: channelId,
        role: 'host',
        clients: channel.clients.length
      }));
      
      // Notify clients that host reconnected
      channel.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({
            type: 'relay',
            event: 'host.connected'
          }));
        }
      });
      
      ws.on('message', (data) => handleHostMessage(ws, channelId, data));
      ws.on('close', () => handleHostDisconnect(channelId));
      
    } else {
      // Client joining
      ws.channelId = channelId;
      ws.role = 'client';
      channel.clients.push(ws);
      
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'channel.joined',
        channelId: channelId,
        role: 'client',
        hostConnected: channel.host && channel.host.readyState === WebSocket.OPEN
      }));
      
      // Notify host that client connected
      if (channel.host && channel.host.readyState === WebSocket.OPEN) {
        channel.host.send(JSON.stringify({
          type: 'relay',
          event: 'client.connected',
          clientCount: channel.clients.length
        }));
      }
      
      console.log(`[channel] Client joined: ${channelId} (${channel.clients.length} clients)`);
      
      ws.on('message', (data) => handleClientMessage(ws, channelId, data));
      ws.on('close', () => handleClientDisconnect(ws, channelId));
    }
    
  } else {
    ws.send(JSON.stringify({
      type: 'relay',
      event: 'error',
      error: 'Invalid path. Use /new or /channel/{id}'
    }));
    ws.close();
  }
});

function handleHostMessage(ws, channelId, data) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  channel.lastActivity = Date.now();
  
  // Forward to all clients
  const message = data.toString();
  channel.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function handleClientMessage(ws, channelId, data) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  channel.lastActivity = Date.now();
  
  // Forward to host
  if (channel.host && channel.host.readyState === WebSocket.OPEN) {
    channel.host.send(data.toString());
  }
}

function handleHostDisconnect(channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  console.log(`[channel] Host disconnected: ${channelId}`);
  
  // Notify clients
  channel.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'relay',
        event: 'host.disconnected'
      }));
    }
  });
  
  channel.host = null;
  
  // Keep channel alive for reconnection (cleanup will remove it later)
}

function handleClientDisconnect(ws, channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  channel.clients = channel.clients.filter(c => c !== ws);
  console.log(`[channel] Client disconnected: ${channelId} (${channel.clients.length} remaining)`);
  
  // Notify host
  if (channel.host && channel.host.readyState === WebSocket.OPEN) {
    channel.host.send(JSON.stringify({
      type: 'relay',
      event: 'client.disconnected',
      clientCount: channel.clients.length
    }));
  }
}

server.listen(PORT, () => {
  console.log(`ClawGPT Relay Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
