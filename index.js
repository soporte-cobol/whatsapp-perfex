require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria temporal de la sesión (se limpia al reiniciar el servidor)
const sessions = {};

// Helper para convertir palabras comunes de números a dígitos
const textToNumber = (text) => {
    const map = { 'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10 };
    const match = String(text).toLowerCase().trim();
    if (map[match]) return map[match];
    return parseInt(match) || 1;
};

// Middleware para capturar errores de JSON mal formado antes de llegar a la ruta
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('❌ Error de sintaxis en el JSON recibido:', err.message);
        return res.status(400).send({ status: "error", message: "Invalid JSON" });
    }
    next();
});

const cleanString = (val) => String(val || "").replace(/^["']|["']$/g, "").trim();

const perfex = new PerfexService(cleanString(process.env.PERFEX_BASE_URL), cleanString(process.env.PERFEX_API_TOKEN));
const whatsapp = new WhatsAppService(cleanString(process.env.WHATSAPP_API_SECRET), cleanString(process.env.WHATSAPP_ACCOUNT_ID));
const gemini = new GeminiService(cleanString(process.env.GEMINI_API_KEY), "gemini-3.5-flash");

app.get('/ai/debug', (req, res) => {
    const mask = (val) => {
        if (!val) return '❌ VACÍO';
        const raw = String(val);
        const str = cleanString(raw);
        return `${str.substring(0, 4)}...${str.substring(Math.max(0, str.length - 4))} (Longitud original: ${raw.length}, Sanitizado: ${str.length})`;
    };
    return res.json({
        env_loaded: Boolean(process.env.WEBHOOK_API_KEY),
        WEBHOOK_API_KEY: mask(process.env.WEBHOOK_API_KEY),
        WHATSAPP_API_SECRET: mask(process.env.WHATSAPP_API_SECRET),
        WHATSAPP_ACCOUNT_ID: mask(process.env.WHATSAPP_ACCOUNT_ID),
        GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY),
        GEMINI_MODEL: process.env.GEMINI_MODEL || '❌ NO DEFINIDO',
        node_version: process.version,
        cwd: process.cwd(),
        dirname: __dirname
    });
});

app.post('/ai/plugin', async (req, res) => {
    try {
        // 1. EXTRACCIÓN INMEDIATA (Previene ReferenceError)
        const payload = req.body?.data || req.body || {};
        const fromRaw = String(payload.phone || payload.wid || payload.from || "");
        const cleanFrom = fromRaw.split('@')[0].replace(/\D/g, '');
        const rawContent = (payload.message || "").trim();
        const msg = rawContent.replace(/Envía:\s*uno\.cobol\.com\.co/gi, "").trim();

        // 2. LOGS Y CONTROL DE HORARIO
        console.log(`\n📥 WEBHOOK RECIBIDO [${cleanFrom}] - ${new Date().toISOString()}`);
        if (!aiConfig.isBotActive()) {
            console.log(`⏳ [HORARIO LABORAL] Bot desactivado (Tel: ${cleanFrom}).`);
            return res.json({ status: "success", stop: true });
        }

        // 3. SEGURIDAD
        const secret = cleanString(req.body?.secret || req.body?.token || req.headers['x-api-key']);
        if (secret !== cleanString(process.env.WEBHOOK_API_KEY)) {
            return res.status(401).json({ status: "error" });
        }

        if (!msg || !cleanFrom || fromRaw.includes('@g.us')) return res.json({ status: "success" });

        // 4. MEMORIA DE SESIÓN
        if (!sessions[cleanFrom]) sessions[cleanFrom] = { destination: null, adultos: 1, ninos: 0, bebes: 0, email: null };
        const session = sessions[cleanFrom];

        const emailFound = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailFound) session.email = emailFound[0];

        const destinoDetectado = aiConfig.findDestination(msg);
        if (destinoDetectado) session.destination = destinoDetectado;

        const numPattern = "(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)";
        const adultosMatch = msg.match(new RegExp(numPattern + '\\s*adultos?', 'i'));
        const ninosMatch = msg.match(new RegExp(numPattern + '\\s*ni[ñn]os?', 'i'));
        if (adultosMatch) session.adultos = textToNumber(adultosMatch[1]);
        if (ninosMatch) session.ninos = textToNumber(ninosMatch[1]);

        // 5. IDENTIFICACIÓN CRM
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;
        const isAccountInquiry = accountKeywords.test(msg);
        let customer = { found: false };

        if (session.email || isAccountInquiry) {
            if (session.email) customer = await perfex.getCustomerByEmail(session.email);
            if (!customer.found && isAccountInquiry) customer = await perfex.getCustomerByPhone(cleanFrom);
        }

        // 6. REGISTRO DE LEAD (Si hay correo y no es cliente)
        if (session.email && !customer.found) {
            console.log(`👤 REGISTRANDO LEAD: ${session.email}`);
            await perfex.createLead({
                name: `Lead WA ${cleanFrom}`,
                email: session.email,
                phonenumber: cleanFrom,
                description: `Interés: ${session.destination?.nombre || 'General'}. PAX: ${session.adultos}A, ${session.ninos}N.`
            }).catch(e => console.error("❌ LEAD FAIL:", e.message));
        }

        // 7. CONTEXTO IA
        let destinoContext = "";
        if (session.destination) {
            const p = aiConfig.calcularPrecio(session.destination, session.adultos, session.ninos, session.bebes);
            const fmt = (n) => `$${n.toLocaleString('es-CO')} COP`;
            destinoContext = `\nPLAN: ${session.destination.nombre}\nPASAJEROS: ${session.adultos} adultos, ${session.ninos} niños.\nTOTAL: ${fmt(p.total)}`;
            console.log(`💰 PAX: ${session.adultos}A | ${session.destination.nombre}`);
        }

        // 8. GENERACIÓN RESPUESTA
        let aiResponse = "";
        if (customer.found) {
            const [inv, proj] = await Promise.all([perfex.getInvoices(customer.customerId), perfex.getProjects(customer.customerId)]);
            let rigid = `*RESUMEN GM GROUP*\n` + (inv.length ? `📄 Facturas:\n` + inv.map(i => `• ${i.number}: $${i.total}`).join('\n') : `✅ Sin deudas.`);
            await whatsapp.sendText(cleanFrom, rigid);
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\nCLIENTE: ${customer.firstname}\nCORREO: ${customer.email}${destinoContext}\nINSTRUCCIÓN: Si quiere concretar, usa [CREATE_TICKET: 1 | Venta | Detalle].\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        } else {
            const instr = session.email ? `Ya tienes su correo (${session.email}). Si quiere concretar, usa [CREATE_TICKET: 1 | Venta | Detalle].` : "Pide el correo.";
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n${destinoContext}\nINSTRUCCIÓN: ${instr}\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        }

        // 9. TICKET Y ENVÍO
        if (aiResponse) {
            const ticketMatch = aiResponse.match(/\[CREATE_TICKET:\s*(\d+)\s*\|\s*([^|]+)\s*\|\s*([^\]]+)\]/i);
            if (ticketMatch) {
                await perfex.createTicket({
                    customerId: customer.customerId || 0,
                    subject: ticketMatch[2].trim(),
                    message: `${ticketMatch[3].trim()}\n\n---\nWA: ${cleanFrom}\nEmail: ${session.email || customer.email || 'N/A'}`,
                    department: parseInt(ticketMatch[1]),
                    priority: 2
                }).then(r => console.log(`✅ Ticket Creado:`, JSON.stringify(r))).catch(e => console.error(`❌ Error Ticket:`, e.message));
            }
            await whatsapp.sendText(cleanFrom, aiResponse.replace(/\[CREATE_TICKET:.*?\]/g, '').trim());
        }

        return res.json({ status: "success" });

    } catch (error) {
        console.error(`💥 ERROR CRÍTICO:`, error);
        return res.json({ status: "error" });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`\n🚀 LAURA (MODO DIOS 3.1) ONLINE | PUERTO ${PORT}`);
    
    // Imprimir resumen de variables cargadas (enmascaradas) para diagnóstico
    const mask = (val) => {
        if (!val) return '❌ NO CARGADO (Vacío)';
        const raw = String(val);
        const str = cleanString(raw);
        let status = `${str.substring(0, 4)}...${str.substring(Math.max(0, str.length - 4))} (Longitud: ${str.length})`;
        if (raw.startsWith('"') || raw.startsWith("'")) {
            status += ' ⚠️ Contiene Comillas!';
        }
        if (raw.includes('\r')) {
            status += ' ⚠️ Contiene Retorno de Carro (CRLF)!';
        }
        return status;
    };
    
    console.log(`🔍 DIAGNÓSTICO DE VARIABLES DE ENTORNO:`);
    console.log(`  - WEBHOOK_API_KEY:     ${mask(process.env.WEBHOOK_API_KEY)}`);
    console.log(`  - WHATSAPP_API_SECRET: ${mask(process.env.WHATSAPP_API_SECRET)}`);
    console.log(`  - WHATSAPP_ACCOUNT_ID: ${mask(process.env.WHATSAPP_ACCOUNT_ID)}`);
    console.log(`  - GEMINI_API_KEY:      ${mask(process.env.GEMINI_API_KEY)}`);
    console.log(`  - GEMINI_MODEL:        ${process.env.GEMINI_MODEL || '❌ NO DEFINIDO'}`);
    console.log(`-----------------------------------------\n`);
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`❌ El puerto ${PORT} ya está en uso. ¿Hay otra instancia corriendo?`);
    else console.error(`❌ Error al iniciar servidor:`, e);
});
