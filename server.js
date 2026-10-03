// マルチプレイ用ロビーサーバー(Node.js + Socket.IO)
//
// 使い方:
//   npm install
//   node server.js
//   (環境変数 PORT でポート番号を指定可能。デフォルトは 8080)
//
// このサーバーが持つ役割は「部屋(ルーム)の管理(参加者・マップ選択・ゲーム開始の合図)」と「プレイヤー同士の位置情報の橋渡し」だけ。
// 幽霊の正解データなど、ゲーム本編の同期はまだ実装していない(ロビーが固まってから着手する)。
//
// Socket.IOの基本(このファイルを読むときの目安):
//   socket.on('イベント名', (データ) => {...})  : クライアントから届いたイベントを受け取る
//   socket.emit('イベント名', データ)           : そのクライアントだけに送る
//   io.to(部屋名).emit(...)                      : 同じ部屋にいる全員に送る
//   socket.to(部屋名).emit(...)                  : 同じ部屋の、送ってきた本人以外に送る
//   socket.join(部屋名)                          : そのクライアントを部屋に入れる(ここでは部屋コードをそのまま部屋名にしている)

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I など紛らわしい文字は除外
const PLAYER_COLORS = [0xff5555, 0x55aaff, 0x55dd77, 0xffcc33]; // 最大4人ぶんの識別色
const MAPS = ['house', 'grafton']; // 選べるマップのid(lobby-board.js の MAPS と同じ。main.js の ?map= にもそのまま使う)
const DEFAULT_MAP = 'grafton';

// ---------- 接続を許可するサイト(CORS) ----------
// ブラウザは、別のドメインのサーバーへの接続を、サーバーが許可したサイトからのものに限っている。
// ここに、ロビーのページを公開しているサイトのURLを書いておく。環境変数 ALLOWED_ORIGINS(カンマ区切り)でも追加できる。
const ALLOWED_ORIGINS = [
  'https://carupisu0320.github.io', // GitHub Pages(ユーザー名のサイトの下にあるページ全部)
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : []),
];
function isAllowedOrigin(origin) {
  if (!origin) return true;                                           // ブラウザ以外(テスト用のスクリプトなど)
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // 自分のパソコンで試すとき(ポートは何番でもOK)
}

// ---------- サーバー本体 ----------
// 普通のURLにアクセスされたときは「動いています」と返す(ホスティング側の死活確認と、ブラウザでの動作確認用)
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ghost-hunting lobby server is running\n');
});
const io = new Server(httpServer, {
  cors: { origin: (origin, callback) => callback(null, isAllowedOrigin(origin)) },
});

const rooms = new Map(); // code -> { code, map, players: Map(socket.id -> player) }

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function roomPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, color: p.color, host: p.host }));
}

function cleanName(value) {
  return String(value || 'プレイヤー').trim().slice(0, 12) || 'プレイヤー';
}

function removePlayerFromRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  const leaving = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (leaving && leaving.host) {
    // ホストが抜けたら、残っている中で一番古参のプレイヤーを次のホストにする
    const next = room.players.values().next().value;
    next.host = true;
    io.to(room.code).emit('hostChanged', { id: next.id });
  }
  io.to(room.code).emit('playerLeft', { id: socket.id });
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  // 部屋を作る
  socket.on('create', (msg = {}) => {
    if (socket.data.roomCode) return; // すでにどこかの部屋にいる
    const code = generateRoomCode();
    const map = MAPS.includes(msg.map) ? msg.map : DEFAULT_MAP;
    const player = { id: socket.id, host: true, color: PLAYER_COLORS[0], name: cleanName(msg.name) };
    const room = { code, map, players: new Map([[socket.id, player]]) };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit('created', { code, map, playerId: socket.id, players: roomPlayerList(room) });
  });

  // 部屋に参加する
  socket.on('join', (msg = {}) => {
    if (socket.data.roomCode) return;
    const room = rooms.get(String(msg.code || '').toUpperCase());
    if (!room) { socket.emit('error', { message: 'その部屋コードは見つかりませんでした' }); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit('error', { message: 'この部屋は満員です(最大4人)' }); return; }

    const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
    const player = { id: socket.id, host: false, color, name: cleanName(msg.name) };
    room.players.set(socket.id, player);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('joined', { code: room.code, map: room.map, playerId: socket.id, players: roomPlayerList(room) });
    socket.to(room.code).emit('playerJoined', { id: socket.id, name: player.name, color: player.color, host: player.host });
  });

  // 自分の位置を伝える(ほかの人にだけ中継する)
  socket.on('move', (msg = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || ![msg.x, msg.y, msg.z, msg.rotY].every(Number.isFinite)) return;
    socket.to(room.code).emit('playerMove', { id: socket.id, x: msg.x, y: msg.y, z: msg.z, rotY: msg.rotY });
  });

  // マップを変える(ホストだけ。存在するマップにだけ変えられる)
  socket.on('setMap', (msg = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.host || !MAPS.includes(msg.map)) return;
    room.map = msg.map;
    socket.to(room.code).emit('mapChanged', { map: room.map }); // 変えた本人は手元で反映済みなので、ほかの人にだけ送る
  });

  // ゲーム開始(ホストだけ)。全員(ホスト自身も)に、選ばれているマップを伝える
  socket.on('start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.host) return;
    io.to(room.code).emit('gameStart', { map: room.map });
  });

  socket.on('disconnect', () => removePlayerFromRoom(socket));
});

httpServer.listen(PORT, () => console.log(`ロビーサーバー起動: http://localhost:${PORT}`));
