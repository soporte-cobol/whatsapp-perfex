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

        // 1. Identificación Multicanal
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) customer = await perfex.getCustomerByEmail(emailMatch[0]).catch(() => ({ found: false }));
        
        if (!customer.found) {
            const nitMatch = msg.match(/\d{9}-\d|\d{9}/);
            if (nitMatch) customer = await perfex.getCustomerByVat(nitMatch[0]).catch(() => ({ found: false }));
        }

        if (!customer.found) {
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname} (${customer.company})`);
            
            // 2. Carga de datos contextuales de viaje
            const results = await Promise.allSettled([
                perfex.getInvoices(customer.customerId),
                perfex.getProjects(customer.customerId),
                perfex.getTickets(customer.email || "")
            ]);

            const invoices = results[0].status === 'fulfilled' ? results[0].value : [];
            const projects = results[1].status === 'fulfilled' ? results[1].value : [];
            const tickets = results[2].status === 'fulfilled' ? results[2].value : [];

            const pendingInvoices = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            
            // Construcción del mensaje rígido (resumen técnico)
            let rigidMsg = `*ESTADO DE CUENTA GM GROUP* 🏛️\n`;
            if (projects.length > 0) {
                rigidMsg += `\n✈️ *Tus Planes de Viaje:*`;
                projects.forEach(p => rigidMsg += `\n• ${p.travel_plan}`);
            }
            if (pendingInvoices.length > 0) {
                rigidMsg += `\n\n📄 *Facturas Pendientes:*`;
                pendingInvoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            }

            // 3. IA Laura con contexto de Viajes
            let aiMsg = null;
            if (gemini.isReady()) {
                const fullPrompt = `
                ${aiConfig.PRE_PROMPT}
                
                BASE DE CONOCIMIENTO AGENCIA:
                ${aiConfig.KNOWLEDGE_BASE}
                
                DATOS DEL CLIENTE EN GM GROUP:
                - Nombre: ${customer.firstname}
                - Empresa: ${customer.company}
                - Planes de Viaje Actuales: ${JSON.stringify(projects)}
                - Facturas por Pagar: ${JSON.stringify(pendingInvoices)}
                - Tickets Recientes: ${JSON.stringify(tickets)}
                
                PREGUNTA DEL CLIENTE: "${msg}"
                
                ${aiConfig.POST_PROMPT}
                `;
                aiMsg = await gemini.generateText(fullPrompt);
            }

            if (aiMsg) {
                // Procesar comandos de tickets detectados por la IA
                if (aiMsg.includes('[CREATE_TICKET:')) {
                    const match = aiMsg.match(/\[CREATE_TICKET:\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/);
                    if (match) {
                        const [_, priority, subject, summary] = match;
                        console.log(`🎫 ACCIÓN: Creando Ticket "${subject}"...`);
                        await perfex.createTicket({
                            subject, message: summary, priority,
                            userid: customer.customerId, contactid: customer.contactId,
                            email: customer.email, name: customer.firstname + ' ' + customer.lastname
                        }).catch(e => console.error("Error al crear ticket:", e.message));
                        aiMsg = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                    }
                }
                await whatsapp.sendText(cleanFrom, aiMsg);
            } else {
                await whatsapp.sendText(cleanFrom, `¡Hola ${customer.firstname}! Soy Laura de GM Group.`);
            }
            
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ NO ENCONTRADO: ${cleanFrom}`);
            let aiFallback = aiConfig.FALLBACK_PROMPT;
            if (gemini.isReady()) {
                aiFallback = await gemini.generateText(`Eres Laura de GM Group. No encuentras al cliente con número ${cleanFrom}. Pídele amablemente su correo o NIT. Sé muy entusiasta y profesional. RESPONDE DIRECTAMENTE.`);
            }
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
        }

        return res.json({ status: "success", stop: true });

    } catch (error) {
        console.error(`💥 Error Crítico:`, error.message);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 LAURA (AGENCIA V2.5) ONLINE EN PUERTO ${PORT}`));
