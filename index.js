require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const PerfexService = require('./perfexService');
const WhatsAppService = require('./whatsappService');
const GeminiService = require('./geminiService');
const aiConfig = require('./aiConfig');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
        // 1. LOG INMEDIATO: Ver exactamente qué llega al servidor
        console.log(`\n📥 WEBHOOK RECIBIDO - ${new Date().toISOString()}`);
        console.log(`📦 CUERPO (BODY):`, req.body ? JSON.stringify(req.body) : 'VACÍO');
        if (req.headers['x-api-key']) {
            console.log(`🔑 AUTH: X-API-KEY Detectado`);
        }
        
        const data = req.body?.data || req.body || {};
        const rawMsg = (data.message || "").trim();
        // Eliminar la firma del plan gratuito de la API para que no ensucie el procesamiento
        const msg = rawMsg.replace(/Envía:\s*uno\.cobol\.com\.co/gi, "").trim();

        // Intentar capturar el teléfono de múltiples fuentes posibles
        const from = String(
            data.phone || data.wid || data.from || data.sender || 
            req.body?.phone || req.body?.sender || ""
        );

        const secret = cleanString(req.body?.secret || req.body?.token || req.headers['x-api-key']);
        const configSecret = cleanString(process.env.WEBHOOK_API_KEY);

        if (secret !== configSecret) {
            console.error(`❌ ERROR DE AUTENTICACIÓN: Secret recibido [${secret}] no coincide con configurado.`);
            return res.json({ status: "error", message: "Unauthorized" });
        }

        if (!msg) { console.log("ℹ️ Mensaje vacío, ignorando."); return res.json({ status: "success", stop: true }); }

        const cleanFrom = from.split('@')[0].replace(/\D/g, '');
        if (!cleanFrom) {
            console.warn("⚠️ No se pudo extraer un número de teléfono. Revisa el formato del JSON arriba.");
            return res.json({ status: "success", stop: true });
        }

        // Ignorar grupos (@g.us), canales (@newsletter), listas de difusión (broadcast) e IDs numéricos que excedan los 15 dígitos standard de teléfonos
        const isGroupOrChannel = 
            from.includes('@g.us') || 
            from.includes('@newsletter') || 
            from.toLowerCase().includes('broadcast') || 
            cleanFrom.length > 15;

        if (isGroupOrChannel) {
            console.log(`🚫 Mensaje ignorado (Grupo/Canal/Difusión detectado: ${from})`);
            return res.json({ status: "success", stop: true });
        }

        console.log(`\n-----------------------------------------`);
        console.log(`📩 ORIGINAL: "${rawMsg.substring(0, 60)}${rawMsg.length > 60 ? '...' : ''}"`);
        console.log(`📩 PROCESADO (Sin firma): "${msg}" | TEL: ${cleanFrom}`);

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

            // Detectar destino específico del catálogo en el mensaje
            const destinoDetectado = aiConfig.findDestination(msg);

            // Extraer número de personas del mensaje
            let adultos = 1, ninos = 0, bebes = 0;
            const somosMatch   = msg.match(/somos\s+(\d+)/i);
            const adultosMatch = msg.match(/(\d+)\s*adultos?/i);
            const ninosMatch   = msg.match(/(\d+)\s*ni[ñn]os?/i);
            const bebesMatch   = msg.match(/(\d+)\s*beb[eé]s?/i);
            if (adultosMatch) adultos = parseInt(adultosMatch[1]);
            else if (somosMatch) adultos = parseInt(somosMatch[1]);
            if (ninosMatch) ninos = parseInt(ninosMatch[1]);
            if (bebesMatch) bebes = parseInt(bebesMatch[1]);

            let destinoContext = '';
            if (destinoDetectado) {
                const precio = aiConfig.calcularPrecio(destinoDetectado, adultos, ninos, bebes);
                const fmt = (n) => `$${n.toLocaleString('es-CO')} COP`;
                console.log(`💰 Destino: ${destinoDetectado.nombre} | Adultos: ${adultos} | Niños: ${ninos} | Bebés: ${bebes}`);
                destinoContext = `\nDESTINO SOLICITADO: ${destinoDetectado.nombre}
DURACION: ${destinoDetectado.duracion_dias} dias / ${destinoDetectado.duracion_noches} noches
INCLUYE: ${destinoDetectado.incluye}
DESCRIPCION: ${destinoDetectado.descripcion}
CALCULO DE PRECIOS:
  - Adultos: ${adultos} x ${fmt(destinoDetectado.precio_adulto)} = ${fmt(precio.totalAdultos)}
  - Ninos (3-11 anos): ${ninos} x ${fmt(destinoDetectado.precio_nino)} = ${fmt(precio.totalNinos)}
  - Bebes (0-2 anos): ${bebes} GRATIS
  - TOTAL ESTIMADO: ${fmt(precio.total)}
INSTRUCCION ESPECIAL: Presenta este calculo de forma calida. Menciona que incluye y anima a reservar. NO inventes precios.`;
            }

            const instruccion = destinoDetectado
                ? 'Presenta el calculo de precios de forma natural y entusiasta.'
                : 'NO le pidas correo ni NIT a menos que quiera reservar o consultar facturas.';

            const prompt = `${aiConfig.PRE_PROMPT}\n\n${aiConfig.KNOWLEDGE_BASE || ''}${destinoContext}\n\nPREGUNTA DEL CLIENTE: "${msg}"\n\nINSTRUCCION: ${instruccion}\n\n${aiConfig.POST_PROMPT}`;
            const aiMsg = await gemini.generateText(prompt);

            console.log(`🤖 [IA FULL RESPONSE]:\n${aiMsg}\n-------------------------`);

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
