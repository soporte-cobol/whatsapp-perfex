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
        if (from.includes('@g.us')) return res.json({ status: "success", stop: true });

        console.log(`\n💬 INPUT: "${msg}" de ${cleanFrom}`);

        let customer = { found: false };

        // 1. INTENTOS DE IDENTIFICACIÓN
        // Por NIT (si hay números de 8+ cifras)
        const nitMatch = msg.match(/\d{8,}/);
        if (nitMatch) {
            console.log(`🔍 Buscando NIT: ${nitMatch[0]}`);
            customer = await perfex.getCustomerByVat(nitMatch[0]).catch(() => ({ found: false }));
        }

        // Por Email
        if (!customer.found) {
            const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (emailMatch) {
                console.log(`🔍 Buscando Email: ${emailMatch[0]}`);
                customer = await perfex.getCustomerByEmail(emailMatch[0]).catch(() => ({ found: false }));
            }
        }

        // Por Teléfono (último recurso)
        if (!customer.found) {
            console.log(`🔍 Buscando Teléfono: ${cleanFrom}`);
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname}`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId).catch(() => []),
                perfex.getProjects(customer.customerId).catch(() => [])
            ]);

            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (invoices.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                invoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ No tienes facturas pendientes.`;
            }

            const fullPrompt = `
            ${aiConfig.PRE_PROMPT}
            REGLA CRÍTICA: Eres Laura. Responde DIRECTAMENTE al cliente. No digas "Aquí tienes un borrador". No uses "Asunto:". 
            
            CONTEXTO:
            - Cliente: ${customer.firstname} (${customer.company})
            - Viajes: ${JSON.stringify(projects)}
            
            MENSAJE DEL CLIENTE: "${msg}"
            
            ${aiConfig.POST_PROMPT}
            `;
            
            const aiMsg = await gemini.generateText(fullPrompt);
            if (aiMsg) {
                // Lógica de tickets
                if (aiMsg.includes('[CREATE_TICKET:')) {
                    const tMatch = aiMsg.match(/\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/);
                    if (tMatch) {
                        await perfex.createTicket({
                            subject: tMatch[2], message: tMatch[3], priority: tMatch[1],
                            userid: customer.customerId, contactid: customer.contactId,
                            email: customer.email, name: customer.firstname
                        });
                    }
                }
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').replace(/Asunto:.*?\n/gi, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            }
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ NO ENCONTRADO: ${cleanFrom}`);
            const fallbackPrompt = `Eres Laura de GM Group. NO ENCONTRAMOS al cliente con número ${cleanFrom}. 
            Responde DIRECTAMENTE pidiendo amablemente su Correo o NIT. 
            NO digas "Borrador", NO digas "Asunto". Solo responde como Laura.`;
            
            const aiFallback = await gemini.generateText(fallbackPrompt);
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
        }

        return res.json({ status: "success" });

    } catch (error) {
        console.error(`💥 ERROR:`, error.message);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LAURA ONLINE | PUERTO ${PORT}`));
