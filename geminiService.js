const axios = require('axios');

class GeminiService {
    constructor(apiKey, model) {
        this.apiKey = String(apiKey || '').trim();
        // El 1.5-flash es el más estable y rápido para WhatsApp
        this.model = 'gemini-1.5-flash';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey) && this.apiKey.length > 20;
    }

    async generateText(prompt) {
        if (!this.isReady()) return null;
        
        const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

        try {
            const requestBody = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 800, // Ajustado para evitar respuestas infinitas
                }
            };

            const response = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                return response.data.candidates[0].content.parts[0].text.trim();
            }
            return null;
        } catch (error) {
            const errorBody = error.response?.data?.error?.message || error.message;
            console.error(`❌ ERROR GEMINI [${this.model}]:`, errorBody);
            
            // Fallback al 1.5-pro si el flash falla
            if (this.model === 'gemini-1.5-flash') {
                this.model = 'gemini-1.5-pro';
                return this.generateText(prompt);
            }
            return null;
        }
    }
}

module.exports = GeminiService;
