# ClawGPT Relay Server

WebSocket relay that bridges ClawGPT desktop and mobile clients for remote access.

## How it works

1. **Desktop** connects to `/new` → gets a unique channel ID
2. **QR code** contains the relay URL + channel ID
3. **Phone** scans QR, connects to `/channel/{id}`
4. **Relay** bridges all messages between them

```
Desktop ←──WebSocket──→ Relay ←──WebSocket──→ Phone
```

## API

### Create new channel (Desktop)
```
ws://relay.clawgpt.com/new
```
Returns: `{ type: "relay", event: "channel.created", channelId: "abc123" }`

### Join channel (Phone)
```
ws://relay.clawgpt.com/channel/abc123
```
Returns: `{ type: "relay", event: "channel.joined", role: "client", hostConnected: true }`

### Health check
```
GET /health
```

## Running locally

```bash
npm install
npm start
```

## Deployment

Deploy anywhere that supports Node.js + WebSockets:
- Fly.io
- Railway
- Render
- VPS with Docker

### Docker

```bash
docker build -t clawgpt-relay .
docker run -p 8787:8787 clawgpt-relay
```

### Fly.io

```bash
fly launch
fly deploy
```

## Environment Variables

- `PORT` - Server port (default: 8787)
