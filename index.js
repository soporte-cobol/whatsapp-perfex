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

    const candidateText =
        _asNonEmptyText(safePayload.response) ||
        _asNonEmptyText(safePayload.message) ||
        _asNonEmptyText(safePayload.output) ||
        _asNonEmptyText(safePayload.text) ||
        _asNonEmptyText(safePayload.result) ||
        _asNonEmptyText(safePayload.status) ||
        "OK";

    if (!_asNonEmptyText(safePayload.response)) safePayload.response = candidateText;
    if (!_asNonEmptyText(safePayload.message)) safePayload.message = candidateText;
    if (!_asNonEmptyText(safePayload.output)) safePayload.output = candidateText;
    if (!_asNonEmptyText(safePayload.text)) safePayload.text = candidateText;

    return res.json(safePayload);
}

// Asegurar que la carpeta de logs exista
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Configuración de Winston
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
        new winston.transports.Console({
            format: winston.format.combine(winston.format.colorize(), winston.format.simple())
        })
    ]
});

// Inicialización de servicios
const perfex = new PerfexService(
    (process.env.PERFEX_BASE_URL || '').trim(),
    (process.env.PERFEX_API_TOKEN || '').trim()
);

const whatsapp = new WhatsAppService(
    process.env.WHATSAPP_API_SECRET,
    process.env.WHATSAPP_ACCOUNT_ID
);

const gemini = new GeminiService(
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_MODEL
);

/**
 * Función auxiliar para enviar alertas de depuración al administrador
 */
function sendDebug(message) {
    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;
    if (adminPhone) {
        whatsapp.sendText(adminPhone, `🛠️ *DEBUG LOG:* ${message}`).catch(() => {});
    }
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Health Check Endpoint
 */
app.get('/health', async (req, res) => {
    const perfexAlive = await perfex.checkHealth().catch(() => false);
    return sendCobolJson(res, { 
        status: 'online', 
        timestamp: new Date().toISOString(),
        config: {
            perfex_connectivity: perfexAlive
        }
    });
});

/**
 * Middleware de seguridad
 */
const authenticateWebhook = (req, res, next) => {
    const apiKey = (req.headers['x-api-key'] || req.headers['X-API-KEY'] || '').trim();
    const bodySecret = (req.body.secret || req.body.password || '').trim();
    const expectedWebhookKey = (process.env.WEBHOOK_API_KEY || '').trim();

    if (expectedWebhookKey && (apiKey === expectedWebhookKey || bodySecret === expectedWebhookKey)) {
        return next();
    }

    logger.error(`🚫 BLOQUEADO: Credenciales incorrectas. IP: ${req.ip}`);
    return sendCobolJson(res.status(200), { status: "error", message: 'Error de autenticación.' });
};

/**
 * Lógica compartida del Dispatcher
 */
async function handlePluginRequest(req, res) {
    try {
        logger.info(`📥 JSON Recibido: ${JSON.stringify(req.body)}`);

        let action = req.body.action || req.body.function || (req.body.data && req.body.data.action);
        let args = req.body.arguments || req.body.data || req.body;

        if (typeof args === 'string' && args.trim().startsWith('{')) {
            try { args = JSON.parse(args); } catch (e) {}
        }

        // Si NO hay acción, es un mensaje de chat
        if (!action) {
            const msg = (req.body.data && req.body.data.message) || req.body.message || "";
            const from = (req.body.data && (req.body.data.phone || req.body.data.wid)) || req.body.from;

            if (msg && from) {
                const cleanFrom = String(from).split('@')[0].replace(/\D/g, '');
                const lowerMsg = msg.toLowerCase();
                
                const customer = await perfex.getCustomerByPhone(cleanFrom).catch(() => ({ found: false }));
                
                if (customer.found) {
                    const keywordsFactura = ['factura', 'debo', 'pendiente', 'pagos', 'pagar', 'saldo'];
                    const wantsInvoices = keywordsFactura.some(k => lowerMsg.includes(k));

                    const [invoices, projects] = await Promise.all([
                        (wantsInvoices || lowerMsg.length < 15) ? perfex.getInvoices(customer.customerId, 3).catch(() => []) : Promise.resolve([]),
                        perfex.getProjects(customer.customerId, 3).catch(() => [])
                    ]);

                    let rigidAnswer = `*DATOS DE TU CUENTA:*\n`;
                    let hasData = false;

                    if (Array.isArray(invoices) && invoices.length > 0) {
                        const pending = invoices.filter(inv => inv.status != 2); // No pagadas
                        if (pending.length > 0) {
                            rigidAnswer += `\n📄 *Facturas Pendientes:*`;
                            pending.forEach(inv => rigidAnswer += `\n• ${inv.number}: $${inv.total}\n  🔗 ${inv.view_url}`);
                            hasData = true;
                        }
                    }

                    if (!hasData) rigidAnswer = "✅ No tienes deudas pendientes.";

                    let aiAnswer = null;
                    if (gemini.isReady()) {
                        const prompt = `Eres un asistente amable. Cliente: ${customer.firstname}. Info CRM: ${rigidAnswer}. Pregunta: "${msg}". Responde brevemente.`;
                        aiAnswer = await gemini.generateText(prompt).catch(() => null);
                    }

                    if (aiAnswer) await whatsapp.sendText(cleanFrom, aiAnswer).catch(() => {});
                    await whatsapp.sendText(cleanFrom, rigidAnswer).catch(() => {});

                    // Retornamos un JSON que detenga cualquier otro procesamiento en el panel
                    return sendCobolJson(res, { 
                        status: "success", 
                        response: "", // Dejamos vacío para que el panel no intente procesar este texto
                        final: true, 
                        stop: true 
                    });
                } else {
                    let fallback = "No encuentro tu número. ¿Me das tu correo electrónico?";
                    if (gemini.isReady()) {
                        const aiFallback = await gemini.generateText(`Pide el correo amablemente porque no encontramos el teléfono: ${cleanFrom}`).catch(() => null);
                        if (aiFallback) fallback = aiFallback;
                    }
                    return sendCobolJson(res, { status: "success", response: fallback, final: true, stop: true });
                }
            }
            return sendCobolJson(res, { status: "success", message: "Heartbeat", stop: true });
        }

        // Si hay acción (IA llamando funciones)
        switch (action) {
            case 'identifyCustomer':
                const c = await perfex.getCustomerByPhone(args.phone);
                return sendCobolJson(res, { ...c, response: c.found ? `Hola ${c.firstname}` : "No encontrado" });
            case 'getInvoices':
                const invs = await perfex.getInvoices(args.customerId || args.id);
                return sendCobolJson(res, { invoices: invs, response: "Facturas obtenidas" });
            default:
                return sendCobolJson(res, { response: "Función no implementada" });
        }
    } catch (error) {
        logger.error(`❌ Fallo: ${error.message}`);
        return sendCobolJson(res, { status: "error", response: "Error interno" });
    }
}

app.post('/', authenticateWebhook, handlePluginRequest);
app.post('/ai/plugin', authenticateWebhook, handlePluginRequest);

process.on('unhandledRejection', (reason) => {
    logger.error('💥 UNHANDLED REJECTION:', reason);
});

setTimeout(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 SERVIDOR FUNCIONANDO EN PUERTO ${PORT}\n`);
    });
}, 500);
