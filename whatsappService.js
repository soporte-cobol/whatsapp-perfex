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

        // Límite generoso: 3500 bytes (~1750 chars en español)
        // Antes era 1000 bytes, lo que causaba fragmentación excesiva (8+ burbujas)
        const MAX_BYTES = 3500; 
        const MIN_CHUNK_BYTES = 10; // Mínimo de bytes para un fragmento de mensaje válido (evita "too short" errors)

        let rawChunks = this._splitMessage(clean, MAX_BYTES);
        let finalChunks = [];

        for (let i = 0; i < rawChunks.length; i++) {
            let currentChunk = rawChunks[i];
            // Si el chunk actual es muy corto y no es el primero, intenta fusionarlo con el anterior
            if (this._byteLength(currentChunk) < MIN_CHUNK_BYTES && finalChunks.length > 0) {
                let lastFinalChunk = finalChunks[finalChunks.length - 1];
                // Intentar combinar con un doble salto de línea para mantener la separación lógica
                let combinedChunk = lastFinalChunk + '\n\n' + currentChunk; 

                if (this._byteLength(combinedChunk) <= MAX_BYTES) {
                    finalChunks[finalChunks.length - 1] = combinedChunk;
                } else {
                    // Si no se puede fusionar sin exceder el límite, lo añadimos tal cual (podría fallar la API)
                    finalChunks.push(currentChunk);
                }
            } else if (this._byteLength(currentChunk) < MIN_CHUNK_BYTES && finalChunks.length === 0) {
                // Si es el primer chunk y es muy corto, lo añadimos tal cual (podría fallar la API)
                finalChunks.push(currentChunk);
            } else {
                // Chunk válido o no se necesita fusionar
                finalChunks.push(currentChunk);
            }
        }

        // Filtrar cualquier chunk que, después de los intentos de fusión, siga siendo demasiado corto
        finalChunks = finalChunks.filter(chunk => this._byteLength(chunk) >= MIN_CHUNK_BYTES);

        console.log(`📝 Procesando mensaje de ${this._byteLength(clean)} bytes.`);

        if (finalChunks.length === 0) {
            console.warn(`⚠️ No hay chunks válidos para enviar después de la división y filtrado por longitud mínima.`);
            return; // No hay nada que enviar
        }

        console.log(`📦 El mensaje total se enviará en ${finalChunks.length} burbujas separadas.`);
        for (let i = 0; i < finalChunks.length; i++) {
            console.log(`   🔹 Preparando burbuja ${i + 1}/${finalChunks.length} (${this._byteLength(finalChunks[i])} bytes)`);
            await this._executeSend(recipient, finalChunks[i]);
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