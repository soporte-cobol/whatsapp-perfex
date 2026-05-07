require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig');

const app = express();
app.use(express.json());

const perfex = new PerfexService(process.env.PERFEX_BASE_URL, process.env.PERFEX_API_TOKEN);
const whatsapp = new WhatsAppService(process.env.WHATSAPP_API_SECRET, process.env.WHATSAPP_ACCOUNT_ID);
const gemini = new GeminiService(process.env.GEMINI_API_KEY, "gemini-2.0-flash");

app.post('/ai/plugin', async (req, res) => {
    try {
        const data = req.body.data || req.body;
        const msg = (data.message || "").trim();
        const from = data.phone || data.wid || "";
        const secret = req.body.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) return res.json({ status: "error" });
        if (!msg) return res.json({ status: "success", stop: true });

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`\n💬 De: ${cleanFrom} | Msg: "${msg}"`);

        let customer = { found: false };

        // 1. Identificación
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
            
            // 2. Datos CRM
            const results = await Promise.allSettled([
                perfex.getInvoices(customer.customerId, 5),
                perfex.getProjects(customer.customerId, 3),
                perfex.getContracts(customer.customerId, 3),
                perfex.getTickets(customer.email || "", 3)
            ]);

            const invoices = results[0].status === 'fulfilled' && Array.isArray(results[0].value) ? results[0].value : [];
            const tickets = results[3].status === 'fulfilled' && Array.isArray(results[3].value) ? results[3].value : [];

            const pending = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (pending.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                pending.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            }

            // 3. IA Laura
            let aiMsg = null;
            if (gemini.isReady()) {
                const fullPrompt = `
                ${aiConfig.PRE_PROMPT}
                
                CONOCIMIENTO:
                ${aiConfig.KNOWLEDGE_BASE}
                
                DATOS CLIENTE:
                - Nombre: ${customer.firstname} ${customer.lastname}
                - Invoices: ${JSON.stringify(invoices)}
                - Tickets Activos: ${JSON.stringify(tickets)}
                
                PREGUNTA: "${msg}"
                
                ${aiConfig.POST_PROMPT}
                `;
                aiMsg = await gemini.generateText(fullPrompt);
            }

            if (aiMsg) {
                // DETECCIÓN DE TICKET
                if (aiMsg.includes('[CREATE_TICKET:')) {
                    const match = aiMsg.match(/\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/);
                    if (match) {
                        const [_, priority, subject, summary] = match;
                        console.log(`🎫 GENERANDO TICKET: ${subject} (Prioridad: ${priority})`);
                        await perfex.createTicket({
                            subject,
                            message: summary,
                            priority,
                            userid: customer.customerId,
                            contactid: customer.contactId,
                            email: customer.email,
                            name: customer.firstname + ' ' + customer.lastname
                        }).catch(e => console.error("❌ Error creando ticket:", e.message));
                        
                        // Limpiar el tag de la respuesta
                        aiMsg = aiMsg.replace(/\[CREATE_TICKET:.*?\]/, '').trim();
                    }
                }
                await whatsapp.sendText(cleanFrom, aiMsg);
            } else {
                await whatsapp.sendText(cleanFrom, `¡Hola ${customer.firstname}! Soy ${aiConfig.BOT_NAME}.`);
            }
            
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ NO ENCONTRADO.`);
            const fallback = gemini.isReady() ? await gemini.generateText(aiConfig.FALLBACK_PROMPT) : aiConfig.FALLBACK_PROMPT;
            await whatsapp.sendText(cleanFrom, fallback || aiConfig.FALLBACK_PROMPT);
        }

        return res.json({ status: "success", stop: true });

    } catch (error) {
        console.error(`💥 Error Crítico:`, error.message);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 LAURA (ADMIN) ONLINE EN PUERTO ${PORT}`));
