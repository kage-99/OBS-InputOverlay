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
                return res.end('Error loading index.html'); 
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { 
        res.writeHead(404); 
        res.end('Not found'); 
    }
});

// 2. WebSocket Server: Streamt die Tasten live an den OBS-Browser
const wss = new WebSocketServer({ server });
let clients = [];

wss.on('connection', (ws) => {
    clients.push(ws);
    console.log('OBS Browser Source connected!');
    
    ws.on('close', () => { 
        clients = clients.filter(c => c !== ws); 
        console.log('OBS Browser Source disconnected.');
    });
});

// 3. Wayland Hardware-Abfrage für deine Corsair K55.
// Stabiler Pfad über die USB-Seriennummer (bleibt über Boots und Port-Änderungen gleich),
// statt hardcoded /dev/input/event5, dessen Nummer sich pro Boot ändert und vorher die
// Maus (G502) statt der Tastatur war.
const keyboardEvent = '/dev/input/by-id/usb-Corsair_CORSAIR_K55_CORE_RGB_Gaming_Keyboard_AD0000008900C1007B7F95103EE50000-event-kbd';

// Set speichert alle aktuell gedrückten Tasten
const activeKeys = new Set();

// Startet das native Linux-Tool im Hintergrund und verarbeitet dessen Ausgabe.
// KEIN sudo: dein User ist in der 'input'-Gruppe und darf das Device direkt lesen.
// sudo würde sonst auf eine Passwort-Eingabe warten und das Programm blockieren.
function startKeyStream() {
    // Beim Autostart kann das USB-Device kurz noch nicht da sein.
    if (!fs.existsSync(keyboardEvent)) {
        console.log(`Waiting for keyboard device: ${keyboardEvent}`);
        return setTimeout(startKeyStream, 1000);
    }

    const keyStream = spawn('evemu-record', [keyboardEvent]);

    keyStream.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');

        for (let line of lines) {
            if (line.includes('EV_KEY')) {
                // evemu-record schreibt z.B.:
                //   E: 0.256830 0001 007d 0002	# EV_KEY / KEY_LEFTMETA         2
                // Der Wert (letztes Feld) ist 1=gedrückt, 0=losgelassen, 2=Repeat.
                const match = line.match(/(KEY_[A-Z0-9_]+)/);
                const tokens = line.trim().split(/\s+/);
                const value = parseInt(tokens[tokens.length - 1], 10);

                if (match && match[1] && !isNaN(value)) {
                    const keyName = match[1];

                    const isPress = value === 1;
                    const isRepeat = value === 2;
                    const isRelease = value === 0;

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

                        console.log(`Active key: ${keysArray.join(' + ')}`);

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
        console.log(`System message: ${data.toString().trim()}`);
    });

    // Self-healing: Wenn evemu-record stirbt (z.B. Device kurz weg), neu starten.
    keyStream.on('close', () => {
        console.log('evemu-record stopped – restarting in 1s...');
        setTimeout(startKeyStream, 1000);
    });
}

setTimeout(startKeyStream, 0);

// 4. Server auf Port 8080 starten
server.listen(8080, () => {
    console.log('===================================================');
    console.log('Server running at http://localhost:8080');
    console.log(`Listening on hardware event: ${keyboardEvent}`);
    console.log('===================================================');
});