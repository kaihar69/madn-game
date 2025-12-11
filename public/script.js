const socket = io();

// --- SOUNDS ---
const sounds = {
    roll: new Audio('/sounds/roll.mp3'),
    move: new Audio('/sounds/move.mp3'),
    kick: new Audio('/sounds/kick.mp3'),
    win:  new Audio('/sounds/win.mp3')
};
Object.values(sounds).forEach(s => s.volume = 0.5);

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
const cubeElement = document.getElementById('diceCube');

// LANDING ELEMENTS
const landingView = document.getElementById('landing-view');
const gameView = document.getElementById('game-view');
const landingName = document.getElementById('landingNameInput');
const createGameBtn = document.getElementById('createGameBtn');
const joinGameBtn = document.getElementById('joinGameBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const landingMsg = document.getElementById('landing-msg');
const currentRoomCodeDisplay = document.getElementById('current-room-code');
const startBtn = document.getElementById('startBtn');
const leaveBtn = document.getElementById('leaveBtn');

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

            boardElement.appendChild(cell);
        }
    }
}
initBoard();

// --- SOUND HANDLER ---
socket.on('playSound', (type) => {
    if (sounds[type]) {
        sounds[type].currentTime = 0;
        sounds[type].play().catch(e => {});
    }
});

// --- LOBBY ACTIONS ---
createGameBtn.addEventListener('click', () => {
    const name = landingName.value;
    if(!name) { landingMsg.innerText = "Bitte Namen eingeben!"; return; }
    socket.emit('createGame', name);
});

joinGameBtn.addEventListener('click', () => {
    const name = landingName.value;
    const code = roomCodeInput.value;
    if(!name) { landingMsg.innerText = "Bitte Namen eingeben!"; return; }
    if(!code || code.length < 4) { landingMsg.innerText = "Code ungültig!"; return; }
    socket.emit('requestJoin', { name: name, roomId: code });
});

leaveBtn.addEventListener('click', () => {
    localStorage.removeItem('madn_token');
    location.reload(); 
});

rollBtn.addEventListener('click', () => { socket.emit('rollDice'); });
startBtn.addEventListener('click', () => { socket.emit('startGame'); });

// --- RECONNECT LOGIK ---
socket.on('connect', () => {
    const storedToken = localStorage.getItem('madn_token');
    if (storedToken) {
        socket.emit('requestRejoin', storedToken);
    }
});
socket.on('rejoinError', () => {
    localStorage.removeItem('madn_token');
});

// --- SERVER EVENTS ---
socket.on('joinSuccess', (data) => {
    amIPlaying = true;
    currentPlayers = data.players;
    myColor = data.players[data.id].color;
    
    if (data.token) localStorage.setItem('madn_token', data.token);

    landingView.style.display = 'none';
    gameView.style.display = 'block';
    
    currentRoomCodeDisplay.innerText = data.roomId;
    
    document.getElementById('my-status').innerText = `${data.players[data.id].name}`;
    document.getElementById('my-status').style.color = getHexColor(myColor);
    
    if(data.rejoining) startBtn.style.display = 'none';
});

socket.on('joinError', (msg) => { landingMsg.innerText = msg; });

socket.on('roomStatus', (info) => {
    if (!info.running) {
        startBtn.style.display = 'inline-block';
        startBtn.innerText = `Start (${info.count}/4)`;
    } else {
        startBtn.style.display = 'none';
    }
});

socket.on('gameStarted', () => { startBtn.style.display = 'none'; });

// --- GAMEPLAY ---
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

// --- RENDER PIECES (KORRIGIERT FÜR 6.2% GRÖSSE) ---
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
                pieceEl.style.cursor = "pointer"; pieceEl.style.zIndex = 101; 
            } else {
                pieceEl.style.cursor = "default"; pieceEl.style.zIndex = 100;
            }

            // POSITIONIERUNG:
            // Spaltenbreite: 100 / 11 = 9.09%
            // Figurbreite (CSS): 6.2%
            // Offset: (9.09 - 6.2) / 2 = 1.445%
            
            const step = 100 / 11; 
            const offset = (step - 6.2) / 2;
            
            const leftPercent = (coords.x * step) + offset;
            const topPercent = (coords.y * step) + offset;

            pieceEl.style.left = `${leftPercent}%`;
            pieceEl.style.top = `${topPercent}%`;
        });
    });
    const allDomPieces = document.querySelectorAll('.piece');
    allDomPieces.forEach(el => { if (!activePieceIds.has(el.id)) el.remove(); });
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
