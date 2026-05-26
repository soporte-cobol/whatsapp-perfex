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

// Helper para convertir palabras comunes a números
const textToNumber = (text) => {
    const map = { 'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10, '0':0, '1':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10 };
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
        const digits = fromRaw.split('@')[0].replace(/\D/g, '');
        const cleanFrom = digits ? `+${digits}` : "";
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
        if (!sessions[cleanFrom]) sessions[cleanFrom] = { destination: null, adultos: 1, ninos: 0, bebes: 0, email: null, vat: null, name: null };
        const session = sessions[cleanFrom];

        const emailFound = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailFound) session.email = emailFound[0];

        // Detección de NIF/VAT/Documento (7 a 11 dígitos, evita confusiones con PAX)
        const vatMatch = msg.match(/\b\d{7,11}\b/);
        if (vatMatch) session.vat = vatMatch[0];

        // Detección de nombre (si el usuario dice "mi nombre es...")
        const nameMatch = msg.match(/mi nombre es\s+([a-záéíóúñ\s]+)/i);
        if (nameMatch) session.name = nameMatch[1].trim();

        const destinoDetectado = aiConfig.findDestination(msg);
        if (destinoDetectado) session.destination = destinoDetectado;

        // Regex Ultra-Estricto: Solo números de 1 o 2 dígitos rodeados de espacios/límites
        const paxNum = "(^|\\s)(\\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(\\s|$)";
        const adultosMatch = msg.match(new RegExp(paxNum + '\\s*adultos?', 'i'));
        const ninosMatch = msg.match(new RegExp(paxNum + '\\s*ni[ñn]os?', 'i'));
        
        if (adultosMatch) session.adultos = textToNumber(adultosMatch[2]);
        if (ninosMatch) session.ninos = textToNumber(ninosMatch[2]);

        // 5. IDENTIFICACIÓN CRM
        const accountKeywords = /factura|saldo|deuda|estado de cuenta|mis viajes|mi cuenta|resumen|pago/i;
        const isAccountInquiry = accountKeywords.test(msg);
        let customer = { found: false };

        if (session.email || isAccountInquiry || session.vat) {
            if (session.vat) customer = await perfex.getCustomerByVat(session.vat);
            if (!customer.found && session.email) customer = await perfex.getCustomerByEmail(session.email);
            if (!customer.found && (isAccountInquiry)) customer = await perfex.getCustomerByPhone(cleanFrom);
        }

        // 6. REGISTRO DE CLIENTE (Aseguramos ID, Nombre, Correo y Teléfono)
        if (session.email && !customer.found) {
            console.log(`👤 REGISTRANDO CLIENTE EN CRM: ${session.email}`);
            try {
                // Formatear nombre: juan.perez -> Juan Perez
                const nameParts = session.email.split('@')[0].split(/[._-]/);
                let formattedName = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
                
                const clientName = session.name || formattedName;
                
                const res = await perfex.createCustomer({
                    name: clientName,
                    email: session.email,
                    phonenumber: cleanFrom,
                    vat: session.vat || ''
                });
                
                if (res && (res.status === 'success' || res.customerId)) {
                    const newId = res.customerId;
                    console.log(`✅ Cliente Creado en CRM. ID: ${newId}. Verificando...`);
                    
                    // Forzamos la obtención de la data completa del cliente recién creado para el ticket
                    const verified = await perfex.getCustomerByEmail(session.email);
                    if (verified.found) {
                        customer = verified;
                        console.log(`✅ Cliente vinculado y verificado: ${customer.firstname}`);
                    } else {
                        // Si por algo no lo encuentra por email, asignamos el ID directamente
                        customer.customerId = newId;
                        customer.found = true;
                    }
                } else {
                    const errorMsg = res && typeof res === 'object' ? JSON.stringify(res) : String(res || 'Respuesta vacía');
                    console.warn(`⚠️ El CRM rechazó la creación (Respuesta: ${errorMsg}). Intentando rescate...`);
                    // Búsqueda de rescate: Quizás el cliente ya existía pero con otro teléfono
                    if (session.vat) customer = await perfex.getCustomerByVat(session.vat);
                    if (!customer.found && session.email) customer = await perfex.getCustomerByEmail(session.email);
                    
                    if (customer.found) {
                        console.log(`✅ Cliente recuperado: ${customer.customerId}`);
                    }

                    if (!customer.found) {
                        console.error("❌ El CRM rechazó la creación del cliente. Respuesta:", JSON.stringify(res));
                    }
                }
            } catch (e) {
                console.error("❌ ERROR AL CREAR CLIENTE:", e.message);
            }
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
            const [inv, proj] = await Promise.all([perfex.getInvoices(customer.customerId).catch(()=>[]), perfex.getProjects(customer.customerId).catch(()=>[])]);
            let rigid = `*RESUMEN GM GROUP*\n` + (inv.length ? `📄 Facturas:\n` + inv.map(i => `• ${i.number}: $${i.total}`).join('\n') : `✅ Sin deudas.`);
            await whatsapp.sendText(cleanFrom, rigid);
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\nCLIENTE IDENTIFICADO: ${customer.firstname || 'Usuario'}\nCORREO: ${session.email || customer.email}${destinoContext}\nINSTRUCCIÓN: Ya identificamos al cliente. Si quiere reservar o concretar, usa [CREATE_TICKET: 1 | Venta | Resumen]. NO vuelvas a pedir el correo bajo ninguna circunstancia.\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        } else {
            const instr = session.email ? `Ya tienes su correo (${session.email}). Si quiere concretar, usa [CREATE_TICKET: 1 | Venta | Detalle].` : "Pide el correo amablemente.";
            aiResponse = await gemini.generateText(`${aiConfig.PRE_PROMPT}\n${destinoContext}\nINSTRUCCIÓN: ${instr}\nPREGUNTA: "${msg}"\n${aiConfig.POST_PROMPT}`);
        }

        // 9. PROCESAMIENTO TICKET (Garantizamos vinculación al Cliente recién creado)
        if (aiResponse) {
            const ticketMatch = aiResponse.match(/\[CREATE_TICKET:\s*(\d+)\s*\|\s*([^|]+)\s*\|\s*([^\]]+)\]/i);
            if (ticketMatch) {
                const deptId = parseInt(ticketMatch[1]);
                const subject = ticketMatch[2].trim();
                const message = ticketMatch[3].trim();
                const fromEmail = session.email || customer.email;
                const deptEmail = aiConfig.DEPT_EMAILS[deptId] || aiConfig.DEPT_EMAILS[1];

                if (customer.customerId) {
                    console.log(`🎫 Creando Ticket DIRECTO para Cliente ID: ${customer.customerId}`);
                    await perfex.createTicket({
                        customerId: customer.customerId,
                        subject: subject,
                        message: message,
                        department: deptId,
                        priority: 2
                    }).then(r => console.log(`✅ Ticket DB Creado:`, JSON.stringify(r)))
                      .catch(e => console.error(`❌ Error Ticket DB:`, e.message));
                } else if (fromEmail) {
                    console.log(`📧 Simulando correo desde ${fromEmail} hacia ${deptEmail}...`);
                    await perfex.sendPipingEmail({
                        to: deptEmail,
                        from_email: fromEmail,
                        subject: subject,
                        body: `SOLICITUD WHATSAPP\n-----------------\nWhatsApp: ${cleanFrom}\nNIF/VAT: ${session.vat || 'No provisto'}\n\nDetalle:\n${message}\n\n---\nLaura AI`
                    }).then(() => console.log(`✅ Ticket enviado al Piping correctamente.`))
                      .catch(e => console.error(`❌ Error en Simulación Piping:`, e.message));
                } else {
                    console.warn("⚠️ No se pudo simular el correo: Falta el email del cliente.");
                }
            }
            // Enviar respuesta sin los tags técnicos
            const cleanResponse = aiResponse.replace(/\[CREATE_TICKET:.*?\]/g, '').trim();
            await whatsapp.sendText(cleanFrom, cleanResponse);
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
