// Shared encryption/decryption utilities using Web Crypto API

const CRYPTO_CONFIG = {
  salt: 'autobidder-salt-2024',
  iterations: 100000,
  algorithm: 'AES-GCM',
  keyLength: 256
};

/** Fixed key material for extension local storage (JWT removed). Not secret from anyone with the source. */
function getExtensionStorageKeyMaterial() {
  return 'mongtro-ext-local-storage-v1'.substring(0, 32).padEnd(32, '0');
}

/**
 * Encrypts text using Web Crypto API with a token as key material
 * @param {string} text - Text to encrypt
 * @param {string} token - Token to use as key material
 * @returns {Promise<string>} Base64-encoded encrypted text (IV + encrypted data)
 */
async function encrypt(text, token) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    
    // Use token as key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(token.substring(0, 32).padEnd(32, '0')),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );
    
    const salt = encoder.encode(CRYPTO_CONFIG.salt);
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: CRYPTO_CONFIG.iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: CRYPTO_CONFIG.algorithm, length: CRYPTO_CONFIG.keyLength },
      false,
      ['encrypt']
    );
    
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: CRYPTO_CONFIG.algorithm, iv: iv },
      key,
      data
    );
    
    // Combine IV and encrypted data, then encode as base64
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    
    return btoa(String.fromCharCode(...combined));
  } catch (error) {
    console.error('[CRYPTO] Encryption error:', error);
    // Fallback to base64 encoding if crypto API fails
    return btoa(unescape(encodeURIComponent(text)));
  }
}

/**
 * Decrypts encrypted text using Web Crypto API
 * @param {string} encryptedText - Base64-encoded encrypted text (IV + encrypted data)
 * @param {string} token - Token to use as key material
 * @returns {Promise<string>} Decrypted text
 */
async function decrypt(encryptedText, token) {
  try {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    const combined = new Uint8Array(
      atob(encryptedText)
        .split('')
        .map(c => c.charCodeAt(0))
    );
    
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    
    if (!token) {
      // If no token, try base64 decode as fallback
      return decodeURIComponent(escape(atob(encryptedText)));
    }
    
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(token.substring(0, 32).padEnd(32, '0')),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );
    
    const salt = encoder.encode(CRYPTO_CONFIG.salt);
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: CRYPTO_CONFIG.iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: CRYPTO_CONFIG.algorithm, length: CRYPTO_CONFIG.keyLength },
      false,
      ['decrypt']
    );
    
    const decrypted = await crypto.subtle.decrypt(
      { name: CRYPTO_CONFIG.algorithm, iv: iv },
      key,
      encrypted
    );
    
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('[CRYPTO] Decryption error:', error);
    // Fallback to base64 decoding if crypto API fails
    try {
      return decodeURIComponent(escape(atob(encryptedText)));
    } catch (e) {
      return encryptedText; // Return as-is if decryption fails
    }
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { encrypt, decrypt, getExtensionStorageKeyMaterial };
}

// Expose globally for browser extension context
if (typeof window !== 'undefined') {
  window.encrypt = encrypt;
  window.decrypt = decrypt;
  window.getExtensionStorageKeyMaterial = getExtensionStorageKeyMaterial;
}
