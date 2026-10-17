/*
 * Starter adapter for the Steel Tank Commander HTML client.
 * Load this after Socket.IO's client script and before your game script,
 * or copy the module's methods into the existing game's main script.
 *
 * This handles matchmaking + network events only. Your game must connect
 * onLocalState() to the existing tank update loop and implement
 * onOpponentState()/onOpponentFire() to update/render the remote tank.
 */
(() => {
  const SERVER_URL = window.STC_SERVER_URL || window.location.origin;
  const socket = io(SERVER_URL, { transports: ["websocket", "polling"] });

  const net = {
    socket,
    active: false,
    waiting: false,
    roomId: null,
    slot: -1,
    seq: 0,
    callbacks: {
      status: () => {},
      matchFound: () => {},
      opponentState: () => {},
      opponentFire: () => {},
      matchEnded: () => {},
      error: () => {}
    },
    on(name, fn) {
      if (Object.hasOwn(this.callbacks, name) && typeof fn === "function") this.callbacks[name] = fn;
      return this;
    },
    findRandomMatch(tankIndex = 0) {
      if (!socket.connected) {
        this.callbacks.status("Подключение к серверу…");
        socket.connect();
        socket.once("connect", () => socket.emit("queue:join", { tankIndex }));
        return;
      }
      this.waiting = true;
      this.callbacks.status("Поиск случайного соперника…");
      socket.emit("queue:join", { tankIndex });
    },
    cancelSearch() {
      this.waiting = false;
      socket.emit("queue:cancel");
      this.callbacks.status("Поиск отменён");
    },
    sendState(state) {
      if (!this.active || !state) return;
      socket.volatile.emit("player:state", { ...state, seq: ++this.seq });
    },
    sendFireVisual(state) {
      if (!this.active || !state) return;
      socket.emit("player:fire-visual", { ...state, seq: ++this.seq });
    },
    leaveMatch() {
      if (this.active) socket.emit("match:leave");
      this.active = false;
      this.waiting = false;
      this.roomId = null;
      this.slot = -1;
    }
  };

  socket.on("connect", () => net.callbacks.status("Подключено к серверу"));
  socket.on("connect_error", () => net.callbacks.status("Сервер недоступен. Повторная попытка…"));
  socket.on("disconnect", () => {
    net.active = false;
    net.callbacks.status("Соединение потеряно");
  });
  socket.on("queue:waiting", () => net.callbacks.status("Ищем соперника…"));
  socket.on("queue:cancelled", () => {
    net.waiting = false;
    net.callbacks.status("Поиск отменён");
  });
  socket.on("queue:error", d => net.callbacks.error(d?.message || "Ошибка очереди"));
  socket.on("match:found", data => {
    net.waiting = false;
    net.active = true;
    net.roomId = data.roomId;
    net.slot = data.slot;
    net.callbacks.matchFound(data);
  });
  socket.on("opponent:state", data => net.callbacks.opponentState(data));
  socket.on("opponent:fire-visual", data => net.callbacks.opponentFire(data));
  socket.on("match:ended", data => {
    net.active = false;
    net.waiting = false;
    net.roomId = null;
    net.slot = -1;
    net.callbacks.matchEnded(data);
  });

  window.STCOnline = net;
})();
