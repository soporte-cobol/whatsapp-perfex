/**
 * Servicio para interactuar con la API de WhatsApp de Cobol
 */
const axios = require('axios');
const FormData = require('form-data');

class WhatsAppService {
    constructor(secret, accountId) {
        this.secret = secret;
        this.accountId = accountId;
        this.baseUrl = 'https://uno.cobol.com.co/api';
    }

    /**
     * Envía un mensaje de texto simple a un destinatario
     */
    async sendText(recipient, message) {
        const url = `${this.baseUrl}/send/whatsapp`;
        const form = new FormData();
        
        form.append('secret', this.secret);
        form.append('account', this.accountId);
        form.append('recipient', recipient);
        form.append('type', 'text');
        form.append('message', message);
        form.append('priority', 1); // Prioridad alta para respuestas de IA

        try {
            const response = await axios.post(url, form, {
                headers: form.getHeaders()
            });
            return response.data;
        } catch (error) {
            console.error('Error enviando mensaje de WhatsApp:', error.response?.data || error.message);
            throw error;
        }
    }
}

module.exports = WhatsAppService;