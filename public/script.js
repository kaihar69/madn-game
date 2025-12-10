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

// HIER WURDE GETAUSCHT: Grün nach unten rechts, Gelb nach unten links
const basePositions = {
    'red':   [{x:0, y:0}, {x:1, y:0}, {x:0, y:1}, {x:1, y:1}],     // Oben Links
    'blue':  [{x:9, y:0}, {x:10, y:0}, {x:9, y:1}, {x:10, y:1}],   // Oben Rechts
    'green': [{x:9, y:9}, {x:10, y:9}, {x:9, y:10}, {x:10, y:10}], // Unten Rechts (War vorher links)
    'yellow':[{x:0, y:9}, {x:1, y:9}, {x:0, y:10}, {x:1, y:10}]    // Unten Links (War vorher rechts)
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
            
            let isSomething = false;

            // Pfad + Startfelder
            const pathIndex = pathMap.findIndex(p => p.x === x && p.y === y);
            if(pathIndex !== -1) {
                cell.classList.add('path');
                if (pathIndex === 0) cell.classList.add('start-field-red');
                if (pathIndex === 10) cell.classList.add('start-field-blue');
                if (pathIndex === 20) cell.classList.add('start-field-green');
                if (pathIndex === 30) cell.classList.add('start-field-yellow');
                isSomething = true;
            }
            
            // Basen (Ebenfalls getauscht für die korrekte Färbung)
            if (x < 4 && y < 4) { cell.classList.add('base-red'); isSomething = true; }
            if (x > 6 && y < 4) { cell.classList.add('base-blue'); isSomething = true; }
            
            // HIER KORRIGIERT:
            if (x > 6 && y > 6) { cell.classList.add('base-green'); isSomething = true; } // Unten Rechts = Grün
            if (x < 4 && y > 6) { cell.classList.add('base-yellow'); isSomething = true; } // Unten Links = Gelb

            // Ziele
            Object.values(targetPositions).forEach(arr => {
                if(arr.some(p => p.x === x && p.y === y)) {
                    cell.classList.add('path'); 
                    cell.style.borderColor = "#666"; 
                    isSomething = true;
                }
            });

            cell.id = `cell-${x}-${y}`;
            boardElement.appendChild(cell);
        }
    }
}
initBoard();

// --- BUTTONS & SOCKET ---
rollBtn.addEventListener('click', () => { socket.emit('rollDice'); });
startBtn.addEventListener('click', () => { socket.emit('addBots'); });

socket.on('init', (data) => {
    myColor = data.players[data.id].color;
    document.getElementById('my-status').innerText = `Du spielst: ${myColor.toUpperCase()}`;
    document.getElementById('my-status').style.color = getHexColor(myColor);
});
socket.on('gameStarted', () => { document.getElementById('setup-controls').style.display = 'none'; });
socket.on('updateBoard', (players) => { renderPieces(players); });

socket.on('diceRolled', (data) => {
    rollBtn.disabled = true;
    rollBtn.innerText = "...";
    animateDice(data.value, () => {
        diceResultDiv.innerText = `${data.player.toUpperCase()} würfelt: ${data.value}`;
        if (data.player === myColor && data.canRetry) {
            rollBtn.disabled = false;
            rollBtn.innerText = "Nochmal würfeln!";
        } else {
            rollBtn.disabled = true; 
            rollBtn.innerText = `Gewürfelt: ${data.value}`;
        }
    });
});

function animateDice(finalValue, callback) {
    let counter = 0;
    const interval = setInterval(() => {
        diceResultDiv.innerText = `Würfelt... ${Math.floor(Math.random() * 6) + 1}`;
        counter++;
        if (counter >= 8) {
            clearInterval(interval);
            callback();
        }
    }, 100); 
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
    setTimeout(() => { if(logDiv.innerText === msg) logDiv.innerText = ''; }, 3000);
});

function renderPieces(players) {
    document.querySelectorAll('.piece').forEach(e => e.remove());
    Object.values(players).forEach(player => {
        player.pieces.forEach((posIndex, pieceIndex) => {
            let x, y;
            if (posIndex === -1) {
                x = basePositions[player.color][pieceIndex].x; y = basePositions[player.color][pieceIndex].y;
            } else if (posIndex >= 100) {
                const idx = posIndex - 100;
                if(targetPositions[player.color][idx]) { x = targetPositions[player.color][idx].x; y = targetPositions[player.color][idx].y; }
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
