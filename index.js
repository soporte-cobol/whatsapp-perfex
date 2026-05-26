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
        // 1. EXTRACCIÓN INICIAL (Sin lógica de negocio aún para evitar ReferenceError)
        const data = req.body?.data || req.body || {};
        const from = String(data.phone || data.wid || data.from || "");
        const cleanFrom = from.split('@')[0].replace(/\D/g, '');
        const rawMsg = (data.message || "").trim();
        const msg = rawMsg.replace(/Envía:\s*uno\.cobol\.com\.co/gi, "").trim();

        // 2. LOGS Y CONTROL DE HORARIO
        console.log(`\n📥 WEBHOOK RECIBIDO - ${new Date().toISOString()}`);
        if (!aiConfig.isBotActive()) {
            console.log(`⏳ [HORARIO LABORAL] Bot desactivado (Tel: ${cleanFrom}).`);
            return res.json({ status: "success", message: "Bot inactive", stop: true });
        }

        // 3. SEGURIDAD Y FILTRADO
        const secret = cleanString(req.body?.secret || req.body?.token || req.headers['x-api-key']);
        if (secret !== cleanString(process.env.WEBHOOK_API_KEY)) {
            return res.status(401).json({ status: "error", message: "Unauthorized" });
        }

        if (!msg || !cleanFrom || cleanFrom.length > 15 || from.includes('@g.us')) {
            return res.json({ status: "success", stop: true });
        }

        // 4. INICIALIZACIÓN DE SESIÓN
        if (!sessions[cleanFrom]) sessions[cleanFrom] = { destination: null, adultos: 1, ninos: 0, bebes: 0, email: null };
        const session = sessions[cleanFrom];

        // 5. EXTRACCIÓN DE DATOS (Email, NIT, Destino, PAX)
        const emailFound = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const nitMatch = msg.match(/\d{7,}/);
        const destinoDetectado = aiConfig.findDestination(msg);
        if (destinoDetectado) session.destination = destinoDetectado;
        if (emailFound) session.email = emailFound[0];

        const regexNums = /(\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)/i;
        const adultosMatch = msg.match(new RegExp(regexNums.source + '\\s*adultos?', 'i'));
        const ninosMatch = msg.match(new RegExp(regexNums.source + '\\s*ni[ñn]os?', 'i'));
        if (adultosMatch) session.adultos = textToNumber(adultosMatch[1]);
        if (ninosMatch) session.ninos = textToNumber(ninosMatch[1]);

        // 6. IDENTIFICACIÓN EN EL CRM (Sólo Clientes)
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;
        const isAccountInquiry = accountKeywords.test(msg);
        let customer = { found: false };

        if (emailFound || nitMatch || isAccountInquiry) {
            if (emailFound) customer = await perfex.getCustomerByEmail(emailFound[0]);
            if (!customer.found && nitMatch) customer = await perfex.getCustomerByVat(nitMatch[0]);
            if (!customer.found && isAccountInquiry) customer = await perfex.getCustomerByPhone(cleanFrom);
        }

        // 7. CONSTRUCCIÓN DEL CONTEXTO PARA LA IA
        let destinoContext = "";
        if (session.destination) {
            const p = aiConfig.calcularPrecio(session.destination, session.adultos, session.ninos, session.bebes);
            const fmt = (n) => `$${n.toLocaleString('es-CO')} COP`;
            console.log(`💰 [MEMORIA] ${session.destination.nombre} | PAX: ${session.adultos}A, ${session.ninos}N`);
            destinoContext = `\nPLAN: ${session.destination.nombre}\nPAX: ${session.adultos} adultos, ${session.ninos} niños.\nTOTAL: ${fmt(p.total)}\nINCLUYE: ${session.destination.incluye}`;
        }

        // 8. LÓGICA DE RESPUESTA
        let responseText = "";
        if (customer.found) {
            // Flujo Cliente Existente
            const [inv, proj] = await Promise.all([perfex.getInvoices(customer.customerId), perfex.getProjects(customer.customerId)]);
            let rigid = `*RESUMEN GM GROUP*\n` + (inv.length ? `📄 Facturas:\n` + inv.map(i => `• ${i.number}: $${i.total}`).join('\n') : `✅ Sin deudas.`);
            await whatsapp.sendText(cleanFrom, rigid);
            
            responseText = await gemini.generateText(`${aiConfig.PRE_PROMPT}\nCLIENTE: ${customer.firstname}\nCORREO: ${customer.email}${destinoContext}\nVIAJES: ${JSON.stringify(proj)}\nINSTRUCCIÓN: Si quiere concretar, usa [CREATE_TICKET: 1 | Venta | Detalle] con su correo: ${customer.email}.\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        } else if (isAccountInquiry) {
            // Flujo Fallo Identificación Crítica (Pedía facturas y no es cliente)
            responseText = await gemini.generateText(`Eres Laura. El cliente pide datos de cuenta pero no lo hallamos. Pídele correo/NIT. Pregunta: "${msg}"`);
        } else {
            // Flujo Prospecto / Lead / General
            if (emailFound) {
                await perfex.createLead({ name: `Prospecto ${cleanFrom}`, email: emailFound[0], phonenumber: cleanFrom, description: `Interés en ${session.destination?.nombre || 'viajar'}` }).catch(() => {});
            }
            responseText = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n${aiConfig.KNOWLEDGE_BASE}${destinoContext}\nDATOS SESIÓN: Correo: ${session.email || 'Desconocido'}\nINSTRUCCIÓN: Si tienes su correo y quiere concretar, crea el ticket de venta (ID 1).\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        }

        // 9. PROCESAMIENTO DE TICKET Y ENVÍO FINAL
        if (responseText) {
            const ticketRegex = /\[CREATE_TICKET:\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\]/i;
            const match = responseText.match(ticketRegex);
            if (match) {
                await perfex.createTicket({ 
                    customerId: customer.customerId || 0, 
                    subject: match[2].trim(), 
                    message: `${match[3].trim()}\n\n---\nTel: ${cleanFrom}\nEmail: ${session.email || customer.email || 'No provisto'}`, 
                    department: parseInt(match[1]), 
                    priority: 2 
                }).then(r => console.log(`✅ Ticket:`, JSON.stringify(r))).catch(e => console.error(`❌ Ticket Error:`, e.message));
            }
            await whatsapp.sendText(cleanFrom, responseText.replace(/\[CREATE_TICKET:.*?\]/g, '').trim());
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
