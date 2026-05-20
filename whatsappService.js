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
        for (const chunk of chunks) {
            await this._executeSend(recipient, chunk);
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
        const paragraphs = text.split(/\n\n+/);

        let buffer = '';

        for (const para of paragraphs) {
            const trimmed = para.trim();
            if (!trimmed) continue;

            const candidate = buffer ? buffer + '\n\n' + trimmed : trimmed;

            if (this._byteLength(candidate) <= maxBytes) {
                // El párrafo cabe junto con el buffer actual
                buffer = candidate;
            } else {
                // Volcar el buffer actual como chunk
                if (buffer) {
                    chunks.push(buffer);
                    buffer = '';
                }

                // ¿El párrafo solo cabe en un chunk?
                if (this._byteLength(trimmed) <= maxBytes) {
                    buffer = trimmed;
                } else {
                    // Nivel 2: Dividir el párrafo en oraciones
                    const sentences = trimmed.split(/(?<=[.!?])\s+/);
                    for (const sentence of sentences) {
                        const s = sentence.trim();
                        if (!s) continue;

                        const sentCandidate = buffer ? buffer + ' ' + s : s;

                        if (this._byteLength(sentCandidate) <= maxBytes) {
                            buffer = sentCandidate;
                        } else {
                            if (buffer) {
                                chunks.push(buffer);
                                buffer = '';
                            }

                            if (this._byteLength(s) <= maxBytes) {
                                buffer = s;
                            } else {
                                // Nivel 3: Corte por bytes contando palabra a palabra
                                const words = s.split(' ');
                                for (const word of words) {
                                    const w = word.trim();
                                    if (!w) continue;
                                    const wCandidate = buffer ? buffer + ' ' + w : w;
                                    if (this._byteLength(wCandidate) <= maxBytes) {
                                        buffer = wCandidate;
                                    } else {
                                        if (buffer) chunks.push(buffer);
                                        buffer = w;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (buffer) chunks.push(buffer);
        return chunks;
    }
}

module.exports = WhatsAppService;