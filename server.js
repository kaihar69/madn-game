const express = require('express');
const app = express();
const http = require('http').createServer(app);
// FIX: CORS erlauben, damit Handys nicht blockiert werden
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };
const DELAY_AFTER_ROLL = 2000; 
const DELAY_BETWEEN_TURNS = 1500; 

// --- EINZIGER GLOBALER SPIELZUSTAND ---
let globalGame = {
    players: {},
    turnIndex: 0,
    running: false,
    winnerDeclared: false
};

io.on('connection', (socket) => {
    // 1. Sofort verbinden bestätigen
    // console.log("Neuer Client:", socket.id); // Debug
    
    // Status senden
    socket.emit('updateBoard', globalGame.players);
    emitStatus(socket);
    
    if(globalGame.running) {
        socket.emit('turnUpdate', TURN_ORDER[globalGame.turnIndex]);
    }

    // --- JOIN ---
    socket.on('requestJoin', (playerName) => {
        try {
            if (globalGame.running) { socket.emit('joinError', 'Spiel läuft bereits!'); return; }
            if (Object.keys(globalGame.players).length >= 4) { socket.emit('joinError', 'Lobby voll!'); return; }
            
            // Verhindern dass man 2x klickt
            if (globalGame.players[socket.id]) return;

            let safeName = (playerName || "").substring(0, 12).trim();
            if (safeName.length === 0) safeName = `Spieler ${Object.keys(globalGame.players).length + 1}`;

            const color = getColor(Object.keys(globalGame.players).length);
            
            globalGame.players[socket.id] = { 
                id: socket.id, 
                color: color, 
                name: safeName,
                pieces: [-1, -1, -1, -1], 
                isBot: false, 
                lastRoll: null, 
                rollCount: 0 
            };

            // Erfolg senden
            socket.emit('joinSuccess', { id: socket.id, players: globalGame.players });
            io.emit('updateBoard', globalGame.players);
            io.emit('turnUpdate', TURN_ORDER[globalGame.turnIndex]);
            broadcastStatus(); 
            
        } catch (e) {
            console.error(e);
            socket.emit('gameLog', "Server-Fehler beim Beitritt.");
        }
    });

    // --- START ---
    socket.on('startGame', () => {
        if (globalGame.running) return;
        
        let botIndex = 1;
        while (Object.keys(globalGame.players).length < 4) {
            const botCount = Object.keys(globalGame.players).filter(id => id.startsWith('bot-')).length;
            const botId = `bot-${Date.now()}-${botCount}`;
            const color = getColor(Object.keys(globalGame.players).length);
            globalGame.players[botId] = { 
                id: botId, color: color, name: `Bot ${botIndex}`, pieces: [-1, -1, -1, -1], isBot: true, lastRoll: null, rollCount: 0 
            };
            botIndex++;
        }
        
        globalGame.running = true;
        io.emit('updateBoard', globalGame.players);
        io.emit('gameStarted');
        broadcastStatus();
        
        setTimeout(() => checkBotTurn(), 1000);
    });

    // --- ROLL ---
    socket.on('rollDice', () => {
        const player = globalGame.players[socket.id];
        if (!player) { socket.emit('sessionLost'); return; }
        if (!globalGame.running || player.color !== TURN_ORDER[globalGame.turnIndex] || player.lastRoll) return;
        handleRoll(player);
    });

    // --- MOVE ---
    socket.on('movePiece', (data) => {
        const player = globalGame.players[socket.id];
        if (!player) { socket.emit('sessionLost'); return; }
        if (!globalGame.running || player.color !== TURN_ORDER[globalGame.turnIndex] || !player.lastRoll) return;
        
        const forcedIndex = getForcedMoveIndex(globalGame, player);
        if (forcedIndex !== -1 && data.pieceIndex !== forcedIndex) {
            const isForcedInHouse = player.pieces[forcedIndex] === -1;
            const isSelectedInHouse = player.pieces[data.pieceIndex] === -1;
            
            // Wenn man raus muss, darf man jede Figur im Haus nehmen
            if (!(isForcedInHouse && isSelectedInHouse)) {
                socket.emit('gameLog', "Zwangszug beachten!");
                return;
            }
        }

        const rolledSix = (player.lastRoll === 6);
        if (tryMove(player, data.pieceIndex)) {
            io.emit('updateBoard', globalGame.players);
            checkWin(player);
            finishTurn(player, rolledSix);
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (globalGame.players[socket.id]) {
            const player = globalGame.players[socket.id];
            
            if (!globalGame.running) {
                delete globalGame.players[socket.id];
                io.emit('updateBoard', globalGame.players);
                broadcastStatus();
            } else {
                io.emit('gameLog', `${player.name} weg. Bot übernimmt.`);
                const botId = `bot-rep-${Date.now()}`;
                globalGame.players[botId] = { ...player, id: botId, name: `${player.name} (Bot)`, isBot: true };
                delete globalGame.players[socket.id];
                io.emit('updateBoard', globalGame.players);
                
                if (globalGame.players[botId].color === TURN_ORDER[globalGame.turnIndex]) {
                    setTimeout(() => {
                        if(globalGame.players[botId].lastRoll) playBotMove(globalGame.players[botId]);
                        else playBotRoll(globalGame.players[botId]);
                    }, 1000);
                }
                
                const humanLeft = Object.values(globalGame.players).some(p => !p.isBot);
                if (!humanLeft) setTimeout(resetGame, 5000);
            }
        }
    });
});

// --- HELPER ---
function resetGame() {
    globalGame = { players: {}, turnIndex: 0, running: false, winnerDeclared: false };
    broadcastStatus();
    io.emit('updateBoard', {});
    io.emit('gameLog', "Spiel zurückgesetzt.");
    io.emit('turnUpdate', 'red'); 
}

function broadcastStatus() {
    const playerCount = Object.keys(globalGame.players).length;
    io.emit('serverStatus', { running: globalGame.running, count: playerCount, full: playerCount >= 4 });
}

function emitStatus(socket) {
    const playerCount = Object.keys(globalGame.players).length;
    socket.emit('serverStatus', { running: globalGame.running, count: playerCount, full: playerCount >= 4 });
}

function handleRoll(player) {
    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++; 
    const roll = player.lastRoll;
    let canRetry = false; 
    let movePossible = false;
    
    const noPiecesOnField = player.pieces.every(p => p === -1 || p >= 100);

    if (noPiecesOnField) {
        if (roll === 6) { canRetry = false; movePossible = true; } 
        else {
            if (canMoveAny(globalGame, player)) { canRetry = false; movePossible = true; }
            else {
                if (player.rollCount < 3) { canRetry = true; player.lastRoll = null; } 
                else { canRetry = false; movePossible = false; }
            }
        }
    } else {
        if (canMoveAny(globalGame, player)) { canRetry = false; movePossible = true; } 
        else { canRetry = false; movePossible = false; }
    }

    io.emit('diceRolled', { value: roll, player: player.color, canRetry: canRetry });
    if (canRetry) io.emit('gameLog', `${player.name}: Versuch ${player.rollCount}/3...`);
    else if (!movePossible) io.emit('gameLog', `${player.name} kann nicht ziehen.`);

    if (player.isBot) {
        if (canRetry) setTimeout(() => playBotRoll(player), DELAY_AFTER_ROLL);
        else if (movePossible) setTimeout(() => playBotMove(player), DELAY_AFTER_ROLL);
        else setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    } else {
        if (!canRetry && !movePossible) setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    }
}

function getForcedMoveIndex(game, player) {
    const hasInHouse = player.pieces.some(p => p === -1);
    const startPos = START_OFFSETS[player.color];
    if (player.lastRoll === 6 && hasInHouse) {
        if (!isOccupiedBySelf(player, startPos)) return player.pieces.findIndex(p => p === -1);
    }
    if (hasInHouse) {
        const indexOnStart = player.pieces.findIndex(p => p === startPos);
        if (indexOnStart !== -1 && isMoveValid(game, player, indexOnStart, player.lastRoll)) return indexOnStart;
    }
    return -1; 
}

function tryMove(player, pieceIndex) {
    if (!isMoveValid(globalGame, player, pieceIndex, player.lastRoll)) return false;
    const currentPos = player.pieces[pieceIndex];
    const roll = player.lastRoll;
    let newPos;

    if (currentPos === -1) newPos = START_OFFSETS[player.color];
    else if (currentPos >= 100) newPos = 100 + (currentPos - 100 + roll);
    else {
        const entryPoint = ENTRY_POINTS[player.color];
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) newPos = 100 + (roll - distanceToEntry - 1);
        else newPos = (currentPos + roll) % 40;
    }

    if (newPos < 100) {
        Object.values(globalGame.players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach((pos, idx) => {
                    if (pos === newPos) {
                        other.pieces[idx] = -1;
                        io.emit('gameLog', `${player.name} kickt ${other.name}!`);
                    }
                });
            }
        });
    }
    player.pieces[pieceIndex] = newPos;
    return true;
}

function isMoveValid(game, player, pieceIndex, roll) {
    if (!player) return false;
    const currentPos = player.pieces[pieceIndex];
    const startPos = START_OFFSETS[player.color];
    if (currentPos === -1) return (roll === 6 && !isOccupiedBySelf(player, startPos));
    let newPos;
    if (currentPos >= 100) {
        const currentTargetIndex = currentPos - 100;
        const targetIndex = currentTargetIndex + roll;
        if (targetIndex > 3) return false;
        if (isPathBlockedInTarget(player, currentTargetIndex, targetIndex)) return false;
        if (isOccupiedBySelf(player, 100 + targetIndex)) return false;
        return true;
    } else {
        const entryPoint = ENTRY_POINTS[player.color];
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) {
            const stepsIntoTarget = roll - distanceToEntry - 1;
            if (stepsIntoTarget > 3 || stepsIntoTarget < 0) return false;
            if (isOccupiedBySelf(player, 100 + stepsIntoTarget)) return false;
            return true;
        } else {
            newPos = (currentPos + roll) % 40;
            if (isOccupiedBySelf(player, newPos)) return false;
        }
    }
    let isProtected = false;
    Object.values(game.players).forEach(other => {
        if (other.id !== player.id) {
            other.pieces.forEach(pos => {
                if (pos === newPos && pos === START_OFFSETS[other.color]) isProtected = true;
            });
        }
    });
    if (isProtected) return false; 
    return true; 
}

function playBotMove(bot) {
    if(!bot.lastRoll) return; 
    const forcedIdx = getForcedMoveIndex(globalGame, bot);
    let moved = false;
    if (forcedIdx !== -1) {
        if (tryMove(bot, forcedIdx)) moved = true;
    } else {
        if (bot.lastRoll === 6) {
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1 && tryMove(bot, houseIdx)) moved = true;
        }
        if (!moved) { for (let i = 0; i < 4; i++) { if (tryMove(bot, i)) { moved = true; break; } } }
    }
    if (moved) {
        io.emit('updateBoard', globalGame.players);
        checkWin(bot);
        finishTurn(bot, bot.lastRoll === 6);
    } else { finishTurn(bot, false); }
}

function playBotRoll(bot) { handleRoll(bot); }

function finishTurn(player, wasSix) {
    if (wasSix === undefined) wasSix = (player.lastRoll === 6);
    if (wasSix) {
        io.emit('gameLog', `Nochmal (6)!`);
        player.lastRoll = null; player.rollCount = 0;   
        io.emit('turnUpdate', player.color);
        if(player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
    } else { player.lastRoll = null; nextTurn(); }
}

function nextTurn() {
    let attempts = 0; let foundNext = false;
    while(attempts < 4 && !foundNext) {
        globalGame.turnIndex = (globalGame.turnIndex + 1) % 4;
        const nextColor = TURN_ORDER[globalGame.turnIndex];
        if (Object.values(globalGame.players).some(p => p.color === nextColor)) foundNext = true;
        attempts++;
    }
    const nextColor = TURN_ORDER[globalGame.turnIndex];
    const nextPlayerId = Object.keys(globalGame.players).find(id => globalGame.players[id].color === nextColor);
    if(nextPlayerId && globalGame.players[nextPlayerId]) globalGame.players[nextPlayerId].rollCount = 0;
    io.emit('turnUpdate', nextColor);
    checkBotTurn();
}

function checkBotTurn() {
    const currentColor = TURN_ORDER[globalGame.turnIndex];
    const playerID = Object.keys(globalGame.players).find(id => globalGame.players[id].color === currentColor);
    if(playerID) {
        const player = globalGame.players[playerID];
        if (player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
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
function checkWin(player) { 
    if (player.pieces.every(p => p >= 100)) { 
        if(!globalGame.winnerDeclared) {
            globalGame.winnerDeclared = true;
            io.emit('gameLog', `${player.name} GEWINNT!!!`); 
            setTimeout(resetGame, 10000); 
        }
    } 
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
