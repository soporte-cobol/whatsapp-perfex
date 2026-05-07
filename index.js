require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const perfex = new PerfexService(process.env.PERFEX_BASE_URL, process.env.PERFEX_API_TOKEN);
const whatsapp = new WhatsAppService(process.env.WHATSAPP_API_SECRET, process.env.WHATSAPP_ACCOUNT_ID);
const gemini = new GeminiService(process.env.GEMINI_API_KEY, "gemini-2.5-flash");

app.post('/ai/plugin', async (req, res) => {
    try {
        const data = req.body.data || req.body;
        const msg = (data.message || "").trim();
        const from = String(data.phone || data.wid || "");
        const secret = req.body.secret || req.body.token || "";

        if (secret !== process.env.WEBHOOK_API_KEY) return res.json({ status: "error" });
        if (!msg) return res.json({ status: "success", stop: true });

        const cleanFrom = from.split('@')[0].replace(/\D/g, '');
        if (from.includes('@g.us') || !cleanFrom) return res.json({ status: "success", stop: true });

        console.log(`\n💬 Mensaje de ${cleanFrom}: "${msg}"`);

        let customer = { found: false };

        // 1. Identificación Profunda
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) customer = await perfex.getCustomerByEmail(emailMatch[0]).catch(() => ({ found: false }));
        
        if (!customer.found) {
            const nitMatch = msg.match(/\d{9}-\d|\d{9}/);
            if (nitMatch) customer = await perfex.getCustomerByVat(nitMatch[0]).catch(() => ({ found: false }));
        }

        if (!customer.found) {
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
            if (!customer.found && cleanFrom.length > 10) {
                customer = await perfex.getCustomerByPhone(cleanFrom.slice(-10)).catch(() => ({ found: false }));
            }
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname}`);
            
            const results = await Promise.allSettled([
                perfex.getInvoices(customer.customerId, 5),
                perfex.getTickets(customer.email || "", 3)
            ]);

            const invoices = results[0].status === 'fulfilled' ? results[0].value : [];
            const pending = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            
            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (pending.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                pending.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            }

            // IA Laura
            let aiMsg = null;
            if (gemini.isReady()) {
                const fullPrompt = `
                ${aiConfig.PRE_PROMPT}
                BASE DE CONOCIMIENTOS: ${aiConfig.KNOWLEDGE_BASE}
                CLIENTE: ${customer.firstname} ${customer.lastname}
                DATA CRM: ${rigidMsg}
                PREGUNTA: "${msg}"
                ${aiConfig.POST_PROMPT}
                `;
                aiMsg = await gemini.generateText(fullPrompt);
            }

            if (aiMsg) {
                // Procesar tickets
                if (aiMsg.includes('[CREATE_TICKET:')) {
                    const match = aiMsg.match(/\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/);
                    if (match) {
                        const [_, priority, subject, summary] = match;
                        console.log(`🎫 Ticket: ${subject}`);
                        await perfex.createTicket({
                            subject, message: summary, priority,
                            userid: customer.customerId, contactid: customer.contactId,
                            email: customer.email, name: customer.firstname + ' ' + customer.lastname
                        }).catch(e => console.error("Error ticket:", e.message));
                        aiMsg = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                    }
                }
                await whatsapp.sendText(cleanFrom, aiMsg);
            } else {
                await whatsapp.sendText(cleanFrom, `¡Hola ${customer.firstname}! Soy Laura. ¿En qué te ayudo?`);
            }
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ NO ENCONTRADO: ${cleanFrom}`);
            // Fallback inteligente para captar leads
            let aiFallback = aiConfig.FALLBACK_PROMPT;
            if (gemini.isReady()) {
                aiFallback = await gemini.generateText(`Eres Laura de GM Group. No encontramos al cliente con el número ${cleanFrom}. Pídele amablemente su correo o NIT para buscarlo en la base de datos de la agencia. Sé muy amable y entusiasta.`);
            }
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
        }

        return res.json({ status: "success", stop: true });

    } catch (error) {
        console.error(`💥 Error:`, error.message);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 LAURA (PRO 2.5) ONLINE EN PUERTO ${PORT}`));
