/**
 * Servicio mínimo para generar respuestas con Gemini (Google Generative Language API).
 *
 * Nota:
 * - Este proyecto ya usa axios; evitamos dependencias nuevas.
 * - Si no hay API key configurada, el servicio retorna null para permitir fallback.
 */
const axios = require('axios');

class GeminiService {
    constructor(apiKey, model) {
        this.apiKey = String(apiKey || '').trim();
        this.model = String(model || '').trim() || 'gemini-1.5-flash';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey);
    }

    /**
     * Genera texto con un prompt.
     * @returns {Promise<string|null>}
     */
    async generateText(prompt) {
        if (!this.isReady()) return null;
        const cleanPrompt = String(prompt || '').trim();
        if (!cleanPrompt) {
            console.error('⚠️ Intento de generar texto con prompt vacío.');
            return null;
        }

        const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;

        try {
            const requestBody = {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: cleanPrompt }]
                    }
                ]
            };

            const response = await axios.post(
                url,
                requestBody,
                {
                    params: { key: this.apiKey },
                    timeout: 15000 // Aumentado a 15s para mayor tolerancia
                }
            );

            const parts = response?.data?.candidates?.[0]?.content?.parts;
            const text = Array.isArray(parts)
                ? parts.map((p) => p?.text).filter(Boolean).join('\n').trim()
                : '';
            
            if (!text) {
                console.warn('⚠️ Gemini devolvió una respuesta vacía.');
            }
            
            return text || null;
        } catch (error) {
            const details = error.response?.data?.error?.message || error.response?.data || error.message;
            console.error('❌ Error en Gemini API:', details);
            
            // Si el error es específicamente el de "at least one part", logueamos qué intentamos enviar
            if (String(details).includes('at least one part')) {
                console.error('DEBUG - Prompt que causó el error:', cleanPrompt);
            }

            const err = new Error(`Gemini failed: ${typeof details === 'string' ? details : JSON.stringify(details)}`);
            err.cause = error;
            throw err;
        }
    }
}

module.exports = GeminiService;
