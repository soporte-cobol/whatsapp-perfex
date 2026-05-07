const axios = require('axios');

class GeminiService {
    constructor(apiKey, model) {
        this.apiKey = String(apiKey || '').trim();
        // Usamos los modelos que confirmamos que tienes disponibles
        this.model = String(model || '').trim() || 'gemini-2.0-flash';
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    }

    isReady() {
        return Boolean(this.apiKey) && !this.apiKey.includes('AIzaSyD4s3H'); // Evitar usar la llave bloqueada
    }

    async generateText(prompt) {
        if (!this.isReady()) {
            console.error("❌ ERROR: La API Key no está configurada o es la llave antigua bloqueada.");
            return null;
        }
        
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
            return null;
        } catch (error) {
            const errorBody = error.response?.data?.error?.message || error.message;
            console.error(`❌ ERROR GEMINI [${this.model}]:`, errorBody);
            
            // Si el 2.0 falla por algo, saltamos al 2.5 que también tienes
            if (this.model === 'gemini-2.0-flash') {
                console.log("🔄 Reintentando con gemini-2.5-flash...");
                this.model = 'gemini-2.5-flash';
                return this.generateText(prompt);
            }
            return null;
        }
    }
}

module.exports = GeminiService;
