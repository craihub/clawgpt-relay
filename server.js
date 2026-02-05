// ClawGPT Relay Server
// Secure WebSocket relay for E2E encrypted communication between desktop and mobile
//
// Security features:
// - UUID v4 channel IDs (128-bit random, unguessable)
// - Single client per channel (no eavesdropping)
// - 5-minute expiry for unclaimed channels
// - Rate limiting on channel creation
// - Zero-knowledge relay (only sees encrypted blobs)

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

// Configuration
const CONFIG = {
  // Channel expiry: 5 minutes for unclaimed, 24 hours for active
  UNCLAIMED_EXPIRY_MS: 5 * 60 * 1000,      // 5 minutes
  ACTIVE_EXPIRY_MS: 24 * 60 * 60 * 1000,   // 24 hours
  
  // Named room expiry: 7 days inactive (for persistence)
  ROOM_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  
  // Rate limiting
  MAX_CHANNELS_PER_IP: 10,                  // Max active channels per IP
  CHANNEL_CREATE_COOLDOWN_MS: 1000,         // Min time between channel creations
  
  // Cleanup interval
  CLEANUP_INTERVAL_MS: 60 * 1000            // Check for stale channels every minute
};

// Named rooms storage: roomId -> { host, client, created, lastActivity }
// Unlike channels, rooms persist and support reconnection
const rooms = new Map();

// Channel storage: channelId -> { host, client, created, lastActivity, claimed }
const channels = new Map();

// Rate limiting: IP -> { count, lastCreate }
const ipLimits = new Map();

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  // CORS headers for health checks
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      channels: channels.size,
      uptime: process.uptime(),
      security: {
        e2eEncryption: true,
        zeroKnowledge: true,
        singleClientPerChannel: true
      }
    }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ClawGPT Relay Server - E2E Encrypted');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Generate a UUID v4 channel ID (128 bits of randomness)
function generateChannelId() {
  return crypto.randomUUID();
}

// Get client IP from request
function getClientIP(req) {
  // Handle proxied connections (Fly.io, Cloudflare, etc.)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Check rate limit for IP
function checkRateLimit(ip) {
  const now = Date.now();
  const limit = ipLimits.get(ip);
  
  if (!limit) {
    ipLimits.set(ip, { count: 1, lastCreate: now });
    return { allowed: true };
  }
  
  // Reset count if cooldown passed
  if (now - limit.lastCreate > CONFIG.CHANNEL_CREATE_COOLDOWN_MS) {
    // Count active channels for this IP
    let activeCount = 0;
    for (const [, channel] of channels) {
      if (channel.hostIP === ip) activeCount++;
    }
    
    if (activeCount >= CONFIG.MAX_CHANNELS_PER_IP) {
      return { allowed: false, reason: 'Too many active channels' };
    }
    
    limit.count = activeCount + 1;
    limit.lastCreate = now;
    return { allowed: true };
  }
  
  return { allowed: false, reason: 'Rate limited, try again shortly' };
}

// Clean up stale channels
function cleanupChannels() {
  const now = Date.now();
  
  for (const [channelId, channel] of channels) {
    const age = now - channel.created;
    const idleTime = now - channel.lastActivity;
    
    // Remove unclaimed channels after 5 minutes
    if (!channel.claimed && age > CONFIG.UNCLAIMED_EXPIRY_MS) {
      console.log(`[cleanup] Removing unclaimed channel: ${channelId.substring(0, 8)}...`);
      closeChannel(channelId);
      continue;
    }
    
    // Remove inactive channels after 24 hours
    if (idleTime > CONFIG.ACTIVE_EXPIRY_MS) {
      console.log(`[cleanup] Removing stale channel: ${channelId.substring(0, 8)}...`);
      closeChannel(channelId);
    }
  }
  
  // Clean up stale rooms (7 days inactive)
  for (const [roomId, room] of rooms) {
    const idleTime = now - room.lastActivity;
    if (idleTime > CONFIG.ROOM_EXPIRY_MS) {
      console.log(`[cleanup] Removing stale room: ${roomId.substring(0, 8)}...`);
      closeRoom(roomId);
    }
  }
  
  // Clean up old IP limits
  for (const [ip, limit] of ipLimits) {
    if (now - limit.lastCreate > 3600000) { // 1 hour
      ipLimits.delete(ip);
    }
  }
}

// Close and remove a room
function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    room.host.close(1000, 'Room closed');
  }
  if (room.client && room.client.readyState === WebSocket.OPEN) {
    room.client.close(1000, 'Room closed');
  }
  rooms.delete(roomId);
}

// Close and remove a channel
function closeChannel(channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  if (channel.host && channel.host.readyState === WebSocket.OPEN) {
    channel.host.close(1000, 'Channel closed');
  }
  if (channel.client && channel.client.readyState === WebSocket.OPEN) {
    channel.client.close(1000, 'Channel closed');
  }
  channels.delete(channelId);
}

// Run cleanup periodically
setInterval(cleanupChannels, CONFIG.CLEANUP_INTERVAL_MS);

// Keepalive ping every 30s to prevent proxy/NAT idle timeouts (e.g. Fly.io)
setInterval(() => {
  for (const [, room] of rooms) {
    if (room.host && room.host.readyState === WebSocket.OPEN) room.host.ping();
    if (room.client && room.client.readyState === WebSocket.OPEN) room.client.ping();
  }
  for (const [, channel] of channels) {
    if (channel.host && channel.host.readyState === WebSocket.OPEN) channel.host.ping();
    if (channel.client && channel.client.readyState === WebSocket.OPEN) channel.client.ping();
  }
}, 30000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const clientIP = getClientIP(req);
  
  // Log connection (truncate channel IDs for privacy)
  const logPath = path.length > 20 ? path.substring(0, 20) + '...' : path;
  console.log(`[connect] ${clientIP} -> ${logPath}`);
  
  // Parse path: /channel/{channelId}
  const match = path.match(/^\/channel\/([a-f0-9-]{36})$/i);
  
  if (path === '/new') {
    // Host requesting a new channel
    
    // Rate limit check
    const rateCheck = checkRateLimit(clientIP);
    if (!rateCheck.allowed) {
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'error',
        error: rateCheck.reason
      }));
      ws.close();
      return;
    }
    
    const channelId = generateChannelId();
    channels.set(channelId, {
      host: ws,
      client: null,
      created: Date.now(),
      lastActivity: Date.now(),
      claimed: false,
      hostIP: clientIP
    });
    
    ws.channelId = channelId;
    ws.role = 'host';
    
    // Send channel ID to host
    ws.send(JSON.stringify({
      type: 'relay',
      event: 'channel.created',
      channelId: channelId
    }));
    
    console.log(`[channel] Created: ${channelId.substring(0, 8)}...`);
    
    ws.on('message', (data) => handleHostMessage(ws, channelId, data));
    ws.on('close', () => handleHostDisconnect(channelId));
    
  } else if (path.startsWith('/room/')) {
    // Named room - persistent channel that both sides can reconnect to
    const roomId = path.substring(6); // Remove '/room/' prefix
    
    // Validate room ID (alphanumeric + hyphens, 8-64 chars)
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(roomId)) {
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'error',
        error: 'Invalid room ID. Use 8-64 alphanumeric characters or hyphens.'
      }));
      ws.close();
      return;
    }
    
    let room = rooms.get(roomId);
    const now = Date.now();
    
    if (!room) {
      // Create new room
      room = {
        host: null,
        client: null,
        created: now,
        lastActivity: now
      };
      rooms.set(roomId, room);
      console.log(`[room] Created: ${roomId.substring(0, 8)}...`);
    }
    
    room.lastActivity = now;
    
    // Determine role: first connection becomes host, second becomes client
    // If host slot is empty or disconnected, take it
    if (!room.host || room.host.readyState !== WebSocket.OPEN) {
      // Become host
      if (room.host) {
        // Clean up old host reference
        room.host = null;
      }
      
      room.host = ws;
      ws.roomId = roomId;
      ws.role = 'host';
      ws.isRoom = true;
      
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'room.joined',
        roomId: roomId,
        role: 'host',
        clientConnected: room.client && room.client.readyState === WebSocket.OPEN
      }));
      
      // Notify client if present
      if (room.client && room.client.readyState === WebSocket.OPEN) {
        room.client.send(JSON.stringify({
          type: 'relay',
          event: 'host.connected'
        }));
      }
      
      console.log(`[room] Host joined: ${roomId.substring(0, 8)}...`);
      
      ws.on('message', (data) => handleRoomMessage(ws, roomId, 'host', data));
      ws.on('close', () => handleRoomDisconnect(roomId, 'host', ws));
      
    } else {
      // Client slot - replace any existing client (handles reconnection)
      // This allows the same phone to reconnect after app restart
      if (room.client && room.client.readyState === WebSocket.OPEN) {
        // Close old client connection gracefully
        console.log(`[room] Replacing existing client in: ${roomId.substring(0, 8)}...`);
        room.client.send(JSON.stringify({
          type: 'relay',
          event: 'replaced',
          reason: 'Another client connected to this room'
        }));
        room.client.close();
      }
      
      room.client = ws;
      ws.roomId = roomId;
      ws.role = 'client';
      ws.isRoom = true;
      
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'room.joined',
        roomId: roomId,
        role: 'client',
        hostConnected: room.host && room.host.readyState === WebSocket.OPEN
      }));
      
      // Notify host
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'relay',
          event: 'client.connected'
        }));
      }
      
      console.log(`[room] Client joined: ${roomId.substring(0, 8)}...`);
      
      ws.on('message', (data) => handleRoomMessage(ws, roomId, 'client', data));
      ws.on('close', () => handleRoomDisconnect(roomId, 'client', ws));
    }
    
  } else if (match) {
    // Client joining existing channel
    const channelId = match[1];
    const channel = channels.get(channelId);
    
    if (!channel) {
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'error',
        error: 'Channel not found or expired'
      }));
      ws.close();
      return;
    }
    
    // SECURITY: Only allow one client per channel
    if (channel.client && channel.client.readyState === WebSocket.OPEN) {
      console.log(`[security] Rejected second client for channel: ${channelId.substring(0, 8)}...`);
      ws.send(JSON.stringify({
        type: 'relay',
        event: 'error',
        error: 'Channel already has a connected client'
      }));
      ws.close();
      return;
    }
    
    // Client joining
    channel.client = ws;
    channel.claimed = true;
    channel.lastActivity = Date.now();
    ws.channelId = channelId;
    ws.role = 'client';
    
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
        event: 'client.connected'
      }));
    }
    
    console.log(`[channel] Client joined: ${channelId.substring(0, 8)}...`);
    
    ws.on('message', (data) => handleClientMessage(ws, channelId, data));
    ws.on('close', () => handleClientDisconnect(channelId));
    
  } else {
    ws.send(JSON.stringify({
      type: 'relay',
      event: 'error',
      error: 'Invalid path. Use /new or /channel/{uuid}'
    }));
    ws.close();
  }
});

function handleHostMessage(ws, channelId, data) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  channel.lastActivity = Date.now();
  
  // Forward to client (we don't look inside - E2E encrypted)
  if (channel.client && channel.client.readyState === WebSocket.OPEN) {
    channel.client.send(data.toString());
  }
}

function handleClientMessage(ws, channelId, data) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  channel.lastActivity = Date.now();
  
  // Forward to host (we don't look inside - E2E encrypted)
  if (channel.host && channel.host.readyState === WebSocket.OPEN) {
    channel.host.send(data.toString());
  }
}

function handleHostDisconnect(channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  console.log(`[channel] Host disconnected: ${channelId.substring(0, 8)}...`);
  
  // Notify client
  if (channel.client && channel.client.readyState === WebSocket.OPEN) {
    channel.client.send(JSON.stringify({
      type: 'relay',
      event: 'host.disconnected'
    }));
  }
  
  // Close the entire channel when host disconnects
  // (no point keeping it open - new session will have new keys anyway)
  closeChannel(channelId);
}

function handleClientDisconnect(channelId) {
  const channel = channels.get(channelId);
  if (!channel) return;
  
  console.log(`[channel] Client disconnected: ${channelId.substring(0, 8)}...`);
  
  // Notify host
  if (channel.host && channel.host.readyState === WebSocket.OPEN) {
    channel.host.send(JSON.stringify({
      type: 'relay',
      event: 'client.disconnected'
    }));
  }
  
  // Clear the client slot (host can show new QR)
  channel.client = null;
}

// Room message handlers
function handleRoomMessage(ws, roomId, role, data) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.lastActivity = Date.now();
  
  // Forward to the other party
  const target = role === 'host' ? room.client : room.host;
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(data.toString());
  }
}

function handleRoomDisconnect(roomId, role, ws) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // IMPORTANT: Only process if this WebSocket is still the current one
  // This prevents race conditions when a new connection replaces an old one
  // and the old one's close event fires after
  if (role === 'host' && room.host !== ws) {
    console.log(`[room] Ignoring stale host disconnect for: ${roomId.substring(0, 8)}...`);
    return;
  }
  if (role === 'client' && room.client !== ws) {
    console.log(`[room] Ignoring stale client disconnect for: ${roomId.substring(0, 8)}...`);
    return;
  }
  
  console.log(`[room] ${role} disconnected: ${roomId.substring(0, 8)}...`);
  
  if (role === 'host') {
    // Notify client that host disconnected (but room persists!)
    if (room.client && room.client.readyState === WebSocket.OPEN) {
      room.client.send(JSON.stringify({
        type: 'relay',
        event: 'host.disconnected'
      }));
    }
    room.host = null;
  } else {
    // Notify host that client disconnected
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'relay',
        event: 'client.disconnected'
      }));
    }
    room.client = null;
  }
  
  // Note: Unlike channels, rooms persist even when empty
  // They'll be cleaned up after 7 days of inactivity
}

server.listen(PORT, () => {
  console.log(`ClawGPT Relay Server running on port ${PORT}`);
  console.log(`Security: E2E encrypted, single-client channels, UUID v4 IDs`);
  console.log(`Persistent rooms: /room/{name} for reconnection support`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
