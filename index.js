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
        const from = data.phone || data.wid || "";
        const secret = req.body.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) return res.json({ status: "error" });
        if (!msg) return res.json({ status: "success", stop: true });

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`\n💬 Mensaje de ${cleanFrom}: "${msg}"`);

        let customer = { found: false };

        // 1. Identificación Multicanal
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
            customer = await perfex.getCustomerByEmail(emailMatch[0]).catch(() => ({ found: false }));
        }

        const nitMatch = msg.match(/\d{9}-\d|\d{9}/);
        if (!customer.found && nitMatch) {
            customer = await perfex.getCustomerByVat(nitMatch[0]).catch(() => ({ found: false }));
        }

        if (!customer.found) {
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
            if (!customer.found && cleanFrom.length > 10) {
                customer = await perfex.getCustomerByPhone(cleanFrom.slice(-10)).catch(() => ({ found: false }));
            }
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname}`);
            
            // 2. RECOPILACIÓN TOTAL DE DATOS
            const [invoices, projects, contracts, tickets] = await Promise.all([
                perfex.getInvoices(customer.customerId, 5).catch(() => []),
                perfex.getProjects(customer.customerId, 3).catch(() => []),
                perfex.getContracts(customer.customerId, 3).catch(() => []),
                perfex.getTickets(customer.email, 3).catch(() => [])
            ]);

            // Resumen para la IA
            const pendingInvoices = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            
            let contextCRM = `
            - Facturas Pendientes: ${pendingInvoices.length}
            - Proyectos Activos: ${projects.length}
            - Contratos Vigentes: ${contracts.length}
            - Tickets de Soporte: ${tickets.length}
            `;

            // Mensaje Rígido (Resumen Técnico)
            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (pendingInvoices.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                pendingInvoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            }
            if (projects.length > 0) {
                rigidMsg += `\n\n🏗️ *Tus Proyectos:*`;
                projects.forEach(p => rigidMsg += `\n• ${p.name}`);
            }
            if (contracts.length > 0) {
                rigidMsg += `\n\n📜 *Contratos:*`;
                contracts.forEach(c => rigidMsg += `\n• ${c.subject}`);
            }
            if (tickets.length > 0) {
                rigidMsg += `\n\n🎫 *Tickets de Soporte:*`;
                tickets.forEach(t => rigidMsg += `\n• ${t.subject} (Estado: ${t.status})`);
            }

            // 3. RESPUESTA DE IA (LAURA)
            let aiMsg = null;
            if (gemini.isReady()) {
                const fullPrompt = `
                ${aiConfig.PRE_PROMPT}
                
                DATOS CRM DEL CLIENTE:
                - Nombre: ${customer.firstname} ${customer.lastname}
                - Empresa: ${customer.company}
                - Resumen: ${contextCRM}
                - Detalles: ${rigidMsg}
                
                PREGUNTA ACTUAL: "${msg}"
                
                ${aiConfig.POST_PROMPT}
                `;
                aiMsg = await gemini.generateText(fullPrompt);
            }

            // Enviar respuestas
            if (aiMsg) {
                await whatsapp.sendText(cleanFrom, aiMsg);
            } else {
                const fallback = `¡Hola ${customer.firstname}! Soy ${aiConfig.BOT_NAME}. Aquí tienes el resumen de tu cuenta:`;
                await whatsapp.sendText(cleanFrom, fallback);
            }
            
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ NO ENCONTRADO.`);
            let aiFallback = aiConfig.FALLBACK_PROMPT;
            if (gemini.isReady()) {
                aiFallback = await gemini.generateText(`Pide amablemente correo o NIT. Cliente dice: "${msg}"`).catch(() => aiFallback);
            }
            await whatsapp.sendText(cleanFrom, aiFallback);
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
    console.log(`\n🚀 LAURA (AGENTE DE VIAJES) ONLINE EN PUERTO ${PORT}`);
});
