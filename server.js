const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- KONFIGURATION ---
const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };
const DELAY_AFTER_ROLL = 2000; 
const DELAY_BETWEEN_TURNS = 1500; 

// GLOBALE LOBBY LISTE
const games = {}; 

io.on('connection', (socket) => {
    // Initialer Status
    emitStatus(socket);
    
    // --- JOIN ---
    socket.on('requestJoin', (playerName) => {
        try {
            if (getGameRunning(socket)) { socket.emit('joinError', 'Spiel läuft bereits!'); return; }
            
            const roomId = 'global'; // Einfache globale Lobby für dieses Setup
            socket.join(roomId);
            
            if (!games[roomId]) games[roomId] = createNewGame();
            const game = games[roomId];

            if (Object.keys(game.players).length >= 4) { socket.emit('joinError', 'Lobby ist voll!'); return; }
            if (game.players[socket.id]) return; 

            // Name bereinigen
            let safeName = (playerName || "").substring(0, 12).trim();
            if (safeName.length === 0) safeName = `Spieler ${Object.keys(game.players).length + 1}`;

            const color = getColor(Object.keys(game.players).length);
            game.players[socket.id] = { 
                id: socket.id, 
                color: color, 
                name: safeName,
                pieces: [-1, -1, -1, -1], 
                isBot: false, 
                lastRoll: null, 
                rollCount: 0 
            };
            socket.data.roomId = roomId;

            socket.emit('joinSuccess', { id: socket.id, players: game.players });
            io.to(roomId).emit('updateBoard', game.players);
            io.to(roomId).emit('turnUpdate', TURN_ORDER[game.turnIndex]);
            broadcastStatus(roomId); 
        } catch (e) {
            console.error("Error in requestJoin:", e);
        }
    });

    // --- START ---
    socket.on('startGame', () => {
        try {
            const roomId = socket.data.roomId;
            const game = games[roomId];
            if (!game || game.running) return;
            
            // Bots auffüllen bis 4 Spieler
            let botIndex = 1;
            while (Object.keys(game.players).length < 4) {
                const botCount = Object.keys(game.players).filter(id => id.startsWith('bot-')).length;
                const botId = `bot-${Date.now()}-${botCount}`;
                const color = getColor(Object.keys(game.players).length);
                game.players[botId] = { 
                    id: botId, color: color, name: `Bot ${botIndex}`, pieces: [-1, -1, -1, -1], isBot: true, lastRoll: null, rollCount: 0 
                };
                botIndex++;
            }
            
            game.running = true;
            io.to(roomId).emit('updateBoard', game.players);
            io.to(roomId).emit('gameStarted');
            broadcastStatus(roomId);
            checkBotTurn(roomId);
        } catch (e) {
            console.error("Error in startGame:", e);
        }
    });

    // --- WÜRFELN ---
    socket.on('rollDice', () => {
        try {
            const roomId = socket.data.roomId;
            const game = games[roomId];
            if (!game) return;

            const player = game.players[socket.id];
            if (!player || !game.running || player.color !== TURN_ORDER[game.turnIndex] || player.lastRoll) return;
            
            handleRoll(roomId, player);
        } catch (e) {
            console.error("Error in rollDice:", e);
        }
    });

    // --- ZIEHEN ---
    socket.on('movePiece', (data) => {
        try {
            const roomId = socket.data.roomId;
            const game = games[roomId];
            if (!game) return;

            const player = game.players[socket.id];
            if (!player || !game.running || player.color !== TURN_ORDER[game.turnIndex] || !player.lastRoll) return;
            
            const forcedIndex = getForcedMoveIndex(game, player);
            if (forcedIndex !== -1 && data.pieceIndex !== forcedIndex) {
                socket.emit('gameLog', "Zwangszug! Du musst den Startplatz räumen!");
                return; 
            }

            const rolledSix = (player.lastRoll === 6);
            if (tryMove(roomId, player, data.pieceIndex)) {
                io.to(roomId).emit('updateBoard', game.players);
                checkWin(roomId, player);
                finishTurn(roomId, player, rolledSix);
            }
        } catch (e) {
            console.error("Error in movePiece:", e);
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        try {
            const roomId = socket.data.roomId;
            if (roomId && games[roomId]) {
                const game = games[roomId];
                
                if (game.players[socket.id]) {
                    const player = game.players[socket.id];

                    if (!game.running) {
                        delete game.players[socket.id];
                        io.to(roomId).emit('updateBoard', game.players);
                        broadcastStatus(roomId);
                    } else {
                        // Spiel läuft -> Bot übernimmt
                        io.to(roomId).emit('gameLog', `${player.name} ist weg. Bot übernimmt.`);
                        
                        const botId = `bot-rep-${Date.now()}`;
                        game.players[botId] = {
                            ...player,
                            id: botId,
                            name: `${player.name} (Bot)`,
                            isBot: true,
                            lastRoll: null 
                        };
                        delete game.players[socket.id];
                        io.to(roomId).emit('updateBoard', game.players);
                        
                        // Wenn er dran war, Bot aktivieren
                        if (game.players[botId].color === TURN_ORDER[game.turnIndex]) {
                            setTimeout(() => playBotRoll(roomId, game.players[botId]), 1000);
                        }

                        // Check ob nur noch Bots da sind
                        const humanLeft = Object.values(game.players).some(p => !p.isBot);
                        if (!humanLeft) {
                            setTimeout(() => resetGame(roomId), 5000);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Error in disconnect:", e);
        }
    });
});

// --- HELPER & STATE ---

function createNewGame() {
    return { players: {}, turnIndex: 0, running: false };
}

function getGameRunning(socket) {
    // Wir prüfen 'global'
    return games['global'] && games['global'].running;
}

function resetGame(roomId) {
    if(games[roomId]) {
        games[roomId] = createNewGame();
        broadcastStatus(roomId);
        io.to(roomId).emit('updateBoard', {});
        io.to(roomId).emit('gameLog', "Spiel wurde zurückgesetzt.");
        // UI Reset
        io.to(roomId).emit('turnUpdate', 'red'); 
    }
}

function broadcastStatus(roomId) {
    if (!games[roomId]) return;
    const playerCount = Object.keys(games[roomId].players).length;
    const info = { running: games[roomId].running, count: playerCount, full: playerCount >= 4 };
    io.emit('serverStatus', info); 
}

function emitStatus(socket) {
    const game = games['global'];
    if (game) {
        const playerCount = Object.keys(game.players).length;
        socket.emit('serverStatus', { running: game.running, count: playerCount, full: playerCount >= 4 });
        socket.emit('updateBoard', game.players); 
    } else {
        socket.emit('serverStatus', { running: false, count: 0, full: false });
    }
}

// --- LOGIK ---

function handleRoll(roomId, player) {
    const game = games[roomId];
    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++; 
    
    const roll = player.lastRoll;
    let canRetry = false;
    let movePossible = false;

    // "Spielfeld leer" Regel (3 Versuche)
    // Alle Figuren im Haus (-1) oder im Ziel (>=100)
    const noPiecesOnField = player.pieces.every(p => p === -1 || p >= 100);

    if (noPiecesOnField) {
        if (roll === 6) { 
            // 6 -> Rauskommen
            canRetry = false; 
            movePossible = true; 
        } else {
            // Keine 6 -> Darf ich im Ziel ziehen?
            if (canMoveAny(game, player)) {
                canRetry = false; 
                movePossible = true;
            } else {
                // Weder rauskommen noch Zielzug möglich -> Retry
                if (player.rollCount < 3) {
                    canRetry = true;
                    player.lastRoll = null;
                } else {
                    canRetry = false;
                    movePossible = false;
                }
            }
        }
    } else {
        // Normales Spiel
        if (canMoveAny(game, player)) { canRetry = false; movePossible = true; }
        else { canRetry = false; movePossible = false; }
    }

    io.to(roomId).emit('diceRolled', { value: roll, player: player.color, canRetry: canRetry });

    if (canRetry) io.to(roomId).emit('gameLog', `${player.name}: Versuch ${player.rollCount}/3...`);
    else if (!movePossible) io.to(roomId).emit('gameLog', `${player.name} kann nicht ziehen.`);

    if (player.isBot) {
        if (canRetry) setTimeout(() => playBotRoll(roomId, player), DELAY_AFTER_ROLL);
        else if (movePossible) setTimeout(() => playBotMove(roomId, player), DELAY_AFTER_ROLL);
        else setTimeout(() => finishTurn(roomId, player, false), DELAY_AFTER_ROLL);
    } else {
        if (!canRetry && !movePossible) setTimeout(() => finishTurn(roomId, player, false), DELAY_AFTER_ROLL);
    }
}

function getForcedMoveIndex(game, player) {
    const hasInHouse = player.pieces.some(p => p === -1);
    if (!hasInHouse) return -1; 
    const startPos = START_OFFSETS[player.color];
    const indexOnStart = player.pieces.findIndex(p => p === startPos);
    if (indexOnStart === -1) return -1; 
    if (isMoveValid(game, player, indexOnStart, player.lastRoll)) return indexOnStart; 
    return -1; 
}

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
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) newPos = 100 + (roll - distanceToEntry - 1);
        else newPos = (currentPos + roll) % 40;
    }

    // Schlagen (Mit Immunitäts-Check)
    if (newPos < 100) {
        Object.values(game.players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach((pos, idx) => {
                    if (pos === newPos) {
                        other.pieces[idx] = -1;
                        io.to(roomId).emit('gameLog', `${player.name} kickt ${other.name}!`);
                    }
                });
            }
        });
    }

    player.pieces[pieceIndex] = newPos;
    return true;
}

function isMoveValid(game, player, pieceIndex, roll) {
    if (!player || !game) return false; // Safety Check

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

    // Immunität Check
    let isProtected = false;
    Object.values(game.players).forEach(other => {
        if (other.id !== player.id) {
            other.pieces.forEach(pos => {
                if (pos === newPos && pos === START_OFFSETS[other.color]) {
                    isProtected = true;
                }
            });
        }
    });
    if (isProtected) return false; 

    return true; 
}

// --- BOT & TURN MANAGEMENT ---

function playBotMove(roomId, bot) {
    const game = games[roomId];
    if(!game || !bot.lastRoll) return; 

    const forcedIdx = getForcedMoveIndex(game, bot);
    let moved = false;

    if (forcedIdx !== -1) {
        if (tryMove(roomId, bot, forcedIdx)) moved = true;
    } else {
        if (bot.lastRoll === 6) {
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1 && tryMove(roomId, bot, houseIdx)) moved = true;
        }
        if (!moved) {
            for (let i = 0; i < 4; i++) {
                if (tryMove(roomId, bot, i)) { moved = true; break; }
            }
        }
    }

    if (moved) {
        io.to(roomId).emit('updateBoard', game.players);
        checkWin(roomId, bot);
        finishTurn(roomId, bot, bot.lastRoll === 6);
    } else {
        finishTurn(roomId, bot, false); 
    }
}

function playBotRoll(roomId, bot) { handleRoll(roomId, bot); }

function finishTurn(roomId, player, wasSix) {
    const game = games[roomId];
    if(!game) return;

    if (wasSix === undefined) wasSix = (player.lastRoll === 6);
    if (wasSix) {
        io.to(roomId).emit('gameLog', `Nochmal (6)!`);
        player.lastRoll = null; player.rollCount = 0;   
        io.to(roomId).emit('turnUpdate', player.color);
        if(player.isBot) setTimeout(() => playBotRoll(roomId, player), DELAY_BETWEEN_TURNS);
    } else {
        player.lastRoll = null; nextTurn(roomId);
    }
}

function nextTurn(roomId) {
    const game = games[roomId];
    if(!game) return;

    // SICHERHEITSSCHLEIFE: Findet den nächsten validen Spieler
    let attempts = 0;
    let foundNext = false;
    
    while(attempts < 4 && !foundNext) {
        game.turnIndex = (game.turnIndex + 1) % 4;
        const nextColor = TURN_ORDER[game.turnIndex];
        
        // Prüfen ob jemand diese Farbe hat
        const hasPlayer = Object.values(game.players).some(p => p.color === nextColor);
        if(hasPlayer) {
            foundNext = true;
        }
        attempts++;
    }

    const nextColor = TURN_ORDER[game.turnIndex];
    // Reset rollCount
    const nextPlayerId = Object.keys(game.players).find(id => game.players[id].color === nextColor);
    if(nextPlayerId && game.players[nextPlayerId]) {
        game.players[nextPlayerId].rollCount = 0;
    }
    
    io.to(roomId).emit('turnUpdate', nextColor);
    checkBotTurn(roomId);
}

function checkBotTurn(roomId) {
    const game = games[roomId];
    if(!game) return;

    const currentColor = TURN_ORDER[game.turnIndex];
    const playerID = Object.keys(game.players).find(id => game.players[id].color === currentColor);
    
    // Wenn kein Spieler für die Farbe da ist (sollte dank nextTurn Loop nicht passieren), abbrechen
    if(!playerID) return;

    const player = game.players[playerID];
    if (player && player.isBot) setTimeout(() => playBotRoll(roomId, player), DELAY_BETWEEN_TURNS);
}

function getColor(index) { return ['red', 'blue', 'green', 'yellow'][index]; }
function isOccupiedBySelf(player, pos) { return player.pieces.includes(pos); }
function isPathBlockedInTarget(player, startIdx, endIdx) {
    for (let i = startIdx + 1; i < endIdx; i++) { if (player.pieces.includes(100 + i)) return true; }
    return false;
}
function canMoveAny(game, player) {
    const forced = getForcedMoveIndex(game, player);
    if (forced !== -1) return true; 
    for (let i = 0; i < 4; i++) { if (isMoveValid(game, player, i, player.lastRoll)) return true; }
    return false;
}
function checkWin(roomId, player) { 
    if (player.pieces.every(p => p >= 100)) {
        io.to(roomId).emit('gameLog', `${player.name} GEWINNT!!!`); 
        setTimeout(() => resetGame(roomId), 10000); 
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
