/**
 * Lifesaver AI Voice Widget
 * Connects to ElatoAI Deno server via WebSocket
 * Streams PCM16 audio in both directions (same protocol as ESP32)
 * 
 * Usage: add <script src="voice-widget.js"></script> before </body>
 * Then call: new LifesaverVoice('ws://10.111.187.209:8787')
 */

(function () {
  // ── CONFIG ──────────────────────────────────────────────────────
  const SAMPLE_RATE  = 24000;   // OpenAI Realtime expects 24kHz
  const CHUNK_MS     = 100;     // send audio every 100ms (2400 samples)
  const CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS / 1000;

  // ── AUDIO WORKLET PROCESSOR (inlined as Blob to avoid file deps) ─
  const WORKLET_CODE = `
    class PCM16Processor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._buffer = [];
        this._chunkSize = ${CHUNK_SAMPLES};
      }
      process(inputs) {
        const ch = inputs[0]?.[0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) this._buffer.push(ch[i]);
        while (this._buffer.length >= this._chunkSize) {
          const chunk = this._buffer.splice(0, this._chunkSize);
          const pcm = new Int16Array(chunk.length);
          for (let j = 0; j < chunk.length; j++) {
            const s = Math.max(-1, Math.min(1, chunk[j]));
            pcm[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
          // Send RMS for level meter
          let sum = 0;
          for (const v of chunk) sum += v * v;
          this.port.postMessage({ rms: Math.sqrt(sum / chunk.length) });
        }
        return true;
      }
    }
    registerProcessor('pcm16-processor', PCM16Processor);
  `;

  // ── STYLES ──────────────────────────────────────────────────────
  const CSS = `
    #ls-voice-widget {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 9998;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 12px;
      font-family: 'DM Mono', 'Courier New', monospace;
    }
    #ls-voice-panel {
      width: 320px;
      background: #111117;
      border: 1px solid rgba(255,68,68,0.25);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
      display: none;
      animation: lsSlideUp 0.25s cubic-bezier(0.34,1.56,0.64,1) both;
    }
    #ls-voice-panel.open { display: block; }
    @keyframes lsSlideUp {
      from { opacity:0; transform:translateY(16px) scale(0.96); }
      to   { opacity:1; transform:none; }
    }
    #ls-panel-header {
      padding: 16px 18px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: linear-gradient(135deg, rgba(255,68,68,0.08), rgba(0,212,255,0.04));
    }
    #ls-panel-title {
      font-family: 'Bebas Neue', 'Arial Black', sans-serif;
      font-size: 20px;
      letter-spacing: 4px;
      color: #F0EEF8;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 3px;
    }
    #ls-panel-title span { color: #FF4444; }
    #ls-panel-subtitle {
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #4A4A5E;
    }
    #ls-status-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
    }
    #ls-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4A4A5E;
      transition: background 0.3s;
      flex-shrink: 0;
    }
    #ls-status-dot.connecting { background: #FF9500; animation: lsPulse 1s infinite; }
    #ls-status-dot.connected  { background: #00E676; }
    #ls-status-dot.listening  { background: #FF4444; animation: lsPulse 0.6s infinite; }
    #ls-status-dot.speaking   { background: #00D4FF; animation: lsPulse 0.8s infinite; }
    @keyframes lsPulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
    #ls-status-text {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #8A8AA0;
    }
    #ls-panel-body { padding: 16px 18px; }
    
    /* VISUALIZER */
    #ls-visualizer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      height: 48px;
      margin-bottom: 14px;
    }
    .ls-bar {
      width: 3px;
      border-radius: 2px;
      background: rgba(255,68,68,0.3);
      transition: height 0.08s ease, background 0.2s;
      min-height: 3px;
    }
    .ls-bar.active { background: #FF4444; }
    .ls-bar.speaking { background: #00D4FF; }

    /* TRANSCRIPT */
    #ls-transcript {
      height: 100px;
      overflow-y: auto;
      background: #0A0A0F;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #ls-transcript::-webkit-scrollbar { width: 2px; }
    #ls-transcript::-webkit-scrollbar-thumb { background: #FF4444; border-radius: 2px; }
    .ls-msg {
      font-size: 11px;
      line-height: 1.5;
      padding: 6px 9px;
      border-radius: 6px;
      animation: lsMsgIn 0.2s ease both;
      max-width: 90%;
    }
    @keyframes lsMsgIn { from{opacity:0;transform:translateY(4px);} to{opacity:1;transform:none;} }
    .ls-msg.user {
      background: rgba(255,68,68,0.1);
      color: #FF6B6B;
      border: 1px solid rgba(255,68,68,0.15);
      align-self: flex-end;
    }
    .ls-msg.ai {
      background: #16161E;
      color: #F0EEF8;
      border: 1px solid rgba(255,255,255,0.07);
      align-self: flex-start;
    }
    .ls-msg.system {
      background: transparent;
      color: #4A4A5E;
      font-size: 10px;
      letter-spacing: 0.08em;
      align-self: center;
    }
    #ls-empty-hint {
      color: #4A4A5E;
      font-size: 11px;
      text-align: center;
      padding: 16px 0;
      letter-spacing: 0.06em;
    }

    /* CONTROLS */
    #ls-controls {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #ls-mic-btn {
      flex: 1;
      height: 44px;
      background: #FF4444;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #fff;
      transition: all 0.15s;
      position: relative;
      overflow: hidden;
    }
    #ls-mic-btn:hover { background: #FF6B6B; transform: translateY(-1px); }
    #ls-mic-btn:active { transform: translateY(0); }
    #ls-mic-btn.listening {
      background: #1C1C26;
      border: 1px solid rgba(255,68,68,0.4);
      color: #FF4444;
      animation: lsBtnPulse 1.5s ease infinite;
    }
    @keyframes lsBtnPulse {
      0%,100%{ box-shadow: 0 0 0 0 rgba(255,68,68,0.3); }
      50%    { box-shadow: 0 0 0 8px rgba(255,68,68,0); }
    }
    #ls-mic-btn.disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    #ls-clear-btn {
      width: 44px;
      height: 44px;
      background: #16161E;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      color: #4A4A5E;
    }
    #ls-clear-btn:hover { background: #1C1C26; color: #8A8AA0; }

    /* LEVEL METER */
    #ls-level-wrap {
      margin-top: 10px;
      display: none;
    }
    #ls-level-wrap.show { display: block; }
    #ls-level-bar {
      height: 2px;
      background: rgba(255,68,68,0.15);
      border-radius: 2px;
      overflow: hidden;
    }
    #ls-level-fill {
      height: 100%;
      background: linear-gradient(90deg, #FF4444, #FF9500);
      border-radius: 2px;
      width: 0%;
      transition: width 0.05s linear;
    }

    /* FAB */
    #ls-fab {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #FF4444;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 8px 24px rgba(255,68,68,0.4), 0 2px 8px rgba(0,0,0,0.4);
      transition: all 0.2s;
      position: relative;
    }
    #ls-fab:hover { transform: scale(1.08); box-shadow: 0 12px 32px rgba(255,68,68,0.5); }
    #ls-fab.open  { background: #1C1C26; border: 1px solid rgba(255,68,68,0.3); }
    #ls-fab.listening { animation: lsFabPulse 1s ease infinite; }
    @keyframes lsFabPulse {
      0%,100%{ box-shadow: 0 8px 24px rgba(255,68,68,0.4); }
      50%    { box-shadow: 0 8px 32px rgba(255,68,68,0.7), 0 0 0 12px rgba(255,68,68,0.1); }
    }
    #ls-fab-tooltip {
      position: absolute;
      right: 64px;
      top: 50%;
      transform: translateY(-50%);
      background: #111117;
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #8A8AA0;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
    }
    #ls-fab:hover #ls-fab-tooltip { opacity: 1; }
    
    /* WS URL input */
    #ls-ws-row {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
    }
    #ls-ws-input {
      flex: 1;
      padding: 8px 10px;
      background: #0A0A0F;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 6px;
      color: #8A8AA0;
      font-family: inherit;
      font-size: 10px;
      outline: none;
      transition: border-color 0.2s;
    }
    #ls-ws-input:focus { border-color: rgba(255,68,68,0.3); color: #F0EEF8; }
    #ls-connect-btn {
      padding: 0 12px;
      background: rgba(255,68,68,0.12);
      border: 1px solid rgba(255,68,68,0.25);
      border-radius: 6px;
      color: #FF6B6B;
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    #ls-connect-btn:hover { background: rgba(255,68,68,0.2); }
  `;

  // ── HTML ────────────────────────────────────────────────────────
  const HTML = `
    <div id="ls-voice-panel">
      <div id="ls-panel-header">
        <div id="ls-panel-title">LIFE<span>SAVER</span> AI</div>
        <div id="ls-panel-subtitle">Voice Emergency Assistant</div>
        <div id="ls-status-row">
          <div id="ls-status-dot"></div>
          <div id="ls-status-text">Not connected</div>
        </div>
      </div>
      <div id="ls-panel-body">
        <div id="ls-ws-row">
          <input id="ls-ws-input" type="text" value="ws://10.111.187.209:8787" spellcheck="false"/>
          <button id="ls-connect-btn" onclick="window._lsVoice.toggleConnect()">Connect</button>
        </div>
        <div id="ls-visualizer">
          ${Array.from({length:20},(_,i)=>`<div class="ls-bar" id="ls-bar-${i}" style="height:3px;"></div>`).join('')}
        </div>
        <div id="ls-transcript"><div id="ls-empty-hint">Connect & tap mic to start speaking</div></div>
        <div id="ls-level-wrap"><div id="ls-level-bar"><div id="ls-level-fill"></div></div></div>
        <div id="ls-controls" style="margin-top:10px;">
          <button id="ls-mic-btn" class="disabled" onclick="window._lsVoice.toggleMic()">
            <span id="ls-mic-icon">🎤</span>
            <span id="ls-mic-label">Hold to Speak</span>
          </button>
          <button id="ls-clear-btn" onclick="window._lsVoice.clearTranscript()" title="Clear">🗑</button>
        </div>
      </div>
    </div>
    <button id="ls-fab" onclick="window._lsVoice.togglePanel()">
      <span id="ls-fab-icon">🎤</span>
      <div id="ls-fab-tooltip">AI Assistant</div>
    </button>
  `;

  // ── MAIN CLASS ──────────────────────────────────────────────────
  class LifesaverVoice {
    constructor(wsUrl) {
      this.wsUrl       = wsUrl || 'ws://10.111.187.209:8787';
      this.ws          = null;
      this.audioCtx    = null;
      this.mediaStream = null;
      this.workletNode = null;
      this.sourceNode  = null;
      this.isListening = false;
      this.isConnected = false;
      this.isSpeaking  = false;
      this.panelOpen   = false;
      this.messages    = [];

      // Playback
      this.playbackQueue  = [];
      this.isPlayingAudio = false;
      this.nextPlayTime   = 0;

      // Visualizer animation
      this.vizBars     = [];
      this.vizRms      = 0;
      this.vizAnimFrame = null;

      this._injectStyles();
      this._injectHTML();
      this._bindUI();
      this._startVizLoop();

      console.log('[LifesaverVoice] Widget initialised. Server:', this.wsUrl);
    }

    // ── INJECT UI ──────────────────────────────────────────────
    _injectStyles() {
      const s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    _injectHTML() {
      const wrap = document.createElement('div');
      wrap.id = 'ls-voice-widget';
      wrap.innerHTML = HTML;
      document.body.appendChild(wrap);
    }

    _bindUI() {
      this.vizBars = Array.from({length:20}, (_,i) => document.getElementById(`ls-bar-${i}`));
      document.getElementById('ls-ws-input').value = this.wsUrl;

      // Push-to-talk on mic button
      const micBtn = document.getElementById('ls-mic-btn');
      micBtn.addEventListener('mousedown',  () => this.isConnected && this._startListening());
      micBtn.addEventListener('mouseup',    () => this._stopListening());
      micBtn.addEventListener('mouseleave', () => this._stopListening());
      micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.isConnected && this._startListening(); });
      micBtn.addEventListener('touchend',   (e) => { e.preventDefault(); this._stopListening(); });
    }

    // ── PANEL TOGGLE ───────────────────────────────────────────
    togglePanel() {
      this.panelOpen = !this.panelOpen;
      const panel = document.getElementById('ls-voice-panel');
      const fab   = document.getElementById('ls-fab');
      const icon  = document.getElementById('ls-fab-icon');
      panel.classList.toggle('open', this.panelOpen);
      fab.classList.toggle('open',   this.panelOpen);
      icon.textContent = this.panelOpen ? '✕' : '🎤';
    }

    // ── WEBSOCKET ──────────────────────────────────────────────
    toggleConnect() {
      if (this.isConnected) {
        this._disconnect();
      } else {
        this.wsUrl = document.getElementById('ls-ws-input').value.trim();
        this._connect();
      }
    }

    _connect() {
      this._setStatus('connecting', 'Connecting…');
      document.getElementById('ls-connect-btn').textContent = 'Cancel';
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.isConnected = true;
          this._setStatus('connected', 'Connected — hold mic to speak');
          document.getElementById('ls-connect-btn').textContent = 'Disconnect';
          document.getElementById('ls-mic-btn').classList.remove('disabled');
          this._addMessage('system', '🟢 Connected to Lifesaver AI');
          console.log('[LifesaverVoice] WebSocket connected to', this.wsUrl);
        };

        this.ws.onmessage = (e) => this._handleMessage(e);

        this.ws.onerror = (err) => {
          console.error('[LifesaverVoice] WebSocket error', err);
          this._setStatus('', 'Connection error');
          this._addMessage('system', '⚠ Connection error. Check server IP.');
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this._stopListening();
          this._setStatus('', 'Disconnected');
          document.getElementById('ls-connect-btn').textContent = 'Connect';
          document.getElementById('ls-mic-btn').classList.add('disabled');
          this._addMessage('system', '⬛ Disconnected');
          console.log('[LifesaverVoice] WebSocket closed');
        };

      } catch(e) {
        this._setStatus('', 'Failed: ' + e.message);
        document.getElementById('ls-connect-btn').textContent = 'Connect';
      }
    }

    _disconnect() {
      if (this.ws) { this.ws.close(); this.ws = null; }
      this._stopListening();
    }

    // ── MESSAGE HANDLER ────────────────────────────────────────
    _handleMessage(event) {
      // Binary = PCM16 audio from server (AI speech)
      if (event.data instanceof ArrayBuffer) {
        this._enqueueAudio(event.data);
        return;
      }

      // Text = JSON control messages
      try {
        const msg = JSON.parse(event.data);
        console.log('[LifesaverVoice] Server msg:', msg);

        if (msg.type === 'transcript' || msg.transcript) {
          const text = msg.transcript || msg.text || '';
          if (text) this._addMessage('ai', text);
        }
        if (msg.type === 'user_transcript' || msg.user_transcript) {
          const text = msg.user_transcript || msg.text || '';
          if (text) this._addMessage('user', text);
        }
        if (msg.type === 'response.audio.delta') {
          // Some servers send base64 audio in JSON
          if (msg.delta) {
            const binary = this._base64ToArrayBuffer(msg.delta);
            this._enqueueAudio(binary);
          }
        }
        if (msg.type === 'response.text.delta' && msg.delta) {
          // Streaming text - create/append to last AI message
          this._appendToLastAI(msg.delta);
        }
        if (msg.type === 'session.created' || msg.type === 'ready') {
          this._addMessage('system', '✦ Session ready — speak your query');
        }
        if (msg.type === 'error') {
          this._addMessage('system', '⚠ ' + (msg.message || msg.error || 'Server error'));
        }
      } catch(e) {
        // Not JSON — might be text transcript
        if (typeof event.data === 'string' && event.data.length > 0) {
          this._addMessage('ai', event.data);
        }
      }
    }

    // ── AUDIO CAPTURE ──────────────────────────────────────────
    async _startListening() {
      if (this.isListening || !this.isConnected) return;

      try {
        // Get microphone
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });

        // Create audio context at 24kHz
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: SAMPLE_RATE,
          latencyHint: 'interactive',
        });

        // Load AudioWorklet from Blob
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        const url  = URL.createObjectURL(blob);
        await this.audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm16-processor');
        this.workletNode.port.onmessage = (e) => {
          if (e.data.pcm) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(e.data.pcm);
            }
          }
          if (e.data.rms !== undefined) {
            this.vizRms = e.data.rms;
            document.getElementById('ls-level-fill').style.width = Math.min(100, e.data.rms * 400) + '%';
          }
        };

        this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
        this.sourceNode.connect(this.workletNode);
        this.workletNode.connect(this.audioCtx.destination);

        this.isListening = true;
        this._setStatus('listening', 'Listening…');
        this._setMicUI(true);
        document.getElementById('ls-level-wrap').classList.add('show');

        console.log('[LifesaverVoice] Started capturing at', this.audioCtx.sampleRate, 'Hz');

      } catch(e) {
        console.error('[LifesaverVoice] Mic error:', e);
        this._addMessage('system', '⚠ Microphone error: ' + e.message);
        this._setStatus('connected', 'Mic denied — check permissions');
      }
    }

    _stopListening() {
      if (!this.isListening) return;
      this.isListening = false;

      // Disconnect audio graph
      if (this.workletNode) { this.workletNode.disconnect(); this.workletNode = null; }
      if (this.sourceNode)  { this.sourceNode.disconnect();  this.sourceNode  = null; }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
        this.mediaStream = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(()=>{});
        this.audioCtx = null;
      }

      this.vizRms = 0;
      document.getElementById('ls-level-fill').style.width = '0%';
      document.getElementById('ls-level-wrap').classList.remove('show');

      this._setStatus('connected', 'Processing…');
      this._setMicUI(false);
      console.log('[LifesaverVoice] Stopped capturing');
    }

    // ── AUDIO PLAYBACK ─────────────────────────────────────────
    _enqueueAudio(arrayBuffer) {
      this.playbackQueue.push(arrayBuffer);
      if (!this.isPlayingAudio) this._drainQueue();
    }

    async _drainQueue() {
      if (this.playbackQueue.length === 0) {
        this.isPlayingAudio = false;
        if (!this.isListening) this._setStatus('connected', 'Hold mic to speak');
        this._setSpeakingUI(false);
        return;
      }

      this.isPlayingAudio = true;
      this._setSpeakingUI(true);
      this._setStatus('speaking', 'AI speaking…');

      // Create playback context if needed
      if (!this.playCtx || this.playCtx.state === 'closed') {
        this.playCtx   = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
        this.nextPlayTime = this.playCtx.currentTime;
      }

      while (this.playbackQueue.length > 0) {
        const chunk = this.playbackQueue.shift();
        const pcm16 = new Int16Array(chunk);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
          float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
        }

        const buffer = this.playCtx.createBuffer(1, float32.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(float32);

        const src = this.playCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.playCtx.destination);

        const startAt = Math.max(this.playCtx.currentTime, this.nextPlayTime);
        src.start(startAt);
        this.nextPlayTime = startAt + buffer.duration;

        // Update visualizer with playback level
        this.vizRms = 0.05;

        // Wait for this chunk to finish before processing more
        await new Promise(r => src.onended = r);
        await new Promise(r => setTimeout(r, 10));
      }

      this.isPlayingAudio = false;
      this._setSpeakingUI(false);
      if (!this.isListening) this._setStatus('connected', 'Hold mic to speak');
      this.vizRms = 0;
    }

    // ── VISUALIZER ─────────────────────────────────────────────
    _startVizLoop() {
      const bars = () => {
        const rms  = this.vizRms;
        const time = Date.now() / 1000;
        this.vizBars.forEach((bar, i) => {
          const wave = Math.sin(time * 3 + i * 0.5) * 0.5 + 0.5;
          const h    = this.isListening || this.isSpeaking
            ? Math.max(3, (rms * 200 + wave * rms * 150) * (0.5 + Math.random() * 0.5))
            : 3 + wave * 3;
          bar.style.height = Math.min(40, h) + 'px';
          bar.className = 'ls-bar' +
            (this.isListening ? ' active'   : '') +
            (this.isSpeaking  ? ' speaking' : '');
        });
        this.vizAnimFrame = requestAnimationFrame(bars);
      };
      this.vizAnimFrame = requestAnimationFrame(bars);
    }

    // ── UI HELPERS ─────────────────────────────────────────────
    _setStatus(state, text) {
      const dot  = document.getElementById('ls-status-dot');
      const span = document.getElementById('ls-status-text');
      dot.className  = 'ls-status-dot' + (state ? ' ' + state : '');  // fixed: was wrong selector
      span.textContent = text;
      dot.id = 'ls-status-dot';
      dot.className = state ? state : '';
    }

    _setMicUI(on) {
      const btn   = document.getElementById('ls-mic-btn');
      const icon  = document.getElementById('ls-mic-icon');
      const label = document.getElementById('ls-mic-label');
      const fab   = document.getElementById('ls-fab');
      btn.classList.toggle('listening', on);
      fab.classList.toggle('listening', on);
      icon.textContent  = on ? '🔴' : '🎤';
      label.textContent = on ? 'Listening… (release to send)' : 'Hold to Speak';
    }

    _setSpeakingUI(on) {
      this.isSpeaking = on;
      const icon = document.getElementById('ls-fab-icon');
      if (!this.panelOpen) icon.textContent = on ? '🔊' : '🎤';
    }

    _addMessage(role, text) {
      // Remove empty hint
      const hint = document.getElementById('ls-empty-hint');
      if (hint) hint.remove();

      const box = document.getElementById('ls-transcript');
      const div = document.createElement('div');
      div.className = 'ls-msg ' + role;
      div.textContent = text;
      div.dataset.msgId = Date.now();
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      this.messages.push({ role, text, id: div.dataset.msgId });
    }

    _appendToLastAI(delta) {
      const box  = document.getElementById('ls-transcript');
      const msgs = box.querySelectorAll('.ls-msg.ai');
      if (msgs.length > 0) {
        msgs[msgs.length-1].textContent += delta;
      } else {
        this._addMessage('ai', delta);
      }
      box.scrollTop = box.scrollHeight;
    }

    clearTranscript() {
      document.getElementById('ls-transcript').innerHTML =
        '<div id="ls-empty-hint" style="color:#4A4A5E;font-size:11px;text-align:center;padding:16px 0;letter-spacing:0.06em;">Connect & tap mic to start speaking</div>';
      this.messages = [];
    }

    toggleMic() {
      // Fallback click handler (push-to-talk via mousedown is primary)
      if (this.isListening) {
        this._stopListening();
      } else if (this.isConnected) {
        this._startListening();
      }
    }

    // ── UTILS ──────────────────────────────────────────────────
    _base64ToArrayBuffer(b64) {
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
      return buf;
    }

    destroy() {
      this._disconnect();
      cancelAnimationFrame(this.vizAnimFrame);
      document.getElementById('ls-voice-widget')?.remove();
    }
  }

  // ── BOOT ────────────────────────────────────────────────────────
  // Auto-init when DOM is ready
  function init() {
    const wsUrl = window._lsVoiceUrl || 'ws://10.111.187.209:8787';
    window._lsVoice = new LifesaverVoice(wsUrl);
    console.log('[LifesaverVoice] Ready. Open the widget bottom-right ↘');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export for manual init
  window.LifesaverVoice = LifesaverVoice;
})();