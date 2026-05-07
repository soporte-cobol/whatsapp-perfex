const axios = require('axios');

class GeminiService {
    constructor(apiKey, model) {
        this.apiKey = String(apiKey || '').trim();
        // Usamos el modelo más reciente y compatible
        this.model = String(model || '').trim() || 'gemini-1.5-flash-latest';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey);
    }

    async generateText(prompt) {
        if (!this.isReady()) return null;
        
        // El endpoint exacto de Google v1beta
        const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

        try {
            const requestBody = {
                contents: [
                    {
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 500,
                }
            };

            const response = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                const text = response.data.candidates[0].content.parts[0].text;
                return text.trim();
            }
            
            return null;
        } catch (error) {
            const errorMsg = error.response?.data?.error?.message || error.message;
            console.error(`❌ Error Gemini API (${this.model}):`, errorMsg);
            return null;
        }
    }
}

module.exports = GeminiService;
