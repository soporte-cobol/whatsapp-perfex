require('dotenv').config({ path: require('path').join(__dirname, '.env') });
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
        const data = req.body?.data || req.body || {};
        const msg = (data.message || "").trim();
        const from = String(data.phone || data.wid || "");
        const secret = req.body?.secret || req.body?.token || "";

        if (secret !== process.env.WEBHOOK_API_KEY) return res.json({ status: "error" });
        if (!msg) return res.json({ status: "success", stop: true });

        const cleanFrom = from.split('@')[0].replace(/\D/g, '');
        if (!cleanFrom) {
            console.warn("⚠️ Petición recibida sin número de teléfono de destino válido.");
            return res.json({ status: "success", stop: true });
        }
        if (from.includes('@g.us')) return res.json({ status: "success", stop: true });

        console.log(`\n-----------------------------------------`);
        console.log(`📩 MENSAJE: "${msg}" | TEL: ${cleanFrom}`);

        let isAccountInquiry = false;
        
        // 1. BUSCAR POR EMAIL SI EXISTE EN EL MENSAJE
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        
        // 2. BUSCAR POR NIT SI EXISTE
        const nitMatch = msg.match(/\d{7,}/);

        // Keywords that strongly indicate the user wants to check their account/invoices
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;

        if (emailMatch || nitMatch || accountKeywords.test(msg)) {
            isAccountInquiry = true;
        }

        let customer = { found: false };

        if (isAccountInquiry) {
            if (emailMatch) {
                console.log(`🔍 Intentando por EMAIL: ${emailMatch[0]}`);
                customer = await perfex.getCustomerByEmail(emailMatch[0]);
                console.log(`📡 Respuesta Bridge (Email):`, JSON.stringify(customer));
            }
            if (!customer.found && nitMatch) {
                console.log(`🔍 Intentando por NIT: ${nitMatch[0]}`);
                customer = await perfex.getCustomerByVat(nitMatch[0]);
                console.log(`📡 Respuesta Bridge (NIT):`, JSON.stringify(customer));
            }
            // Sólo buscamos por teléfono si explícitamente están pidiendo cuenta/facturas
            if (!customer.found && accountKeywords.test(msg)) {
                console.log(`🔍 Intentando por TELÉFONO: ${cleanFrom}`);
                customer = await perfex.getCustomerByPhone(cleanFrom);
                console.log(`📡 Respuesta Bridge (Tel):`, JSON.stringify(customer));
            }
        }

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname} (${customer.company})`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId).catch(() => []),
                perfex.getProjects(customer.customerId).catch(() => [])
            ]);

            console.log(`📊 Datos: ${invoices.length} facturas, ${projects.length} viajes.`);

            let rigidMsg = `*RESUMEN DE CUENTA GM GROUP* 🏛️\n`;
            if (invoices.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                invoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ No tienes facturas pendientes.`;
            }

            // También enviamos el contexto a Gemini para que pueda saludar o complementar
            const aiMsg = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n\nCLIENTE: ${customer.firstname}\nVIAJES: ${JSON.stringify(projects)}\nFACTURAS: ${JSON.stringify(invoices)}\n\nINSTRUCCIÓN: El cliente acaba de ser identificado. Salúdalo por su nombre y responde a su mensaje de forma muy breve y amigable.\n\nPREGUNTA: "${msg}"\n\n${aiConfig.POST_PROMPT}`);
            
            await whatsapp.sendText(cleanFrom, rigidMsg);
            if (aiMsg) {
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            }

        } else if (isAccountInquiry && (emailMatch || nitMatch || accountKeywords.test(msg))) {
            console.log(`⚠️ FALLÓ IDENTIFICACIÓN TRAS INTENTO EXPLÍCITO`);
            const aiFallback = await gemini.generateText(`Eres Laura de GM Group. El cliente intentó consultar información de su cuenta o facturas, pero NO lo encontramos en el sistema. Pídele amablemente que te confirme su correo electrónico o NIT para buscarlo bien. Mensaje del cliente: "${msg}"`);
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
        } else {
            console.log(`🤖 RESPUESTA GENERATIVA (Sin forzar identificación)`);
            // TEXTO GENERATIVO PURO
            const aiMsg = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n\n${aiConfig.KNOWLEDGE_BASE || ''}\n\nPREGUNTA DEL CLIENTE: "${msg}"\n\nINSTRUCCIÓN: Eres asesora de viajes. Responde amablemente a la pregunta del cliente. NO le pidas su correo electrónico ni su NIT a menos que te esté pidiendo reservar algo o consultar sus facturas.\n\n${aiConfig.POST_PROMPT}`);
            
            if (aiMsg) {
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            } else {
                console.warn(`⚠️ Gemini no generó respuesta. Enviando Fallback.`);
                await whatsapp.sendText(cleanFrom, aiConfig.FALLBACK_PROMPT);
            }
        }

        return res.json({ status: "success" });

    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 LAURA (MODO DIOS 3.1) ONLINE | PUERTO ${PORT}`);
        console.log(`-----------------------------------------\n`);
    });
