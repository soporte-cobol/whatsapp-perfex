const axios = require('axios');

class GeminiService {
    constructor(apiKey) {
        this.apiKey = String(apiKey || '').trim();
        // Volvemos al modelo 2.0 que es el que tu llave soporta
        this.model = 'gemini-2.0-flash'; 
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
                    maxOutputTokens: 1024,
                }
            };

            const response = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                const text = response.data.candidates[0].content.parts[0].text;
                return text.trim();
            }
            return null;
        } catch (error) {
            const errorBody = error.response?.data?.error?.message || error.message;
            console.error(`❌ ERROR GEMINI [${this.model}]:`, errorBody);
            
            // Si el 2.0-flash falla por cuotas, intentamos con el 2.0-flash-exp
            if (this.model === 'gemini-2.0-flash') {
                this.model = 'gemini-2.0-flash-exp';
                return this.generateText(prompt);
            }
            return null;
        }
    }
}

module.exports = GeminiService;
