window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);

class ServerConnection {

    constructor() {
        this._connected = false;
        this._connecting = false;
        this._silentReconnect = false;
        this._disconnectedSince = null;
        this._gracePeriod = 8000; // ms before showing "Connection lost"
        this._graceTimer = null;
        this._sendBuffer = [];
        this._postQueue = [];
        this._posting = false;
        this._postEndpoint = this._baseUrl() + '/server/message';
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._connected || this._connecting) return;
        this._connecting = true;
        // Close old EventSource if any
        if (this._sse) {
            this._sse.onopen = null;
            this._sse.onmessage = null;
            this._sse.onerror = null;
            this._sse.close();
        }
        const sse = new EventSource(this._sseEndpoint(), { withCredentials: true });
        sse.onopen = () => this._onConnect();
        sse.onmessage = e => this._onMessage(e.data);
        sse.onerror = e => this._onDisconnect();
        this._sse = sse;
    }

    _onMessage(data) {
        const msg = JSON.parse(data);
        if (msg.type !== 'ws-relay') console.log('SSE:', msg);
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
            case 'ws-relay':
                Events.fire('ws-relay', msg);
                break;
            case 'display-name':
                Events.fire('display-name', msg);
                break;
            default:
                console.error('SSE: unknown message type', msg);
        }
    }

    send(message) {
        if (!this._connected) {
            this._sendBuffer.push(message);
            return;
        }
        this._enqueue(message);
    }

    _enqueue(message) {
        this._postQueue.push(message);
        if (!this._posting) {
            this._processQueue();
        }
    }

    _processQueue() {
        if (this._postQueue.length === 0) {
            this._posting = false;
            return;
        }
        this._posting = true;
        const message = this._postQueue.shift();
        this._post(message, 0);
    }

    _post(message, retries) {
        const maxRetries = 3;
        fetch(this._postEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
            credentials: 'include'
        }).then(response => {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            // Success — send next message in queue
            this._processQueue();
        }).catch(e => {
            if (retries < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, retries), 4000);
                console.warn('POST retry', retries + 1, '/', maxRetries, 'in', delay, 'ms:', e.message);
                setTimeout(() => this._post(message, retries + 1), delay);
            } else {
                console.error('POST failed after', maxRetries, 'retries:', e.message);
                // Skip this message and continue queue
                this._processQueue();
            }
        });
    }

    _flushBuffer() {
        clearTimeout(this._flushTimer);
        while (this._sendBuffer.length > 0 && this._connected) {
            const msg = this._sendBuffer.shift();
            this._enqueue(msg);
        }
    }

    _scheduleFlush() {
        clearTimeout(this._flushTimer);
        this._flushTimer = setTimeout(() => {
            if (this._connected && this._sendBuffer.length > 0) {
                this._flushBuffer();
            }
        }, 5000);
    }

    _baseUrl() {
        return location.protocol + '//' + location.host + location.pathname.replace(/\/$/, '');
    }

    _sseEndpoint() {
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        return this._baseUrl() + '/server/sse' + webrtc;
    }

    _disconnect() {
        this._post({ type: 'disconnect' });
        if (this._sse) {
            this._sse.onopen = null;
            this._sse.onmessage = null;
            this._sse.onerror = null;
            this._sse.close();
        }
        this._connected = false;
        this._connecting = false;
    }

    _onDisconnect() {
        if (!this._connected && !this._connecting) return; // already handled
        console.log('SSE: server disconnected');
        this._connected = false;
        this._connecting = false;
        Events.fire('ws-disconnected');
        clearTimeout(this._reconnectTimer);
        if (!this._disconnectedSince) {
            this._disconnectedSince = Date.now();
            this._silentReconnect = true;
            this._graceTimer = setTimeout(() => {
                if (!this._connected) {
                    this._silentReconnect = false;
                    Events.fire('notify-user', 'Connection lost. Reconnecting...');
                }
            }, this._gracePeriod);
        }
        // EventSource auto-reconnects, but we also set a manual fallback
        this._reconnectTimer = setTimeout(() => this._connect(), 2000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._connected;
    }

    _onConnect() {
        console.log('SSE: server connected');
        this._connected = true;
        this._connecting = false;
        clearTimeout(this._graceTimer);
        this._flushBuffer();
        Events.fire('ws-connected');
        if (this._disconnectedSince) {
            const downtime = Date.now() - this._disconnectedSince;
            console.log('SSE: reconnected after', downtime, 'ms');
            if (!this._silentReconnect) {
                Events.fire('notify-user', 'Reconnected.');
            }
            this._disconnectedSince = null;
            this._silentReconnect = false;
        }
    }

    _isConnecting() {
        return this._connecting;
    }
}

class Peer {

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._busy = false;
        this._awaitingPartitionReceived = false;
        this._lastPartitionOffset = null;
        Events.on('ws-connected', _ => this._onWSConnected());
    }

    _onWSConnected() {
        // If we sent a partition but never got partition-received (lost in transit), resend it
        if (this._awaitingPartitionReceived && this._lastPartitionOffset !== null && this._chunker) {
            console.log('Peer: resending partition after reconnect (partition-received may have been lost)');
            this.sendJSON({ type: 'partition', offset: this._lastPartitionOffset });
        }
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        // Envoyer d'abord le nombre total de fichiers
        this._totalFiles = files.length;
        this._currentFileIndex = 0;
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
        if (!this._filesQueue.length) {
            this._busy = false;
            this._totalFiles = 0;
            this._currentFileIndex = 0;
            Events.fire('send-progress', { done: true, allComplete: true });
            return;
        }
        this._busy = true;
        this._currentFileIndex++;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    _sendFile(file) {
        console.log('Peer: sending file', file.name, 'size:', file.size, 'type:', file.type);
        this._currentFile = file;
        this._chunkSeq = 0;
        this._awaitingPartitionReceived = false;
        this._lastPartitionOffset = null;
        Events.fire('send-progress', { 
            progress: 0, 
            name: file.name, 
            size: file.size,
            fileIndex: this._currentFileIndex,
            totalFiles: this._totalFiles
        });
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size
        });
        this._chunker = new FileChunker(file,
            chunk => {
                this._chunkSeq++;
                console.log('Sending chunk #' + this._chunkSeq, chunk.byteLength, 'bytes');
                this._send(chunk);
            },
            offset => {
                this._onPartitionEnd(offset);
                if (this._currentFile) {
                    Events.fire('send-progress', { 
                        progress: offset / this._currentFile.size, 
                        name: this._currentFile.name, 
                        size: this._currentFile.size,
                        fileIndex: this._currentFileIndex,
                        totalFiles: this._totalFiles
                    });
                }
            },
            () => this._server._isConnected());
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this._awaitingPartitionReceived = true;
        this._lastPartitionOffset = offset;
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        this._awaitingPartitionReceived = false;
        if (!this._chunker || this._chunker.isFileEnd()) {
            // File fully sent — wait for transfer-complete from receiver before next file
            console.log('Peer: file fully sent, waiting for transfer-complete');
            return;
        }
        if (!this._server._isConnected()) {
            // WS is down — wait and retry instead of losing the call
            clearTimeout(this._partitionRetry);
            this._partitionRetry = setTimeout(() => this._sendNextPartition(), 300);
            return;
        }
        clearTimeout(this._partitionRetry);
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message, seq) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message, seq);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC:', message);
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message.offset);
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
        this._chunkCount = 0;
        this._totalBytesReceived = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file));
    }

    _onChunkReceived(chunk, seq) {
        if(!chunk.byteLength) return;
        if(!this._digester) return; // ignore late chunks after transfer complete
        
        if (!this._chunkCount) this._chunkCount = 0;
        if (!this._totalBytesReceived) this._totalBytesReceived = 0;
        this._chunkCount++;
        this._totalBytesReceived += chunk.byteLength;
        if (this._chunkCount % 10 === 0) {
            console.log('Receiver: chunk #' + this._chunkCount, 'bytes so far:', this._totalBytesReceived, '/', this._digester._size);
        }
        this._digester.unchunk(chunk, seq);
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
        console.log('Peer: transfer-complete received for file', this._currentFileIndex, '/', this._totalFiles);
        Events.fire('send-progress', { 
            progress: 1, 
            name: this._currentFile ? this._currentFile.name : '', 
            size: this._currentFile ? this._currentFile.size : 0,
            fileIndex: this._currentFileIndex,
            totalFiles: this._totalFiles,
            done: true 
        });
        this._chunker = null;
        this._currentFile = null;
        this._busy = false;
        this._dequeueFile();
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
        this._connectTimeout = null;
        this._reconnectAttempts = 0;
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        console.log('RTC: _connect called for', peerId, 'as', isCaller ? 'caller' : 'callee');
        
        if (!this._conn) {
            this._openConnection(peerId, isCaller);
        } else if (this._isCaller !== isCaller) {
            console.warn('RTC: Role changed, recreating connection');
            this._conn.close();
            this._openConnection(peerId, isCaller);
        } else {
            console.log('RTC: Connection already exists, state:', this._conn.signalingState);
            return; // Don't re-create channel or set timeout again
        }

        // Set a timeout: if data channel doesn't open in 15s, fallback to WSPeer
        clearTimeout(this._connectTimeout);
        this._connectTimeout = setTimeout(() => {
            if (!this._isConnected()) {
                console.warn('RTC: Connection timeout (15s) for', this._peerId, '- falling back to WS');
                if (this._conn) { try { this._conn.close(); } catch(e) {} }
                this._conn = null;
                this._channel = null;
                Events.fire('rtc-fallback', this._peerId);
            }
        }, 15000);

        if (isCaller) {
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
        clearTimeout(this._connectTimeout);
        const channel = event.channel || event.target;
        console.log('RTC: channel state:', channel.readyState);
        channel.binaryType = 'arraybuffer';
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = e => this._onChannelClosed();
        channel.onerror = e => console.error('RTC: Channel error:', e);
        this._channel = channel;
        this._reconnectAttempts = 0;
        Events.fire('peer-connected', { peerId: this._peerId });
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        // Don't immediately reconnect — let _onConnectionStateChange handle it
    }

    _onConnectionStateChange(e) {
        console.log('RTC: state changed:', this._conn.connectionState, 'for', this._peerId);
        switch (this._conn.connectionState) {
            case 'connected':
                console.log('RTC: Successfully connected to', this._peerId);
                this._reconnectAttempts = 0;
                break;
            case 'disconnected':
                // Transient state — don't do anything, wait for 'failed' or recovery
                console.warn('RTC: Disconnected from', this._peerId, '(waiting for recovery or failure)');
                break;
            case 'failed':
                console.error('RTC: Connection failed with', this._peerId);
                this._conn.close();
                this._conn = null;
                this._channel = null;
                this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
                if (this._reconnectAttempts > 2) {
                    console.warn('RTC: Falling back to WebSocket relay for', this._peerId);
                    Events.fire('rtc-fallback', this._peerId);
                    return;
                }
                console.log('RTC: Will retry connection (attempt', this._reconnectAttempts, ')');
                setTimeout(() => {
                    if (!this._isConnected()) {
                        this._connect(this._peerId, this._isCaller);
                    }
                }, 3000 * this._reconnectAttempts);
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
        // Don't restart RTC negotiation on WS reconnect — let timeout handle fallback
        if (this._isConnected() || this._isAlive()) return;
        // Only retry if connection is truly dead and we haven't exceeded attempts
        this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
        if (this._reconnectAttempts > 2) {
            console.warn('RTC: refresh() max attempts, falling back to WS for', this._peerId);
            Events.fire('rtc-fallback', this._peerId);
            return;
        }
        console.log('RTC: refresh() triggering reconnect for', this._peerId, 'attempt', this._reconnectAttempts);
        this._connect(this._peerId, this._isCaller);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    _isAlive() {
        // Return true if the RTC connection exists and is not dead
        if (!this._conn) return false;
        const connState = this._conn.connectionState;
        // Any state other than 'failed' and 'closed' means the connection is alive or in progress
        return connState !== 'failed' && connState !== 'closed';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('ws-relay', e => this._onWSRelayMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('rtc-fallback', e => this._onRtcFallback(e.detail));
    }

    _onMessage(message) {
        // RTC signaling — ignore since we use WSPeer for all transfers
        // If we already have a WSPeer for this sender, no need to handle RTC signals
        if (!this.peers[message.sender]) return;
        if (this.peers[message.sender].onServerMessage) {
            this.peers[message.sender].onServerMessage(message);
        }
    }

    _onWSRelayMessage(message) {
        // Handle incoming WS relay messages
        if (!this.peers[message.sender]) {
            console.log('WSRelay: creating WSPeer for unknown sender', message.sender);
            this.peers[message.sender] = new WSPeer(this._server, message.sender);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onRtcFallback(peerId) {
        console.log('PeersManager: Switching to WSPeer for', peerId);
        // Clean up old RTCPeer
        const oldPeer = this.peers[peerId];
        if (oldPeer && oldPeer._conn) {
            try { oldPeer._conn.close(); } catch(e) {}
        }
        // Replace with WSPeer
        this.peers[peerId] = new WSPeer(this._server, peerId);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            // Use WSPeer (WebSocket relay) for all transfers
            // RTC is disabled until a working TURN server is configured
            this.peers[peer.id] = new WSPeer(this._server, peer.id);
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        if (!this.peers[message.to]) {
            console.warn('PeersManager: peer', message.to, 'not found, creating WSPeer');
            this.peers[message.to] = new WSPeer(this._server, message.to);
        }
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        if (!this.peers[message.to]) {
            console.warn('PeersManager: peer', message.to, 'not found, creating WSPeer');
            this.peers[message.to] = new WSPeer(this._server, message.to);
        }
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._peer) return;
        peer._peer.close();
    }

}

class WSPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        console.log('WS: Using WebSocket relay for', peerId);
    }

    _send(message) {
        if (typeof message === 'string') {
            // Check if this is a new file header - reset chunk sequence
            try {
                const msg = JSON.parse(message);
                if (msg.type === 'header') {
                    this._chunkSeq = 0;
                    console.log('WSPeer: new file header, reset chunk sequence');
                }
            } catch(e) {}
            // JSON text message — wrap in ws-relay envelope
            this._server.send({
                type: 'ws-relay',
                to: this._peerId,
                payload: message
            });
        } else {
            // Binary data — encode as base64 and wrap in ws-relay envelope
            const base64 = this._arrayBufferToBase64(message);
            if (!this._chunkSeq) this._chunkSeq = 0;
            this._chunkSeq++;
            this._server.send({
                type: 'ws-relay',
                to: this._peerId,
                binary: true,
                seq: this._chunkSeq,
                payload: base64
            });
        }
    }

    _arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    onServerMessage(message) {
        if (message.type === 'ws-relay') {
            if (message.binary) {
                // Decode base64 back to ArrayBuffer
                try {
                    const binary = atob(message.payload);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    const seq = message.seq || 0;
                    console.log('WSPeer: received binary chunk #' + seq + ', size:', bytes.byteLength);
                    this._onMessage(bytes.buffer, seq);
                } catch(e) {
                    console.error('WSPeer: base64 decode error:', e);
                }
            } else {
                console.log('WSPeer: received text message:', message.payload.substring(0, 100));
                this._onMessage(message.payload);
            }
        }
    }

    refresh() {
        // WSPeer is always "connected" as long as the WS is open
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd, isConnected) {
        this._chunkSize = 16000; // 16 KB — kept small for base64-over-SSE (~22KB per message)
        this._maxPartitionSize = 256000; // 256 KB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._isConnected = isConnected || (() => true);
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        if (!this._isConnected()) {
            // WS is down — wait and retry instead of flooding the send buffer
            clearTimeout(this._waitRetry);
            this._waitRetry = setTimeout(() => this._readChunk(), 300);
            return;
        }
        clearTimeout(this._waitRetry);
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) {
            console.log('FileChunker: file end reached at offset', this._offset);
            this._onPartitionEnd(this._offset);
            return;
        }
        if (this._isPartitionEnd()) {
            console.log('FileChunker: partition end at offset', this._offset);
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
        this._chunks = {}; // seq -> chunk
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk, seq) {
        if (this._completed) {
            console.warn('FileDigester: ignoring late chunk after completion, seq:', seq, 'size:', chunk.byteLength);
            return;
        }
        
        // Store chunk with sequence number
        if (seq && this._chunks[seq]) {
            console.warn('FileDigester: duplicate chunk seq:', seq);
            return;
        }
        this._chunks[seq || 0] = chunk;
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = Object.keys(this._chunks).length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done — reorder chunks by sequence
        this._completed = true;
        console.log('FileDigester: complete', this._name, 'received:', this._bytesReceived, 'expected:', this._size, 'chunks:', totalChunks);
        
        // Sort chunks by sequence number
        const seqs = Object.keys(this._chunks).map(s => parseInt(s)).sort((a, b) => a - b);
        const orderedChunks = seqs.map(s => this._chunks[s]);
        console.log('FileDigester: reordered chunks, seq range:', seqs[0], '-', seqs[seqs.length - 1]);
        
        let blob = new Blob(orderedChunks, { type: this._mime });
        console.log('FileDigester: blob size:', blob.size, 'type:', blob.type);
        if (blob.size !== this._size) {
            console.error('FileDigester: blob size mismatch! blob:', blob.size, 'expected:', this._size);
        }
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
