# SFU Integration Notes

This starter uses peer-to-peer mesh. For scalability use an SFU like mediasoup or Janus.

High-level changes:
- Keep signaling server but add room-level producer/consumer signaling for SFU.
- Move heavy logic to server; use mediasoup-worker/routers and client-side consume/produce flows.
- Use TURN servers for improved connectivity.

See mediasoup docs for full example.
