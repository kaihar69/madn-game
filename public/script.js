const socket = io();

// --- KOORDINATEN KONFIGURATION ---

// Weg (0-39) - Der Hauptpfad
const pathMap = [
    {x:0, y:4}, {x:1, y:4}, {x:2, y:4}, {x:3, y:4}, {x:4, y:4}, 
    {x:4, y:3}, {x:4, y:2}, {x:4, y:1}, {x:4, y:0},             
    {x:5, y:0}, {x:6, y:0},                                     
    {x:6, y:1}, {x:6, y:2}, {x:6, y:3}, {x:6, y:4},             
    {x:7, y:4}, {x:8, y:4}, {x:9, y:4}, {x:10, y:4},            
    {x:10, y:5}, {x:10, y:6},                                   
    {x:9, y:6}, {x:8, y:6}, {x:7, y:6}, {x:6, y:6},             
    {x:6, y:7}, {x:6, y:8}, {x:6, y:9}, {x:6, y:10},            
    {x:5, y:10}, {x:4, y:10},                                   
    {x:4, y:9}, {x:4, y:8}, {x:4, y:7}, {x:4, y:6},             
    {x:3, y:6}, {x:2, y:6}, {x:1, y:6}, {x:0, y:6},             
    {x:0, y:5}                                                  
];

// Start-Häuser (Base) - Wo die Figuren warten (-1)
const basePositions = {
    'red':   [{x:0, y:0}, {x:1, y:0}, {x:0, y:1}, {x:1, y:1}],
    'blue':  [{x:9, y:0}, {x:10, y:0}, {x:9, y:1}, {x:10, y:1}],
    'green': [{x:0, y:9}, {x:1, y:9}, {x:0, y:10}, {x:1, y:10}],
    'yellow':[{x:9, y:9}, {x:10, y:9}, {x:9, y:10}, {x:10, y:10}]
};

// Ziel-Felder (Mitte) - Wo man hin muss (100+)
const targetPositions = {
    'red':   [{x:1, y:5}, {x:2, y:5}, {x:3, y:5}, {x:4, y:5}],
    'blue':  [{x:5, y:1}, {x:5, y:2}, {x:5, y:3}, {x:5, y:4}],
    'green': [{x:9, y:5}, {x:8, y:5}, {x:7, y:5}, {x:6, y:5}],
    'yellow':[{x:5, y:9}, {x:5, y:8}, {x:5, y:7}, {x:5, y:6}]
};

// --- INITIALISIERUNG ---

const boardElement = document.getElementById('board');
const rollBtn = document.getElementById('rollBtn');
const turnDisplay = document.getElementById('turn-indicator');
const turnName = document.getElementById('current-player-name');
const startBtn = document.getElementById('startWithBotsBtn');
let myColor = null;

// Board einmalig aufbauen (nur das Gitter und die Farben)
function initBoard() {
    boardElement.innerHTML = '';
    for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            
            // Visualisierung des Pfades
            const isPath = pathMap.some(p => p.x === x && p.y === y);
            if(isPath) cell.classList.add('path');
            
            // Visualisierung der Ecken
            if (x < 4 && y < 4) cell.classList.add('base-red');
            if (x > 6 && y < 4) cell.classList.add('base-blue');
            if (x < 4 && y > 6) cell.classList.add('base-green');
            if (x > 6 && y > 6) cell.classList.add('base-yellow');

            cell.id = `cell-${x}-${y}`;
            boardElement.appendChild(cell);
        }
    }
}
initBoard();

// --- BUTTON EVENTS ---

rollBtn.addEventListener('click', () => {
    socket.emit('rollDice');
});

startBtn.addEventListener('click', () => {
    socket.emit('addBots');
});

// --- SOCKET EVENTS ---

socket.on('init', (data) => {
    myColor = data.players[data.id].color;
    const status = document.getElementById('my-status');
    status.innerText = `Du spielst: ${myColor.toUpperCase()}`;
    status.style.color = getHexColor(myColor);
});

socket.on('gameStarted', () => {
    document.getElementById('setup-controls').style.display = 'none';
});

socket.on('updateBoard', (players) => {
    renderPieces(players);
});

// Hier ist das Update für die 3 Versuche:
socket.on('diceRolled', (data) => {
    document.getElementById('diceResult').innerText = `${data.player.toUpperCase()} würfelt: ${data.value}`;
    
    // Wenn ich dran bin UND der Server sagt "canRetry" (weil ich 3 Versuche habe)
    if (data.player === myColor && data.canRetry) {
        rollBtn.disabled = false;
        rollBtn.innerText = "Nochmal würfeln!";
    } else {
        // Normalfall: Button aus, jetzt muss gezogen werden (oder Zug ist vorbei)
        rollBtn.disabled = true;
        rollBtn.innerText = `Gewürfelt: ${data.value}`;
    }
});

socket.on('turnUpdate', (activeColor) => {
    turnName.innerText = activeColor.toUpperCase();
    
    // Visuelles Feedback
    turnDisplay.className = ''; 
    turnDisplay.classList.add('active-turn');
    turnDisplay.style.borderColor = getHexColor(activeColor);

    // Button steuern: Bin ich dran?
    if (myColor === activeColor) {
        rollBtn.disabled = false;
        rollBtn.innerText = "Würfeln";
    } else {
        rollBtn.disabled = true;
        rollBtn.innerText = `${activeColor.toUpperCase()} ist dran...`;
    }
});

socket.on('gameLog', (msg) => {
    const logDiv = document.getElementById('log-container');
    logDiv.innerText = msg;
    // Löscht Nachricht nach 4 Sekunden
    setTimeout(() => { 
        // Nur löschen, wenn noch dieselbe Nachricht drin steht
        if(logDiv.innerText === msg) logDiv.innerText = ''; 
    }, 4000);
});

// --- FIGUREN RENDERN ---

function renderPieces(players) {
    // Alte Figuren entfernen
    document.querySelectorAll('.piece').forEach(e => e.remove());

    Object.values(players).forEach(player => {
        player.pieces.forEach((posIndex, pieceIndex) => {
            let x, y;

            if (posIndex === -1) {
                // BASE (Im Haus)
                const baseCoords = basePositions[player.color][pieceIndex];
                x = baseCoords.x;
                y = baseCoords.y;
            } else if (posIndex >= 100) {
                // ZIEL (Im Ziel-Einlauf)
                const targetIndex = posIndex - 100;
                if(targetPositions[player.color][targetIndex]) {
                    const t = targetPositions[player.color][targetIndex];
                    x = t.x; y = t.y;
                }
            } else {
                // FELD (Auf dem Weg)
                if (pathMap[posIndex]) {
                    x = pathMap[posIndex].x;
                    y = pathMap[posIndex].y;
                }
            }

            // Figur erstellen und ins DOM hängen
            if (x !== undefined && y !== undefined) {
                const cell = document.getElementById(`cell-${x}-${y}`);
                if (cell) {
                    const piece = document.createElement('div');
                    piece.classList.add('piece', player.color);
                    
                    // Klick-Logik: Nur wenn ich dran bin und es meine Figur ist
                    if (player.color === myColor) {
                        piece.onclick = () => {
                            socket.emit('movePiece', { pieceIndex: pieceIndex });
                        };
                        piece.style.cursor = "pointer";
                        // Optional: Highlighten, welche Figur bewegt werden kann?
                        // Das ist komplexer, lassen wir erstmal weg.
                    } else {
                        piece.style.cursor = "default";
                    }
                    cell.appendChild(piece);
                }
            }
        });
    });
}

// Hilfsfunktion für Farben
function getHexColor(name) {
    if(name === 'red') return '#d32f2f';
    if(name === 'blue') return '#1976d2';
    if(name === 'green') return '#388e3c';
    if(name === 'yellow') return '#fbc02d';
    return '#333';
}
