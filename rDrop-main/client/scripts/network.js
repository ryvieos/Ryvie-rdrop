window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._connect();
        this._silentReconnect = false;
        this._disconnectedSince = null;
        this._gracePeriod = 8000; // ms before showing "Connection lost"
        this._graceTimer = null;
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        // Detach old socket handlers to prevent ghost disconnects
        if (this._socket) {
            this._socket.onclose = null;
            this._socket.onerror = null;
            this._socket.onmessage = null;
        }
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => this._onConnect();
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        console.log('WS:', msg);
        switch (msg.type) {
            case 'peers':
                Events.fire('peers', msg.peers);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'display-name':
                Events.fire('display-name', msg);
                break;
            default:
                console.error('WS: unkown message type', msg);
        }
    }

    send(message) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const url = protocol + '://' + location.host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
    }

    _onDisconnect() {
        console.log('WS: server disconnected');
        clearTimeout(this._reconnectTimer);
        if (!this._disconnectedSince) {
            this._disconnectedSince = Date.now();
            this._silentReconnect = true;
            // Start grace period — only show notification if still disconnected after delay
            this._graceTimer = setTimeout(() => {
                if (!this._isConnected()) {
                    this._silentReconnect = false;
                    Events.fire('notify-user', 'Connection lost. Reconnecting...');
                }
            }, this._gracePeriod);
        }
        // Reconnect quickly and silently
        this._reconnectTimer = setTimeout(_ => this._connect(), 1000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _onConnect() {
        console.log('WS: server connected');
        clearTimeout(this._graceTimer);
        if (this._disconnectedSince) {
            const downtime = Date.now() - this._disconnectedSince;
            console.log('WS: reconnected after', downtime, 'ms');
            if (!this._silentReconnect) {
                // Was visible to user, notify reconnection
                Events.fire('notify-user', 'Reconnected.');
            }
            this._disconnectedSince = null;
            this._silentReconnect = false;
        }
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }
}

class Peer {

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._busy = false;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        // Envoyer d'abord le nombre total de fichiers
        this.sendJSON({
            type: 'transfer-start',
            totalFiles: files.length
        });

        // Ajouter les fichiers à la queue
        for (let i = 0; i < files.length; i++) {
            this._filesQueue.push(files[i]);
        }
        if (this._busy) return;
        this._dequeueFile();
    }

    _dequeueFile() {
        if (!this._filesQueue.length) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    _sendFile(file) {
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size
        });
        this._chunker = new FileChunker(file,
            chunk => this._send(chunk),
            offset => this._onPartitionEnd(offset));
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd()) return;
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC:', message);
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition-received':
                this._sendNextPartition();
                break;
            case 'progress':
                this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted();
                break;
            case 'text':
                this._onTextReceived(message);
                break;
            case 'transfer-start':
                this._onTransferStart(message);
                break;
        }
    }

    _onFileHeader(header) {
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength) return;
        
        this._digester.unchunk(chunk);
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress 
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        Events.fire('file-progress', { sender: this._peerId, progress: progress });
    }

    _onFileReceived(proxyFile) {
        Events.fire('file-received', proxyFile);
        this.sendJSON({ type: 'transfer-complete' });
    }

    _onTransferCompleted() {
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        this._dequeueFile();
        Events.fire('notify-user', 'File transfer completed.');
    }

    _onTransferStart(message) {
        Events.fire('transfer-start', { sender: this._peerId, totalFiles: message.totalFiles });
    }

    sendText(text) {
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        this.sendJSON({ type: 'text', text: unescaped });
    }

    _onTextReceived(message) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        Events.fire('text-received', { text: escaped, sender: this._peerId });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        console.log('RTC: _connect called for', peerId, 'as', isCaller ? 'caller' : 'callee');
        
        if (!this._conn) {
            this._openConnection(peerId, isCaller);
        } else if (this._isCaller !== isCaller) {
            // Si le rôle change, on doit recréer la connexion
            console.warn('RTC: Role changed, recreating connection');
            this._conn.close();
            this._openConnection(peerId, isCaller);
        } else {
            console.log('RTC: Connection already exists, state:', this._conn.signalingState);
        }

        if (isCaller) {
            // Ne créer un canal que si on n'en a pas déjà un en cours
            if (!this._channel || this._channel.readyState === 'closed') {
                this._openChannel();
            } else {
                console.log('RTC: Channel already exists, state:', this._channel.readyState);
            }
        } else {
            console.log('RTC: Waiting for data channel as callee');
            this._conn.ondatachannel = e => {
                console.log('RTC: ondatachannel event received');
                this._onChannelOpened(e);
            };
        }
    }

    _openConnection(peerId, isCaller) {
        this._isCaller = isCaller;
        this._peerId = peerId;
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = e => this._onConnectionStateChange(e);
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
    }

    _openChannel() {
        console.log('RTC: Creating data channel as caller for', this._peerId);
        const channel = this._conn.createDataChannel('data-channel', { 
            ordered: true,
            reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
        });
        channel.onopen = e => this._onChannelOpened(e);
        channel.onerror = e => console.error('RTC: Channel error:', e);
        console.log('RTC: Creating offer for', this._peerId);
        this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
    }

    _onDescription(description) {
        console.log('RTC: Setting local description:', description.type, 'for', this._peerId);
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._conn.setLocalDescription(description)
            .then(_ => {
                console.log('RTC: Sending', description.type, 'to', this._peerId);
                this._sendSignal({ sdp: description });
            })
            .catch(e => this._onError(e));
    }

    _onIceCandidate(event) {
        if (!event.candidate) {
            console.log('RTC: ICE gathering complete for', this._peerId);
            return;
        }
        const candidate = event.candidate;
        const candidateType = candidate.candidate.includes('typ relay') ? 'TURN' :
                             candidate.candidate.includes('typ srflx') ? 'STUN' :
                             candidate.candidate.includes('typ host') ? 'HOST' : 'UNKNOWN';
        console.log('RTC: ICE candidate (' + candidateType + ') for', this._peerId);
        this._sendSignal({ ice: event.candidate });
    }

    onServerMessage(message) {
        if (!this._conn) this._connect(message.sender, false);

        if (message.sdp) {
            const signalingState = this._conn.signalingState;
            const sdpType = message.sdp.type;
            
            console.log('RTC: Received', sdpType, 'from', message.sender, 'in state:', signalingState);
            
            // Vérifier si on peut traiter ce message SDP selon l'état actuel
            if (sdpType === 'offer' && signalingState !== 'stable' && signalingState !== 'have-local-offer') {
                console.warn('RTC: Ignoring offer in state:', signalingState);
                return;
            }
            
            if (sdpType === 'answer' && signalingState !== 'have-local-offer') {
                console.warn('RTC: Ignoring answer in state:', signalingState);
                return;
            }
            
            console.log('RTC: Setting remote description:', sdpType);
            this._conn.setRemoteDescription(new RTCSessionDescription(message.sdp))
                .then( _ => {
                    console.log('RTC: Remote description set, new state:', this._conn.signalingState);
                    if (message.sdp.type === 'offer') {
                        console.log('RTC: Creating answer for', message.sender);
                        return this._conn.createAnswer()
                            .then(d => this._onDescription(d));
                    }
                })
                .catch(e => this._onError(e));
        } else if (message.ice) {
            this._conn.addIceCandidate(new RTCIceCandidate(message.ice))
                .catch(e => console.warn('RTC: Failed to add ICE candidate:', e));
        }
    }

    _onChannelOpened(event) {
        console.log('RTC: channel opened with', this._peerId);
        const channel = event.channel || event.target;
        console.log('RTC: channel state:', channel.readyState);
        channel.binaryType = 'arraybuffer';
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = e => this._onChannelClosed();
        channel.onerror = e => console.error('RTC: Channel error:', e);
        this._channel = channel;
        Events.fire('peer-connected', { peerId: this._peerId });
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        if (!this.isCaller) return;
        this._connect(this._peerId, true); // reopen the channel
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed:', this._conn.connectionState, 'for', this._peerId);
        switch (this._conn.connectionState) {
            case 'connected':
                console.log('RTC: Successfully connected to', this._peerId);
                this._reconnectAttempts = 0;
                break;
            case 'disconnected':
                console.warn('RTC: Disconnected from', this._peerId);
                this._onChannelClosed();
                break;
            case 'failed':
                console.error('RTC: Connection failed with', this._peerId);
                this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
                if (this._reconnectAttempts > 3) {
                    console.error('RTC: Max reconnection attempts reached for', this._peerId);
                    Events.fire('notify-user', 'Connection failed with peer. Please try again.');
                    return;
                }
                this._conn = null;
                this._channel = null;
                console.log('RTC: Will retry connection (attempt', this._reconnectAttempts, ')');
                setTimeout(() => {
                    if (!this._isConnected()) {
                        this._connect(this._peerId, this._isCaller);
                    }
                }, 2000 * this._reconnectAttempts);
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE Gathering failed');
                break;
            default:
                console.log('ICE Gathering', this._conn.iceConnectionState);
        }
    }

    _onError(error) {
        console.error(error);
    }

    _send(message) {
        if (!this._channel) return this.refresh();
        this._channel.send(message);
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        this._server.send(signal);
    }

    refresh() {
        // check if channel is open. otherwise create one
        if (this._isConnected() || this._isConnecting()) return;
        this._connect(this._peerId, this._isCaller);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    _isConnecting() {
        return this._channel && this._channel.readyState === 'connecting';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._peer) return;
        peer._peer.close();
    }

}

class WSPeer {
    _send(message) {
        message.to = this._peerId;
        this._server.send(message);
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000; // 64 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) return;
        if (this._isPartitionEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        let blob = new Blob(this._buffer, { type: this._mime });
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            blob: blob
        });
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static off(type, callback) {
        return window.removeEventListener(type, callback, false);
    }
}


RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        {
            urls: 'stun:stun.l.google.com:19302'
        },
        {
            urls: 'stun:stun1.l.google.com:19302'
        },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    'iceCandidatePoolSize': 10
}
