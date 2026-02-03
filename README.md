# ClawGPT Relay Server

WebSocket relay that bridges ClawGPT desktop and mobile clients for secure remote access.

## 🔒 Security

ClawGPT Relay is designed with security as a priority. We use industry-standard cryptography to ensure your data stays private.

### End-to-End Encryption

| Feature | Status | Description |
|---------|--------|-------------|
| **E2E Encryption** | ✅ | All messages encrypted with XSalsa20-Poly1305 |
| **Key Exchange** | ✅ | X25519 (Curve25519) Diffie-Hellman |
| **Zero-Knowledge Relay** | ✅ | Relay only sees encrypted blobs, never plaintext |
| **Visual Verification** | ✅ | Matching words on both devices confirms secure connection |
| **Forward Secrecy** | ✅ | New keypair generated for each session |

### How It Works

```
┌─────────┐                  ┌─────────┐                  ┌─────────┐
│ Desktop │                  │  Relay  │                  │  Phone  │
└────┬────┘                  └────┬────┘                  └────┬────┘
     │                            │                            │
     │  1. Connect + get channel  │                            │
     │ ─────────────────────────> │                            │
     │                            │                            │
     │  2. QR code contains:      │                            │
     │     - Channel ID           │                            │
     │     - Desktop PUBLIC key   │                            │
     │     (NOT your auth token!) │                            │
     │                            │                            │
     │                            │  3. Phone scans QR         │
     │                            │ <───────────────────────── │
     │                            │                            │
     │  4. Phone sends its        │                            │
     │     public key             │                            │
     │ <───────────────────────── │ <───────────────────────── │
     │                            │                            │
     │  5. Both derive shared     │                            │
     │     secret (X25519)        │     Same shared secret     │
     │                            │                            │
     │  6. All messages encrypted │  Relay sees only           │
     │ ══════════════════════════>│  encrypted blobs           │
     │                            │ ══════════════════════════>│
     │                            │                            │
     │  7. Visual verification:   │                            │
     │     apple-tiger-castle-moon│  apple-tiger-castle-moon   │
     └────────────────────────────┴────────────────────────────┘
```

### Cryptographic Details

- **Key Exchange**: X25519 (Curve25519 Diffie-Hellman)
- **Encryption**: XSalsa20-Poly1305 (authenticated encryption)
- **Nonce**: 24 random bytes per message (never reused)
- **Library**: [TweetNaCl.js](https://tweetnacl.js.org/) - audited, battle-tested

### What This Means

- ✅ **We can't read your messages** - even if we wanted to
- ✅ **Man-in-the-middle attacks prevented** - visual verification catches them
- ✅ **Your auth token never touches the relay** - encrypted end-to-end
- ✅ **Each session is unique** - compromising one doesn't affect others

---

## How It Works

1. **Desktop** connects to `/new` → gets a unique channel ID
2. **QR code** contains the relay URL + channel ID + desktop's public key
3. **Phone** scans QR, connects to `/channel/{id}`
4. **Key exchange** happens, shared secret derived
5. **All traffic** is encrypted end-to-end

```
Desktop ←──🔐 Encrypted ──→ Relay ←──🔐 Encrypted ──→ Phone
```

## API

### Create new channel (Desktop)
```
wss://clawgpt-relay.fly.dev/new
```
Returns: `{ type: "relay", event: "channel.created", channelId: "abc123" }`

### Join channel (Phone)
```
wss://clawgpt-relay.fly.dev/channel/abc123
```
Returns: `{ type: "relay", event: "channel.joined", role: "client", hostConnected: true }`

### Health check
```
GET https://clawgpt-relay.fly.dev/health
```

## Self-Hosting

Don't trust our relay? Run your own!

### Local Development

```bash
npm install
npm start
```

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

### Other Platforms

Deploy anywhere that supports Node.js + WebSockets:
- Railway
- Render
- DigitalOcean App Platform
- Any VPS

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8787 | Server port |

## Security Reporting

Found a vulnerability? Please report it responsibly:
- Open a GitHub issue (for non-critical issues)
- For critical vulnerabilities, contact us directly before public disclosure

## License

MIT
