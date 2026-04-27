// Global configuration for Mongtro
const configModes = {
  development: {
    defaultApiBaseUrl: 'https://localhost:6291'
  },
  production: {
    defaultApiBaseUrl: 'https://autobid.duckdns.org:6291'
  }
};

// Determine environment - default to development
// This will be replaced by CI/CD script for production builds
const currentConfig = configModes['production'];

class Config {
  constructor() {
    this.defaultApiBaseUrl = currentConfig.defaultApiBaseUrl;
    this.apiBaseUrl = null;
  }

  async getApiBaseUrl() {
    if (this.apiBaseUrl) {
      return this.apiBaseUrl;
    }

    // Try to get from Chrome storage
    return new Promise((resolve) => {
      chrome.storage.local.get(['apiBaseUrl'], (result) => {
        if (result.apiBaseUrl) {
          this.apiBaseUrl = result.apiBaseUrl;
          resolve(result.apiBaseUrl);
        } else {
          // Use default if not configured
          this.apiBaseUrl = this.defaultApiBaseUrl;
          resolve(this.defaultApiBaseUrl);
        }
      });
    });
  }

  async setApiBaseUrl(url) {
    this.apiBaseUrl = url;
    await chrome.storage.local.set({ apiBaseUrl: url });
  }

  getDefaultApiBaseUrl() {
    return this.defaultApiBaseUrl;
  }
}

// Create a global instance
const config = new Config();

