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
            lastRoll: null,
            rollCount: 0 // Neuer Zähler für Versuche
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
            players[botId] = { 
                id: botId, 
                color: color, 
                pieces: [-1, -1, -1, -1], 
                isBot: true, 
                lastRoll: null,
                rollCount: 0 
            };
        }
        gameRunning = true;
        io.emit('updateBoard', players);
        io.emit('gameStarted');
        checkBotTurn();
    });

    // 3. WÜRFELN (Die neue Logik!)
    socket.on('rollDice', () => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || player.lastRoll) return;

        handleRoll(player);
    });

    // 4. Ziehen
    socket.on('movePiece', (data) => {
        const player = players[socket.id];
        if (!player || player.color !== TURN_ORDER[turnIndex] || !player.lastRoll) return;

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
    
    // Szenario A: Alle im Haus
    if (allInHouse) {
        if (roll === 6) {
            // Endlich eine 6! -> Muss ziehen
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
        } else {
            // Keine 6
            if (player.rollCount < 3) {
                // Darf nochmal würfeln
                player.lastRoll = null; // Reset damit er wieder drücken darf
                io.emit('diceRolled', { value: roll, player: player.color, canRetry: true });
                io.emit('gameLog', `${player.color.toUpperCase()}: Versuch ${player.rollCount}/3 missglückt...`);
                
                // Falls Bot -> sofort nochmal
                if(player.isBot) setTimeout(() => playBotRound(player), 1000);
            } else {
                // 3x versemmelt -> Nächster
                io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
                io.emit('gameLog', `${player.color.toUpperCase()} hat 3x keine 6 gewürfelt.`);
                setTimeout(() => nextTurn(), 1500);
            }
        }
    } 
    // Szenario B: Figuren draußen
    else {
        // Prüfen: Kann er überhaupt ziehen?
        if (canMoveAny(player)) {
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
        } else {
            // Sackgasse! Keine Figur kann ziehen.
            io.emit('diceRolled', { value: roll, player: player.color, canRetry: false });
            io.emit('gameLog', `${player.color.toUpperCase()} kann nicht ziehen!`);
            setTimeout(() => nextTurn(), 1500);
        }
    }
}

// Prüft ob IRGENDEIN Zug möglich ist
function canMoveAny(player) {
    for (let i = 0; i < 4; i++) {
        if (isMoveValid(player, i, player.lastRoll)) return true;
    }
    return false;
}

// Simuliert, ob ein Zug gültig wäre (ohne ihn auszuführen)
function isMoveValid(player, pieceIndex, roll) {
    // Kopie der Logik von tryMove, nur als Check
    const currentPos = player.pieces[pieceIndex];
    const startPos = START_OFFSETS[player.color];
    const entryPoint = ENTRY_POINTS[player.color];

    if (currentPos === -1) {
        return (roll === 6 && !isOccupiedBySelf(player, startPos));
    } 
    else if (currentPos >= 100) {
        const currentTargetIndex = currentPos - 100;
        const targetIndex = currentTargetIndex + roll;
        if (targetIndex > 3) return false;
        if (isPathBlockedInTarget(player, currentTargetIndex, targetIndex)) return false;
        if (isOccupiedBySelf(player, 100 + targetIndex)) return false;
        return true;
    } 
    else {
        const distanceToEntry = (entryPoint - currentPos + 40) % 40;
        if (distanceToEntry < roll) {
            const stepsIntoTarget = roll - distanceToEntry - 1;
            if (stepsIntoTarget > 3 || stepsIntoTarget < 0) return false; // Zu weit oder passthrough fehler
            if (isOccupiedBySelf(player, 100 + stepsIntoTarget)) return false;
            return true;
        } else {
            // Normal
            return true; // Kollisionen mit Gegnern sind immer erlaubt (Schlagen)
        }
    }
}

function tryMove(player, pieceIndex) {
    // Hier rufen wir jetzt isMoveValid auf, um Code zu sparen, 
    // aber wir müssen die Berechnung für newPos wiederholen.
    if (!isMoveValid(player, pieceIndex, player.lastRoll)) return false;

    // Berechnung (Redundant aber sicher)
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

function finishTurn(player) {
    if (player.lastRoll === 6) {
        io.emit('gameLog', `${player.color.toUpperCase()} darf nochmal (6)!`);
        player.lastRoll = null;
        player.rollCount = 0; // Reset für den neuen Wurf
        if(player.isBot) setTimeout(() => playBotRound(player), 1000);
    } else {
        player.lastRoll = null;
        nextTurn();
    }
}

function nextTurn() {
    turnIndex = (turnIndex + 1) % 4;
    const nextColor = TURN_ORDER[turnIndex];
    
    // Reset Roll Count für den neuen Spieler
    const nextPlayerId = Object.keys(players).find(id => players[id].color === nextColor);
    if(nextPlayerId && players[nextPlayerId]) {
        players[nextPlayerId].rollCount = 0;
    }

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
    // Bot nutzt jetzt die zentrale handleRoll Logik
    handleRoll(bot);
    
    // Wenn er nochmal würfeln muss (z.B. Versuch 1 missglückt),
    // passiert das automatisch durch handleRoll -> setTimeout -> playBotRound
    
    // Wenn er ziehen muss (handleRoll hat diceRolled gesendet ohne Retry):
    setTimeout(() => {
        if (!bot.lastRoll) return; // Er darf noch würfeln, also nicht ziehen

        let moved = false;
        
        // 1. Prio: Rauskommen
        if (bot.lastRoll === 6) {
             const houseIdx = bot.pieces.findIndex(p => p === -1);
             if (houseIdx !== -1 && tryMove(bot, houseIdx)) moved = true;
        }

        // 2. Prio: Schlagen oder Laufen
        if (!moved) {
            for (let i = 0; i < 4; i++) {
                // Prüfen ob Move valide, dann ausführen
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
            // Sollte eigentlich durch handleRoll (canMoveAny) abgefangen sein,
            // aber sicher ist sicher:
            // io.emit('gameLog', 'Bot passt.');
            // nextTurn(); 
        }

    }, 1000);
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
    if (player.pieces.every(p => p >= 100)) {
        io.emit('gameLog', `SIEG!!! ${player.color.toUpperCase()} HAT GEWONNEN!`);
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server auf Port ${PORT}`));
