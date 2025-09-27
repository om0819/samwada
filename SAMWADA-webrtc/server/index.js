const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { PORT, WS_PATH, ICE_SERVERS } = require('./config');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('WebRTC Room App Signaling Server'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: WS_PATH });

const rooms = new Map();

function send(ws, type, payload) {
  ws.send(JSON.stringify({ type, payload }));
}

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.roomId = null;

  ws.on('message', (msg) => {
    let m = null;
    try { m = JSON.parse(msg); } catch (e) { return; }
    const { type, payload } = m;

    switch (type) {
      case 'join': {
        const { roomId, displayName } = payload;
        ws.roomId = roomId;
        ws.displayName = displayName || 'Anonymous';
        if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Map() });
        const room = rooms.get(roomId);
        room.clients.set(ws.id, ws);

        for (const [id, client] of room.clients) {
          if (id === ws.id) continue;
          send(client, 'peer-joined', { id: ws.id, displayName: ws.displayName });
        }

        send(ws, 'joined', { id: ws.id, peers: Array.from(room.clients.keys()).filter(id => id !== ws.id), iceServers: ICE_SERVERS });
        break;
      }

      case 'signal': {
        const { target, data } = payload;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const targetWs = room.clients.get(target);
        if (!targetWs) return;
        send(targetWs, 'signal', { from: ws.id, data });
        break;
      }

      case 'broadcast': {
        const { data } = payload;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const [id, client] of room.clients) {
          if (id === ws.id) continue;
          send(client, 'broadcast', { from: ws.id, data });
        }
        break;
      }

      case 'leave': {
        const room = rooms.get(ws.roomId);
        if (room) {
          room.clients.delete(ws.id);
          for (const client of room.clients.values()) send(client, 'peer-left', { id: ws.id });
        }
        ws.roomId = null;
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.clients.delete(ws.id);
    for (const client of room.clients.values()) send(client, 'peer-left', { id: ws.id });
    if (room.clients.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => console.log(`Signaling server listening on ${PORT}${WS_PATH}`));
