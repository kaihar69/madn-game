const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };
const DELAY_AFTER_ROLL = 2000; 
const DELAY_BETWEEN_TURNS = 1500; 

// --- STATE ---
const games = {}; 

// Funktion um sicherzustellen, dass das Spiel existiert
function ensureGlobalGame() {
    if (!games['global']) {
        console.log("Erstelle neues Global Game...");
        games['global'] = { players: {}, turnIndex: 0, running: false, winnerDeclared: false };
    }
    return games['global'];
}

ensureGlobalGame(); // Start-Init

io.on('connection', (socket) => {
    // Sofort in den Raum
    socket.join('global');
    
    // Status senden
    const game = ensureGlobalGame();
    socket.emit('updateBoard', game.players);
    emitStatus(socket);

    // --- DEBUG: Verbindung prüfen ---
    // console.log("Neuer User verbunden:", socket.id);

    // --- BEITRETEN ---
    socket.on('requestJoin', (playerName) => {
        try {
            const game = ensureGlobalGame();

            if (game.running) { socket.emit('joinError', 'Spiel läuft bereits!'); return; }
            if (Object.keys(game.players).length >= 4) { socket.emit('joinError', 'Lobby ist voll!'); return; }
            
            // Falls Spieler schon existiert (doppelklick schutz)
            if (game.players[socket.id]) return;

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

            // Erfolgsmeldung an Client
            socket.emit('joinSuccess', { id: socket.id, players: game.players });
            
            // Updates an alle
            io.to('global').emit('updateBoard', game.players);
            io.to('global').emit('turnUpdate', TURN_ORDER[game.turnIndex]);
            broadcastStatus(); 
            
        } catch (e) {
            console.error(e);
            socket.emit('gameLog', "Server Fehler beim Beitritt!");
        }
    });

    // --- STARTEN ---
    socket.on('startGame', () => {
        const game = ensureGlobalGame();
        if (game.running) return;
        
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
        io.to('global').emit('updateBoard', game.players);
        io.to('global').emit('gameStarted');
        broadcastStatus();
        
        setTimeout(() => checkBotTurn(), 1000);
    });

    // --- GAMEPLAY EVENTS ---
    socket.on('rollDice', () => {
        const game = ensureGlobalGame();
        const player = game.players[socket.id];
        if (!player) { socket.emit('sessionLost'); return; }
        if (!game.running || player.color !== TURN_ORDER[game.turnIndex] || player.lastRoll) return;
        handleRoll(player);
    });

    socket.on('movePiece', (data) => {
        const game = ensureGlobalGame();
        const player = game.players[socket.id];
        if (!player) { socket.emit('sessionLost'); return; }
        if (!game.running || player.color !== TURN_ORDER[game.turnIndex] || !player.lastRoll) return;
        
        const forcedIndex = getForcedMoveIndex(game, player);
        if (forcedIndex !== -1 && data.pieceIndex !== forcedIndex) {
            // Sonderfall: Rauskommen Zwang erlaubt jede Figur im Haus
            const isForcedInHouse = player.pieces[forcedIndex] === -1;
            const isSelectedInHouse = player.pieces[data.pieceIndex] === -1;
            if(!(isForcedInHouse && isSelectedInHouse)) {
                socket.emit('gameLog', "Zwangszug beachten!");
                return;
            }
        }

        const rolledSix = (player.lastRoll === 6);
        if (tryMove(player, data.pieceIndex)) {
            io.to('global').emit('updateBoard', game.players);
            checkWin(player);
            finishTurn(player, rolledSix);
        }
    });

    socket.on('disconnect', () => {
        const game = ensureGlobalGame();
        if (game.players[socket.id]) {
            const player = game.players[socket.id];
            
            if (!game.running) {
                delete game.players[socket.id];
                io.to('global').emit('updateBoard', game.players);
                broadcastStatus();
            } else {
                io.to('global').emit('gameLog', `${player.name} weg. Bot übernimmt.`);
                const botId = `bot-rep-${Date.now()}`;
                game.players[botId] = { ...player, id: botId, name: `${player.name} (Bot)`, isBot: true };
                delete game.players[socket.id];
                io.to('global').emit('updateBoard', game.players);
                
                if (game.players[botId].color === TURN_ORDER[game.turnIndex]) {
                    setTimeout(() => {
                        if(game.players[botId].lastRoll) playBotMove(game.players[botId]);
                        else playBotRoll(game.players[botId]);
                    }, 1000);
                }
                const humanLeft = Object.values(game.players).some(p => !p.isBot);
                if (!humanLeft) setTimeout(resetGame, 5000);
            }
        }
    });
});

// --- CORE LOGIK ---
function handleRoll(player) {
    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++; 
    const roll = player.lastRoll;
    let canRetry = false; 
    let movePossible = false;
    
    // Spielfeld leer Regel (3x Würfeln)
    const noPiecesOnField = player.pieces.every(p => p === -1 || p >= 100);
    const game = ensureGlobalGame();

    if (noPiecesOnField) {
        if (roll === 6) { canRetry = false; movePossible = true; } 
        else {
            if (canMoveAny(game, player)) { canRetry = false; movePossible = true; } // Zug im Ziel möglich?
            else {
                if (player.rollCount < 3) { canRetry = true; player.lastRoll = null; } 
                else { canRetry = false; movePossible = false; }
            }
        }
    } else {
        if (canMoveAny(game, player)) { canRetry = false; movePossible = true; } 
        else { canRetry = false; movePossible = false; }
    }

    io.to('global').emit('diceRolled', { value: roll, player: player.color, canRetry: canRetry });
    if (canRetry) io.to('global').emit('gameLog', `${player.name}: Versuch ${player.rollCount}/3...`);
    else if (!movePossible) io.to('global').emit('gameLog', `${player.name} kann nicht ziehen.`);

    if (player.isBot) {
        if (canRetry) setTimeout(() => playBotRoll(player), DELAY_AFTER_ROLL);
        else if (movePossible) setTimeout(() => playBotMove(player), DELAY_AFTER_ROLL);
        else setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    } else {
        if (!canRetry && !movePossible) setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    }
}

function tryMove(player, pieceIndex) {
    const game = ensureGlobalGame();
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

    if (newPos < 100) {
        Object.values(game.players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach((pos, idx) => {
                    if (pos === newPos) {
                        other.pieces[idx] = -1;
                        io.to('global').emit('gameLog', `${player.name} kickt ${other.name}!`);
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

    // Immunität
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

// ... Restliche Helper ...
function playBotMove(bot) {
    const game = ensureGlobalGame();
    if(!game || !bot.lastRoll) return; 
    const forcedIdx = getForcedMoveIndex(game, bot);
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
        io.to('global').emit('updateBoard', game.players);
        checkWin(bot);
        finishTurn(bot, bot.lastRoll === 6);
    } else { finishTurn(bot, false); }
}
function playBotRoll(bot) { handleRoll(bot); }
function finishTurn(player, wasSix) {
    const game = ensureGlobalGame();
    if (wasSix) {
        io.to('global').emit('gameLog', `Nochmal (6)!`);
        player.lastRoll = null; player.rollCount = 0;   
        io.to('global').emit('turnUpdate', player.color);
        if(player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
    } else { player.lastRoll = null; nextTurn(); }
}
function nextTurn() {
    const game = ensureGlobalGame();
    let attempts = 0; let foundNext = false;
    while(attempts < 4 && !foundNext) {
        game.turnIndex = (game.turnIndex + 1) % 4;
        const nextColor = TURN_ORDER[game.turnIndex];
        if (Object.values(game.players).some(p => p.color === nextColor)) foundNext = true;
        attempts++;
    }
    const nextColor = TURN_ORDER[game.turnIndex];
    const nextPlayerId = Object.keys(game.players).find(id => game.players[id].color === nextColor);
    if(nextPlayerId && game.players[nextPlayerId]) game.players[nextPlayerId].rollCount = 0;
    io.to('global').emit('turnUpdate', nextColor);
    checkBotTurn();
}
function checkBotTurn() {
    const game = ensureGlobalGame();
    const currentColor = TURN_ORDER[game.turnIndex];
    const playerID = Object.keys(game.players).find(id => game.players[id].color === currentColor);
    if(playerID) {
        const player = game.players[playerID];
        if (player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
    }
}
function broadcastStatus() {
    const game = ensureGlobalGame();
    const count = Object.keys(game.players).length;
    io.emit('serverStatus', { running: game.running, count: count, full: count >= 4 });
}
function emitStatus(socket) {
    const game = ensureGlobalGame();
    const count = Object.keys(game.players).length;
    socket.emit('serverStatus', { running: game.running, count: count, full: count >= 4 });
}
function resetGame() {
    games['global'] = createNewGame();
    broadcastStatus();
    io.to('global').emit('updateBoard', {});
    io.to('global').emit('gameLog', "Reset.");
    io.to('global').emit('turnUpdate', 'red');
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
        const game = ensureGlobalGame();
        if(!game.winnerDeclared) {
            game.winnerDeclared = true;
            io.to('global').emit('gameLog', `${player.name} GEWINNT!!!`); 
            setTimeout(resetGame, 10000); 
        }
    } 
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
