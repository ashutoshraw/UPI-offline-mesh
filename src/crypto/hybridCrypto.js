'use strict';

/**
 * Hybrid encryption: RSA-OAEP(SHA-256) wraps a fresh AES-256 key,
 * AES-256-GCM encrypts the actual JSON payload.
 *
 * Wire format (all concatenated, then base64-encoded as `ciphertext`):
 *   [256 bytes RSA-encrypted AES key][12 bytes IV][AES ciphertext + 16-byte GCM tag]
 *
 * This mirrors HybridCryptoService.java from the original Spring Boot project,
 * so the on-the-wire shape is identical even though the language changed.
 */

const crypto = require('crypto');

const RSA_KEY_SIZE_BYTES = 256; // 2048-bit key -> 256-byte modulus
const IV_LENGTH = 12; // GCM standard IV length
const AUTH_TAG_LENGTH = 16; // GCM standard tag length

class HybridCryptoService {
  constructor(keyPair) {
    this.publicKey = keyPair.publicKey; // KeyObject
    this.privateKey = keyPair.privateKey; // KeyObject
  }

  /** Generates a fresh RSA-2048 keypair, exactly like ServerKeyHolder.java does on startup. */
  static generateServerKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048
    });
    return new HybridCryptoService({ publicKey, privateKey });
  }

  /** Base64 SPKI-encoded public key, for the /api/server-key endpoint. */
  getPublicKeyBase64() {
    return this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  /**
   * Encrypts a plain JS object (e.g. a PaymentInstruction) and returns a base64 string
   * suitable for MeshPacket.ciphertext.
   */
  encrypt(payloadObject) {
    const plaintext = Buffer.from(JSON.stringify(payloadObject), 'utf8');

    const aesKey = crypto.randomBytes(32); // AES-256
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv, {
      authTagLength: AUTH_TAG_LENGTH
    });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const rsaEncryptedKey = crypto.publicEncrypt(
      {
        key: this.publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      aesKey
    );

    const wire = Buffer.concat([rsaEncryptedKey, iv, encrypted, authTag]);
    return wire.toString('base64');
  }

  /**
   * Decrypts a base64 ciphertext string back into the original JS object.
   * Throws if the RSA unwrap fails or the GCM tag doesn't verify (tampering).
   */
  decrypt(ciphertextBase64) {
    const wire = Buffer.from(ciphertextBase64, 'base64');

    if (wire.length < RSA_KEY_SIZE_BYTES + IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Ciphertext too short to be a valid packet');
    }

    const rsaEncryptedKey = wire.subarray(0, RSA_KEY_SIZE_BYTES);
    const iv = wire.subarray(RSA_KEY_SIZE_BYTES, RSA_KEY_SIZE_BYTES + IV_LENGTH);
    const rest = wire.subarray(RSA_KEY_SIZE_BYTES + IV_LENGTH);
    const authTag = rest.subarray(rest.length - AUTH_TAG_LENGTH);
    const encrypted = rest.subarray(0, rest.length - AUTH_TAG_LENGTH);

    const aesKey = crypto.privateDecrypt(
      {
        key: this.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      rsaEncryptedKey
    );

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv, {
      authTagLength: AUTH_TAG_LENGTH
    });
    decipher.setAuthTag(authTag);

    // Throws "Unsupported state or unable to authenticate data" if tampered.
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  /** SHA-256 hash of the raw ciphertext bytes, used as the idempotency key. */
  static hashCiphertext(ciphertextBase64) {
    const bytes = Buffer.from(ciphertextBase64, 'base64');
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }
}

module.exports = { HybridCryptoService };
