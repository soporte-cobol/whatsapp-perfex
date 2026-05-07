const axios = require('axios');

class GeminiService {
    constructor(apiKey) {
        this.apiKey = String(apiKey || '').trim();
        // Ponemos el 2.5-flash de primero, ya que es el que te funcionó perfectamente
        this.models = [
            'gemini-2.5-flash', 
            'gemini-2.0-flash',
            'gemini-2.0-flash-exp',
            'gemini-1.5-flash-latest'
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
            console.warn(`⚠️ MODELO [${model}] FALLÓ. Probando siguiente...`);
            if (this.currentModelIndex < this.models.length - 1) {
                this.currentModelIndex++;
                return this.generateText(prompt);
            }
            return null;
        }
    }
}

module.exports = GeminiService;
