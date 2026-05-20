const axios = require('axios');
const FormData = require('form-data');

class WhatsAppService {
    constructor(secret, accountId) {
        this.secret = secret;
        this.accountId = accountId;
        this.baseUrl = 'https://uno.cobol.com.co/api';
    }

    async sendText(recipient, message) {
        if (!message) return;

        // Subimos a 400 para un mejor balance entre seguridad y fluidez
        const MAX_LENGTH = 400; 
        
        if (message.length > MAX_LENGTH) {
            const chunks = this._splitMessage(message, MAX_LENGTH);
            console.log(`📦 Fragmentando mensaje en ${chunks.length} partes...`);
            for (const chunk of chunks) {
                await this._executeSend(recipient, chunk);
                // Espera de 1.5s para asegurar orden y evitar spam filters
                await new Promise(r => setTimeout(r, 1500));
            }
        } else {
            return await this._executeSend(recipient, message);
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
            // Sanitizar mensaje removiendo emojis de 4 bytes (pares subrogados) para evitar truncamiento en la base de datos UTF-8 de Zender
            const sanitizedMessage = String(message || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
            form.append('message', sanitizedMessage);

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

    _splitMessage(text, limit) {
        const chunks = [];
        let current = text;
        while (current.length > limit) {
            // Buscamos un punto o un espacio para no cortar palabras
            let splitAt = current.lastIndexOf('. ', limit);
            
            if (splitAt !== -1) {
                // Si encontramos un punto seguido de espacio, cortamos incluyendo el punto (splitAt + 1)
                chunks.push(current.substring(0, splitAt + 1).trim());
                current = current.substring(splitAt + 1).trim();
            } else {
                splitAt = current.lastIndexOf(' ', limit);
                if (splitAt === -1) splitAt = limit;
                chunks.push(current.substring(0, splitAt).trim());
                current = current.substring(splitAt).trim();
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }
}

module.exports = WhatsAppService;