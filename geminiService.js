const axios = require('axios');

class GeminiService {
    constructor(apiKey) {
        this.apiKey = String(apiKey || '').trim();
        // Lista actualizada con los modelos disponibles para tu API Key
        this.models = [
            'gemini-3.1-flash-lite',
            'gemini-2.5-flash',
            'gemini-flash-latest'
        ];
        this.currentModelIndex = 0;
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey) && this.apiKey.length > 20;
    }

    async generateText(prompt) {
        if (!this.isReady()) return null;
        
        const model = this.models[this.currentModelIndex];
        const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;

        try {
            const requestBody = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1000,
                }
            };

            const response = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 12000
            });

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                return response.data.candidates[0].content.parts[0].text.trim();
            }
            return null;
        } catch (error) {
            console.warn(`⚠️ MODELO [${model}] FALLÓ. Error:`, error.response?.data || error.message);
            if (this.currentModelIndex < this.models.length - 1) {
                this.currentModelIndex++;
                return this.generateText(prompt);
            }
            // Si fallan todos, resetea el índice para futuras llamadas
            this.currentModelIndex = 0;
            return null;
        }
    }
}

module.exports = GeminiService;
