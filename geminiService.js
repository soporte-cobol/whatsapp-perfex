/**
 * Servicio para gestionar la lógica de IA con Google Gemini
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");

class GeminiService {
    constructor(apiKey, perfexService, customConfig = {}) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.perfex = perfexService;
        
        // Configuración extraída del dashboard de Cobol
        this.systemInstruction = `
Eres un asistente virtual corporativo inteligente y proactivo. Tu función es actuar como un puente entre el sistema de gestión (CRM) y el cliente a través de WhatsApp.

Tu objetivo es:
- Proporcionar respuestas claras, precisas y naturales basadas en los datos del CRM.
- Usar un tono profesional pero cercano y amigable.
- Utiliza emojis de forma estratégica para hacer la lectura agradable y moderna (🚀, ✅, 📊, 📄, 👋).
- Usa separadores horizontales (---) para dividir tu respuesta natural de los datos técnicos obtenidos del CRM.
- Para presentar datos tabulares (listas de facturas, proyectos, etc.), utiliza separadores verticales (|) creando tablas de texto simple.
- Usa asteriscos (*) para negritas en puntos clave.
- Si los datos muestran deudas o pendientes, informa con cortesía.
- Siempre termina con un llamado a la acción o una pregunta para ayudar más.
- Usa listas con viñetas para datos múltiples.
- Evita bloques de texto densos.
- Si no conoces el ID del cliente, utiliza la herramienta 'getCustomerByPhone' proporcionando el número de teléfono del usuario para identificarlo.
- Si no encuentras información específica, indica que un asesor humano revisará el caso.
`;

        // Definición de herramientas (herramientas que la IA puede llamar)
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "getCustomerByPhone",
                        description: "Busca la identidad y el ID de un cliente en el CRM a partir de su número de teléfono de WhatsApp.",
                        parameters: {
                            type: "object",
                            properties: {
                                phone: { type: "string", description: "El número de teléfono completo del remitente (ej: 573211234567)" }
                            },
                            required: ["phone"]
                        }
                    },
                    {
                        name: "getInvoices",
                        description: "Consulta las facturas de un cliente específico en Perfex CRM",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "string", description: "El ID del cliente en el CRM" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getSupportTickets",
                        description: "Obtiene los tickets de soporte asociados a un correo electrónico",
                        parameters: {
                            type: "object",
                            properties: {
                                email: { type: "string", description: "Correo electrónico del cliente" }
                            },
                            required: ["email"]
                        }
                    },
                    {
                        name: "getEstimates",
                        description: "Consulta presupuestos o estimaciones de un cliente",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "string", description: "El ID del cliente" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getProjects",
                        description: "Consulta los proyectos o servicios activos asociados al cliente",
                        parameters: {
                            type: "object",
                            properties: {
                                customerId: { type: "string", description: "El ID del cliente" }
                            },
                            required: ["customerId"]
                        }
                    },
                    {
                        name: "getTime",
                        description: "Obtiene la hora actual de una ubicación específica",
                        parameters: {
                            type: "object",
                            properties: {
                                timezone: { type: "string", description: "Identificador de zona horaria (ej: Europe/Rome)" }
                            },
                            required: ["timezone"]
                        }
                    }
                ]
            }
        ];

        this.model = this.genAI.getGenerativeModel({
            model: customConfig.model || "gemini-1.5-flash", // Usamos Flash por ser más rápido y económico
            tools: this.tools,
            systemInstruction: this.systemInstruction,
            generationConfig: {
                maxOutputTokens: customConfig.maxTokens || 2048,
            }
        });
    }

    /**
     * Inicia una sesión de chat con el contexto de la agencia de viajes
     */
    startChatSession() {
        return this.model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: "Eres un asistente virtual corporativo inteligente. Tienes acceso al CRM para identificar clientes por su teléfono y consultar facturas, proyectos y soporte. Usa '---' y '|' para dar formato. Sé amable y profesional." }],
                },
                {
                    role: "model",
                    parts: [{ text: "Entendido. Soy el asistente corporativo. Puedo identificar clientes por su número y formatear datos con separadores horizontales y verticales. Estoy listo para consultar facturas, proyectos y soporte, utilizando emojis para mejorar la experiencia." }],
                },
            ],
        });
    }
}

module.exports = GeminiService;