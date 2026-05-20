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

        // Eliminar emojis de 4 bytes que truncan MySQL utf8 (3-byte)
        const clean = String(message || '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '').trim();

        // Límite conservador: 300 bytes (~150 chars en español)
        const MAX_BYTES = 1000; // Aumentado para permitir mensajes más completos por burbuja

        // Usamos _splitMessage directamente sobre el texto completo. 
        // Esto agrupará párrafos hasta llegar al límite de MAX_BYTES,
        // reduciendo drásticamente la cantidad de firmas "Envía: uno.cobol.com.co".
        const chunks = this._splitMessage(clean, MAX_BYTES);

        console.log(`📝 Procesando mensaje de ${this._byteLength(clean)} bytes.`);

        if (chunks.length === 1) {
            return await this._executeSend(recipient, chunks[0]);
        }

        console.log(`📦 El mensaje total se enviará en ${chunks.length} burbujas separadas.`);
        for (let i = 0; i < chunks.length; i++) {
            console.log(`   🔹 Preparando burbuja ${i + 1}/${chunks.length} (${this._byteLength(chunks[i])} bytes)`);
            await this._executeSend(recipient, chunks[i]);
            await new Promise(r => setTimeout(r, 1500));
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

    /**
     * División inteligente de 3 niveles respetando la estructura natural del texto de la IA:
     *   Nivel 1: Respeta párrafos separados por \n\n (como los genera Gemini)
     *   Nivel 2: Si un párrafo es muy largo, lo divide en oraciones (. ! ?)
     *   Nivel 3: Si una oración es muy larga, corta en la última palabra completa (byte-aware)
     */
    _splitMessage(text, maxBytes) {
        const chunks = [];
        // Nivel 1: Dividir por párrafos dobles (\n\n) 
        // Cada párrafo será intentado como una burbuja única para evitar saturar la API externa
        const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);

        for (const para of paragraphs) {
            if (this._byteLength(para) <= maxBytes) {
                // El párrafo cabe completo en una burbuja
                chunks.push(para);
            } else {
                // Nivel 2: El párrafo es demasiado largo, dividimos en oraciones
                const sentences = para.split(/(?<=[.!?])\s+/);
                let buffer = '';
                for (const sentence of sentences) {
                    const s = sentence.trim();
                    if (!s) continue;

                    if (this._byteLength(s) > maxBytes) {
                        // Nivel 3: La oración sola es demasiado larga, dividimos por palabras
                        if (buffer) { chunks.push(buffer); buffer = ''; }
                        const words = s.split(' ');
                        for (const word of words) {
                            const w = word.trim();
                            if (!w) continue;
                            const candidate = buffer ? buffer + ' ' + w : w;
                            if (this._byteLength(candidate) <= maxBytes) {
                                buffer = candidate;
                            } else {
                                if (buffer) chunks.push(buffer);
                                buffer = w;
                            }
                        }
                    } else {
                        const candidate = buffer ? buffer + ' ' + s : s;
                        if (this._byteLength(candidate) <= maxBytes) {
                            buffer = candidate;
                        } else {
                            chunks.push(buffer);
                            buffer = s;
                        }
                    }
                }
                if (buffer) chunks.push(buffer);
            }
        }
        return chunks;
    }
}

module.exports = WhatsAppService;