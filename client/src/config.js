/**
 * Pipecat transport configuration
 *
 * VITE_BOT_START_URL      — URL of the Pipecat bot start endpoint (default: http://localhost:7860/start)
 * VITE_BOT_START_PUBLIC_API_KEY — Optional bearer token for authenticated deployments
 * VITE_CONFIG_SERVER_URL  — URL of the config API server (default: http://localhost:7861)
 */

export const AVAILABLE_TRANSPORTS = ['daily', 'smallwebrtc'];

// SmallWebRTC works on all platforms including Windows.
// Switch to 'daily' only on Linux/macOS where daily-python is available.
export const DEFAULT_TRANSPORT = 'smallwebrtc';

const botStartUrl =
  import.meta.env.VITE_BOT_START_URL || 'http://localhost:7860/start';
const botStartPublicApiKey = import.meta.env.VITE_BOT_START_PUBLIC_API_KEY;

if (!import.meta.env.VITE_BOT_START_URL) {
  console.warn('[config] VITE_BOT_START_URL not set — using http://localhost:7860/start');
}

// ── Daily transport config ────────────────────────────────────
const dailyConfig = {
  endpoint: botStartUrl,
  requestData: {
    createDailyRoom: true,
    dailyRoomProperties: { start_video_off: true },
    transport: 'daily',
  },
};
if (botStartPublicApiKey) {
  dailyConfig.headers = new Headers({ Authorization: `Bearer ${botStartPublicApiKey}` });
}

// ── SmallWebRTC transport config ──────────────────────────────
const smallWebRTCConfig = {
  endpoint: botStartUrl,
  requestData: {
    createDailyRoom: false,
    enableDefaultIceServers: true,
    transport: 'webrtc',
  },
};
if (botStartPublicApiKey) {
  smallWebRTCConfig.headers = new Headers({ Authorization: `Bearer ${botStartPublicApiKey}` });
}

export const TRANSPORT_CONFIG = {
  daily: dailyConfig,
  smallwebrtc: smallWebRTCConfig,
};

/**
 * Dynamically import and instantiate the correct transport class.
 */
export async function createTransport(transportType) {
  switch (transportType) {
    case 'daily': {
      const { DailyTransport } = await import('@pipecat-ai/daily-transport');
      return new DailyTransport();
    }
    case 'smallwebrtc': {
      const { SmallWebRTCTransport } = await import('@pipecat-ai/small-webrtc-transport');
      return new SmallWebRTCTransport();
    }
    default:
      throw new Error(`Unknown transport: ${transportType}`);
  }
}
