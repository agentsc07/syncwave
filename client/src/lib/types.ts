// Contract types from PROTOCOL.md (client side). Keep in sync with that file.

export type Channel = 'stereo' | 'left' | 'right' | 'center' | 'rear-left' | 'rear-right' | 'sub';

export interface Device {
  id: string;
  name: string;
  isHost: boolean;
  trimMs: number;
  channel: Channel;
  x: number;
  y: number; // 0..1 room map
  readyTrackId: string | null;
  offsetMs: number | null;
  driftMs: number | null;
  rtt: number | null;
  syncScore?: number | null; // 0..100 from the last auto-calibration
  lastSeen: number;
  connected: boolean;
}

export interface Track {
  id: string;
  name: string;
  sizeBytes: number;
  votes: number; voters?: string[];
  durationMs?: number;
}

export interface Playback {
  status: 'stopped' | 'scheduled' | 'playing' | 'paused';
  trackId: string | null;
  startServerTime: number | null; // S: server time at which track position 0 plays
  pausedPositionMs: number;
}

export interface LiveInfo {
  kind: 'share' | 'announce';
  sourceId: string;
  bufferMs: number;
}

export type CalibrationError = 'mic-denied' | 'insecure-context' | 'mic-error' | 'low-confidence' | 'cancelled' | 'host-left' | 'mic-timeout' | 'result-timeout';
export interface CalibrationResult { delayMs: number; score: number; error?: string; trimMs?: number }
export interface CalibrationState {
  status: 'idle' | 'running' | 'done' | 'failed';
  phase: 'idle' | 'arming' | 'step' | 'analysing' | 'done';
  runId: string | null;
  step: number; // current device index (0-based); == total while analysing; -1 while arming
  total: number;
  deviceId: string | null; // device playing now
  results: Record<string, CalibrationResult>;
  error: CalibrationError | string | null;
}

export interface RoomState {
  roomId: string;
  serverTime: number;
  devices: Device[];
  tracks: Track[];
  queue: string[];
  playback: Playback;
  volume: number;
  lights: boolean;
  live: LiveInfo | null;
  calibration?: CalibrationState;
  hostId: string;
}

// ---- WebSocket messages ----
export type ClientMessage =
  | { type: 'ping'; t0: number }
  | { type: 'join'; roomId: string; name: string; deviceId: string; hostToken?: string }
  | { type: 'ready'; trackId: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; positionMs: number }
  | { type: 'next' }
  | { type: 'volume'; value: number }
  | { type: 'setTrim'; deviceId: string; ms: number }
  | { type: 'setChannel'; deviceId: string; channel: Channel; x?: number; y?: number }
  | { type: 'lights'; on: boolean }
  | { type: 'kick'; deviceId: string }
  | { type: 'setTrack'; trackId: string }
  | { type: 'setTrimSelf'; ms: number }
  | { type: 'report'; offsetMs: number; driftMs: number; rtt: number }
  | { type: 'queueAdd'; trackId: string }
  | { type: 'queueVote'; trackId: string }
  | { type: 'liveStart'; kind: 'share' | 'announce'; bufferMs?: number }
  | { type: 'liveStop' }
  | { type: 'liveBuffer'; ms: number }
  | { type: 'calibrateStart' }
  | { type: 'calibrateCancel' }
  | { type: 'calibrateReady'; runId: string }
  | { type: 'calibrationResult'; runId: string; results?: Record<string, { delayMs: number; score: number; error?: string }>; error?: string }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'pong'; t0: number; t1: number; t2: number }
  | { type: 'joined'; deviceId: string; isHost: boolean }
  | { type: 'state' } & RoomState
  | { type: 'calibrateStep'; runId: string; step: number; total: number; deviceId: string; times: number[]; chirp: { f0: number; f1: number; durMs: number } }
  | { type: 'error'; message: string };

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
