require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');

const app = express();

// Body Parsers (Importante tener ambos)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log Global de Peticiones (Radar)
app.use((req, res, next) => {
    console.log(`📡 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url} | IP: ${req.ip}`);
    next();
});

// Inicialización
const perfex = new PerfexService(process.env.PERFEX_BASE_URL, process.env.PERFEX_API_TOKEN);
const whatsapp = new WhatsAppService(process.env.WHATSAPP_API_SECRET, process.env.WHATSAPP_ACCOUNT_ID);
const gemini = new GeminiService(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL);

app.post('/ai/plugin', async (req, res) => {
    try {
        const body = req.body;
        console.log(`📩 PROCESANDO PLUGIN REQUEST...`);
        
        // Detección flexible de datos (Cobol a veces lo anida en 'data')
        const data = body.data || body;
        const msg = data.message || body.message || "";
        const from = data.phone || data.wid || body.from || "";
        const secret = body.secret || data.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) {
            console.log(`🚫 Bloqueado: Secret incorrecto (${secret})`);
            return res.json({ status: "error", message: "Auth failed" });
        }

        if (!msg) {
            console.log(`ℹ️ Mensaje vacío o Heartbeat detectado`);
            return res.json({ status: "success", stop: true });
        }

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`💬 Mensaje de ${cleanFrom}: "${msg}"`);

        // Búsqueda en Perfex
        console.log(`🔍 Buscando cliente...`);
        let customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
        
        if (!customer.found && cleanFrom.length > 10) {
            customer = await perfex.getCustomerByPhone(cleanFrom.slice(-10)).catch(() => ({ found: false }));
        }

        if (customer.found) {
            console.log(`✅ Cliente encontrado: ${customer.firstname}`);
            
            // Consultar facturas/proyectos
            const [invoices, projects] = await Promise.all([
                perfex.getInvoices(customer.customerId, 5).catch(() => []),
                perfex.getProjects(customer.customerId, 3).catch(() => [])
            ]);

            let rigidData = `Facturas: ${invoices.length}, Proyectos: ${projects.length}`;
            let rigidMsg = `*RESUMEN CRM:*\n`;
            invoices.filter(i => i.status != 2).forEach(i => rigidMsg += `\n• ${i.number}: $${i.total}`);
            if (invoices.length === 0) rigidMsg = "No tienes facturas pendientes.";

            let aiMsg = "Hola! Soy tu asistente virtual.";
            if (gemini.isReady()) {
                aiMsg = await gemini.generateText(`Cliente: ${customer.firstname}. Contexto: ${rigidData}. Pregunta: ${msg}`).catch(() => aiMsg);
            }

            console.log(`📤 Enviando respuestas por API...`);
            await whatsapp.sendText(cleanFrom, aiMsg).catch(e => console.log(`Error API IA: ${e.message}`));
            await whatsapp.sendText(cleanFrom, rigidMsg).catch(e => console.log(`Error API CRM: ${e.message}`));

        } else {
            console.log(`⚠️ Cliente no encontrado. Enviando fallback.`);
            const fallback = "Hola! No encuentro tu número registrado. ¿Podrías indicarme tu correo?";
            await whatsapp.sendText(cleanFrom, fallback).catch(e => console.log(`Error API Fallback: ${e.message}`));
        }

        // Siempre responder 200 OK al panel
        return res.json({ status: "success", response: "", final: true, stop: true });

    } catch (error) {
        console.error(`💥 Error interno:`, error.message);
        return res.json({ status: "error", response: "Error" });
    }
});

// Alias para ruta raíz
app.post('/', (req, res) => res.redirect(307, '/ai/plugin'));
app.get('/', (req, res) => res.send('Bot Online 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR RADAR ACTIVO EN PUERTO ${PORT}`);
    console.log(`🔑 WEBHOOK SECRET: ${process.env.WEBHOOK_API_KEY.substring(0, 5)}...`);
});
