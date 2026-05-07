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

        console.log(`\n-----------------------------------------`);
        console.log(`📩 MENSAJE: "${msg}" | TEL: ${cleanFrom}`);

        let customer = { found: false };

        // 1. BUSCAR POR EMAIL SI EXISTE EN EL MENSAJE
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
            console.log(`🔍 Intentando por EMAIL: ${emailMatch[0]}`);
            customer = await perfex.getCustomerByEmail(emailMatch[0]);
            console.log(`📡 Respuesta Bridge (Email):`, JSON.stringify(customer));
        }

        // 2. BUSCAR POR NIT SI EXISTE
        if (!customer.found) {
            const nitMatch = msg.match(/\d{7,}/);
            if (nitMatch) {
                console.log(`🔍 Intentando por NIT: ${nitMatch[0]}`);
                customer = await perfex.getCustomerByVat(nitMatch[0]);
                console.log(`📡 Respuesta Bridge (NIT):`, JSON.stringify(customer));
            }
        }

        // 3. BUSCAR POR TELÉFONO (Último recurso)
        if (!customer.found) {
            console.log(`🔍 Intentando por TELÉFONO: ${cleanFrom}`);
            customer = await perfex.getCustomerByPhone(cleanFrom);
            console.log(`📡 Respuesta Bridge (Tel):`, JSON.stringify(customer));
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

            const aiMsg = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n\nCLIENTE: ${customer.firstname}\nVIAJES: ${JSON.stringify(projects)}\n\nPREGUNTA: "${msg}"\n\n${aiConfig.POST_PROMPT}`);
            
            if (aiMsg) {
                const finalAi = aiMsg.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
                await whatsapp.sendText(cleanFrom, finalAi);
            }
            await whatsapp.sendText(cleanFrom, rigidMsg);

        } else {
            console.log(`⚠️ FALLÓ IDENTIFICACIÓN`);
            const aiFallback = await gemini.generateText(`Eres Laura de GM Group. NO encontramos al cliente con número ${cleanFrom}. Pide el correo o NIT amablemente.`);
            await whatsapp.sendText(cleanFrom, aiFallback || aiConfig.FALLBACK_PROMPT);
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
