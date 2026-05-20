const axios = require('axios');
const FormData = require('form-data');

class WhatsAppService {
    constructor(secret, accountId) {
        this.secret = secret;
        this.accountId = accountId;
        this.baseUrl = 'https://uno.cobol.com.co/api';
    }

    // Calcula el tamaño en bytes UTF-8 de un string (como lo cuenta la base de datos MySQL utf8)
    _byteLength(str) {
        return Buffer.byteLength(str, 'utf8');
    }

    async sendText(recipient, message) {
        if (!message) return;

        // 1. Sanitizar PRIMERO (antes de dividir) para que los chunks se calculen sobre texto limpio
        //    Eliminar emojis de 4 bytes (pares subrogados) que truncan bases de datos MySQL utf8 (3-byte)
        const clean = String(message || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();

        // 2. Límite en BYTES (no en chars) para respetar el límite del gateway de Zender.
        //    160 bytes es el estándar seguro: cubre ~80 chars españoles acentuados o ~160 chars ASCII.
        const MAX_BYTES = 160;

        if (this._byteLength(clean) > MAX_BYTES) {
            const chunks = this._splitMessage(clean, MAX_BYTES);
            console.log(`📦 Fragmentando mensaje en ${chunks.length} partes...`);
            for (const chunk of chunks) {
                await this._executeSend(recipient, chunk);
                // Espera de 1.5s para asegurar orden y evitar spam filters
                await new Promise(r => setTimeout(r, 1500));
            }
        } else {
            return await this._executeSend(recipient, clean);
        }
    }

    async _executeSend(recipient, message) {
        try {
            const url = `${this.baseUrl}/send/whatsapp`;

            // Log de depuración seguro para verificar credenciales
            const secretStr = String(this.secret || '');
            const accountStr = String(this.accountId || '');
            const maskedSecret = secretStr ? `${secretStr.substring(0, 4)}...${secretStr.substring(Math.max(0, secretStr.length - 4))}` : 'UNDEFINED';
            const maskedAccount = accountStr ? `${accountStr.substring(0, 8)}...${accountStr.substring(Math.max(0, accountStr.length - 8))}` : 'UNDEFINED';
            console.log(`📤 Enviando fragmento a ${recipient} | Credenciales en uso: Account=[${maskedAccount}], Secret=[${maskedSecret}]`);

            const form = new FormData();
            form.append('secret', this.secret);
            form.append('account', this.accountId);
            form.append('recipient', recipient);
            form.append('type', 'text');
            form.append('message', message);

            const response = await axios.post(url, form, {
                headers: form.getHeaders(),
                timeout: 10000
            });

            if (response.data && (response.data.status === 200 || response.data.status === 'success')) {
                console.log(`✅ Parte enviada a ${recipient}`);
                return true;
            } else {
                console.warn(`⚠️ Respuesta API WhatsApp:`, response.data);
                return false;
            }
        } catch (error) {
            console.error(`❌ Error envío WhatsApp:`, error.message);
            return false;
        }
    }

    // Divide el texto en chunks respetando límite en BYTES (no en chars JS)
    // Corta siempre en oraciones completas o palabras, nunca a mitad de palabra
    _splitMessage(text, maxBytes) {
        const chunks = [];
        let current = text.trim();

        while (this._byteLength(current) > maxBytes) {
            // Intentar cortar en el último punto seguido de espacio dentro del límite de bytes
            let splitAt = -1;
            let probe = 0;
            let lastPeriod = -1;
            let lastSpace = -1;

            // Recorrer caracter por caracter contando bytes reales
            for (let i = 0; i < current.length; i++) {
                const charBytes = Buffer.byteLength(current[i], 'utf8');
                if (probe + charBytes > maxBytes) break;
                probe += charBytes;
                if (current[i] === '.' && i + 1 < current.length && current[i + 1] === ' ') lastPeriod = i;
                if (current[i] === ' ') lastSpace = i;
            }

            if (lastPeriod !== -1) {
                splitAt = lastPeriod + 1; // incluir el punto
            } else if (lastSpace !== -1) {
                splitAt = lastSpace;
            } else {
                // Sin espacio ni punto, cortar en el último byte seguro
                splitAt = probe;
            }

            chunks.push(current.substring(0, splitAt).trim());
            current = current.substring(splitAt).trim();
        }

        if (current) chunks.push(current);
        return chunks;
    }
}

module.exports = WhatsAppService;