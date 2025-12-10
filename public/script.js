const socket = io();

// --- KONFIGURATION ---
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
const basePositions = {
    'red':   [{x:0, y:0}, {x:1, y:0}, {x:0, y:1}, {x:1, y:1}],
    'blue':  [{x:9, y:0}, {x:10, y:0}, {x:9, y:1}, {x:10, y:1}],
    'green': [{x:0, y:9}, {x:1, y:9}, {x:0, y:10}, {x:1, y:10}],
    'yellow':[{x:9, y:9}, {x:10, y:9}, {x:9, y:10}, {x:10, y:10}]
};
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
const diceResultDiv = document.getElementById('diceResult');
let myColor = null;

function initBoard() {
    boardElement.innerHTML = '';
    for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            const isPath = pathMap.some(p => p.x === x && p.y === y);
            if(isPath) cell.classList.add('path');
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

// --- BUTTONS ---
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

// --- WÜRFEL ANIMATION & LOGIK ---
socket.on('diceRolled', (data) => {
    // Button sofort sperren während der Animation
    rollBtn.disabled = true;
    rollBtn.innerText = "...";

    // Animation starten
    animateDice(data.value, () => {
        // Diese Funktion wird ausgeführt, wenn die Animation fertig ist (nach ca. 600ms)
        
        // UI Update mit dem echten Wert
        diceResultDiv.innerText = `${data.player.toUpperCase()} würfelt: ${data.value}`;

        // Jetzt Button Logik prüfen (Darf ich nochmal?)
        if (data.player === myColor && data.canRetry) {
            rollBtn.disabled = false;
            rollBtn.innerText = "Nochmal würfeln!";
        } else {
            // Wenn ich nicht nochmal darf, bleibt er disabled (ich muss ziehen)
            rollBtn.disabled = true; 
            rollBtn.innerText = `Gewürfelt: ${data.value}`;
        }
    });
});

function animateDice(finalValue, callback) {
    let counter = 0;
    const maxCounts = 10; // Wie oft die Zahl wechselt
    
    const interval = setInterval(() => {
        // Zeige zufällige Zahlen (1-6)
        const randomVal = Math.floor(Math.random() * 6) + 1;
        diceResultDiv.innerText = `Würfelt... ${randomVal}`;
        counter++;

        if (counter >= maxCounts) {
            clearInterval(interval);
            callback(); // Animation fertig -> Callback aufrufen
        }
    }, 50); // Alle 50ms neue Zahl
}

socket.on('turnUpdate', (activeColor) => {
    turnName.innerText = activeColor.toUpperCase();
    turnDisplay.className = ''; 
    turnDisplay.classList.add('active-turn');
    turnDisplay.style.borderColor = getHexColor(activeColor);

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
    setTimeout(() => { if(logDiv.innerText === msg) logDiv.innerText = ''; }, 4000);
});

function renderPieces(players) {
    document.querySelectorAll('.piece').forEach(e => e.remove());
    Object.values(players).forEach(player => {
        player.pieces.forEach((posIndex, pieceIndex) => {
            let x, y;
            if (posIndex === -1) {
                const baseCoords = basePositions[player.color][pieceIndex];
                x = baseCoords.x; y = baseCoords.y;
            } else if (posIndex >= 100) {
                const targetIndex = posIndex - 100;
                if(targetPositions[player.color][targetIndex]) {
                    const t = targetPositions[player.color][targetIndex];
                    x = t.x; y = t.y;
                }
            } else {
                if (pathMap[posIndex]) { x = pathMap[posIndex].x; y = pathMap[posIndex].y; }
            }
            if (x !== undefined && y !== undefined) {
                const cell = document.getElementById(`cell-${x}-${y}`);
                if (cell) {
                    const piece = document.createElement('div');
                    piece.classList.add('piece', player.color);
                    if (player.color === myColor) {
                        piece.onclick = () => { socket.emit('movePiece', { pieceIndex: pieceIndex }); };
                        piece.style.cursor = "pointer";
                    } else {
                        piece.style.cursor = "default";
                    }
                    cell.appendChild(piece);
                }
            }
        });
    });
}
function getHexColor(name) {
    if(name === 'red') return '#d32f2f';
    if(name === 'blue') return '#1976d2';
    if(name === 'green') return '#388e3c';
    if(name === 'yellow') return '#fbc02d';
    return '#333';
}
