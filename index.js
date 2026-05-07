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
const gemini = new GeminiService(process.env.GEMINI_API_KEY, "gemini-2.5-flash");

// DETECTIVE DE RUTA
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

app.post('/ai/plugin', async (req, res) => {
    console.log("📥 DATOS RECIBIDOS:", JSON.stringify(req.body));
    
    try {
        const data = req.body.data || req.body;
        const msg = (data.message || "").trim();
        const from = String(data.phone || data.wid || "");
        const secret = req.body.secret || req.body.token || "";

        // Verificación de secreto con log
        if (secret !== process.env.WEBHOOK_API_KEY) {
            console.warn(`❌ TOKEN INCORRECTO. Recibido: "${secret}", Esperado: "${process.env.WEBHOOK_API_KEY}"`);
            // Por ahora dejamos pasar para ver si responde, pero avisamos
        }

        if (!msg) {
            console.log("Empty message, ignoring.");
            return res.json({ status: "success", stop: true });
        }

        const cleanFrom = from.split('@')[0].replace(/\D/g, '');
        
        if (from.includes('@g.us') || !cleanFrom) {
            console.log(`⏭️ Ignorando grupo: ${from}`);
            return res.json({ status: "success", stop: true });
        }

        console.log(`💬 Procesando mensaje de ${cleanFrom}: "${msg}"`);

        let customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
        if (!customer.found && cleanFrom.length > 10) {
            customer = await perfex.getCustomerByPhone(cleanFrom.slice(-10)).catch(() => ({ found: false }));
        }

        if (customer.found) {
            console.log(`✅ Cliente: ${customer.firstname}`);
            
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

            let aiMsg = null;
            if (gemini.isReady()) {
                const fullPrompt = `${aiConfig.PRE_PROMPT}\n\nConocimiento: ${aiConfig.KNOWLEDGE_BASE}\n\nCliente: ${customer.firstname}\n\nPregunta: "${msg}"\n\n${aiConfig.POST_PROMPT}`;
                aiMsg = await gemini.generateText(fullPrompt);
            }

            if (aiMsg) {
                // Limpieza de tags de ticket antes de enviar
                let cleanAiMsg = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                
                if (aiMsg.includes('[CREATE_TICKET:')) {
                    const match = aiMsg.match(/\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/);
                    if (match) {
                        const [_, priority, subject, summary] = match;
                        console.log(`🎫 Ticket detectado: ${subject}`);
                        await perfex.createTicket({
                            subject, message: summary, priority,
                            userid: customer.customerId, contactid: customer.contactId,
                            email: customer.email, name: customer.firstname + ' ' + customer.lastname
                        }).catch(e => console.error("Error ticket:", e.message));
                    }
                }
                await whatsapp.sendText(cleanFrom, cleanAiMsg);
            } else {
                await whatsapp.sendText(cleanFrom, `¡Hola ${customer.firstname}! Soy Laura.`);
            }
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ No registrado: ${cleanFrom}`);
            const fallback = gemini.isReady() ? await gemini.generateText(aiConfig.FALLBACK_PROMPT) : aiConfig.FALLBACK_PROMPT;
            await whatsapp.sendText(cleanFrom, fallback || aiConfig.FALLBACK_PROMPT);
        }

        return res.json({ status: "success", stop: true });

    } catch (error) {
        console.error(`💥 ERROR DETECTIVE:`, error);
        return res.json({ status: "error", message: error.message });
    }
});

app.post('/', (req, res) => res.redirect(307, '/ai/plugin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🕵️ MODO DETECTIVE ACTIVADO EN PUERTO ${PORT}`));
