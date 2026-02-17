var process = require('process')
var http = require('http');
var url = require('url');
// Handle SIGINT
process.on('SIGINT', () => {
  console.info("SIGINT Received, exiting...")
  process.exit(0)
})

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info("SIGTERM Received, exiting...")
  process.exit(0)
})

const parser = require('ua-parser-js');
const { uniqueNamesGenerator, animals, colors } = require('unique-names-generator');

class SnapdropServer {

    constructor(port) {
        this._rooms = {};
        this._peers = {}; // peerId -> Peer (for POST message routing)
        this._messageBuffers = {}; // peerId -> [messages] for temporarily disconnected peers
        this._disconnectTimers = {}; // peerId -> timer for grace period

        this._httpServer = http.createServer((req, res) => this._onRequest(req, res));
        this._httpServer.listen(port, () => {
            console.log('Snapdrop is running on port', port, '(SSE + HTTP POST)');
        });

        // Keep-alive: send SSE comment every 20s to keep connection alive through proxies
        this._keepAliveInterval = setInterval(() => {
            for (const peerId in this._peers) {
                const peer = this._peers[peerId];
                if (peer && peer.res && !peer._disconnected) {
                    try { peer.res.write(':keepalive\n\n'); } catch(e) {}
                }
            }
        }, 20000);
    }

    _onRequest(req, res) {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // CORS headers for all responses
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method === 'GET' && pathname.startsWith('/server/sse')) {
            this._handleSSE(req, res);
        } else if (req.method === 'POST' && pathname === '/server/message') {
            this._handleMessage(req, res);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }

    _handleSSE(req, res) {
        // Determine peer ID from cookie or generate new one
        let peerId = null;
        let isNewPeer = false;
        const cookies = req.headers.cookie || '';
        const match = cookies.match(/peerid=([^;]+)/);
        if (match) {
            peerId = match[1];
        } else {
            peerId = Peer.uuid();
            isNewPeer = true;
        }

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            ...(isNewPeer ? { 'Set-Cookie': 'peerid=' + peerId + '; SameSite=None; Secure; Path=/' } : {})
        });
        res.flushHeaders();

        // Send initial retry interval
        res.write('retry: 1000\n\n');

        const rtcSupported = req.url.indexOf('webrtc') > -1;
        const peer = new Peer(res, req, peerId, rtcSupported);
        this._onConnection(peer);

        // Handle client disconnect
        req.on('close', () => {
            console.log('SSE closed for', peer.id.substring(0,8));
            this._onPeerDisconnect(peer);
        });
    }

    _handleMessage(req, res) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            // Get peer ID from cookie
            const cookies = req.headers.cookie || '';
            const match = cookies.match(/peerid=([^;]+)/);
            if (!match) {
                res.writeHead(401);
                res.end('{"error":"no peer id"}');
                return;
            }
            const peerId = match[1];
            const peer = this._peers[peerId];
            if (!peer) {
                res.writeHead(404);
                res.end('{"error":"peer not found"}');
                return;
            }

            // Update lastBeat on any message
            peer.lastBeat = Date.now();

            try {
                const message = JSON.parse(body);
                this._onMessage(peer, message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"ok":true}');
            } catch(e) {
                res.writeHead(400);
                res.end('{"error":"invalid json"}');
            }
        });
    }

    _onConnection(peer) {
        this._peers[peer.id] = peer;
        this._joinRoom(peer);
        this._keepAlive(peer);

        // send displayName
        this._send(peer, {
            type: 'display-name',
            message: {
                displayName: peer.name.displayName,
                deviceName: peer.name.deviceName
            }
        });
    }

    _onMessage(sender, message) {
        switch (message.type) {
            case 'disconnect':
                console.log('Received disconnect from', sender.id);
                // Voluntary disconnect — cancel any grace timer and remove immediately
                if (this._disconnectTimers[sender.id]) {
                    clearTimeout(this._disconnectTimers[sender.id]);
                    delete this._disconnectTimers[sender.id];
                }
                delete this._messageBuffers[sender.id];
                this._leaveRoom(sender);
                break;
            case 'pong':
                sender.lastBeat = Date.now();
                break;
        }

        // relay message to recipient
        if (message.to && this._rooms[sender.ip]) {
            const recipientId = message.to; // TODO: sanitize
            const recipient = this._rooms[sender.ip][recipientId];
            delete message.to;
            // add sender id
            message.sender = sender.id;
            if (message.type === 'signal') {
                const sigType = message.sdp ? 'sdp:' + message.sdp.type : message.ice ? 'ice' : 'other';
                console.log('Signal', sigType, 'from', sender.id.substring(0,8), 'to', recipientId.substring(0,8), recipient ? (recipient._disconnected ? '(buffered)' : '(live)') : '(not found)');
            }
            if (message.type === 'ws-relay') {
                let info = 'binary';
                if (message.binary && message.payload) {
                    info = 'binary:' + message.payload.length + 'chars';
                } else if (!message.binary && message.payload) {
                    try { info = JSON.parse(message.payload).type || 'unknown'; } catch(e) { info = 'parse-error'; }
                }
                console.log('WS-Relay from', sender.id.substring(0,8), 'to', recipientId.substring(0,8), info, recipient ? (recipient._disconnected ? '(buffered)' : '(live)') : '(not found)');
            }
            // If recipient is temporarily disconnected, buffer the message
            if (recipient && recipient._disconnected) {
                if (!this._messageBuffers[recipientId]) this._messageBuffers[recipientId] = [];
                // Store message with recipient info for proper delivery on reconnect
                this._messageBuffers[recipientId].push({ message, recipientId });
            } else {
                this._send(recipient, message);
            }
            return;
        }
    }

    _joinRoom(peer) {
        // if room doesn't exist, create it
        if (!this._rooms[peer.ip]) {
            this._rooms[peer.ip] = {};
        }

        // If peer with same ID already exists (reconnect), handle gracefully
        const existingPeer = this._rooms[peer.ip][peer.id];
        if (existingPeer) {
            const wasDisconnected = existingPeer._disconnected;
            this._cancelKeepAlive(existingPeer);
            // Close old SSE connection
            try { existingPeer.res.end(); } catch(e) {}
            // Cancel grace timer
            if (this._disconnectTimers[peer.id]) {
                clearTimeout(this._disconnectTimers[peer.id]);
                delete this._disconnectTimers[peer.id];
            }
            // Replace with new peer in room and peers map
            this._rooms[peer.ip][peer.id] = peer;
            this._peers[peer.id] = peer;
            if (wasDisconnected) {
                console.log('Peer', peer.id.substring(0,8), 'reconnected within grace period');
                // Deliver buffered messages to their correct recipients
                if (this._messageBuffers[peer.id]) {
                    const buffered = this._messageBuffers[peer.id];
                    delete this._messageBuffers[peer.id];
                    console.log('Delivering', buffered.length, 'buffered messages to', peer.id.substring(0,8));
                    buffered.forEach(item => {
                        // Send to the reconnected peer (who was the intended recipient)
                        this._send(peer, item.message);
                    });
                }
                // Send current peers list (without triggering peer-joined on others since they never saw peer-left)
                const otherPeers = [];
                for (const otherPeerId in this._rooms[peer.ip]) {
                    if (otherPeerId === peer.id) continue;
                    otherPeers.push(this._rooms[peer.ip][otherPeerId].getInfo());
                }
                this._send(peer, { type: 'peers', peers: otherPeers });
                console.log('Room', peer.ip, 'still has', Object.keys(this._rooms[peer.ip]).length, 'peers:', Object.keys(this._rooms[peer.ip]).map(id => id.substring(0,8)).join(', '));
                return;
            }
            delete this._rooms[peer.ip][peer.id];
        }

        // notify all other peers (skip disconnected ones, they'll get the info on reconnect)
        for (const otherPeerId in this._rooms[peer.ip]) {
            const otherPeer = this._rooms[peer.ip][otherPeerId];
            if (otherPeer._disconnected) continue;
            this._send(otherPeer, {
                type: 'peer-joined',
                peer: peer.getInfo()
            });
        }

        // notify peer about the other peers (include disconnected ones — they're still "in the room")
        const otherPeers = [];
        for (const otherPeerId in this._rooms[peer.ip]) {
            otherPeers.push(this._rooms[peer.ip][otherPeerId].getInfo());
        }

        this._send(peer, {
            type: 'peers',
            peers: otherPeers
        });

        // add peer to room
        this._rooms[peer.ip][peer.id] = peer;
        console.log('Room', peer.ip, 'now has', Object.keys(this._rooms[peer.ip]).length, 'peers:', Object.keys(this._rooms[peer.ip]).map(id => id.substring(0,8)).join(', '));
    }

    _onPeerDisconnect(peer) {
        if (!this._rooms[peer.ip] || !this._rooms[peer.ip][peer.id]) return;
        // Don't remove from room yet — mark as disconnected and start grace period
        peer._disconnected = true;
        this._cancelKeepAlive(peer);
        console.log('Peer', peer.id.substring(0,8), 'disconnected, starting 15s grace period');
        this._disconnectTimers[peer.id] = setTimeout(() => {
            console.log('Grace period expired for', peer.id.substring(0,8), '- removing from room');
            delete this._disconnectTimers[peer.id];
            delete this._messageBuffers[peer.id];
            this._leaveRoom(peer);
        }, 15000);
    }

    _leaveRoom(peer) {
        if (!this._rooms[peer.ip] || !this._rooms[peer.ip][peer.id]) return;
        this._cancelKeepAlive(this._rooms[peer.ip][peer.id]);

        // delete the peer
        delete this._rooms[peer.ip][peer.id];
        delete this._peers[peer.id];

        try { peer.res.end(); } catch(e) {}
        //if room is empty, delete the room
        if (!Object.keys(this._rooms[peer.ip]).length) {
            delete this._rooms[peer.ip];
        } else {
            // notify all other peers (only connected ones)
            for (const otherPeerId in this._rooms[peer.ip]) {
                const otherPeer = this._rooms[peer.ip][otherPeerId];
                if (otherPeer._disconnected) continue;
                this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
            }
        }
    }

    _send(peer, message) {
        if (!peer) return;
        if (peer._disconnected) return;
        if (!peer.res || peer.res.writableEnded) return;
        try {
            const data = JSON.stringify(message);
            const sseMsg = 'data: ' + data + '\n\n';
            const ok = peer.res.write(sseMsg);
            if (!ok) {
                console.warn('SSE backpressure for', peer.id.substring(0,8), 'msg size:', sseMsg.length);
            }
        } catch(e) {
            console.error('SSE send error to', peer.id, e.message);
        }
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        // With SSE, connection closure is detected by req.on('close').
        // This timer is a safety net for stale peers whose SSE close event was missed.
        var timeout = 120000; // 2 minutes
        peer.timerId = setTimeout(() => {
            if (peer._disconnected) return;
            if (peer.res && peer.res.writableEnded) {
                console.log('Keep-alive: SSE ended for', peer.id.substring(0,8), '- cleaning up');
                this._onPeerDisconnect(peer);
            } else {
                this._keepAlive(peer); // reschedule
            }
        }, timeout);
    }

    _cancelKeepAlive(peer) {
        if (peer && peer.timerId) {
            clearTimeout(peer.timerId);
        }
    }
}



class Peer {

    constructor(res, request, peerId, rtcSupported) {
        // set SSE response
        this.res = res;

        // set remote ip
        this._setIP(request);

        // set peer id
        this.id = peerId;
        // is WebRTC supported ?
        this.rtcSupported = rtcSupported;
        // set name 
        this._setName(request);
        // for keepalive
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setIP(request) {
        const isInternalIP = (ip) => {
            if (!ip) return true;
            // Netbird / WireGuard overlay: 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
            if (ip.startsWith('100.')) {
                const second = parseInt(ip.split('.')[1], 10);
                if (second >= 64 && second <= 127) return true;
            }
            // Docker / private ranges
            if (ip.startsWith('172.') || ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
            // Loopback
            if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
            // IPv6-mapped private
            if (ip.startsWith('::ffff:')) return true;
            return false;
        };

        // 1. Try X-Forwarded-For: pick the first public (non-internal) IP
        if (request.headers['x-forwarded-for']) {
            const forwardedIps = request.headers['x-forwarded-for'].split(/\s*,\s*/);
            for (let ip of forwardedIps) {
                if (!isInternalIP(ip)) {
                    this.ip = ip;
                    break;
                }
            }
        }

        // 2. Fallback to X-Real-IP if it's public
        if (!this.ip && request.headers['x-real-ip'] && !isInternalIP(request.headers['x-real-ip'])) {
            this.ip = request.headers['x-real-ip'];
        }

        // 3. Fallback to remote address
        if (!this.ip) {
            this.ip = request.connection.remoteAddress;
        }

        // Normalize IPv6 loopback
        if (this.ip === '::1' || this.ip === '::ffff:127.0.0.1') {
            this.ip = '127.0.0.1';
        }

        // Normalize all internal IPs to 'local-network'
        if (isInternalIP(this.ip)) {
            this.ip = 'local-network';
        }
        
        console.log('Peer connected - IP:', this.ip, 'X-Real-IP:', request.headers['x-real-ip'], 'X-Forwarded-For:', request.headers['x-forwarded-for'], 'Remote:', request.connection.remoteAddress);
    }

    toString() {
        return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`
    }

    _setName(req) {
        let ua = parser(req.headers['user-agent']);


        let deviceName = '';
        
        if (ua.os && ua.os.name) {
            deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
        }
        
        if (ua.device.model) {
            deviceName += ua.device.model;
        } else {
            deviceName += ua.browser.name;
        }

        if(!deviceName)
            deviceName = 'Unknown Device';

        const displayName = uniqueNamesGenerator({
            length: 2,
            separator: ' ',
            dictionaries: [colors, animals],
            style: 'capital',
            seed: this.id.hashCode()
        })

        this.name = {
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
            deviceName,
            displayName
        };
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            rtcSupported: this.rtcSupported
        }
    }

    // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    static uuid() {
        let uuid = '',
            ii;
        for (ii = 0; ii < 32; ii += 1) {
            switch (ii) {
                case 8:
                case 20:
                    uuid += '-';
                    uuid += (Math.random() * 16 | 0).toString(16);
                    break;
                case 12:
                    uuid += '-';
                    uuid += '4';
                    break;
                case 16:
                    uuid += '-';
                    uuid += (Math.random() * 4 | 8).toString(16);
                    break;
                default:
                    uuid += (Math.random() * 16 | 0).toString(16);
            }
        }
        return uuid;
    };
}

Object.defineProperty(String.prototype, 'hashCode', {
  value: function() {
    var hash = 0, i, chr;
    for (i = 0; i < this.length; i++) {
      chr   = this.charCodeAt(i);
      hash  = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }
});

const server = new SnapdropServer(process.env.PORT || 3000);
