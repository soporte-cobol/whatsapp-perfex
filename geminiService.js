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
        if (!cleanPrompt) return null;

        const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;

        try {
            const response = await axios.post(
                url,
                {
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: cleanPrompt }]
                        }
                    ]
                },
                {
                    params: { key: this.apiKey },
                    timeout: 12000
                }
            );

            const parts = response?.data?.candidates?.[0]?.content?.parts;
            const text = Array.isArray(parts)
                ? parts.map((p) => p?.text).filter(Boolean).join('\n').trim()
                : '';
            return text || null;
        } catch (error) {
            // Dejar que el caller haga fallback; exponemos un error legible.
            const details = error.response?.data?.error?.message || error.response?.data || error.message;
            const err = new Error(`Gemini generateContent failed: ${typeof details === 'string' ? details : JSON.stringify(details)}`);
            err.cause = error;
            throw err;
        }
    }
}

module.exports = GeminiService;
