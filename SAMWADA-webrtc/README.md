    # WebRTC Room App (starter)

    A standards-based WebRTC application with:

    - Room-based audio/video with low-latency peer connections
    - Signaling server (WebSocket + Express)
    - File sharing (data channel), live chat, one-to-one and group sharing tabs
    - TURN support (configurable)
    - Screen-share, recording, and robust chunked file transfer example

## How to run (dev)

1. Create project folder and paste files from this scaffold.
2. Install server dependencies:
   ```bash
   cd server
   npm install
   node index.js
   ```
3. Install client dependencies and start dev server:
   ```bash
   cd client
   npm install
   npm start
   ```

Notes:
- Add TURN credentials in `server/config.js` or environment variables.
- Use HTTPS/WSS in production.
