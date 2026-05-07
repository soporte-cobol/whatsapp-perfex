const axios = require('axios');

class GeminiService {
    constructor(apiKey, model) {
        this.apiKey = String(apiKey || '').trim();
        // Cambiamos al 2.0 que es ultra-estable y rápido
        this.model = String(model || '').trim() || 'gemini-2.0-flash';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey);
    }

    async generateText(prompt) {
        if (!this.isReady()) return null;
        
        // Probamos con la URL limpia
        const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

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
            
            console.error(`⚠️ Gemini respondió sin candidatos. Data:`, JSON.stringify(response.data));
            return null;
        } catch (error) {
            const errorBody = error.response?.data?.error?.message || error.message;
            console.error(`❌ ERROR GEMINI [${this.model}]:`, errorBody);
            
            // Reintento automático con 1.5 si el 2.0 falla
            if (this.model !== 'gemini-1.5-flash') {
                console.log("🔄 Reintentando con gemini-1.5-flash...");
                this.model = 'gemini-1.5-flash';
                return this.generateText(prompt);
            }
            return null;
        }
    }
}

module.exports = GeminiService;
