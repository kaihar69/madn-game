const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- KONFIGURATION ---
const TURN_ORDER = ['red', 'blue', 'green', 'yellow'];
const START_OFFSETS = { 'red': 0, 'blue': 10, 'green': 20, 'yellow': 30 };
const ENTRY_POINTS = { 'red': 39, 'blue': 9, 'green': 19, 'yellow': 29 };

// --- SPIEL ZUSTAND ---
let players = {};
let turnIndex = 0;
let gameRunning = false;

io.on('connection', (socket) => {
    console.log('Verbunden:', socket.id);

    if (Object.keys(players).length < 4 && !gameRunning) {
        const color = getColor(Object.keys(players).length);
        players[socket.id] = {
            id: socket.id,
            color: color,
            pieces: [-1, -1, -1, -1],
            isBot: false,
            lastRoll: null,
            rollCount: 0
        };
        socket.emit('init', { id: socket.id, players: players });
        io.emit('updateBoard', players);
        socket.emit('turnUpdate', TURN_ORDER[turnIndex]);
    } else {
        socket.emit('full', 'Voll.');
    }

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
        
        // Wir speichern das Wurfergebnis kurz zwischen, bevor tryMove es evtl. löscht oder verändert
        const rolledSix = (player.lastRoll === 6);

        if (tryMove(player, data.pieceIndex)) {
            io.emit('updateBoard', players);
            checkWin(player);
            // Hier übergeben wir explizit, ob es eine 6 war
            finishTurn(player, rolledSix);
        }
    });

    socket.on('disconnect', () => {
        if(players[socket.id]) {
            delete players[socket.id];
            io.emit('updateBoard', players);
        }
    });
});

// --- CORE LOGIK ---

function handleRoll(player) {
    player.lastRoll = Math.floor(Math.random() * 6) + 1;
    player.rollCount++; 
    const allInHouse = player.pieces.every(p => p === -1);
    const roll = player.lastRoll;
    
    if (allInHouse) {
        if (roll === 6) {
            // Eine 6! Egal ob 1., 2. oder 3. Versuch -> Rauskommen!
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
        } else {
            // Keine 6
            if (player.rollCount < 3) {
                // Darf nochmal
                player.lastRoll = null; 
                io.emit('diceRolled', { value: roll, player: player.color, canRetry: true });
                io.emit('gameLog', `${player.color.toUpperCase()}: Versuch ${player.rollCount}/3 missglückt...`);
                if(player.isBot) setTimeout(() => playBotRound(player), 1500);
            } else {
                // 3x versemmelt -> Nächster
                io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
                io.emit('gameLog', `${player.color.toUpperCase()} passt (3x fail).`);
                setTimeout(() => nextTurn(), 2000);
            }
        }
    } else {
        if (canMoveAny(player)) {
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
        } else {
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
            io.emit('gameLog', `${player.color.toUpperCase()} kann nicht ziehen!`);
            setTimeout(() => nextTurn(), 2000);
        }
    }
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

// WICHTIG: Hier habe ich die Logik angepasst
function finishTurn(player, wasSix) {
    // Falls wasSix nicht übergeben wurde (Fallback), nutzen wir lastRoll
    if (wasSix === undefined) wasSix = (player.lastRoll === 6);

    if (wasSix) {
        io.emit('gameLog', `${player.color.toUpperCase()} darf nochmal (6)!`);
        
        player.lastRoll = null; // Wurf verbraucht, bereit für neuen
        player.rollCount = 0;   // Zähler resetten, da neuer Zug beginnt

        // DAS WAR DER FIX:
        // Wir müssen dem Frontend sagen: "Hey, Spieler X ist immer noch dran!"
        // Damit wird der Button wieder aktiviert.
        io.emit('turnUpdate', player.color);

        if(player.isBot) setTimeout(() => playBotRound(player), 1500);
    } else {
        player.lastRoll = null;
        nextTurn();
    }
}

function nextTurn() {
    turnIndex = (turnIndex + 1) % 4;
    const nextColor = TURN_ORDER[turnIndex];
    const nextPlayerId = Object.keys(players).find(id => players[id].color === nextColor);
    if(nextPlayerId && players[nextPlayerId]) {
        players[nextPlayerId].rollCount = 0;
    }
    io.emit('turnUpdate', nextColor);
    checkBotTurn();
}

function canMoveAny(player) {
    for (let i = 0; i < 4; i++) {
        if (isMoveValid(player, i, player.lastRoll)) return true;
    }
    return false;
}

function isMoveValid(player, pieceIndex, roll) {
    const currentPos = player.pieces[pieceIndex];
    const startPos = START_OFFSETS[player.color];
    const entryPoint = ENTRY_POINTS[player.color];

    if (currentPos === -1) {
        // Rauskommen braucht 6
        return (roll === 6 && !isOccupiedBySelf(player, startPos));
    } else if (currentPos >= 100) {
        const currentTargetIndex = currentPos - 100;
        const targetIndex = currentTargetIndex + roll;
        if (targetIndex > 3) return false;
        if (isPathBlockedInTarget(player, currentTargetIndex, targetIndex)) return false;
        if (isOccupiedBySelf(player, 100 + targetIndex)) return false;
        return true;
    } else {
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) {
            const stepsIntoTarget = roll - distanceToEntry - 1;
            if (stepsIntoTarget > 3 || stepsIntoTarget < 0) return false;
            if (isOccupiedBySelf(player, 100 + stepsIntoTarget)) return false;
            return true;
        }
        return true; 
    }
}

// --- BOT LOGIK ---
function checkBotTurn() {
    const currentColor = TURN_ORDER[turnIndex];
    const playerID = Object.keys(players).find(id => players[id].color === currentColor);
    const player = players[playerID];

    if (player && player.isBot) {
        setTimeout(() => playBotRound(player), 1500);
    }
}

function playBotRound(bot) {
    handleRoll(bot);
    
    setTimeout(() => {
        if (!bot.lastRoll) return; 

        let moved = false;
        
        if (bot.lastRoll === 6) {
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1 && tryMove(bot, houseIdx)) moved = true;
        }

        if (!moved) {
            for (let i = 0; i < 4; i++) {
                if (tryMove(bot, i)) {
                    moved = true;
                    break;
                }
            }
        }

        if (moved) {
            io.emit('updateBoard', players);
            checkWin(bot);
            // Move Funktion ruft finishTurn auf
        } else {
            // Wenn nichts geht -> Ende
            finishTurn(bot, false); 
        }

    }, 1500);
}

// --- HELPER ---
function getColor(index) { return ['red', 'blue', 'green', 'yellow'][index]; }
function isOccupiedBySelf(player, pos) { return player.pieces.includes(pos); }
function isPathBlockedInTarget(player, startIdx, endIdx) {
    for (let i = startIdx + 1; i < endIdx; i++) {
        if (player.pieces.includes(100 + i)) return true;
    }
    return false;
}
function checkWin(player) {
    if (player.pieces.every(p => p >= 100)) io.emit('gameLog', `SIEG!!! ${player.color.toUpperCase()} HAT GEWONNEN!`);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
