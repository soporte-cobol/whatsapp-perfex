const axios = require('axios');
const FormData = require('form-data');

class WhatsAppService {
    constructor(secret, accountId) {
        this.secret = secret;
        this.accountId = accountId;
        this.baseUrl = 'https://uno.cobol.com.co/api';
    }

    /**
     * Envía un mensaje de texto. Si es muy largo, lo fragmenta.
     */
    async sendText(recipient, message) {
        if (!message) return;

        // Si el mensaje es muy largo, lo dividimos por párrafos o puntos
        const MAX_LENGTH = 600; // Límite conservador para evitar recortes
        if (message.length > MAX_LENGTH) {
            const chunks = this._splitMessage(message, MAX_LENGTH);
            for (const chunk of chunks) {
                await this._executeSend(recipient, chunk);
                // Pequeña espera para que lleguen en orden
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            return await this._executeSend(recipient, message);
        }
    }

    async _executeSend(recipient, message) {
        try {
            const url = `${this.baseUrl}/send/whatsapp`;
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

            if (response.data && response.data.status === 200) {
                console.log(`✅ WhatsApp enviado a ${recipient}`);
                return true;
            } else {
                console.warn(`⚠️ Error API WhatsApp:`, response.data);
                return false;
            }
        } catch (error) {
            console.error(`❌ Fallo crítico WhatsApp:`, error.message);
            return false;
        }
    }

    _splitMessage(text, limit) {
        const chunks = [];
        let current = text;
        while (current.length > limit) {
            let splitAt = current.lastIndexOf('\n', limit);
            if (splitAt === -1) splitAt = current.lastIndexOf('. ', limit);
            if (splitAt === -1) splitAt = limit;
            
            chunks.push(current.substring(0, splitAt).trim());
            current = current.substring(splitAt).trim();
        }
        if (current) chunks.push(current);
        return chunks;
    }
}

module.exports = WhatsAppService;