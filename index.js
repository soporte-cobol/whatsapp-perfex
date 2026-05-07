require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig'); // <--- Importamos los prompts modulares

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Radar de peticiones
app.use((req, res, next) => {
    console.log(`\n📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

const perfex = new PerfexService(process.env.PERFEX_BASE_URL, process.env.PERFEX_API_TOKEN);
const whatsapp = new WhatsAppService(process.env.WHATSAPP_API_SECRET, process.env.WHATSAPP_ACCOUNT_ID);
const gemini = new GeminiService(process.env.GEMINI_API_KEY, "gemini-1.5-flash-latest");

app.post('/ai/plugin', async (req, res) => {
    try {
        const data = req.body.data || req.body;
        const msg = (data.message || "").trim();
        const from = data.phone || data.wid || "";
        const secret = req.body.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) return res.json({ status: "error" });
        if (!msg) return res.json({ status: "success", stop: true });

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`💬 De: ${cleanFrom} | Msg: "${msg}"`);

        let customer = { found: false };

        // 1. DETECTOR DE EMAIL
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
            console.log(`📧 Buscando por EMAIL: ${emailMatch[0]}`);
            customer = await perfex.getCustomerByEmail(emailMatch[0]).catch(() => ({ found: false }));
        }

        // 2. DETECTOR DE NIT
        const nitMatch = msg.match(/\d{9}-\d|\d{9}/);
        if (!customer.found && nitMatch) {
            console.log(`🆔 Buscando por NIT: ${nitMatch[0]}`);
            customer = await perfex.getCustomerByVat(nitMatch[0]).catch(() => ({ found: false }));
        }

        // 3. BUSCADOR POR TELÉFONO (Si falla lo anterior)
        if (!customer.found) {
            console.log(`🔍 Buscando por TELÉFONO: ${cleanFrom}`);
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
            
            if (!customer.found && cleanFrom.length > 10) {
                customer = await perfex.getCustomerByPhone(cleanFrom.slice(-10)).catch(() => ({ found: false }));
            }
        }

        console.log(`📊 CRM RESPONSE:`, JSON.stringify(customer));

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname}`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId, 5).catch(() => []),
                perfex.getProjects(customer.customerId, 3).catch(() => [])
            ]);

            // Construir respuesta rígida
            const pending = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            let rigidMsg = `*RESUMEN DE CUENTA:*\n`;
            if (pending.length > 0) {
                pending.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ Sin deudas pendientes.`;
            }

            // Generar respuesta con Gemini usando el nuevo sistema de Prompts
            let aiMsg = `Hola ${customer.firstname}! Soy ${aiConfig.BOT_NAME}.`;
            if (gemini.isReady()) {
                const fullPrompt = `
                ${aiConfig.PRE_PROMPT}
                
                DATOS DEL CLIENTE EN CRM:
                - Nombre: ${customer.firstname} ${customer.lastname || ''}
                - Empresa: ${customer.company || 'N/A'}
                - Información de Cuenta: ${rigidMsg}
                
                PREGUNTA DEL CLIENTE: "${msg}"
                
                ${aiConfig.POST_PROMPT}
                `;
                aiMsg = await gemini.generateText(fullPrompt).catch(() => aiMsg);
            }

            console.log(`📤 Enviando a WhatsApp...`);
            await whatsapp.sendText(cleanFrom, aiMsg).catch(() => {});
            await whatsapp.sendText(cleanFrom, rigidMsg).catch(() => {});

        } else {
            console.log(`⚠️ NO ENCONTRADO.`);
            let aiFallback = aiConfig.FALLBACK_PROMPT;
            if (gemini.isReady()) {
                aiFallback = await gemini.generateText(`Contexto: ${aiConfig.PRE_PROMPT}. El cliente dice "${msg}" pero no lo encontramos. Pídele su correo o NIT amablemente como Gloria.`).catch(() => aiFallback);
            }
            await whatsapp.sendText(cleanFrom, aiFallback).catch(() => {});
        }

        return res.json({ status: "success", response: "", final: true, stop: true });

    } catch (error) {
        console.error(`💥 Error:`, error.message);
        return res.json({ status: "error" });
    }
});

app.post('/', (req, res) => res.redirect(307, '/ai/plugin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR MODULAR LISTO EN PUERTO ${PORT}`);
});
