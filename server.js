const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };
const DELAY_AFTER_ROLL = 2500; 
const DELAY_BETWEEN_TURNS = 2000; 

let players = {};
let turnIndex = 0;
let gameRunning = false;

io.on('connection', (socket) => {
    console.log('Verbunden:', socket.id);

    if (Object.keys(players).length < 4 && !gameRunning) {
        const color = getColor(Object.keys(players).length);
        players[socket.id] = { id: socket.id, color: color, pieces: [-1, -1, -1, -1], isBot: false, lastRoll: null, rollCount: 0 };
        socket.emit('init', { id: socket.id, players: players });
        io.emit('updateBoard', players);
        socket.emit('turnUpdate', TURN_ORDER[turnIndex]);
    } else { socket.emit('full', 'Voll.'); }

    socket.on('addBots', () => {
        if (gameRunning) return;
        while (Object.keys(players).length < 4) {
            const botCount = Object.keys(players).filter(id => id.startsWith('bot-')).length;
            const botId = `bot-${Date.now()}-${botCount}`;
            const color = getColor(Object.keys(players).length);
            players[botId] = { id: botId, color: color, pieces: [-1, -1, -1, -1], isBot: true, lastRoll: null, rollCount: 0 };
        }
        gameRunning = true;
        io.emit('updateBoard', players);
        io.emit('gameStarted');
        checkBotTurn();
    });

    socket.on('rollDice', () => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || player.lastRoll) return;
        handleRoll(player);
    });

    socket.on('movePiece', (data) => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || !player.lastRoll) return;
        
        // Zwangszug Check
        const forcedIndex = getForcedMoveIndex(player);
        if (forcedIndex !== -1 && data.pieceIndex !== forcedIndex) {
            socket.emit('gameLog', "Zwangszug! Du musst den Startplatz räumen!");
            return; 
        }

        const rolledSix = (player.lastRoll === 6);
        if (tryMove(player, data.pieceIndex)) {
            io.emit('updateBoard', players);
            checkWin(player);
            finishTurn(player, rolledSix);
        }
    });

    socket.on('disconnect', () => {
        if(players[socket.id]) { delete players[socket.id]; io.emit('updateBoard', players); }
    });
});

// --- LOGIK ---

function handleRoll(player) {
    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++; 
    const allInHouse = player.pieces.every(p => p === -1);
    const roll = player.lastRoll;
    let canRetry = false;
    let movePossible = false;

    if (allInHouse) {
        if (roll === 6) { canRetry = false; movePossible = true; }
        else {
            if (player.rollCount < 3) { canRetry = true; player.lastRoll = null; }
            else { canRetry = false; movePossible = false; }
        }
    } else {
        if (canMoveAny(player)) { canRetry = false; movePossible = true; }
        else { canRetry = false; movePossible = false; }
    }

    io.emit('diceRolled', { value: roll, player: player.color, canRetry: canRetry });

    if (canRetry) io.emit('gameLog', `${player.color.toUpperCase()}: Versuch ${player.rollCount}/3...`);
    else if (!movePossible) io.emit('gameLog', `${player.color.toUpperCase()} kann nicht ziehen.`);

    if (player.isBot) {
        if (canRetry) setTimeout(() => playBotRoll(player), DELAY_AFTER_ROLL);
        else if (movePossible) setTimeout(() => playBotMove(player), DELAY_AFTER_ROLL);
        else setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    } else {
        if (!canRetry && !movePossible) setTimeout(() => finishTurn(player, false), DELAY_AFTER_ROLL);
    }
}

function getForcedMoveIndex(player) {
    const hasInHouse = player.pieces.some(p => p === -1);
    if (!hasInHouse) return -1; 
    const startPos = START_OFFSETS[player.color];
    const indexOnStart = player.pieces.findIndex(p => p === startPos);
    if (indexOnStart === -1) return -1; 
    if (isMoveValid(player, indexOnStart, player.lastRoll)) return indexOnStart; 
    return -1; 
}

function tryMove(player, pieceIndex) {
    if (!isMoveValid(player, pieceIndex, player.lastRoll)) return false;

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

    // Schlagen
    if (newPos < 100) {
        Object.values(players).forEach(other => {
            if (other.id !== player.id) {
                other.pieces.forEach((pos, idx) => {
                    if (pos === newPos) {
                        other.pieces[idx] = -1;
                        io.emit('gameLog', `${player.color.toUpperCase()} kickt ${other.color.toUpperCase()}!`);
                    }
                });
            }
        });
    }

    player.pieces[pieceIndex] = newPos;
    return true;
}

function isMoveValid(player, pieceIndex, roll) {
    const currentPos = player.pieces[pieceIndex];
    const startPos = START_OFFSETS[player.color];

    // Rauskommen
    if (currentPos === -1) return (roll === 6 && !isOccupiedBySelf(player, startPos));

    let newPos;
    // Ziel
    if (currentPos >= 100) {
        const currentTargetIndex = currentPos - 100;
        const targetIndex = currentTargetIndex + roll;
        if (targetIndex > 3) return false;
        if (isPathBlockedInTarget(player, currentTargetIndex, targetIndex)) return false;
        if (isOccupiedBySelf(player, 100 + targetIndex)) return false;
        return true;
    } 
    // Feld
    else {
        const entryPoint = ENTRY_POINTS[player.color];
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) {
            // Ins Ziel gehen
            const stepsIntoTarget = roll - distanceToEntry - 1;
            if (stepsIntoTarget > 3 || stepsIntoTarget < 0) return false;
            if (isOccupiedBySelf(player, 100 + stepsIntoTarget)) return false;
            return true;
        } else {
            // Normal weiter
            newPos = (currentPos + roll) % 40;
            
            // NEU: HIER WAR DER FEHLER
            // Darf nicht auf eigene Figur ziehen
            if (isOccupiedBySelf(player, newPos)) return false;
        }
    }

    // --- IMMUNITÄTS REGEL ---
    let isProtected = false;
    Object.values(players).forEach(other => {
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

function playBotMove(bot) {
    if (!bot.lastRoll) return; 
    const forcedIdx = getForcedMoveIndex(bot);
    let moved = false;

    if (forcedIdx !== -1) {
        if (tryMove(bot, forcedIdx)) moved = true;
    } else {
        if (bot.lastRoll === 6) {
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1 && tryMove(bot, houseIdx)) moved = true;
        }
        if (!moved) {
            for (let i = 0; i < 4; i++) {
                if (tryMove(bot, i)) { moved = true; break; }
            }
        }
    }

    if (moved) {
        io.emit('updateBoard', players);
        checkWin(bot);
        finishTurn(bot, bot.lastRoll === 6);
    } else {
        finishTurn(bot, false); 
    }
}

function playBotRoll(bot) { handleRoll(bot); }

function finishTurn(player, wasSix) {
    if (wasSix === undefined) wasSix = (player.lastRoll === 6);
    if (wasSix) {
        io.emit('gameLog', `Nochmal (6)!`);
        player.lastRoll = null; player.rollCount = 0;   
        io.emit('turnUpdate', player.color);
        if(player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
    } else {
        player.lastRoll = null; nextTurn();
    }
}

function nextTurn() {
    turnIndex = (turnIndex + 1) % 4;
    const nextColor = TURN_ORDER[turnIndex];
    const nextPlayerId = Object.keys(players).find(id => players[id].color === nextColor);
    if(nextPlayerId && players[nextPlayerId]) players[nextPlayerId].rollCount = 0;
    io.emit('turnUpdate', nextColor);
    checkBotTurn();
}

function checkBotTurn() {
    const currentColor = TURN_ORDER[turnIndex];
    const playerID = Object.keys(players).find(id => players[id].color === currentColor);
    const player = players[playerID];
    if (player && player.isBot) setTimeout(() => playBotRoll(player), DELAY_BETWEEN_TURNS);
}

function getColor(index) { return ['red', 'blue', 'green', 'yellow'][index]; }
function isOccupiedBySelf(player, pos) { return player.pieces.includes(pos); }
function isPathBlockedInTarget(player, startIdx, endIdx) {
    for (let i = startIdx + 1; i < endIdx; i++) { if (player.pieces.includes(100 + i)) return true; }
    return false;
}
function canMoveAny(player) {
    const forced = getForcedMoveIndex(player);
    if (forced !== -1) return true; 
    for (let i = 0; i < 4; i++) { if (isMoveValid(player, i, player.lastRoll)) return true; }
    return false;
}
function checkWin(player) { if (player.pieces.every(p => p >= 100)) io.emit('gameLog', `SIEG!!!`); }

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
