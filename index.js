require('dotenv').config();
const express = require('express');
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');

function _asNonEmptyText(value) {
    const text = (value === undefined || value === null) ? '' : String(value);
    const trimmed = text.trim();
    return trimmed.length ? trimmed : null;
}

function sendCobolJson(res, payload) {
    const safePayload = payload && typeof payload === 'object' ? { ...payload } : {};
    const candidateText = _asNonEmptyText(safePayload.response) || "OK";
    if (!_asNonEmptyText(safePayload.response)) safePayload.response = candidateText;
    return res.json(safePayload);
}

// Configuración de logs
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

// Inicialización
const perfex = new PerfexService(process.env.PERFEX_BASE_URL, process.env.PERFEX_API_TOKEN);
const whatsapp = new WhatsAppService(process.env.WHATSAPP_API_SECRET, process.env.WHATSAPP_ACCOUNT_ID);
const gemini = new GeminiService(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL);

const app = express();
app.use(express.json());

app.post('/ai/plugin', async (req, res) => {
    try {
        const body = req.body;
        console.log(`\n📩 NUEVO MENSAJE RECIBIDO`);
        
        const msg = (body.data && body.data.message) || body.message || "";
        const from = (body.data && (body.data.phone || body.data.wid)) || body.from;
        const secret = body.secret || "";

        if (secret !== process.env.WEBHOOK_API_KEY) {
            console.log(`🚫 Bloqueado: Secret incorrecto`);
            return res.status(200).json({ status: "error", message: "Auth failed" });
        }

        if (!msg || !from) {
            console.log(`ℹ️ Heartbeat o mensaje vacío`);
            return res.json({ status: "success", stop: true });
        }

        const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
        console.log(`👤 De: ${cleanFrom} | Msg: "${msg}"`);

        // 1. IDENTIFICACIÓN DEL CLIENTE (Búsqueda flexible)
        console.log(`🔍 Buscando cliente en Perfex...`);
        let customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
        
        // Si no lo encuentra por número completo, intentamos por los últimos 10 dígitos (Colombia)
        if (!customer.found && cleanFrom.length > 10) {
            const last10 = cleanFrom.slice(-10);
            console.log(`🔍 Reintentando con últimos 10 dígitos: ${last10}`);
            customer = await perfex.getCustomerByPhone(last10).catch(() => ({ found: false }));
        }

        if (customer.found) {
            console.log(`✅ CLIENTE ENCONTRADO: ${customer.firstname} (ID: ${customer.customerId})`);
            
            const lowerMsg = msg.toLowerCase();
            const keywordsFactura = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo', 'pago', 'cuenta'];
            const wantsInvoices = keywordsFactura.some(k => lowerMsg.includes(k));

            console.log(`📊 Consultando datos de cuenta...`);
            const [invoices, projects] = await Promise.all([
                (wantsInvoices || lowerMsg.length < 20) ? perfex.getInvoices(customer.customerId, 5).catch(() => []) : Promise.resolve([]),
                perfex.getProjects(customer.customerId, 3).catch(() => [])
            ]);

            let rigidAnswer = `*DATOS DE TU CUENTA (CRM):*\n`;
            let hasData = false;

            if (Array.isArray(invoices) && invoices.length > 0) {
                const pending = invoices.filter(inv => inv.status != 2 && inv.status != 4); // No pagadas ni canceladas
                if (pending.length > 0) {
                    rigidAnswer += `\n📄 *Facturas Pendientes:*`;
                    pending.forEach(inv => rigidAnswer += `\n• ${inv.number}: $${inv.total}\n  🔗 ${inv.view_url}`);
                    hasData = true;
                }
            }

            if (Array.isArray(projects) && projects.length > 0) {
                rigidAnswer += `\n\n🏗️ *Proyectos:*`;
                projects.forEach(p => rigidAnswer += `\n• ${p.name} (Estado: ${p.status_name || p.status})`);
                hasData = true;
            }

            if (!hasData) rigidAnswer = "✅ No tienes facturas pendientes ni proyectos activos en este momento.";

            let aiAnswer = "Hola, un gusto saludarte. Aquí tienes la información solicitada:";
            if (gemini.isReady()) {
                console.log(`🤖 Generando respuesta con Gemini...`);
                const prompt = `Eres un asistente de GM Group. Cliente: ${customer.firstname}. Info: ${rigidAnswer}. Pregunta: "${msg}". Responde amable y breve.`;
                aiAnswer = await gemini.generateText(prompt).catch(e => {
                    console.error(`❌ Error Gemini: ${e.message}`);
                    return aiAnswer;
                });
            }

            console.log(`📤 Enviando mensajes por WhatsApp API...`);
            await whatsapp.sendText(cleanFrom, aiAnswer).catch(e => console.error(`❌ Falló envío IA: ${e.message}`));
            await whatsapp.sendText(cleanFrom, rigidAnswer).catch(e => console.error(`❌ Falló envío CRM: ${e.message}`));

            return res.json({ status: "success", response: "", final: true, stop: true });
        } else {
            console.log(`⚠️ CLIENTE NO ENCONTRADO en Perfex.`);
            
            let fallback = "Lo siento, no reconozco este número. ¿Podrías darme tu correo electrónico o NIT para buscarte?";
            if (gemini.isReady()) {
                fallback = await gemini.generateText(`Dile al cliente que no lo encontramos por su teléfono (${cleanFrom}) y pídele su correo amablemente.`).catch(() => fallback);
            }

            // Enviamos el fallback también por API por seguridad
            console.log(`📤 Enviando mensaje de "No encontrado" por API...`);
            await whatsapp.sendText(cleanFrom, fallback).catch(e => console.error(`❌ Falló envío Fallback: ${e.message}`));

            return res.json({ status: "success", response: "", final: true, stop: true });
        }
    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error);
        return res.json({ status: "error", response: "Ocurrió un error interno." });
    }
});

app.post('/', (req, res) => res.redirect(307, '/ai/plugin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR ONLINE EN PUERTO ${PORT}`);
    console.log(`📡 URL PERFEX: ${process.env.PERFEX_BASE_URL}`);
    console.log(`🤖 GEMINI READY: ${gemini.isReady()}`);
});
