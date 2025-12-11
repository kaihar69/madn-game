const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');

app.use(express.static('public'));

// --- KONFIGURATION ---
const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };
const DELAY_AFTER_ROLL = 2000; 
const DELAY_BETWEEN_TURNS = 1500; 
const DATA_FILE = 'game_state.json';

// GLOBALE LOBBY
let games = {}; 

loadGameData();

// Cleanup Loop (Alle 30 Min)
setInterval(() => {
    Object.keys(games).forEach(roomId => {
        if (Object.keys(games[roomId].players).length === 0) {
            delete games[roomId];
            persistGame();
        }
    });
}, 30 * 60 * 1000);

io.on('connection', (socket) => {
    
    // --- NEUES SPIEL ---
    socket.on('createGame', (playerName) => {
        try {
            const roomId = generateRoomId();
            games[roomId] = createNewGame();
            joinRoom(socket, roomId, playerName);
        } catch (e) { console.error("Error Create:", e); }
    });

    // --- BEITRETEN ---
    socket.on('requestJoin', (data) => {
        try {
            const roomId = (data.roomId || "").toUpperCase();
            const playerName = data.name;

            if (!games[roomId]) { socket.emit('joinError', 'Raum nicht gefunden!'); return; }
            if (Object.keys(games[roomId].players).length >= 4) { socket.emit('joinError', 'Raum ist voll!'); return; }
            if (games[roomId].running) { socket.emit('joinError', 'Spiel läuft bereits!'); return; }

            joinRoom(socket, roomId, playerName);
        } catch (e) { console.error("Error Join:", e); }
    });

    // --- REJOIN ---
    socket.on('requestRejoin', (token) => {
        try {
            let foundRoomId = null;
            let foundPlayerId = null;

            for (const [rId, game] of Object.entries(games)) {
                Object.values(game.players).forEach(p => {
                    if (p.token === token) { foundRoomId = rId; foundPlayerId = p.id; }
                });
                if (foundRoomId) break;
            }

            if (foundRoomId && foundPlayerId) {
                const game = games[foundRoomId];
                const oldPlayer = game.players[foundPlayerId];
                delete game.players[foundPlayerId];

                game.players[socket.id] = {
                    ...oldPlayer, id: socket.id, isBot: false,
                    name: oldPlayer.name.replace(' (Bot)', ''), token: token 
                };

                socket.join(foundRoomId);
                socket.data.roomId = foundRoomId;

                socket.emit('joinSuccess', { id: socket.id, players: game.players, token: token, roomId: foundRoomId, rejoining: true });
                io.to(foundRoomId).emit('updateBoard', game.players);
                io.to(foundRoomId).emit('gameLog', `${game.players[socket.id].name} ist zurück!`);
                broadcastRoomStatus(foundRoomId);
                persistGame();
            } else {
                socket.emit('rejoinError'); 
            }
        } catch (e) { console.error("Error Rejoin:", e); }
    });

    // --- START ---
    socket.on('startGame', () => {
        try {
            const roomId = socket.data.roomId;
            if(!roomId || !games[roomId]) return;
            const game = games[roomId];
            if (game.running) return;
            
            let botIndex = 1;
            while (Object.keys(game.players).length < 4) {
                const botCount = Object.keys(game.players).filter(id => id.startsWith('bot-')).length;
                const botId = `bot-${Date.now()}-${botCount}`;
                const color = getColor(Object.keys(game.players).length);
                game.players[botId] = { 
                    id: botId, color: color, name: `Bot ${botIndex}`, pieces: [-1, -1, -1, -1], isBot: true, lastRoll: null, rollCount: 0, token: null 
                };
                botIndex++;
            }
            
            game.running = true;
            io.to(roomId).emit('updateBoard', game.players);
            io.to(roomId).emit('gameStarted');
            broadcastRoomStatus(roomId);
            persistGame();
            
            if (typeof checkBotTurn === 'function') checkBotTurn(roomId);
        } catch (e) { console.error("Error Start:", e); }
    });

    // --- EMOJIS (NEU) ---
    socket.on('sendEmote', (emoji) => {
        const roomId = socket.data.roomId;
        if(roomId && games[roomId]) {
            // Sende Emoji an ALLE im Raum (inkl. Absender)
            io.to(roomId).emit('emoteReceived', emoji);
        }
    });

    // --- SPIEL AKTIONEN ---
    socket.on('rollDice', () => {
        const roomId = socket.data.roomId;
        if(roomId && games[roomId]) {
            const player = games[roomId].players[socket.id];
            if (player && games[roomId].running && player.color === TURN_ORDER[games[roomId].turnIndex] && !player.lastRoll) {
                handleRoll(roomId, player);
            }
        }
    });

    socket.on('movePiece', (data) => {
        const roomId = socket.data.roomId;
        if(roomId && games[roomId]) {
            const player = games[roomId].players[socket.id];
            if (player && games[roomId].running && player.color === TURN_ORDER[games[roomId].turnIndex] && player.lastRoll) {
                
                const forcedIndex = getForcedMoveIndex(games[roomId], player);
                if (forcedIndex !== -1) {
                    const isForcedInHouse = player.pieces[forcedIndex] === -1;
                    const isSelectedInHouse = player.pieces[data.pieceIndex] === -1;
                    if (isForcedInHouse && !isSelectedInHouse) { socket.emit('gameLog', "Zwang: Rauskommen!"); return; }
                    if (!isForcedInHouse && data.pieceIndex !== forcedIndex) { socket.emit('gameLog', "Zwang: Start räumen!"); return; }
                }

                const rolledSix = (player.lastRoll === 6);
                if (tryMove(roomId, player, data.pieceIndex)) {
                    io.to(roomId).emit('updateBoard', games[roomId].players);
                    checkWin(roomId, player);
                    finishTurn(roomId, player, rolledSix);
                }
            }
        }
    });

    socket.on('disconnect', () => handleDisconnect(socket));
});

// --- HELPER ---
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (games[result]) return generateRoomId();
    return result;
}

function joinRoom(socket, roomId, playerName) {
    const game = games[roomId];
    socket.join(roomId);
    socket.data.roomId = roomId;

    let safeName = (playerName || "").substring(0, 12).trim();
    if (safeName.length === 0) safeName = `Spieler ${Object.keys(game.players).length + 1}`;

    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const color = getColor(Object.keys(game.players).length);

    game.players[socket.id] = { 
        id: socket.id, token: token, color: color, name: safeName,
        pieces: [-1, -1, -1, -1], isBot: false, lastRoll: null, rollCount: 0 
    };

    socket.emit('joinSuccess', { id: socket.id, players: game.players, token: token, roomId: roomId });
    io.to(roomId).emit('updateBoard', game.players);
    io.to(roomId).emit('turnUpdate', TURN_ORDER[game.turnIndex]);
    broadcastRoomStatus(roomId); 
    persistGame();
}

function handleDisconnect(socket) {
    const roomId = socket.data.roomId;
    if (roomId && games[roomId]) {
        const game = games[roomId];
        if (game.players[socket.id]) {
            const player = game.players[socket.id];
            if (!game.running) {
                delete game.players[socket.id];
                io.to(roomId).emit('updateBoard', game.players);
                broadcastRoomStatus(roomId);
            } else {
                if (!game.players[socket.id].rejoined) {
                    io.to(roomId).emit('gameLog', `${player.name} ist weg.`);
                    const botId = `bot-rep-${Date.now()}`;
                    game.players[botId] = {
                        ...player, id: botId, name: `${player.name} (Bot)`, isBot: true, lastRoll: null, token: player.token 
                    };
                    delete game.players[socket.id];
                    io.to(roomId).emit('updateBoard', game.players);
                    if (game.players[botId].color === TURN_ORDER[game.turnIndex]) {
                        setTimeout(() => playBotRoll(roomId, game.players[botId]), 2000);
                    }
                }
            }
            persistGame();
        }
    }
}

function createNewGame() { return { players: {}, turnIndex: 0, running: false }; }
function resetGame(roomId) {
    if(games[roomId]) {
        games[roomId] = createNewGame();
        broadcastRoomStatus(roomId);
        io.to(roomId).emit('updateBoard', {});
        io.to(roomId).emit('gameLog', "Spiel zurückgesetzt.");
        io.to(roomId).emit('turnUpdate', 'red'); 
        persistGame();
    }
}
function broadcastRoomStatus(roomId) {
    if (!games[roomId]) return;
    const count = Object.keys(games[roomId].players).length;
    io.to(roomId).emit('roomStatus', { running: games[roomId].running, count: count, full: count >= 4 }); 
}
function persistGame() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(games, null, 2)); } catch (e) {} }
function loadGameData() {
    try { 
        if (fs.existsSync(DATA_FILE)) { 
            games = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); 
            Object.keys(games).forEach(roomId => {
                if(games[roomId].running) setTimeout(() => checkBotTurn(roomId), 1000);
            });
        } 
    } catch (e) { games = {}; }
}
function emitStatus(socket) { socket.emit('serverStatus', { running: false, count: 0 }); }

// --- GAME LOGIC ---

function handleRoll(roomId, player) {
    const game = games[roomId];
    if(!game) return;

    io.to(roomId).emit('playSound', 'roll');

    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++;
    const roll = player.lastRoll;
    let canRetry = false, movePossible = false;

    if(!player.pieces) player.pieces = [-1,-1,-1,-1];
    const empty = player.pieces.every(p => p === -1 || p >= 100);

    if (empty) {
        if (roll === 6) { canRetry = false; movePossible = true; }
        else {
            if (canMoveAny(game, player)) { canRetry = false; movePossible = true; }
            else { if (player.rollCount < 3) { canRetry = true; player.lastRoll = null; } else { canRetry = false; movePossible = false; } }
        }
    } else {
        if (canMoveAny(game, player)) { canRetry = false; movePossible = true; } 
        else { canRetry = false; movePossible = false; }
    }

    io.to(roomId).emit('diceRolled', { value: roll, player: player.color, canRetry: canRetry });
    
    if (canRetry) io.to(roomId).emit('gameLog', `${player.name}: ${player.rollCount}/3`);
    else if (!movePossible) io.to(roomId).emit('gameLog', `Kein Zug.`);
    
    persistGame();

    if (player.isBot) {
        if (canRetry) setTimeout(() => playBotRoll(roomId, player), DELAY_AFTER_ROLL);
        else if (movePossible) {
            if(!player.lastRoll) player.lastRoll = roll;
            setTimeout(() => playBotMove(roomId, player), DELAY_AFTER_ROLL);
        } else setTimeout(() => finishTurn(roomId, player, false), DELAY_AFTER_ROLL);
    } else {
        if (!canRetry && !movePossible) setTimeout(() => finishTurn(roomId, player, false), DELAY_AFTER_ROLL);
    }
}

function playBotMove(roomId, bot) {
    const game = games[roomId];
    if(!game || !bot.lastRoll) { finishTurn(roomId, bot, false); return; }

    const forcedIdx = getForcedMoveIndex(game, bot);
    if (forcedIdx !== -1) { 
        if (tryMove(roomId, bot, forcedIdx)) { finishBotTurn(roomId, game, bot); return; }
    }

    let possibleMoves = [];
    for (let i = 0; i < 4; i++) {
        if (isMoveValid(game, bot, i, bot.lastRoll)) {
            const score = evaluateMove(game, bot, i, bot.lastRoll);
            possibleMoves.push({ index: i, score: score });
        }
    }

    if (possibleMoves.length > 0) {
        possibleMoves.sort((a, b) => b.score - a.score);
        if (tryMove(roomId, bot, possibleMoves[0].index)) {
            finishBotTurn(roomId, game, bot);
        } else { finishTurn(roomId, bot, false); }
    } else {
        finishTurn(roomId, bot, false);
    }
}

function evaluateMove(game, player, pieceIndex, roll) {
    let score = 0;
    const currentPos = player.pieces[pieceIndex];
    let newPos;

    if (currentPos === -1) newPos = START_OFFSETS[player.color];
    else if (currentPos >= 100) newPos = 100 + (currentPos - 100 + roll);
    else {
        const entryPoint = ENTRY_POINTS[player.color];
        const dist = (entryPoint - currentPos + 40) % 40;
        if (dist < roll) newPos = 100 + (roll - dist - 1);
        else newPos = (currentPos + roll) % 40;
    }

    if (newPos < 100) {
        Object.values(game.players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach(pos => { if (pos === newPos) score += 100; }); 
            }
        });
    }
    if (newPos >= 100) score += 50; 
    if (currentPos === -1) score += 30; 
    score += 10; 

    return score;
}

function finishBotTurn(roomId, game, bot) {
    io.to(roomId).emit('updateBoard', game.players); 
    checkWin(roomId, bot); 
    finishTurn(roomId, bot, bot.lastRoll === 6); 
}

function playBotRoll(roomId, bot) { handleRoll(roomId, bot); }

function tryMove(roomId, player, pieceIndex) {
    const game = games[roomId];
    if (!isMoveValid(game, player, pieceIndex, player.lastRoll)) return false;
    const currentPos = player.pieces[pieceIndex];
    const roll = player.lastRoll;
    let newPos;
    
    if (currentPos === -1) newPos = START_OFFSETS[player.color];
    else if (currentPos >= 100) newPos = 100 + (currentPos - 100 + roll);
    else {
        const entryPoint = ENTRY_POINTS[player.color];
        const dist = (entryPoint - currentPos + 40) % 40;
        if (dist < roll) newPos = 100 + (roll - dist - 1);
        else newPos = (currentPos + roll) % 40;
    }

    let kicked = false;
    if (newPos < 100) {
        Object.values(game.players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach((pos, idx) => {
                    if (pos === newPos) { other.pieces[idx] = -1; io.to(roomId).emit('gameLog', `Kick!`); kicked = true; }
                });
            }
        });
    }

    if (kicked) io.to(roomId).emit('playSound', 'kick');
    else io.to(roomId).emit('playSound', 'move');

    player.pieces[pieceIndex] = newPos;
    persistGame();
    return true;
}

function getForcedMoveIndex(game, player) {
    const startPos = START_OFFSETS[player.color];
    const hasInHouse = player.pieces.some(p => p === -1);
    if (player.lastRoll === 6 && hasInHouse) {
        if (!isOccupiedBySelf(player, startPos)) return player.pieces.findIndex(p => p === -1);
    }
    if (hasInHouse) {
        const indexOnStart = player.pieces.findIndex(p => p === startPos);
        if (indexOnStart !== -1 && isMoveValid(game, player, indexOnStart, player.lastRoll)) return indexOnStart;
    }
    return -1; 
}

function isMoveValid(game, player, pieceIndex, roll) {
    if (!player || !game || !roll) return false; 
    const currentPos = player.pieces[pieceIndex];
    const startPos = START_OFFSETS[player.color];
    if (currentPos === -1) return (roll === 6 && !isOccupiedBySelf(player, startPos));
    let newPos;
    if (currentPos >= 100) {
        const targetIdx = currentPos - 100;
        const targetDest = targetIdx + roll;
        if (targetDest > 3) return false;
        if (isPathBlockedInTarget(player, targetIdx, targetDest)) return false;
        if (isOccupiedBySelf(player, 100 + targetDest)) return false;
        return true;
    } else {
        const entryPoint = ENTRY_POINTS[player.color];
        const dist = (entryPoint - currentPos + 40) % 40;
        if (dist < roll) {
            const stepsIn = roll - dist - 1;
            if (stepsIn > 3 || stepsIn < 0) return false;
            if (isOccupiedBySelf(player, 100 + stepsIn)) return false;
            return true;
        } else {
            newPos = (currentPos + roll) % 40;
            if (isOccupiedBySelf(player, newPos)) return false;
        }
    }
    let protectedField = false;
    Object.values(game.players).forEach(other => {
        if (other.id !== player.id) { 
            other.pieces.forEach(pos => { if (pos === newPos && pos === START_OFFSETS[other.color]) protectedField = true; }); 
        }
    });
    if (protectedField) return false; 
    return true; 
}

function finishTurn(roomId, player, wasSix) {
    const game = games[roomId]; if(!game) return;
    if (wasSix === undefined) wasSix = (player.lastRoll === 6);
    if (wasSix) {
        io.to(roomId).emit('gameLog', `Nochmal (6)!`);
        player.lastRoll = null; player.rollCount = 0;   
        io.to(roomId).emit('turnUpdate', player.color);
        if(player.isBot) setTimeout(() => playBotRoll(roomId, player), DELAY_BETWEEN_TURNS);
    } else { player.lastRoll = null; nextTurn(roomId); }
}

function nextTurn(roomId) {
    const game = games[roomId]; if(!game) return;
    let attempts = 0, foundNext = false;
    while(attempts < 4 && !foundNext) {
        game.turnIndex = (game.turnIndex + 1) % 4;
        const nextColor = TURN_ORDER[game.turnIndex];
        const hasPlayer = Object.values(game.players).some(p => p.color === nextColor);
        if(hasPlayer) foundNext = true;
        attempts++;
    }
    const nextColor = TURN_ORDER[game.turnIndex];
    const nextPlayerId = Object.keys(game.players).find(id => game.players[id].color === nextColor);
    if(nextPlayerId && game.players[nextPlayerId]) game.players[nextPlayerId].rollCount = 0; 
    io.to(roomId).emit('turnUpdate', nextColor);
    checkBotTurn(roomId);
}

function checkBotTurn(roomId) {
    const game = games[roomId]; if(!game) return;
    const color = TURN_ORDER[game.turnIndex];
    const playerID = Object.keys(game.players).find(id => game.players[id].color === color);
    if(playerID) {
        const player = game.players[playerID];
        if (player && player.isBot) setTimeout(() => playBotRoll(roomId, player), DELAY_BETWEEN_TURNS);
    }
}

function checkWin(roomId, player) { 
    if (player.pieces.every(p => p >= 100)) { 
        io.to(roomId).emit('gameLog', `${player.name} GEWINNT!`); 
        io.to(roomId).emit('playSound', 'win');
        setTimeout(() => resetGame(roomId), 10000); 
    } 
}

function getColor(index) { return ['red', 'blue', 'green', 'yellow'][index]; }
function isOccupiedBySelf(player, pos) { return player.pieces.includes(pos); }
function isPathBlockedInTarget(player, startIdx, endIdx) { for (let i = startIdx + 1; i < endIdx; i++) { if (player.pieces.includes(100 + i)) return true; } return false; }
function canMoveAny(game, player) { 
    const forced = getForcedMoveIndex(game, player); 
    if (forced !== -1) return true; 
    for (let i = 0; i < 4; i++) { if (isMoveValid(game, player, i, player.lastRoll)) return true; } 
    return false; 
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
