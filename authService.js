/**
 * API helper for the extension (no JWT — server uses authOrDefaultUser for extension routes).
 */
class AuthService {
  constructor() {
    this.apiBaseUrl = null;
    this.currentUser = null;
  }

  async getApiBaseUrl() {
    if (!this.apiBaseUrl) {
      this.apiBaseUrl = await config.getApiBaseUrl();
    }
    return this.apiBaseUrl;
  }

  extensionCryptoKey() {
    if (typeof getExtensionStorageKeyMaterial === 'function') {
      return getExtensionStorageKeyMaterial();
    }
    return 'mongtro-ext-local-storage-v1'.padEnd(32, '0').substring(0, 32);
  }

  async getCurrentUser() {
    if (this.currentUser) {
      return this.currentUser;
    }
    try {
      const apiBaseUrl = await this.getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/api/auth/user`);
      if (!response.ok) {
        return null;
      }
      this.currentUser = await response.json();
      return this.currentUser;
    } catch (error) {
      console.error('Error getting current user:', error);
      return null;
    }
  }

  async fetchAndStoreApiKeys() {
    try {
      const apiBaseUrl = await this.getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/api/users/api-keys`);

      if (!response.ok) {
        if (response.status === 404) {
          console.log('API keys endpoint not available yet');
          return;
        }
        throw new Error('Failed to fetch API keys');
      }

      const apiKeys = await response.json();
      const keyMat = this.extensionCryptoKey();

      if (apiKeys.openaiApiKey) {
        const encryptedOpenAI =
          typeof encrypt === 'function'
            ? await encrypt(apiKeys.openaiApiKey, keyMat)
            : await this.encrypt(apiKeys.openaiApiKey, keyMat);
        await chrome.storage.local.set({ openaiApiKey: encryptedOpenAI });
      }

      console.log('API keys fetched and stored successfully');
    } catch (error) {
      console.error('Error fetching API keys:', error);
    }
  }

  async encrypt(text, keyMaterial) {
    if (typeof encrypt === 'function') {
      return await encrypt(text, keyMaterial);
    }
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(text);
      const raw = encoder.encode(keyMaterial.substring(0, 32).padEnd(32, '0'));
      const keyMaterialKey = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
      );
      const salt = encoder.encode('autobidder-salt-2024');
      const key = await crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt,
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterialKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);
      return btoa(String.fromCharCode(...combined));
    } catch (error) {
      console.error('[AUTHSERVICE] Encryption error:', error);
      return btoa(unescape(encodeURIComponent(text)));
    }
  }

  /** Clears local session and cached keys (does not log in — there is no login). */
  async clearLocalSession() {
    this.currentUser = null;
    await chrome.storage.local.remove(['currentSession', 'openaiApiKey']);
  }

  getUserId() {
    return this.currentUser?.id || this.currentUser?._id;
  }

  /**
   * Full resume document from GET /api/resumes/:id (canonical server shape for the assistant).
   */
  normalizeResumeContent(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.content && typeof record.content === 'object') {
      return record.content;
    }
    return {
      name: record.name,
      email: record.email,
      phone: record.phone,
      personal_info: record.personal_info,
      experience: record.experience,
      education: record.education,
      skillset: record.skillset,
      rawText: record.rawText
    };
  }

  resumeBodyLooksUsable(resumeContent) {
    const rc = resumeContent;
    if (!rc || typeof rc !== 'object') return false;
    return !!(
      (rc.name && String(rc.name).trim()) ||
      (rc.email && String(rc.email).trim()) ||
      (rc.phone && String(rc.phone).trim()) ||
      (rc.rawText && String(rc.rawText).trim()) ||
      (rc.personal_info && typeof rc.personal_info === 'object' && Object.keys(rc.personal_info).length) ||
      (Array.isArray(rc.experience) && rc.experience.length) ||
      (Array.isArray(rc.education) && rc.education.length) ||
      (Array.isArray(rc.skillset) && rc.skillset.length)
    );
  }

  async fetchResumeById(resumeId) {
    if (!resumeId) return null;
    try {
      const apiBaseUrl = await this.getApiBaseUrl();
      const response = await fetch(
        `${apiBaseUrl}/api/resumes/${encodeURIComponent(String(resumeId))}`
      );
      if (!response.ok) {
        console.error('[AUTHSERVICE] fetchResumeById failed:', response.status);
        return null;
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching resume by id:', error);
      return null;
    }
  }

  async fetchResumes() {
    try {
      const apiBaseUrl = await this.getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/api/resumes`);

      if (!response.ok) {
        throw new Error('Failed to fetch resumes');
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching resumes:', error);
      return [];
    }
  }
}
