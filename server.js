
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const DB_FILE = path.join(__dirname, 'db.json');

const app = express();
app.use(bodyParser.json());
const server = http.createServer(app);
const io = socketIO(server);

const balances = {};
const userSocketMap = {};
const ADMIN_SECRET = 'changeme';

let players = {};
let lockedSeeds = new Set();
let calledNumbers = new Set();
let callPool = [];
let callInterval = null;
let countdownTimer = null;
let countdownTime = 60;
let gameStarted = false;
let winnerInfo = null;
let storedPlayers = {};

function loadPlayers() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = fs.readFileSync(DB_FILE);
      const obj = JSON.parse(data);
      if (obj.players) {
        storedPlayers = obj.players;
        for (const username in storedPlayers) {
          balances[username] = storedPlayers[username].balance || 0;
          lockedSeeds.add(storedPlayers[username].seed);
        }
        console.log('✅ Loaded players from db.json');
      }
    } catch (e) {
      console.error('❌ Failed to load players:', e);
    }
  }
}
loadPlayers();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function broadcastPlayers() {
  io.emit('players', Object.values(players));
}

function startCountdownIfNeeded() {
  if (Object.keys(players).length >= 2 && !gameStarted && !countdownTimer) {
    countdownTime = 60;
    io.emit('countdown', countdownTime);
    countdownTimer = setInterval(() => {
      countdownTime--;
      io.emit('countdown', countdownTime);
      if (countdownTime <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        startGame();
      }
    }, 1000);
  }
}

function startGame() {
  if (gameStarted || Object.keys(players).length === 0) return;

  gameStarted = true;
  calledNumbers.clear();
  callPool = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
  io.emit('gameStarted');
  io.emit('lockedSeedsUpdate', []); // ❌ Clear red highlights on frontend

  callInterval = setInterval(() => {
    if (Object.keys(players).length === 0) {
      console.log("🛑 No players left. Stopping game.");
      resetGame();
      return;
    }

    if (callPool.length === 0) return;
    const number = callPool.shift();
    calledNumbers.add(number);
    io.emit('numberCalled', number);
  }, 5000);
}

function resetGame() {
  clearInterval(callInterval);
  clearInterval(countdownTimer);
  callInterval = null;
  countdownTimer = null;
  players = {};
  lockedSeeds = new Set();
  calledNumbers = new Set();
  callPool = [];
  gameStarted = false;
  winnerInfo = null;
  io.emit('reset');
}

function updatePlayerBalanceByUsername(username, newBalance) {
  if (!username || typeof newBalance !== 'number') {
    throw new Error('Invalid username or balance value');
  }
  balances[username] = newBalance;
  const socketId = userSocketMap[username];
  if (socketId && io.sockets.sockets.get(socketId)) {
    io.to(socketId).emit('balanceUpdate', newBalance);
  }
  console.log(`✅ Updated balance for @${username} to ${newBalance}`);
}

app.post('/admin/update-balance', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { username, amount } = req.body;
  if (!username || typeof amount !== 'number' || amount < 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    updatePlayerBalanceByUsername(username, amount);
    storedPlayers[username] = storedPlayers[username] || {};
    storedPlayers[username].balance = amount;
    fs.writeFileSync(DB_FILE, JSON.stringify({ players: storedPlayers }, null, 2));
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/admin/get-balance', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const username = req.query.username;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const user = storedPlayers[username];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({ balance: user.balance || 0 });
});

app.get('/admin/list-users', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.json({ users: storedPlayers || {} });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', ({ username, seed }) => {
    if ((balances[username] || 0) < 0) {
      socket.emit('blocked', 'Not enough balance to play. Please top up.');
      return;
    }
    if (gameStarted) {
      socket.emit('blocked', 'Game already started');
      return;
    }

    const storedPlayer = storedPlayers[username] || {};
    const playerSeed = storedPlayer.seed ?? seed;

    if (lockedSeeds.has(playerSeed)) {
      socket.emit('blocked', 'Card already taken');
      return;
    }

    const balance = storedPlayer.balance ?? (balances[username] || 0);

    players[socket.id] = {
      id: socket.id,
      username,
      seed: playerSeed,
      balance,
    };

    lockedSeeds.add(playerSeed);
    userSocketMap[username] = socket.id;

    socket.emit('init', {
      username,
      calledNumbers: Array.from(calledNumbers),
      balance: balances[username] || 0,
      lockedSeeds: Array.from(lockedSeeds),
    });

    broadcastPlayers();
    startCountdownIfNeeded();
  });

  socket.on('bingo', (card) => {
  if (!gameStarted || winnerInfo) return;

  winnerInfo = {
    username: players[socket.id]?.username || 'Unknown',
    card
  };

  io.emit('winner', winnerInfo);

  // ✅ STOP calling numbers immediately
  clearInterval(callInterval);
  callInterval = null;
});

  socket.on('playAgain', () => {
    resetGame();
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      lockedSeeds.delete(player.seed);
      delete userSocketMap[player.username];
      delete players[socket.id];
    }
    broadcastPlayers();
    console.log('User disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('✅ Bingo server running at http://localhost:3000');
});
