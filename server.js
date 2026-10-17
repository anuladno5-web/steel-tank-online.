import express from "express";
import http from "node:http";
import { Server } from "socket.io";

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_ORIGIN || "*" },
  pingInterval: 10000,
  pingTimeout: 20000
});

app.get("/", (_req, res) => {
  res.type("text").send("Steel Tank Commander PvP server is running.");
});
app.get("/health", (_req, res) => res.json({ ok: true, waiting: queue.length, rooms: rooms.size }));

const PORT = Number(process.env.PORT || 10000);
const queue = [];
const rooms = new Map(); // roomId -> { players: [socketId, socketId], createdAt }
const socketRoom = new Map();
const lastStateAt = new Map();
const lastShotAt = new Map();

function removeFromQueue(id) {
  const i = queue.indexOf(id);
  if (i !== -1) queue.splice(i, 1);
}
function safeTankIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(0, Math.min(7, n)) : 0;
}
function makeRoom(a, b) {
  const roomId = `pvp-${a.slice(0, 5)}-${b.slice(0, 5)}-${Date.now().toString(36)}`;
  const room = { players: [a, b], createdAt: Date.now() };
  rooms.set(roomId, room);
  socketRoom.set(a, roomId);
  socketRoom.set(b, roomId);
  const spawn = [
    { x: -12, z: 0, yaw: Math.PI / 2 },
    { x: 12, z: 0, yaw: -Math.PI / 2 }
  ];
  for (let i = 0; i < 2; i++) {
    const id = room.players[i];
    io.sockets.sockets.get(id)?.join(roomId);
    io.to(id).emit("match:found", {
      roomId,
      slot: i,
      opponentId: room.players[1 - i],
      spawn: spawn[i],
      opponentSpawn: spawn[1 - i],
      tankIndex: Number(io.sockets.sockets.get(id)?.data?.tankIndex ?? 0),
      opponentTankIndex: Number(io.sockets.sockets.get(room.players[1 - i])?.data?.tankIndex ?? 0),
      map: "default"
    });
  }
}
function leaveRoom(socket, reason = "opponent-left") {
  const roomId = socketRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  socketRoom.delete(socket.id);
  socket.leave(roomId);
  if (!room) return;
  rooms.delete(roomId);
  const otherId = room.players.find(id => id !== socket.id);
  if (otherId) {
    socketRoom.delete(otherId);
    const other = io.sockets.sockets.get(otherId);
    if (other) {
      other.leave(roomId);
      other.emit("match:ended", { reason });
    }
  }
}

io.on("connection", socket => {
  socket.emit("server:ready", { version: 1 });

  socket.on("queue:join", payload => {
    if (socketRoom.has(socket.id)) {
      socket.emit("queue:error", { message: "Ты уже находишься в бою." });
      return;
    }
    removeFromQueue(socket.id);
    // The server accepts only a small public model index, never client stats.
    socket.data.tankIndex = safeTankIndex(payload?.tankIndex);
    const opponentIndex = queue.findIndex(id => id !== socket.id && io.sockets.sockets.has(id));
    if (opponentIndex >= 0) {
      const opponentId = queue.splice(opponentIndex, 1)[0];
      makeRoom(opponentId, socket.id);
    } else {
      queue.push(socket.id);
      socket.emit("queue:waiting", { position: 1 });
    }
  });

  socket.on("queue:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("queue:cancelled");
  });

  // State relay starter: server clamps values and rate-limits packets.
  // For a competitive release, replace this relay with authoritative simulation.
  socket.on("player:state", state => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !state || typeof state !== "object") return;
    const now = Date.now();
    if (now - (lastStateAt.get(socket.id) || 0) < 40) return; // max 25 updates/sec
    lastStateAt.set(socket.id, now);
    const num = (v, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
    };
    const clean = {
      x: num(state.x, -48, 48),
      y: num(state.y, 0, 8),
      z: num(state.z, -48, 48),
      yaw: num(state.yaw, -Math.PI * 8, Math.PI * 8),
      turretYaw: num(state.turretYaw, -Math.PI * 8, Math.PI * 8),
      tankIndex: safeTankIndex(state.tankIndex),
      hp: num(state.hp, 0, 10000),
      seq: Math.floor(num(state.seq, 0, 1e9))
    };
    socket.to(roomId).volatile.emit("opponent:state", clean);
  });

  // Visual event relay only. Damage/hit confirmation must be decided by server
  // before this can be used in a competitive build.
  socket.on("player:fire-visual", shot => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !shot || typeof shot !== "object") return;
    const now = Date.now();
    if (now - (lastShotAt.get(socket.id) || 0) < 250) return;
    lastShotAt.set(socket.id, now);
    const num = (v, min, max) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
    };
    socket.to(roomId).emit("opponent:fire-visual", {
      x: num(shot.x, -48, 48), y: num(shot.y, 0, 8), z: num(shot.z, -48, 48),
      yaw: num(shot.yaw, -Math.PI * 8, Math.PI * 8),
      turretYaw: num(shot.turretYaw, -Math.PI * 8, Math.PI * 8),
      seq: Math.floor(num(shot.seq, 0, 1e9))
    });
  });

  socket.on("match:leave", () => leaveRoom(socket, "opponent-left"));

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    leaveRoom(socket, "connection-lost");
    lastStateAt.delete(socket.id);
    lastShotAt.delete(socket.id);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Steel Tank Commander server listening on ${PORT}`);
});
