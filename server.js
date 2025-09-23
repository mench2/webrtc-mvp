import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// simple in-memory rooms map: roomId -> Set(socketId)
const roomIdToSocketIds = new Map();

io.on('connection', (socket) => {
  socket.on('join', (roomId) => {
    if (!roomIdToSocketIds.has(roomId)) roomIdToSocketIds.set(roomId, new Set());
    const peers = roomIdToSocketIds.get(roomId);
    peers.add(socket.id);
    socket.join(roomId);

    // Отправляем новому пиру список всех существующих пиров
    const existingPeers = [...peers].filter(id => id !== socket.id);
    socket.emit('peers-list', { peers: existingPeers });

    // Уведомляем всех существующих пиров о новом участнике
    socket.to(roomId).emit('peer-joined', { socketId: socket.id });

    socket.on('disconnect', () => {
      peers.delete(socket.id);
      socket.to(roomId).emit('peer-left', { socketId: socket.id });
      if (peers.size === 0) roomIdToSocketIds.delete(roomId);
    });
  });

  socket.on('signal', ({ to, data }) => {
    if (to) io.to(to).emit('signal', { from: socket.id, data });
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`webrtc-mvp listening on http://localhost:${PORT}`);
});


