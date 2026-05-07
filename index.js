require('dotenv').config();
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Radar de peticiones
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
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
        console.log(`💬 Mensaje de ${cleanFrom}: "${msg}"`);

        let customer = { found: false };

        // 1. ¿ES UN CORREO ELECTRÓNICO?
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const foundEmail = msg.match(emailRegex);

        if (foundEmail) {
            const email = foundEmail[0];
            console.log(`📧 Detectado correo: ${email}. Buscando en Perfex...`);
            customer = await perfex.getCustomerByEmail(email).catch(() => ({ found: false }));
        }

        // 2. SI NO SE ENCONTRÓ POR EMAIL, BUSCAR POR TELÉFONO
        if (!customer.found) {
            console.log(`🔍 Buscando por teléfono: ${cleanFrom}`);
            customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
            
            if (!customer.found && cleanFrom.length > 10) {
                const last10 = cleanFrom.slice(-10);
                console.log(`🔍 Reintentando con últimos 10: ${last10}`);
                customer = await perfex.getCustomerByPhone(last10).catch(() => ({ found: false }));
            }
            
            // Intento final con el formato original (por si tiene el +)
            if (!customer.found && from.includes('+')) {
                console.log(`🔍 Intento final con formato original: ${from}`);
                customer = await perfex.getCustomerByPhone(from).catch(() => ({ found: false }));
            }
        }

        if (customer.found) {
            console.log(`✅ Cliente identificado: ${customer.firstname} ${customer.lastname || ''}`);
            
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId, 5).catch(() => []),
                perfex.getProjects(customer.customerId, 3).catch(() => [])
            ]);

            const pendingInvoices = invoices.filter(i => i.status != 2 && i.status != 4);
            
            let rigidMsg = `*DATOS DE TU CUENTA EN GM GROUP:*\n`;
            if (pendingInvoices.length > 0) {
                rigidMsg += `\n📄 *Facturas Pendientes:*`;
                pendingInvoices.forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}\n  🔗 ${i.view_url}`);
            } else {
                rigidMsg += `\n✅ No tienes facturas pendientes.`;
            }

            if (projects.length > 0) {
                rigidMsg += `\n\n🏗️ *Tus Proyectos:*`;
                projects.forEach(p => rigidMsg += `\n• ${p.name} (${p.status_name || p.status})`);
            }

            let aiMsg = "Hola! Aquí tienes la información de tu cuenta.";
            if (gemini.isReady()) {
                const context = `Cliente: ${customer.firstname}. Info CRM: ${rigidMsg}`;
                aiMsg = await gemini.generateText(`${context}\n\nPregunta: ${msg}\nResponde amable.`).catch(() => aiMsg);
            }

            await whatsapp.sendText(cleanFrom, aiMsg).catch(() => {});
            await whatsapp.sendText(cleanFrom, rigidMsg).catch(() => {});

        } else {
            console.log(`⚠️ No se encontró al cliente.`);
            const fallback = "Lo siento, no encuentro tu número ni tu correo en nuestro sistema. ¿Podrías confirmarme tu correo electrónico o el NIT de tu empresa para ayudarte mejor?";
            await whatsapp.sendText(cleanFrom, fallback).catch(() => {});
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
    console.log(`\n🚀 SERVIDOR ACTUALIZADO Y LISTO`);
});
