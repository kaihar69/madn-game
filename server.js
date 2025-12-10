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

    // 1. Spieler hinzufügen
    if (Object.keys(players).length < 4 && !gameRunning) {
        const color = getColor(Object.keys(players).length);
        players[socket.id] = {
            id: socket.id,
            color: color,
            pieces: [-1, -1, -1, -1],
            isBot: false,
            lastRoll: null
        };
        
        socket.emit('init', { id: socket.id, players: players });
        io.emit('updateBoard', players);
        socket.emit('turnUpdate', TURN_ORDER[turnIndex]);
    } else {
        socket.emit('full', 'Spiel läuft bereits oder ist voll.');
    }

    // 2. Bots hinzufügen
    socket.on('addBots', () => {
        if (gameRunning) return;
        while (Object.keys(players).length < 4) {
            const botCount = Object.keys(players).filter(id => id.startsWith('bot-')).length;
            const botId = `bot-${Date.now()}-${botCount}`;
            const color = getColor(Object.keys(players).length);
            players[botId] = { id: botId, color: color, pieces: [-1, -1, -1, -1], isBot: true, lastRoll: null };
        }
        gameRunning = true;
        io.emit('updateBoard', players);
        io.emit('gameStarted');
        checkBotTurn();
    });

    // 3. Würfeln
    socket.on('rollDice', () => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || player.lastRoll) return;

        player.lastRoll = Math.floor(Math.random() * 6) + 1;
        io.emit('diceRolled', { value: player.lastRoll, player: player.color });
    });

    // 4. Ziehen
    socket.on('movePiece', (data) => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || !player.lastRoll) return;

        // Versuche Zug auszuführen
        const success = tryMove(player, data.pieceIndex);
        
        if (success) {
            io.emit('updateBoard', players);
            checkWin(player);
            finishTurn(player);
        }
    });

    socket.on('disconnect', () => {
        if(players[socket.id]) {
            delete players[socket.id];
            // Einfacher Reset wenn ein echter Spieler geht (für MVP)
            io.emit('updateBoard', players);
        }
    });
});

// --- SPIEL LOGIK ---

function tryMove(player, pieceIndex) {
    const currentPos = player.pieces[pieceIndex];
    const roll = player.lastRoll;
    const startPos = START_OFFSETS[player.color];
    const entryPoint = ENTRY_POINTS[player.color];
    
    let newPos = currentPos;
    let moveValid = false;

    // Rauskommen
    if (currentPos === -1) {
        if (roll === 6 && !isOccupiedBySelf(player, startPos)) {
            newPos = startPos;
            moveValid = true;
        }
    } 
    // Im Ziel laufen
    else if (currentPos >= 100) {
        const currentTargetIndex = currentPos - 100;
        const targetIndex = currentTargetIndex + roll;
        if (targetIndex <= 3) {
            // Check Kollision im Ziel (eigene und besetzt)
            if (!isPathBlockedInTarget(player, currentTargetIndex, targetIndex) && 
                !isOccupiedBySelf(player, 100 + targetIndex)) {
                newPos = 100 + targetIndex;
                moveValid = true;
            }
        }
    }
    // Auf dem Feld laufen
    else {
        // Distanz zum Entry Point
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        
        if (distanceToEntry < roll) {
            // Ins Ziel gehen
            const stepsIntoTarget = roll - distanceToEntry - 1;
            if (stepsIntoTarget <= 3 && stepsIntoTarget >= 0) {
                const targetPosCode = 100 + stepsIntoTarget;
                if (!isOccupiedBySelf(player, targetPosCode)) {
                    newPos = targetPosCode;
                    moveValid = true;
                }
            }
        } else {
            // Normal weiter
            newPos = (currentPos + roll) % 40;
            moveValid = true;
        }
    }

    if (moveValid) {
        // Schlagen prüfen (nur auf Hauptfeld)
        if (newPos < 100) {
            Object.values(players).forEach(other => {
                if (other.id !== player.id) {
                    other.pieces.forEach((pos, idx) => {
                        if (pos === newPos) {
                            other.pieces[idx] = -1; // KICK!
                            io.emit('gameLog', `${player.color.toUpperCase()} kickt ${other.color.toUpperCase()}!`);
                        }
                    });
                }
            });
        }
        player.pieces[pieceIndex] = newPos;
        return true;
    }
    return false;
}

function finishTurn(player) {
    if (player.lastRoll === 6) {
        io.emit('gameLog', `${player.color.toUpperCase()} würfelt nochmal (6)!`);
        player.lastRoll = null;
        // Falls Bot, gleich weiter machen
        if(player.isBot) setTimeout(() => playBotRound(player), 1000);
    } else {
        player.lastRoll = null;
        nextTurn();
    }
}

function nextTurn() {
    turnIndex = (turnIndex + 1) % 4;
    const nextColor = TURN_ORDER[turnIndex];
    io.emit('turnUpdate', nextColor);
    checkBotTurn();
}

// --- BOT LOGIK ---

function checkBotTurn() {
    const currentColor = TURN_ORDER[turnIndex];
    const playerID = Object.keys(players).find(id => players[id].color === currentColor);
    const player = players[playerID];

    if (player && player.isBot) {
        setTimeout(() => playBotRound(player), 1000);
    }
}

function playBotRound(bot) {
    bot.lastRoll = Math.floor(Math.random() * 6) + 1;
    io.emit('diceRolled', { value: bot.lastRoll, player: bot.color });

    setTimeout(() => {
        // Versuche alle 4 Figuren, nimm die erste die geht (Simpel)
        // Besser: Prüfe ob Schlag möglich wäre, aber für MVP reicht "First Valid Move"
        let moved = false;
        
        // 1. Priorität: Rauskommen
        if (bot.lastRoll === 6) {
             // Suche Figur im Haus
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1) {
                 if (tryMove(bot, houseIdx)) {
                     moved = true; 
                 }
             }
        }

        // 2. Priorität: Irgendwas bewegen
        if (!moved) {
            for (let i = 0; i < 4; i++) {
                // Wir simulieren den Zug, tryMove führt ihn direkt aus wenn true
                if (tryMove(bot, i)) {
                    moved = true;
                    break;
                }
            }
        }

        if (moved) {
            io.emit('updateBoard', players);
            checkWin(bot);
            finishTurn(bot);
        } else {
            io.emit('gameLog', `${bot.color.toUpperCase()} kann nicht ziehen.`);
            finishTurn(bot);
        }

    }, 1000);
}

// --- HELPER ---

function getColor(index) {
    return ['red', 'blue', 'green', 'yellow'][index];
}

function isOccupiedBySelf(player, pos) {
    return player.pieces.includes(pos);
}

function isPathBlockedInTarget(player, startIdx, endIdx) {
    for (let i = startIdx + 1; i < endIdx; i++) {
        if (player.pieces.includes(100 + i)) return true;
    }
    return false;
}

function checkWin(player) {
    if (player.pieces.every(p => p >= 100)) {
        io.emit('gameLog', `SIEG!!! ${player.color.toUpperCase()} HAT GEWONNEN!`);
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
