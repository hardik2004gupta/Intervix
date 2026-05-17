/**
 * AI Interview Coach — Enhanced Client
 *
 * Features:
 *  - Configurable bot nature / difficulty / interview type / focus areas
 *  - Live session timer
 *  - Question counter
 *  - Speaking indicator
 *  - Transcript export (.txt)
 *  - Toast notifications
 *  - Sidebar collapse
 *  - Config auto-save before each session
 */

import { PipecatClient, RTVIEvent } from '@pipecat-ai/client-js';
import {
  AVAILABLE_TRANSPORTS,
  DEFAULT_TRANSPORT,
  TRANSPORT_CONFIG,
  createTransport,
} from './config.js';

// ── Helpers ───────────────────────────────────────────────────

function fmtTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toast(msg, type = 'info', durationMs = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// ── Main class ────────────────────────────────────────────────

class InterviewCoachClient {
  constructor() {
    this.client = null;
    this.transportType = DEFAULT_TRANSPORT;
    this.isConnected = false;

    // Session state
    this._timerInterval = null;
    this._sessionSeconds = 0;
    this._questionCount = 0;
    this._maxQuestions = 8;
    this._transcript = [];   // { role, text, ts }
    this._sessionConfig = {};

    this._bindDOM();
    this._populateTransports();
    this._setupSidebar();
    this._setupCharCount();
    this._logEvent('app', 'Interview Coach initialized');
  }

  // ── DOM wiring ────────────────────────────────────────────

  _bindDOM() {
    this.$sidebar           = document.getElementById('sidebar');
    this.$sidebarToggle     = document.getElementById('sidebar-toggle');
    this.$transportSelect   = document.getElementById('transport-select');
    this.$botNature         = document.getElementById('bot-nature-select');
    this.$difficulty        = document.getElementById('difficulty-select');
    this.$interviewType     = document.getElementById('interview-type-select');
    this.$maxQ              = document.getElementById('max-questions-input');
    this.$roleName          = document.getElementById('role-name-input');
    this.$companyName       = document.getElementById('company-name-input');
    this.$focusAreas        = document.getElementById('focus-areas-input');
    this.$jd                = document.getElementById('jd-textarea');
    this.$charCount         = document.getElementById('char-count');

    this.$connectBtn        = document.getElementById('connect-btn');
    this.$sessionControls   = document.getElementById('session-controls');
    this.$micBtn            = document.getElementById('mic-btn');
    this.$micStatus         = document.getElementById('mic-status');
    this.$exportBtn         = document.getElementById('export-btn');
    this.$clearChatBtn      = document.getElementById('clear-chat-btn');

    this.$statusDot         = document.querySelector('.stat-dot');
    this.$statusText        = document.getElementById('status-text');
    this.$statTimer         = document.getElementById('stat-timer');
    this.$timerDisplay      = document.getElementById('timer-display');
    this.$statPhase         = document.getElementById('stat-phase');
    this.$phaseDisplay      = document.getElementById('phase-display');
    this.$statQuestions     = document.getElementById('stat-questions');
    this.$questionsDisplay  = document.getElementById('questions-display');

    this.$botVideoContainer = document.getElementById('bot-video-container');
    this.$speakingIndicator = document.getElementById('speaking-indicator');
    this.$avatarLabel       = document.getElementById('avatar-label');
    this.$conversationLog   = document.getElementById('conversation-log');
    this.$eventsLog         = document.getElementById('events-log');

    // Event listeners
    this.$connectBtn.addEventListener('click', () => {
      this.isConnected ? this._disconnect() : this._connect();
    });

    this.$micBtn.addEventListener('click', () => {
      if (!this.client) return;
      const newState = !this.client.isMicEnabled;
      this.client.enableMic(newState);
      this._updateMicButton(newState);
    });

    this.$exportBtn.addEventListener('click', () => this._exportTranscript());
    this.$clearChatBtn.addEventListener('click', () => this._clearChat());

    this.$transportSelect.addEventListener('change', (e) => {
      this.transportType = e.target.value;
      this._logEvent('transport', e.target.value);
    });
  }

  _populateTransports() {
    this.$transportSelect.innerHTML = '';
    AVAILABLE_TRANSPORTS.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t === 'smallwebrtc' ? 'SmallWebRTC (local)' : 'Daily (cloud)';
      this.$transportSelect.appendChild(opt);
    });
    this.transportType = DEFAULT_TRANSPORT;
    this.$transportSelect.value = DEFAULT_TRANSPORT;

    if (AVAILABLE_TRANSPORTS.length === 1) {
      this.$transportSelect.closest('.field-group').style.display = 'none';
    }
  }

  _setupSidebar() {
    this.$sidebarToggle.addEventListener('click', () => {
      this.$sidebar.classList.toggle('collapsed');
    });
  }

  _setupCharCount() {
    const update = () => {
      const n = this.$jd.value.length;
      this.$charCount.textContent = `${n} chars`;
      this.$charCount.style.color = n < 30 ? 'var(--danger)' : 'var(--text-muted)';
    };
    this.$jd.addEventListener('input', update);
    update();
  }

  // ── Config collection ─────────────────────────────────────

  _collectConfig() {
    const focusRaw = this.$focusAreas.value.trim();
    return {
      botNature:     this.$botNature.value,
      difficulty:    this.$difficulty.value,
      interviewType: this.$interviewType.value,
      maxQuestions:  parseInt(this.$maxQ.value, 10) || 8,
      roleName:      this.$roleName.value.trim(),
      companyName:   this.$companyName.value.trim(),
      focusAreas:    focusRaw ? focusRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
      jd:            this.$jd.value.trim(),
    };
  }

  _validate(config) {
    if (!config.jd) {
      toast('Job description is required.', 'error');
      this.$jd.focus();
      return false;
    }
    if (config.jd.length < 30) {
      toast('Job description must be at least 30 characters.', 'error');
      this.$jd.focus();
      return false;
    }
    return true;
  }

  // ── Connection lifecycle ──────────────────────────────────

  async _connect() {
    const config = this._collectConfig();
    if (!this._validate(config)) return;

    this._sessionConfig = config;
    this._maxQuestions = config.maxQuestions;
    this._questionCount = 0;
    this._transcript = [];

    this._setStatus('Saving config…', 'loading');
    this._logEvent('connect', `transport=${this.transportType}`);

    // Push config to server
    const configUrl =
      (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CONFIG_SERVER_URL) ||
      'http://localhost:7861';

    try {
      const res = await fetch(`${configUrl}/api/interview-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      const result = await res.json();
      this._logEvent('config-saved', result.message || 'OK');
    } catch (err) {
      this._logEvent('config-warn', `${err.message} — using server defaults`);
      toast(`Config save failed: ${err.message}`, 'warning');
      // non-fatal: continue
    }

    this._setStatus('Connecting…', 'loading');

    try {
      const transport = await createTransport(this.transportType);

      const self = this;

      this.client = new PipecatClient({
        transport,
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected:             () => self._onConnected(),
          onDisconnected:          () => self._onDisconnected(),
          onTransportStateChanged: (s) => self._logEvent('transport-state', s),
          onBotReady:              () => {
            self._logEvent('bot-ready', 'Bot is ready');
            self._setPhase('Introduction');
          },
          onUserTranscript: (data) => {
            if (data.final) {
              self._addChatMessage('user', data.text);
            }
          },
          onBotTranscript: (data) => {
            self._addChatMessage('bot', data.text);
            self._detectPhase(data.text);
          },
          onError: (err) => {
            self._logEvent('error', err.message);
            toast(`Error: ${err.message}`, 'error');
          },
          // Primary audio/video track handler (official callbacks API)
          onTrackStarted: (track, participant) => {
            self._logEvent('track-event', `kind=${track.kind} local=${participant?.local ?? 'n/a'} id=${track.id.slice(0,8)}`);
            if (participant?.local === true) return;
            if (track.kind === 'audio') self._attachBotAudio(track);
            else if (track.kind === 'video') self._setupVideo(track);
          },
          onTrackStopped: (track, participant) => {
            if (!participant?.local && track.kind === 'video') self._clearVideo();
          },
          onBotStartedSpeaking: () => {
            self.$speakingIndicator.classList.add('active');
            self._logEvent('bot-speaking', 'Bot started speaking');
            // Resume audio context if suspended (e.g. after page idle)
            const audioEl = document.getElementById('bot-audio-el');
            if (audioEl && audioEl.paused) {
              audioEl.play().catch(() => {});
            }
          },
          onBotStoppedSpeaking: () => {
            self.$speakingIndicator.classList.remove('active');
          },
        },
      });

      // Belt-and-suspenders: also listen via .on() in case callbacks miss it
      this._setupAudio();

      const connectParams = TRANSPORT_CONFIG[this.transportType];
      await this.client.connect(connectParams);

      // ── Native WebRTC track interception ─────────────────────────────────
      // RTVIEvent.TrackStarted and callbacks.onTrackStarted do NOT fire
      // reliably in @pipecat-ai/client-js v1.5.0 + SmallWebRTC.
      // Hook directly into the RTCPeerConnection instead — this always fires.
      this._hookNativeWebRTC();
    } catch (err) {
      this._logEvent('error', err.message);
      toast(`Connection failed: ${err.message}`, 'error');
      this._setStatus('Connection failed', 'error');
      console.error(err);
    }
  }

  async _disconnect() {
    if (this.client) {
      await this.client.disconnect();
    }
  }

  // ── Audio / video setup ───────────────────────────────────

  _hookNativeWebRTC() {
    // Walk every possible property path to find the RTCPeerConnection.
    // The SmallWebRTC transport stores it under different keys across versions.
    const transport = this.client?.transport;
    const pc = (
      transport?.peerConnection      ||   // most common
      transport?._peerConnection     ||
      transport?.pc                  ||
      transport?._pc                 ||
      transport?.connection?.pc      ||
      transport?.connection?._pc     ||
      transport?.connection?.peerConnection ||
      null
    );

    if (!pc) {
      this._logEvent('webrtc-warn', 'Could not find RTCPeerConnection — trying again in 500ms');
      // Retry once — the transport may not have set up the PC yet
      setTimeout(() => {
        const pc2 = (
          this.client?.transport?.peerConnection ||
          this.client?.transport?._peerConnection ||
          this.client?.transport?.pc ||
          this.client?.transport?.connection?.pc ||
          null
        );
        if (pc2) {
          this._attachPCTrackListener(pc2);
        } else {
          this._logEvent('webrtc-warn', 'RTCPeerConnection still not found after retry — audio may be silent');
        }
      }, 500);
      return;
    }

    this._attachPCTrackListener(pc);
  }

  _attachPCTrackListener(pc) {
    this._logEvent('webrtc-pc', `Found RTCPeerConnection (signalingState=${pc.signalingState})`);

    // Check for already-existing remote audio tracks (in case ontrack already fired)
    if (pc.getReceivers) {
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind === 'audio' && receiver.track.readyState === 'live') {
          this._logEvent('webrtc-track', 'Found existing live audio receiver — attaching now');
          this._attachBotAudio(receiver.track);
          return;
        }
      }
    }

    // Listen for new tracks
    const existingHandler = pc.ontrack;
    pc.ontrack = (evt) => {
      this._logEvent('webrtc-ontrack', `kind=${evt.track.kind} state=${evt.track.readyState} streams=${evt.streams.length}`);

      if (evt.track.kind === 'audio') {
        // Prefer the stream's audio track if available — it's already in a MediaStream
        if (evt.streams && evt.streams[0]) {
          const audioTracks = evt.streams[0].getAudioTracks();
          if (audioTracks.length > 0) {
            this._logEvent('webrtc-audio', 'Using stream audio track');
            this._attachBotAudio(audioTracks[0]);
          } else {
            this._attachBotAudio(evt.track);
          }
        } else {
          this._attachBotAudio(evt.track);
        }
      } else if (evt.track.kind === 'video') {
        this._setupVideo(evt.track);
      }

      // Call any existing handler too
      if (typeof existingHandler === 'function') existingHandler(evt);
    };

    this._logEvent('webrtc-pc', 'Native ontrack listener attached ✓');
  }

  // _attachBotAudio: called by both callbacks.onTrackStarted AND .on() fallback
  _attachBotAudio(track) {
    // Guard: skip local mic tracks
    if (track.kind !== 'audio') return;

    // Avoid re-attaching the same track
    if (this._attachedTrackId === track.id) {
      this._logEvent('audio-info', 'Same track already attached — skipping');
      return;
    }
    this._attachedTrackId = track.id;

    this._logEvent('audio-attached', `Track ${track.id.slice(0, 8)} — routing via Web Audio API`);

    // ── Web Audio API approach ───────────────────────────────────────────────
    // Bypasses Chrome's autoplay policy on <audio> elements entirely.
    // AudioContext created/resumed after a user gesture always runs immediately.
    try {
      // Reuse existing context if still running; create fresh otherwise
      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }

      const ctx = this._audioCtx;

      const doConnect = () => {
        // Disconnect any previous source node
        if (this._audioSource) {
          try { this._audioSource.disconnect(); } catch (_) {}
        }

        const stream = new MediaStream([track]);
        this._audioSource = ctx.createMediaStreamSource(stream);
        this._audioSource.connect(ctx.destination);

        this._logEvent('audio-ok', `Web Audio connected — ctx.state=${ctx.state} ✓`);

        // Also keep the <audio> element in sync as a fallback (muted so no double-play)
        const audioEl = document.getElementById('bot-audio-el');
        if (audioEl) {
          audioEl.srcObject = stream;
          audioEl.muted = true;  // Web Audio handles output; prevent doubling
          audioEl.play().catch(() => {});
        }
      };

      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          this._logEvent('audio-ctx', `AudioContext resumed — state=${ctx.state}`);
          doConnect();
        }).catch((err) => {
          this._logEvent('audio-ctx-error', `resume() failed: ${err.message}`);
          doConnect(); // try anyway
        });
      } else {
        doConnect();
      }

    } catch (err) {
      this._logEvent('audio-error', `Web Audio setup failed: ${err.message} — falling back to <audio>`);

      // Hard fallback: plain <audio> element
      const audioEl = document.getElementById('bot-audio-el');
      if (audioEl) {
        audioEl.srcObject = new MediaStream([track]);
        audioEl.muted = false;
        audioEl.volume = 1.0;
        audioEl.play().catch((e) => this._logEvent('audio-fallback-error', e.message));
      }
    }
  }

  _setupAudio() {
    // Fallback: .on() listener in case callbacks.onTrackStarted didn't fire
    this.client.on(RTVIEvent.TrackStarted, (track, participant) => {
      this._logEvent('on-track', `kind=${track.kind} local=${participant?.local ?? 'n/a'}`);
      if (participant?.local === true) return;
      if (track.kind === 'audio') this._attachBotAudio(track);
      else if (track.kind === 'video') this._setupVideo(track);
    });

    this.client.on(RTVIEvent.TrackStopped, (track, participant) => {
      if (!participant?.local && track.kind === 'video') this._clearVideo();
    });

    this.client.on(RTVIEvent.BotStartedSpeaking, () => {
      this.$speakingIndicator.classList.add('active');
    });
    this.client.on(RTVIEvent.BotStoppedSpeaking, () => {
      this.$speakingIndicator.classList.remove('active');
    });
  }

  _setupVideo(track) {
    this.$botVideoContainer.innerHTML = '';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    this.$botVideoContainer.appendChild(video);
  }

  _clearVideo() {
    const video = this.$botVideoContainer.querySelector('video');
    if (video?.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    this.$botVideoContainer.innerHTML = `
      <div class="avatar-placeholder">
        <div class="avatar-placeholder-icon">🤖</div>
        <div class="avatar-placeholder-text">Interviewer offline</div>
      </div>`;
  }

  // ── Connection state updates ──────────────────────────────

  _onConnected() {
    this.isConnected = true;
    this.$connectBtn.textContent = '⏹ End Interview';
    this.$connectBtn.classList.add('active');
    this.$sessionControls.style.display = 'flex';
    this.$micBtn.disabled = false;
    this.$transportSelect.disabled = true;
    this._updateMicButton(true);
    this._setStatus('Connected', 'connected');
    this._startTimer();
    this._showSessionStats();
    this._updateQCounter();
    this._logEvent('connected', 'Session started');

    // Clear placeholder
    const ph = this.$conversationLog.querySelector('.chat-placeholder');
    if (ph) ph.remove();
  }

  _onDisconnected() {
    this.isConnected = false;
    this.$connectBtn.innerHTML = '<span class="btn-icon">▶</span> Start Interview';
    this.$connectBtn.classList.remove('active');
    this.$micBtn.disabled = true;
    this.$transportSelect.disabled = false;
    this._updateMicButton(false);
    this._clearVideo();
    this._stopTimer();
    this._setStatus('Session ended', 'idle');
    this.$speakingIndicator.classList.remove('active');
    this._logEvent('disconnected', `Duration: ${fmtTime(this._sessionSeconds)}`);
    toast(`Interview ended — ${fmtTime(this._sessionSeconds)} elapsed`, 'info', 4000);

    // Clean up Web Audio
    this._attachedTrackId = null;
    if (this._audioSource) { try { this._audioSource.disconnect(); } catch (_) {} this._audioSource = null; }
    if (this._audioCtx)    { try { this._audioCtx.close(); }         catch (_) {} this._audioCtx = null; }

    // Auto-save transcript to server (fire & forget)
    this._pushTranscript();
  }

  // ── Timer ─────────────────────────────────────────────────

  _startTimer() {
    this._sessionSeconds = 0;
    this._timerInterval = setInterval(() => {
      this._sessionSeconds++;
      this.$timerDisplay.textContent = fmtTime(this._sessionSeconds);
    }, 1000);
  }

  _stopTimer() { clearInterval(this._timerInterval); }

  // ── UI helpers ────────────────────────────────────────────

  _setStatus(text, type = 'idle') {
    this.$statusText.textContent = text;
    this.$statusDot.className = 'stat-dot dot-' + type;
  }

  _showSessionStats() {
    this.$statTimer.style.display = 'flex';
    this.$statPhase.style.display = 'flex';
    this.$statQuestions.style.display = 'flex';
  }

  _setPhase(phase) {
    this.$phaseDisplay.textContent = phase;
  }

  _updateQCounter() {
    this.$questionsDisplay.textContent = `${this._questionCount} / ${this._maxQuestions}`;
  }

  _updateMicButton(enabled) {
    this.$micStatus.textContent = enabled ? 'Mic On' : 'Mic Off';
    this.$micBtn.classList.toggle('active', enabled);
  }

  _detectPhase(text) {
    const lower = text.toLowerCase();
    // Heuristic phase detection from bot text
    if (this._questionCount === 0 &&
        (lower.includes("introduce") || lower.includes("tell me about yourself"))) {
      this._setPhase('Introduction');
    } else if (
      lower.endsWith('?') ||
      lower.includes('can you') ||
      lower.includes('how would') ||
      lower.includes('describe a time')
    ) {
      this._questionCount++;
      this._updateQCounter();

      if (this._questionCount <= 2) this._setPhase('Introduction');
      else if (this._questionCount >= this._maxQuestions - 1) this._setPhase('Wrap-Up');
      else this._setPhase('Core Questions');
    }

    if (lower.includes('thank you') && (lower.includes('time') || lower.includes('best'))) {
      this._setPhase('Complete');
    }
  }

  // ── Chat messages ─────────────────────────────────────────

  _addChatMessage(role, text) {
    const ts = now();
    this._transcript.push({ role, text, ts });

    const wrapper = document.createElement('div');
    wrapper.className = `chat-msg ${role}`;

    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    roleEl.textContent = role === 'user' ? 'You' : 'Alex (AI)';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = ts;

    wrapper.append(roleEl, bubble, timeEl);
    this.$conversationLog.appendChild(wrapper);
    this.$conversationLog.scrollTop = this.$conversationLog.scrollHeight;
  }

  _clearChat() {
    this.$conversationLog.innerHTML = '';
    this._transcript = [];
    this._logEvent('chat', 'Cleared');
  }

  // ── Events log ────────────────────────────────────────────

  _logEvent(name, data) {
    const row = document.createElement('div');
    row.className = 'event-entry';

    const ts   = document.createElement('span'); ts.className = 'ts';    ts.textContent = now();
    const ename = document.createElement('span'); ename.className = 'ename'; ename.textContent = name;
    const edata = document.createElement('span'); edata.className = 'edata';
    edata.textContent = typeof data === 'string' ? data : JSON.stringify(data);

    row.append(ts, ename, edata);
    this.$eventsLog.appendChild(row);
    this.$eventsLog.scrollTop = this.$eventsLog.scrollHeight;
  }

  // ── Transcript export ─────────────────────────────────────

  _exportTranscript() {
    if (this._transcript.length === 0) {
      toast('No transcript to export yet.', 'warning');
      return;
    }

    const cfg = this._sessionConfig;
    const header = [
      '='.repeat(60),
      'AI INTERVIEW COACH — SESSION TRANSCRIPT',
      '='.repeat(60),
      `Role       : ${cfg.roleName || '—'}`,
      `Company    : ${cfg.companyName || '—'}`,
      `Type       : ${cfg.interviewType} | ${cfg.difficulty} level`,
      `Bot style  : ${cfg.botNature}`,
      `Duration   : ${fmtTime(this._sessionSeconds)}`,
      `Date       : ${new Date().toLocaleString()}`,
      '='.repeat(60),
      '',
    ].join('\n');

    const body = this._transcript
      .map((m) => `[${m.ts}] ${m.role === 'user' ? 'CANDIDATE' : 'INTERVIEWER (Alex)'}\n${m.text}\n`)
      .join('\n');

    const blob = new Blob([header + body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-transcript-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Transcript downloaded!');
  }

  // ── Server transcript push ────────────────────────────────

  async _pushTranscript() {
    if (this._transcript.length === 0) return;
    const configUrl =
      (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CONFIG_SERVER_URL) ||
      'http://localhost:7861';
    try {
      await fetch(`${configUrl}/api/session-transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          durationSeconds: this._sessionSeconds,
          config: this._sessionConfig,
          messages: this._transcript,
        }),
      });
      this._logEvent('transcript', `${this._transcript.length} messages saved to server`);
    } catch (e) {
      // non-fatal
      this._logEvent('transcript-warn', 'Could not push transcript to server');
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  new InterviewCoachClient();
});
