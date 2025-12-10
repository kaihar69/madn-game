const socket = io();

// --- KONFIGURATION (Bleibt gleich) ---
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
    'green': [{x:9, y:9}, {x:10, y:9}, {x:9, y:10}, {x:10, y:10}],
    'yellow':[{x:0, y:9}, {x:1, y:9}, {x:0, y:10}, {x:1, y:10}]
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
const turnName = document.getElementById('current-player-name');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const cubeElement = document.getElementById('diceCube');
let myColor = null;
let amIPlaying = false;

function initBoard() {
    boardElement.innerHTML = '';
    for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            
            const pathIndex = pathMap.findIndex(p => p.x === x && p.y === y);
            if(pathIndex !== -1) {
                cell.classList.add('path');
                if (pathIndex === 0) cell.classList.add('start-field-red');
                if (pathIndex === 10) cell.classList.add('start-field-blue');
                if (pathIndex === 20) cell.classList.add('start-field-green');
                if (pathIndex === 30) cell.classList.add('start-field-yellow');
            }
            
            Object.entries(basePositions).forEach(([color, positions]) => {
                if(positions.some(p => p.x === x && p.y === y)) cell.classList.add(`base-${color}`);
            });
            Object.entries(targetPositions).forEach(([color, positions]) => {
                if(positions.some(p => p.x === x && p.y === y)) cell.classList.add(`target-${color}`); 
            });

            cell.id = `cell-${x}-${y}`;
            boardElement.appendChild(cell);
        }
    }
}
initBoard();

// --- BUTTONS ---
rollBtn.addEventListener('click', () => { socket.emit('rollDice'); });

joinBtn.addEventListener('click', () => {
    socket.emit('requestJoin');
});

startBtn.addEventListener('click', () => {
    socket.emit('startGame');
});


// --- LOBBY LOGIK ---

// Status Updates vom Server (läuft das Spiel? wie viele sind drin?)
socket.on('serverStatus', (info) => {
    // Wenn ich schon mitspiele, brauche ich den Join Button nicht
    if (amIPlaying) {
        joinBtn.style.display = 'none';
        
        // Start Button nur zeigen, wenn Spiel noch NICHT läuft
        if (!info.running) {
            startBtn.style.display = 'inline-block';
            startBtn.innerText = `Start (${info.count}/4)`;
        } else {
            startBtn.style.display = 'none';
        }
        return;
    }

    // Ich bin Zuschauer -> Status prüfen
    startBtn.style.display = 'none';
    joinBtn.style.display = 'inline-block';

    if (info.running) {
        // Spiel läuft -> Button aus
        joinBtn.disabled = true;
        joinBtn.innerText = "Spiel läuft (Warten...)";
        joinBtn.style.backgroundColor = "#999";
        rollBtn.innerText = "Zuschauer";
    } else if (info.full) {
        // Spiel voll -> Button aus
        joinBtn.disabled = true;
        joinBtn.innerText = "Lobby Voll";
        joinBtn.style.backgroundColor = "#999";
    } else {
        // Platz frei -> Button an
        joinBtn.disabled = false;
        joinBtn.innerText = `MITSPIELEN (${info.count}/4)`;
        joinBtn.style.backgroundColor = "#2196F3"; // Blau
    }
});

socket.on('joinSuccess', (data) => {
    amIPlaying = true;
    myColor = data.players[data.id].color;
    
    // Status Text update
    const statusText = (myColor === 'red') ? 'Rot' : 
                       (myColor === 'blue') ? 'Blau' :
                       (myColor === 'green') ? 'Grün' : 'Gelb';
    document.getElementById('my-status').innerText = `Ich: ${statusText}`;
    document.getElementById('my-status').style.color = getHexColor(myColor);

    // Buttons tauschen
    joinBtn.style.display = 'none';
    startBtn.style.display = 'inline-block';
});

socket.on('joinError', (msg) => {
    alert(msg);
});

socket.on('gameStarted', () => {
    startBtn.style.display = 'none';
});

// --- GAMEPLAY (Standard) ---

socket.on('updateBoard', (players) => { renderPieces(players); });

socket.on('diceRolled', (data) => {
    rollBtn.disabled = true;
    rollBtn.innerText = "...";
    
    animateDice3D(data.value, data.player, () => {
        if (data.player === myColor && data.canRetry) {
            rollBtn.disabled = false;
            rollBtn.innerText = "Nochmal!";
        } else {
            rollBtn.disabled = true; 
            rollBtn.innerText = `${data.value}`;
        }
    });
});

function animateDice3D(finalValue, playerColor, callback) {
    cubeElement.className = 'cube';
    cubeElement.classList.add(playerColor);
    cubeElement.classList.add('rolling');
    setTimeout(() => {
        cubeElement.classList.remove('rolling');
        cubeElement.classList.add(`show-${finalValue}`);
        setTimeout(callback, 800); 
    }, 600); 
}

socket.on('turnUpdate', (activeColor) => {
    const deName = (activeColor === 'red') ? 'ROT' : 
                   (activeColor === 'blue') ? 'BLAU' :
                   (activeColor === 'green') ? 'GRÜN' : 'GELB';
    turnName.innerText = deName;
    turnName.style.color = getHexColor(activeColor);
    cubeElement.className = 'cube ' + activeColor;

    if (amIPlaying && myColor === activeColor) {
        rollBtn.disabled = false;
        rollBtn.innerText = "Würfeln";
    } else {
        rollBtn.disabled = true;
        rollBtn.innerText = `${deName}...`;
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
                    if (amIPlaying && player.color === myColor) {
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
