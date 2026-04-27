// Application-wide constants

const CONSTANTS = {
  // AI Models
  DEFAULT_MODEL: 'gpt-4o-mini',
  DEFAULT_SEARCH_MODEL: 'gpt-4o-mini-search-preview-2025-03-11',
  WHISPER_MODEL: 'whisper-1',
  
  // API Endpoints
  OPENAI_API_BASE: 'https://api.openai.com/v1',
  OPENAI_CHAT_ENDPOINT: '/chat/completions',
  OPENAI_TRANSCRIPTION_ENDPOINT: '/audio/transcriptions',
  
  // Audio Configuration
  AUDIO_CHUNK_DURATION: 8000, // 8 seconds in milliseconds
  MIN_CHUNK_SIZE: 5000, // Minimum 5KB for audio chunks
  AUDIO_BITS_PER_SECOND: 128000, // 128 kbps
  TARGET_SAMPLE_RATE: 16000, // 16kHz for Whisper
  TARGET_CHANNELS: 1, // Mono
  
  // Silence Detection
  SILENCE_THRESHOLD: 0.05, // 0-0.5 scale
  SILENCE_DURATION: 0.3, // seconds
  MIN_CHUNK_DURATION: 10, // seconds
  COMPRESSION_RATIO: 9,
  
  // Caption Monitoring
  CAPTION_MONITORING_INTERVAL: 300, // milliseconds
  
  // Chat History
  MAX_CAPTIONS: 100,
  MAX_TRANSCRIPTS_TO_SAVE: 200,
  CHAT_HISTORY_SAVE_INTERVAL_MS: 10000, // 10 seconds
  
  // Context Windows
  RECENT_CONTEXT_SECONDS: 30,
  RECENT_CONTEXT_MINUTES: 0.5, // 30 seconds / 60
  
  // UI Settings
  DEFAULT_FONT_SIZE: 16,
  MIN_FONT_SIZE: 12,
  MAX_FONT_SIZE: 24,
  DEFAULT_OPACITY: 0.7,
  MIN_OPACITY: 0.3,
  MAX_OPACITY: 1.0,
  
  // Window Constraints
  MIN_WINDOW_WIDTH: 400,
  MIN_WINDOW_HEIGHT: 300,
  PANEL_WIDTH: 300,
  
  // Storage Keys
  STORAGE_KEYS: {
    TOKEN: 'token',
    OPENAI_API_KEY: 'openaiApiKey',
    CUSTOM_OPENAI_API_KEY: 'customOpenaiApiKey',
    CURRENT_SESSION: 'currentSession',
    API_BASE_URL: 'apiBaseUrl',
    WINDOW_OPACITY: 'windowOpacity',
    FONT_SIZE: 'fontSize',
    BULLET_MODE: 'bulletMode',
    DETAIL_MODE: 'detailMode',
    SIDEBAR_VISIBLE: 'sidebarVisible',
    WEB_SEARCH_ENABLED: 'webSearchEnabled'
  },
  
  // MIME Types (priority order)
  AUDIO_MIME_TYPES: [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
    ''
  ],
  
  // Whisper Retry Configuration
  WHISPER_SERVICE_MAX_RETRIES: 20,
  WHISPER_SERVICE_INITIAL_DELAY: 100, // milliseconds
  WHISPER_SERVICE_MAX_DELAY: 2000 // milliseconds
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONSTANTS;
}

// Expose globally for browser extension context
if (typeof window !== 'undefined') {
  window.CONSTANTS = CONSTANTS;
}
