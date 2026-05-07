require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Radar de peticiones con tiempo exacto
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
        const msg = (data.message || body.message || "").trim();
        const from = data.phone || data.wid || "";
        const secret = req.body.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) {
            console.log("🚫 Secret no coincide");
            return res.json({ status: "error" });
        }

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`💬 De: ${cleanFrom} | Msg: "${msg}"`);

        let customer = { found: false };

        // --- DETECTORES ---
        const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const nitMatch = msg.match(/\d{9}-\d|\d{9}/); // Detecta NITs como 901013407-9 o solo números

        // 1. BUSCAR POR EMAIL
        if (emailMatch) {
            const email = emailMatch[0];
            console.log(`📧 Detectado EMAIL: ${email}. Consultando CRM...`);
            customer = await perfex.getCustomerByEmail(email).catch(e => ({ found: false, error: e.message }));
        } 
        // 2. BUSCAR POR NIT
        else if (nitMatch) {
            const nit = nitMatch[0];
            console.log(`🆔 Detectado NIT: ${nit}. Consultando CRM...`);
            customer = await perfex.getCustomerByVat(nit).catch(e => ({ found: false, error: e.message }));
        }
        // 3. BUSCAR POR TELÉFONO (Default)
        if (!customer.found) {
            console.log(`🔍 Buscando por TELÉFONO: ${cleanFrom}`);
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(e => ({ found: false, error: e.message }));
            
            if (!customer.found && cleanFrom.length > 10) {
                const last10 = cleanFrom.slice(-10);
                console.log(`🔍 Reintentando con últimos 10: ${last10}`);
                customer = await perfex.getCustomerByPhone(last10).catch(() => ({ found: false }));
            }
        }

        console.log(`📊 RESULTADO BÚSQUEDA:`, JSON.stringify(customer));

        if (customer.found) {
            console.log(`✅ IDENTIFICADO: ${customer.firstname} (ID: ${customer.customerId})`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId, 5).catch(() => []),
                perfex.getProjects(customer.customerId, 3).catch(() => [])
            ]);

            const pending = invoices.filter(i => i.status != 2 && i.status != 4 && i.status != 5);
            
            let rigidMsg = `*RESUMEN DE CUENTA - GM GROUP:*\n`;
            if (pending.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                pending.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ Estás al día con tus facturas.`;
            }

            if (projects.length > 0) {
                rigidMsg += `\n\n🏗️ *Proyectos Actuales:*`;
                projects.forEach(p => rigidMsg += `\n• ${p.name}`);
            }

            let aiMsg = "¡Hola! Gusto en saludarte. Aquí tienes la información que encontré en nuestro sistema:";
            if (gemini.isReady()) {
                console.log("🤖 Consultando a Gemini...");
                aiMsg = await gemini.generateText(`Cliente: ${customer.firstname}. Info: ${rigidMsg}. Pregunta: ${msg}`).catch(() => aiMsg);
            }

            console.log("📤 Enviando respuestas por WhatsApp API...");
            await whatsapp.sendText(cleanFrom, aiMsg).catch(e => console.log("Error IA:", e.message));
            await whatsapp.sendText(cleanFrom, rigidMsg).catch(e => console.log("Error CRM:", e.message));

        } else {
            console.log(`⚠️ NO ENCONTRADO. Enviando mensaje de ayuda.`);
            const fallback = "Lo siento, no encuentro tu número, correo ni NIT en nuestro sistema de GM Group. ¿Podrías confirmarme tu correo electrónico o el NIT de tu empresa para buscarte manualmente?";
            await whatsapp.sendText(cleanFrom, fallback).catch(e => console.log("Error Fallback:", e.message));
        }

        return res.json({ status: "success", response: "", final: true, stop: true });

    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error.message);
        return res.json({ status: "error" });
    }
});

app.post('/', (req, res) => res.redirect(307, '/ai/plugin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🕵️ MODO DETECTIVE ACTIVADO EN PUERTO ${PORT}`);
});
