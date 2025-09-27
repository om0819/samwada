require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3001,
  WS_PATH: '/ws',
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};
