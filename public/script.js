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
const nameInput = document.getElementById('playerNameInput');
const cubeElement = document.getElementById('diceCube');
let myColor = null;
let amIPlaying = false;
let currentPlayers = {}; 

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
    const name = nameInput.value;
    socket.emit('requestJoin', name);
});
startBtn.addEventListener('click', () => { socket.emit('startGame'); });

// --- RECONNECT LOGIK ---
// UI verstecken bis Status klar ist
joinBtn.style.display = 'none';
nameInput.style.display = 'none';
startBtn.style.display = 'none';

socket.on('connect', () => {
    const storedToken = localStorage.getItem('madn_token');
    if (storedToken) {
        console.log("Versuche Rejoin...");
        socket.emit('requestRejoin', storedToken);
    } else {
        showLobbyUI();
    }
});

socket.on('rejoinError', () => {
    console.log("Rejoin nicht möglich.");
    localStorage.removeItem('madn_token');
    amIPlaying = false;
    showLobbyUI();
});

function showLobbyUI() {
    if(!amIPlaying) {
        joinBtn.style.display = 'inline-block';
        nameInput.style.display = 'inline-block';
    }
}

// --- LOBBY LOGIK ---

socket.on('serverStatus', (info) => {
    if (amIPlaying) {
        joinBtn.style.display = 'none';
        nameInput.style.display = 'none'; 
        if (!info.running) {
            startBtn.style.display = 'inline-block';
            startBtn.innerText = `Start (${info.count}/4)`;
        } else {
            startBtn.style.display = 'none';
        }
        return;
    }

    if (joinBtn.style.display !== 'none') {
        if (info.running) {
            joinBtn.disabled = true; joinBtn.innerText = "Spiel läuft..."; joinBtn.style.backgroundColor = "#999";
            nameInput.disabled = true;
            rollBtn.innerText = "Zuschauer";
        } else if (info.full) {
            joinBtn.disabled = true; joinBtn.innerText = "Lobby Voll"; joinBtn.style.backgroundColor = "#999";
            nameInput.disabled = true;
        } else {
            joinBtn.disabled = false; joinBtn.innerText = `MITSPIELEN (${info.count}/4)`; joinBtn.style.backgroundColor = "#2196F3";
            nameInput.disabled = false;
        }
    }
});

socket.on('joinSuccess', (data) => {
    amIPlaying = true;
    currentPlayers = data.players;
    myColor = data.players[data.id].color;
    
    if (data.token) localStorage.setItem('madn_token', data.token);

    document.getElementById('my-status').innerText = `${data.players[data.id].name}`;
    document.getElementById('my-status').style.color = getHexColor(myColor);
    
    joinBtn.style.display = 'none';
    nameInput.style.display = 'none';
    startBtn.style.display = 'inline-block';
    
    if (data.rejoining) startBtn.style.display = 'none'; 
});

socket.on('joinError', (msg) => { alert(msg); });
socket.on('gameStarted', () => { startBtn.style.display = 'none'; });

// --- GAMEPLAY & ANIMATION ---

socket.on('updateBoard', (players) => { 
    currentPlayers = players;
    renderPieces(players); 
});

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
    let playerName = "Unbekannt";
    Object.values(currentPlayers).forEach(p => {
        if (p.color === activeColor) playerName = p.name;
    });

    turnName.innerText = `${playerName} (${getDeColor(activeColor)})`;
    turnName.style.color = getHexColor(activeColor);
    cubeElement.className = 'cube ' + activeColor;

    if (amIPlaying && myColor === activeColor) {
        rollBtn.disabled = false;
        rollBtn.innerText = "Würfeln";
    } else {
        rollBtn.disabled = true;
        rollBtn.innerText = `${playerName}...`;
    }
});

socket.on('gameLog', (msg) => {
    const logDiv = document.getElementById('log-container');
    logDiv.innerText = msg;
    setTimeout(() => { if(logDiv.innerText === msg) logDiv.innerText = ''; }, 3000);
});

// NEUE RENDER LOGIK: Absolute Positionierung & Wiederverwendung von Elementen
function renderPieces(players) {
    const activePieceIds = new Set();

    Object.values(players).forEach(player => {
        player.pieces.forEach((posIndex, pieceIndex) => {
            const pieceId = `piece-${player.color}-${pieceIndex}`;
            activePieceIds.add(pieceId);

            const coords = getCoordinates(posIndex, player.color, pieceIndex);
            
            let pieceEl = document.getElementById(pieceId);
            if (!pieceEl) {
                pieceEl = document.createElement('div');
                pieceEl.id = pieceId;
                pieceEl.classList.add('piece', player.color);
                
                pieceEl.onclick = () => { 
                    if (amIPlaying && player.color === myColor) {
                        socket.emit('movePiece', { pieceIndex: pieceIndex }); 
                    }
                };
                boardElement.appendChild(pieceEl);
            }

            if (amIPlaying && player.color === myColor) {
                pieceEl.style.cursor = "pointer";
                pieceEl.style.zIndex = 101; 
            } else {
                pieceEl.style.cursor = "default";
                pieceEl.style.zIndex = 100;
            }

            // Umrechnung Grid (40px + 2px Gap) zu Pixeln
            // Padding Board = 8px. Zelle = 40px. Gap = 2px.
            // Formel: 8px (Rand) + (Koordinate * 42px)
            const cellSize = 42; 
            const boardPadding = 8;
            
            const pixelX = boardPadding + (coords.x * cellSize);
            const pixelY = boardPadding + (coords.y * cellSize);

            pieceEl.style.left = `${pixelX}px`;
            pieceEl.style.top = `${pixelY}px`;
        });
    });

    // Alte Figuren entfernen
    const allDomPieces = document.querySelectorAll('.piece');
    allDomPieces.forEach(el => {
        if (!activePieceIds.has(el.id)) el.remove();
    });
}

function getCoordinates(posIndex, color, pieceIndex) {
    if (posIndex === -1) return basePositions[color][pieceIndex];
    if (posIndex >= 100) {
        const targetIdx = posIndex - 100;
        if (targetPositions[color][targetIdx]) return targetPositions[color][targetIdx];
        return basePositions[color][pieceIndex]; 
    }
    if (pathMap[posIndex]) return pathMap[posIndex];
    return {x: 0, y: 0}; 
}

function getHexColor(name) {
    if(name === 'red') return '#d32f2f';
    if(name === 'blue') return '#1976d2';
    if(name === 'green') return '#388e3c';
    if(name === 'yellow') return '#fbc02d';
    return '#333';
}
function getDeColor(c) {
    if (c==='red') return 'ROT';
    if (c==='blue') return 'BLAU';
    if (c==='green') return 'GRÜN';
    return 'GELB';
}
