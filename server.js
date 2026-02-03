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
  
  // Rate limiting
  MAX_CHANNELS_PER_IP: 10,                  // Max active channels per IP
  CHANNEL_CREATE_COOLDOWN_MS: 1000,         // Min time between channel creations
  
  // Cleanup interval
  CLEANUP_INTERVAL_MS: 60 * 1000            // Check for stale channels every minute
};

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
  
  // Clean up old IP limits
  for (const [ip, limit] of ipLimits) {
    if (now - limit.lastCreate > 3600000) { // 1 hour
      ipLimits.delete(ip);
    }
  }
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

server.listen(PORT, () => {
  console.log(`ClawGPT Relay Server running on port ${PORT}`);
  console.log(`Security: E2E encrypted, single-client channels, UUID v4 IDs`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
