const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

// 1. HTTP Server: Liefert die index.html an den OBS-Browser aus
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { 
                res.writeHead(500); 
                return res.end('Fehler beim Laden der index.html'); 
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { 
        res.writeHead(404); 
        res.end('Nicht gefunden'); 
    }
});

// 2. WebSocket Server: Streamt die Tasten live an den OBS-Browser
const wss = new WebSocketServer({ server });
let clients = [];

wss.on('connection', (ws) => {
    clients.push(ws);
    console.log('OBS Browser Source erfolgreich verbunden!');
    
    ws.on('close', () => { 
        clients = clients.filter(c => c !== ws); 
        console.log('OBS Browser Source getrennt.');
    });
});

// 3. Wayland Hardware-Abfrage für deine Corsair K55 (event5)
const keyboardEvent = '/dev/input/event5'; 

// Startet das native Linux-Tool im Hintergrund
const keyStream = spawn('sudo', ['evemu-record', keyboardEvent]);

// Set speichert alle aktuell gedrückten Tasten
const activeKeys = new Set();

keyStream.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    
    for (let line of lines) {
        if (line.includes('EV_KEY')) {
            const match = line.match(/(KEY_[A-Z0-9_]+)/);
            
            if (match && match[1]) {
                const keyName = match[1];
                const trimmedLine = line.trim();
                
                const isPress = trimmedLine.endsWith(' 1');
                const isRepeat = trimmedLine.endsWith(' 2');
                const isRelease = trimmedLine.endsWith(' 0');

                let stateChanged = false;

                if (isPress) {
                    activeKeys.add(keyName);
                    stateChanged = true;
                } else if (isRelease) {
                    activeKeys.delete(keyName);
                    stateChanged = true;
                } else if (isRepeat) {
                    // WICHTIG: Wenn ein Repeat-Signal kommt, stellen wir nur sicher,
                    // dass die Taste im Set bleibt. Wir löschen andere Tasten NICHT.
                    if (!activeKeys.has(keyName)) {
                        activeKeys.add(keyName);
                        stateChanged = true;
                    }
                }

                // Nur an OBS senden, wenn sich im Set wirklich was getan hat
                if (stateChanged || isRepeat) {
                    const keysArray = Array.from(activeKeys);
                    
                    console.log(`Aktive Tasten: ${keysArray.join(' + ')}`);

                    const message = JSON.stringify({ keys: keysArray });
                    clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(message);
                        }
                    });
                }
            }
        }
    }
});

keyStream.stderr.on('data', (data) => {
    console.log(`System-Meldung: ${data.toString().trim()}`);
});

// 4. Server auf Port 8080 starten
server.listen(8080, () => {
    console.log('===================================================');
    console.log('Server läuft auf http://localhost:8080');
    console.log(`Belausche Hardware-Event: ${keyboardEvent}`);
    console.log('HINWEIS: Bitte tippe dein Linux-Passwort ein, falls gefordert.');
    console.log('===================================================');
});